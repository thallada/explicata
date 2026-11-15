/** The real provider: Claude, through the Anthropic SDK. The API key never leaves this process. */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { TOOLS } from "../src/llm/tasks";
import type { JsonReq, LLM, Req, Turn, TurnReq, WebStep } from "../src/llm/types";
import { webOf } from "../src/llm/web";
import { schemas } from "./schemas";
import { usage, type ApiUsage } from "./usage";
import { apiWebTools } from "./web";

/**
 * Run one API call and report its `usage` to the tracker. A call that throws is counted as failed
 * without token counts; one the browser cancelled is counted without being called a failure.
 */
async function reported<T extends { usage?: ApiUsage | null }>(signal: AbortSignal | undefined, call: () => Promise<T>): Promise<T> {
  let response: T;
  try {
    response = await call();
  } catch (err) {
    usage.recordCall("api", null, { ok: Boolean(signal?.aborted) });
    throw err;
  }
  usage.recordApiUsage(response.usage);
  return response;
}

// If the model declines a request, the API re-runs it on a fallback model inside the same call.
const FALLBACK: { betas: Anthropic.AnthropicBeta[]; fallbacks: "default" } = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

export function claudeLLM(model: string): LLM {
  const client = new Anthropic();

  // The system prompt and the document are the stable prefix; both are marked for caching so a
  // run of expansions in one document pays for that context once.
  const shape = (req: Req) => ({
    model,
    max_tokens: req.maxTokens ?? 4000,
    system: [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }],
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: req.context, cache_control: { type: "ephemeral" as const } },
          { type: "text" as const, text: req.prompt },
        ],
      },
    ],
    output_config: { effort: req.effort ?? "low" },
  });

  return {
    kind: "claude",
    model,

    async stream(req, onText, signal) {
      const final = await reported(signal, () => {
        const stream = client.beta.messages.stream({ ...shape(req), ...FALLBACK }, { signal });
        stream.on("text", onText);
        return stream.finalMessage();
      });
      if (final.stop_reason === "refusal") throw new Error("The model declined this request.");
      return final.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    },

    async json<T>(req: JsonReq, signal?: AbortSignal) {
      const response = await reported(signal, () =>
        client.messages.parse(
          { ...shape(req), max_tokens: req.maxTokens ?? 8000, output_config: { effort: req.effort ?? "low", format: zodOutputFormat(schemas[req.schema]) } },
          { signal },
        ),
      );
      if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
      if (response.parsed_output == null) throw new Error("The model's reply did not match the expected structure.");
      return response.parsed_output as T;
    },

    async turn(req: TurnReq, signal?: AbortSignal, onWeb?: (step: WebStep) => void): Promise<Turn> {
      const [first, ...rest] = req.messages;
      const tools: Anthropic.Beta.BetaToolUnion[] = TOOLS.map((t) => ({ ...t, input_schema: { ...t.input_schema, required: [...t.input_schema.required] } }));
      // Research adds the API's own web search and fetch. Their blocks (server_tool_use and the
      // results) come back in the content and are passed back untouched on later turns.
      if (req.research) tools.push(...apiWebTools(model, req.research));
      const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: 16000,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        tools,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: req.context, cache_control: { type: "ephemeral" } },
              { type: "text", text: String(first.content) },
            ],
          },
          ...(rest as Anthropic.Beta.BetaMessageParam[]),
        ],
        output_config: { effort: "medium" },
        ...FALLBACK,
      };
      if (!req.research) {
        const response = await reported(signal, () => client.beta.messages.create(params, { signal }));
        return { content: response.content as Turn["content"], stop_reason: response.stop_reason };
      }
      // Streamed, so each search and page read can be shown as it finishes rather than when the
      // whole turn (which may run several of them) is over.
      const earlier = req.messages.flatMap((m) => (m.role === "assistant" && Array.isArray(m.content) ? m.content : []));
      const response = await reported(signal, () => {
        const stream = client.beta.messages.stream(params, { signal });
        const seen: unknown[] = [];
        let told = 0;
        stream.on("contentBlock", (block) => {
          seen.push(block);
          const steps = webOf(seen, earlier).steps;
          for (; told < steps.length; told++) onWeb?.(steps[told]);
        });
        return stream.finalMessage();
      });
      return { content: response.content as Turn["content"], stop_reason: response.stop_reason };
    },
  };
}

/** A short, human-readable reason for a failed call. */
export function describeError(err: unknown): { status: number; message: string } {
  if (err instanceof Anthropic.AuthenticationError) return { status: 401, message: `The API key was rejected: ${err.message}` };
  if (err instanceof Anthropic.PermissionDeniedError) return { status: 403, message: "This API key is not allowed to use the configured model." };
  if (err instanceof Anthropic.NotFoundError) return { status: 404, message: "The configured model was not found." };
  if (err instanceof Anthropic.RateLimitError) {
    // The API says which limit was hit (requests, input tokens, output tokens) and when it resets.
    // Pass that on: "rate limited" alone does not tell a new account from a busy one.
    const h = err.headers;
    const limits = ["requests", "input-tokens", "output-tokens"]
      .map((k) => (h?.get(`anthropic-ratelimit-${k}-limit`) ? `${k} ${h.get(`anthropic-ratelimit-${k}-remaining`)}/${h.get(`anthropic-ratelimit-${k}-limit`)} left` : ""))
      .filter(Boolean)
      .join(", ");
    const retry = h?.get("retry-after");
    return { status: 429, message: `Rate limited: ${err.message}${limits ? ` [${limits}]` : ""}${retry ? ` Retry after ${retry}s.` : ""}` };
  }
  if (err instanceof Anthropic.APIConnectionError) return { status: 502, message: "Could not reach the Anthropic API." };
  if (err instanceof Anthropic.APIError) return { status: err.status ?? 500, message: err.message };
  return { status: 500, message: err instanceof Error ? err.message : String(err) };
}
