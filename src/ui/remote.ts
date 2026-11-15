/** The model, as the browser sees it: the LLM seam (src/llm/types.ts) as fetches to the local server's /api/llm. */
import type { JsonReq, LLM, Req, Turn, TurnReq } from "../llm/types";
import type { WebStep } from "../llm/web";
import { failure } from "./session";

async function fail(res: Response): Promise<never> {
  throw await failure(res);
}

export function remoteLLM(kind: LLM["kind"], model?: string): LLM {
  const post = (path: string, payload: unknown, signal?: AbortSignal) =>
    fetch(`/api/llm/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal });
  return {
    kind,
    model,
    async stream(req: Req, onText, signal) {
      const res = await post("stream", req, signal);
      if (!res.ok || !res.body) await fail(res);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      let error: string | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let chunk = decoder.decode(value, { stream: true });
        if (error !== null) {
          error += chunk;
          continue;
        }
        // A failure after the stream has started arrives in-band, after a NUL.
        const nul = chunk.indexOf("\u0000");
        if (nul >= 0) {
          error = chunk.slice(nul + 1);
          chunk = chunk.slice(0, nul);
        }
        if (chunk) {
          text += chunk;
          onText(chunk);
        }
      }
      if (error !== null) throw new Error(error || "generation failed");
      return text;
    },
    async json<T>(req: JsonReq, signal?: AbortSignal) {
      const res = await post("json", req, signal);
      if (!res.ok) await fail(res);
      return (await res.json()) as T;
    },
    async turn(req: TurnReq, signal?: AbortSignal, onWeb?: (step: WebStep) => void) {
      if (!onWeb) {
        const res = await post("turn", req, signal);
        if (!res.ok) await fail(res);
        return (await res.json()) as Turn;
      }
      // With research, the server sends each search and page read as a line as it happens, then the turn.
      const res = await post("turn?steps=1", req, signal);
      if (!res.ok || !res.body) await fail(res);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        buf += decoder.decode(value, { stream: !done });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as { step?: WebStep; turn?: Turn; error?: string };
          if (msg.step) onWeb(msg.step);
          else if (msg.turn) return msg.turn;
          else if (msg.error) throw new Error(msg.error);
        }
        if (done) break;
      }
      throw new Error("the server ended the turn without a reply");
    },
  };
}
