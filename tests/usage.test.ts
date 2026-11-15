/** The server's usage tracker, fed messages shaped like the Agent SDK's and the Messages API's. */
import type { SDKRateLimitEvent, SDKResultError, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { mockLLM } from "../src/llm/mock";
import { UsageTracker, withMockUsage, type RateLimitInfo } from "../server/usage";
import { view } from "../src/ui/usage";

const T0 = Date.parse("2026-11-14T10:00:00Z");
const S0 = T0 / 1000;
const H = 3600;

function tracker(provider: "subscription" | "api" | "mock" = "subscription") {
  let now = T0;
  const t = new UsageTracker(() => new Date(now));
  t.configure(provider, "claude-opus-5-5");
  return { t, advance: (ms: number) => (now += ms) };
}

// Fixtures follow the SDK types: SDKRateLimitEvent / SDKRateLimitInfo and SDKResultSuccess
// (sdk.d.ts). `satisfies` keeps them honest if the SDK changes shape.
const rateLimitEvent = (info: RateLimitInfo) =>
  ({ type: "rate_limit_event", rate_limit_info: info, uuid: "00000000-0000-4000-8000-000000000001", session_id: "s" }) satisfies SDKRateLimitEvent;

const modelUsage = { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 8000, cacheCreationInputTokens: 500, webSearchRequests: 0, costUSD: 0.21, contextWindow: 200000, maxOutputTokens: 64000 };
const result = (over: Partial<SDKResultSuccess> = {}) =>
  ({
    type: "result",
    subtype: "success",
    duration_ms: 2100,
    duration_api_ms: 1800,
    is_error: false,
    num_turns: 1,
    result: "text",
    stop_reason: "end_turn",
    total_cost_usd: 0.21,
    usage: {
      input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 8000, cache_creation_input_tokens: 500,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 500 }, inference_geo: "", iterations: [],
      output_tokens_details: { thinking_tokens: 0 } as never, server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 } as never,
      service_tier: "standard", speed: "standard", fallback_credit: null,
    } as SDKResultSuccess["usage"],
    modelUsage: { "claude-opus-5-5": modelUsage },
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-000000000002",
    session_id: "s",
    ...over,
  }) as SDKResultSuccess;

describe("usage tracker: the session", () => {
  it("adds up calls and tokens from SDK results, splitting cached from fresh input", () => {
    const { t } = tracker();
    t.recordResult(result());
    t.recordResult(result({ modelUsage: { "claude-opus-5-5": { ...modelUsage, inputTokens: 100, cacheReadInputTokens: 9000, cacheCreationInputTokens: 0, outputTokens: 50 } } }));
    const s = t.summary().session;
    expect(s.calls).toBe(2);
    expect(s.input).toEqual({ fresh: 1300, cacheRead: 17000, cacheWrite: 500, total: 18800 });
    expect(s.output).toBe(350);
    expect(s.lastCall).toEqual({ at: new Date(T0).toISOString(), input: 9100, output: 50 });
    expect(s.costUsd).toBeCloseTo(0.42);
    expect(s.startedAt).toBe(new Date(T0).toISOString());
  });

  it("counts a zeroed error result and a throw as failed calls without token counts", () => {
    const { t } = tracker();
    const zeroed = { ...result(), subtype: "error_during_execution", errors: ["boom"], total_cost_usd: 0, modelUsage: {}, usage: { ...result().usage, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as SDKResultError;
    t.recordResult(zeroed);
    t.recordFailure("subscription");
    const s = t.summary().session;
    expect(s).toMatchObject({ calls: 2, failed: 2, unreported: 2, output: 0, lastCall: null, costUsd: null });
  });

  it("reads Messages API usage on the API-key route, and has no plan there", () => {
    const { t } = tracker("api");
    t.recordApiUsage({ input_tokens: 40, output_tokens: 900, cache_read_input_tokens: 12000, cache_creation_input_tokens: null });
    const u = t.summary();
    expect(u.session.input).toEqual({ fresh: 40, cacheRead: 12000, cacheWrite: 0, total: 12040 });
    expect(u.plan).toBeNull();
    const v = view(u, new Date(T0))!;
    expect(v.plan).toBeNull();
    expect(v.session!.text).toBe("1 call · 12k in · 900 out");
  });

  it("the mock reports deterministic estimates", async () => {
    const { t } = tracker("mock");
    const llm = withMockUsage(mockLLM(), t);
    const req = { task: "write", system: "x".repeat(40), context: "y".repeat(400), prompt: "z".repeat(4), vars: { title: "T" } };
    const text = await llm.stream(req, () => {});
    expect(t.summary().session).toMatchObject({ calls: 1, input: { fresh: 111, cacheRead: 0, cacheWrite: 0, total: 111 }, output: Math.ceil(text.length / 4) });
  });

  it("with no model there is nothing to show", () => {
    const t = new UsageTracker();
    expect(t.summary().provider).toBeNull();
    expect(view(t.summary())).toBeNull();
  });
});

describe("usage tracker: the plan window", () => {
  it("keeps every window reported, and summarises the most constrained one", () => {
    const { t } = tracker();
    expect(t.summary().plan).toMatchObject({ windows: [], tightest: null, remainingPercent: null, limited: false });
    t.recordRateLimit(rateLimitEvent({ status: "allowed", rateLimitType: "five_hour", utilization: 0.31, resetsAt: S0 + 2 * H }).rate_limit_info);
    t.recordRateLimit(rateLimitEvent({ status: "allowed", rateLimitType: "seven_day", utilization: 0.58, resetsAt: S0 + 50 * H }).rate_limit_info);
    const p = t.summary().plan!;
    expect(p.windows.map((w) => [w.id, w.label, Math.round(w.usedPercent!)])).toEqual([["five_hour", "5-hour", 31], ["seven_day", "weekly", 58]]);
    expect(p.tightest).toBe("seven_day");
    expect(p.remainingPercent).toBeCloseTo(42);
    expect(p.resetsAt).toBe(new Date((S0 + 50 * H) * 1000).toISOString());
    expect(p.warning).toBe(false);
    const v = view(t.summary(), new Date(T0))!;
    expect(v.plan!.text).toBe("weekly 42% left");
    expect(v.plan!.attn).toBe(false);
    expect(v.plan!.title).toContain("42% of weekly usage left");
    expect(v.plan!.title).toContain("69% of 5-hour usage left");
  });

  it("reads the per-window figures Claude Code attaches when present", () => {
    const { t } = tracker();
    t.recordRateLimit({
      status: "allowed", rateLimitType: "five_hour", utilization: 0.1, resetsAt: S0 + H,
      unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: S0 + H, status: "allowed" }, seven_day: { utilization: 0.83, resetsAt: S0 + 30 * H, status: "allowed_warning" } },
    });
    const p = t.summary().plan!;
    expect(p.tightest).toBe("seven_day");
    expect(p.windows.find((w) => w.id === "seven_day")!.status).toBe("allowed_warning");
  });

  it("turns to the attention state at 90% used or more", () => {
    const { t } = tracker();
    t.recordRateLimit(rateLimitEvent({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.964, resetsAt: S0 + 29 * H, surpassedThreshold: 0.9 }).rate_limit_info);
    const p = t.summary().plan!;
    expect(p.warning).toBe(true);
    expect(p.limited).toBe(false);
    const v = view(t.summary(), new Date(T0))!;
    expect(v.plan).toMatchObject({ text: "weekly 3% left", attn: true, limited: false });
    t.recordRateLimit({ status: "allowed", rateLimitType: "seven_day", utilization: 0.899, resetsAt: S0 + 29 * H });
    expect(t.summary().plan!.warning).toBe(false);
  });

  it("shows a refusal when the SDK says requests are rejected, until the reset passes", () => {
    const { t, advance } = tracker();
    t.recordRateLimit(rateLimitEvent({ status: "rejected", rateLimitType: "seven_day", utilization: 1, resetsAt: S0 + 26 * H, overageStatus: "rejected" }).rate_limit_info);
    const p = t.summary().plan!;
    expect(p).toMatchObject({ limited: true, limitLabel: "weekly", limitResetsAt: new Date((S0 + 26 * H) * 1000).toISOString(), remainingPercent: 0 });
    const v = view(t.summary(), new Date(T0))!;
    expect(v.plan!.limited).toBe(true);
    expect(v.plan!.attn).toBe(true);
    expect(v.plan!.text).toMatch(/^limit reached, resets /);
    expect(v.plan!.title).toContain("Claude is refusing requests: weekly limit reached.");
    advance(27 * H * 1000);
    const after = t.summary().plan!;
    expect(after.limited).toBe(false);
    // The old percentage is no longer known once the window has reset.
    expect(after.windows[0]).toMatchObject({ usedPercent: null, reset: true });
    expect(after.remainingPercent).toBeNull();
  });

  it("a rate-limit error alone means refused, until a call succeeds", () => {
    const { t } = tracker();
    t.recordRefusal();
    expect(t.summary().plan!.limited).toBe(true);
    t.recordResult(result());
    expect(t.summary().plan!.limited).toBe(false);
  });

  it("takes the startup usage query's windows (already 0-100)", () => {
    const { t } = tracker();
    t.recordPlanQuery({
      five_hour: { utilization: 12, resets_at: new Date(T0 + 3 * H * 1000).toISOString() },
      seven_day: { utilization: 96, resets_at: new Date(T0 + 60 * H * 1000).toISOString() },
      seven_day_opus: null,
      model_scoped: [{ display_name: "Fable", utilization: 40, resets_at: null }],
    });
    const p = t.summary().plan!;
    expect(p.source).toBe("query");
    expect(p.tightest).toBe("seven_day");
    expect(p.warning).toBe(true);
    expect(p.windows.map((w) => w.label)).toEqual(["5-hour", "weekly", "weekly Fable"]);
  });
});
