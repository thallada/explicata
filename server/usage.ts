/**
 * How much model use this server process has seen, and what the Claude subscription says is left
 * of the plan. Every provider reports into one tracker; `GET /api/usage` returns its summary.
 *
 * Two kinds of figure, kept apart:
 *   - the session: calls and tokens since this process started, from each response's own usage
 *   - the plan window (subscription only): what the Agent SDK reports about the plan's rate limits,
 *     from `rate_limit_event` messages and, at startup, from the SDK's usage query
 * Nothing is estimated for a real provider; a figure the SDK or the API did not give stays null.
 */
import type { SDKControlGetUsageResponse, SDKRateLimitInfo, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { LLM } from "../src/llm/types";
import { spent, webOf } from "../src/llm/web";

export type Provider = "subscription" | "api" | "mock";
export type WindowStatus = "allowed" | "allowed_warning" | "rejected";

/** At or above this share of a window used, the footer turns to the attention colour. */
const WARN_AT = 90;

export interface PlanWindow {
  /** The SDK's name for the window: five_hour, seven_day, seven_day_opus, overage, … */
  id: string;
  /** The same in plain words, as the footer says it: "5-hour", "weekly", "weekly Opus". */
  label: string;
  /** Share used, 0–100 (can pass 100). Null when not reported, or when the window has reset since. */
  usedPercent: number | null;
  /** ISO time the window resets, if known. */
  resetsAt: string | null;
  /** What the server said about this window, if it said. A rejected window alone does not mean refusal. */
  status: WindowStatus | null;
  /** The reset time has passed since this was reported, so the percentage is no longer known. */
  reset: boolean;
  /** When this was learned (ISO). */
  updatedAt: string;
}

export interface UsageSummary {
  /** Which provider answers model calls; null when there is no model. */
  provider: Provider | null;
  model: string | null;
  now: string;
  session: {
    /** When this server process started (ISO): "this session" means since then. */
    startedAt: string;
    /** Model calls finished (successfully or not). */
    calls: number;
    /** Of those, how many failed. */
    failed: number;
    /** Of those, how many came back without token counts (cancelled, or failed before a reply). */
    unreported: number;
    input: { fresh: number; cacheRead: number; cacheWrite: number; total: number };
    output: number;
    /** The most recent call that reported tokens: how much context it sent. */
    lastCall: { at: string; input: number; output: number } | null;
    /** The SDK's own estimate of what the calls would cost at API prices (subscription only). */
    costUsd: number | null;
    /** Web searches and pages fetched by the editor agent's research, as the provider reported them. */
    web: { searches: number; fetches: number };
  };
  /** Null unless the provider has a plan (the subscription) or a window has been reported. */
  plan: null | {
    windows: PlanWindow[];
    /** The id of the most used window with a known share, excluding extra usage. */
    tightest: string | null;
    /** 100 minus the tightest window's share used, floored at 0. */
    remainingPercent: number | null;
    resetsAt: string | null;
    /** The tightest window is at or above WARN_AT percent used. */
    warning: boolean;
    /** The SDK says requests are being refused. */
    limited: boolean;
    /** When the refusing limit resets, if the SDK said. */
    limitResetsAt: string | null;
    /** Which window is refusing, in plain words, if known. */
    limitLabel: string | null;
    overage: { status: WindowStatus | null; resetsAt: string | null; inUse: boolean | null } | null;
    /** When the plan was last heard about (ISO), and from where. */
    updatedAt: string | null;
    source: "event" | "query" | null;
  };
}

/** Tokens one call used, as the response reported them. */
interface Tokens {
  fresh: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

const LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
  seven_day_oauth_apps: "weekly apps",
  seven_day_overage_included: "weekly per-model",
  overage: "extra usage",
};
const labelOf = (id: string) => LABELS[id] ?? (id.startsWith("model:") ? `weekly ${id.slice(6)}` : id.replaceAll("_", " "));

/** SDK reset times are unix seconds (the subscription code accepts milliseconds too, defensively). */
const epochIso = (t: number | undefined | null) => (typeof t === "number" && Number.isFinite(t) ? new Date(t < 1e12 ? t * 1000 : t).toISOString() : null);
const isoOrNull = (s: string | null | undefined) => (s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null);
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
/** A fraction as a percentage, without float noise (0.96 → 96, not 96.00000000000001). */
const pct = (f: number) => Math.round(f * 1e6) / 1e4;

/**
 * Per-window figures that Claude Code 2.1.325 attaches to rate_limit_info as `unifiedWindows`.
 * The field is marked @internal and stripped from the published .d.ts; its schema is in the
 * bundled CLI. Utilisation there is a fraction (usually 0–1) and resetsAt is unix seconds, the
 * same scale as the public top-level fields. Read only when present and well-formed.
 */
type UnifiedWindow = { utilization?: number; resetsAt?: number; status?: WindowStatus; surpassedThreshold?: number };
export type RateLimitInfo = SDKRateLimitInfo & { unifiedWindows?: Record<string, UnifiedWindow | undefined> };

interface Session {
  calls: number;
  failed: number;
  unreported: number;
  fresh: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  lastCall: { at: string; input: number; output: number } | null;
  costUsd: number | null;
  searches: number;
  fetches: number;
}
const emptySession = (): Session => ({ calls: 0, failed: 0, unreported: 0, fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, lastCall: null, costUsd: null, searches: 0, fetches: 0 });

/** Searches and fetches one call made. */
interface WebUse {
  searches: number;
  fetches: number;
}

export class UsageTracker {
  readonly startedAt: Date;
  provider: Provider | null = null;
  model: string | null = null;
  private sessions = new Map<Provider, Session>();
  private windows = new Map<string, Omit<PlanWindow, "label" | "reset">>();
  /** The latest top-level rate-limit status: it alone says whether requests are being refused. */
  private gate: { status: WindowStatus; resetsAt: string | null; window: string | null; at: string } | null = null;
  /** A rate-limit error seen without a rejecting event; cleared by the next successful call. */
  private refusal: { at: string; resetsAt: string | null } | null = null;
  private overage: { status: WindowStatus | null; resetsAt: string | null; inUse: boolean | null } | null = null;
  private planAt: string | null = null;
  private planSource: "event" | "query" | null = null;

  constructor(private clock: () => Date = () => new Date()) {
    this.startedAt = clock();
  }

  now(): Date {
    return this.clock();
  }

  configure(provider: Provider | null, model: string | null) {
    this.provider = provider;
    this.model = model;
  }

  private session(p: Provider) {
    let s = this.sessions.get(p);
    if (!s) this.sessions.set(p, (s = emptySession()));
    return s;
  }

  // ---- the session ----

  /** One finished model call. `tokens` null means the reply carried no counts. */
  recordCall(provider: Provider, tokens: Tokens | null, opts: { ok: boolean; costUsd?: number | null; web?: WebUse | null } = { ok: true }) {
    const s = this.session(provider);
    s.calls++;
    if (opts.web) {
      s.searches += finite(opts.web.searches) ? opts.web.searches : 0;
      s.fetches += finite(opts.web.fetches) ? opts.web.fetches : 0;
    }
    if (!opts.ok) s.failed++;
    if (finite(opts.costUsd)) s.costUsd = (s.costUsd ?? 0) + opts.costUsd;
    if (!tokens) {
      s.unreported++;
      return;
    }
    s.fresh += tokens.fresh;
    s.cacheRead += tokens.cacheRead;
    s.cacheWrite += tokens.cacheWrite;
    s.output += tokens.output;
    s.lastCall = { at: this.clock().toISOString(), input: tokens.fresh + tokens.cacheRead + tokens.cacheWrite, output: tokens.output };
    if (opts.ok) this.refusal = null;
  }

  /** A Messages API response's `usage` (the API-key route). */
  recordApiUsage(u: ApiUsage | null | undefined) {
    const st = u?.server_tool_use;
    this.recordCall("api", u ? tokensFromApi(u) : null, { ok: true, web: st ? { searches: st.web_search_requests ?? 0, fetches: st.web_fetch_requests ?? 0 } : null });
  }

  /**
   * The Agent SDK's `result` message (the subscription route). Searches come from the result's
   * `modelUsage` (webSearchRequests); fetches, which Claude Code makes itself, are counted by the
   * caller from the WebFetch calls that ran, and passed in.
   */
  recordResult(result: SDKResultMessage, opts: { failed?: boolean; fetches?: number } = {}) {
    const ok = result.subtype === "success" && !result.is_error && !opts.failed;
    const searches = Object.values(result.modelUsage ?? {}).reduce((n, m) => n + (finite(m.webSearchRequests) ? m.webSearchRequests : 0), 0);
    this.recordCall("subscription", tokensFromResult(result), {
      ok,
      costUsd: finite(result.total_cost_usd) && result.total_cost_usd > 0 ? result.total_cost_usd : null,
      web: searches || opts.fetches ? { searches, fetches: opts.fetches ?? 0 } : null,
    });
  }

  /** A call that ended without a result message (it threw, or was cancelled). */
  recordFailure(provider: Provider) {
    this.recordCall(provider, null, { ok: false });
  }

  // ---- the plan ----

  /** A `rate_limit_event`'s `rate_limit_info`. */
  recordRateLimit(info: RateLimitInfo) {
    const at = this.clock().toISOString();
    this.planAt = at;
    this.planSource = "event";
    const resetsAt = epochIso(info.resetsAt);
    this.gate = { status: info.status, resetsAt, window: info.rateLimitType ?? null, at };
    if (info.status !== "rejected") this.refusal = null;
    if (info.rateLimitType) {
      const prev = this.windows.get(info.rateLimitType);
      this.windows.set(info.rateLimitType, {
        id: info.rateLimitType,
        usedPercent: finite(info.utilization) ? pct(info.utilization) : (prev?.usedPercent ?? null),
        resetsAt: resetsAt ?? prev?.resetsAt ?? null,
        status: info.status,
        updatedAt: at,
      });
    }
    for (const [id, w] of Object.entries(info.unifiedWindows ?? {})) {
      if (!w || typeof w !== "object") continue;
      const prev = this.windows.get(id);
      this.windows.set(id, {
        id,
        usedPercent: finite(w.utilization) ? pct(w.utilization) : (prev?.usedPercent ?? null),
        resetsAt: epochIso(w.resetsAt) ?? prev?.resetsAt ?? null,
        status: w.status ?? prev?.status ?? null,
        updatedAt: at,
      });
    }
    if (info.overageStatus || info.isUsingOverage !== undefined || info.overageInUse !== undefined) {
      this.overage = {
        status: info.overageStatus ?? null,
        resetsAt: epochIso(info.overageResetsAt),
        inUse: info.isUsingOverage ?? info.overageInUse ?? null,
      };
    }
  }

  /** A rate-limit error from the API, which means this request was refused. */
  recordRefusal(info?: SDKRateLimitInfo) {
    this.refusal = { at: this.clock().toISOString(), resetsAt: epochIso(info?.resetsAt) };
  }

  /** The `rate_limits` of the SDK's usage query (utilisation there is already 0–100). */
  recordPlanQuery(rl: SDKControlGetUsageResponse["rate_limits"]) {
    if (!rl) return;
    const at = this.clock().toISOString();
    const put = (id: string, w: { utilization: number | null; resets_at: string | null } | null | undefined) => {
      if (!w) return;
      const prev = this.windows.get(id);
      this.windows.set(id, {
        id,
        usedPercent: finite(w.utilization) ? w.utilization : null,
        resetsAt: isoOrNull(w.resets_at),
        status: prev?.status ?? null,
        updatedAt: at,
      });
    };
    put("five_hour", rl.five_hour);
    put("seven_day", rl.seven_day);
    put("seven_day_oauth_apps", rl.seven_day_oauth_apps);
    put("seven_day_opus", rl.seven_day_opus);
    put("seven_day_sonnet", rl.seven_day_sonnet);
    for (const m of rl.model_scoped ?? []) put(`model:${m.display_name}`, m);
    this.planAt = at;
    this.planSource = "query";
  }

  // ---- the summary ----

  summary(): UsageSummary {
    const now = this.clock();
    const nowMs = now.getTime();
    const s = this.provider ? this.session(this.provider) : emptySession();
    const passed = (iso: string | null) => iso !== null && Date.parse(iso) <= nowMs;

    const windows: PlanWindow[] = [...this.windows.values()].map((w) => {
      const reset = passed(w.resetsAt);
      return { ...w, label: labelOf(w.id), usedPercent: reset ? null : w.usedPercent, status: reset ? null : w.status, reset };
    });
    // Order: shortest window first, then weekly, then the rest, then extra usage.
    const rank = (id: string) => (id === "five_hour" ? 0 : id === "seven_day" ? 1 : id === "overage" ? 9 : 5);
    windows.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));

    const known = windows.filter((w) => w.usedPercent !== null && w.id !== "overage");
    const tight = known.reduce<PlanWindow | null>((m, w) => (!m || w.usedPercent! > m.usedPercent! ? w : m), null);

    const gateRefusing = this.gate?.status === "rejected" && !passed(this.gate.resetsAt);
    const refusalLive = this.refusal !== null && !passed(this.refusal.resetsAt);
    const limited = gateRefusing || refusalLive;
    const limitResetsAt = gateRefusing ? this.gate!.resetsAt : refusalLive ? this.refusal!.resetsAt : null;
    const limitWindow = gateRefusing ? this.gate!.window : null;

    const hasPlan = this.provider === "subscription" || windows.length > 0 || this.gate !== null || this.refusal !== null;
    return {
      provider: this.provider,
      model: this.model,
      now: now.toISOString(),
      session: {
        startedAt: this.startedAt.toISOString(),
        calls: s.calls,
        failed: s.failed,
        unreported: s.unreported,
        input: { fresh: s.fresh, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, total: s.fresh + s.cacheRead + s.cacheWrite },
        output: s.output,
        lastCall: s.lastCall,
        costUsd: s.costUsd,
        web: { searches: s.searches, fetches: s.fetches },
      },
      plan: hasPlan
        ? {
            windows,
            tightest: tight?.id ?? null,
            remainingPercent: tight ? Math.max(0, 100 - tight.usedPercent!) : null,
            resetsAt: tight?.resetsAt ?? null,
            warning: tight !== null && tight.usedPercent! >= WARN_AT,
            limited,
            limitResetsAt,
            limitLabel: limitWindow ? labelOf(limitWindow) : null,
            overage: this.overage,
            updatedAt: this.planAt,
            source: this.planSource,
          }
        : null,
    };
  }
}

// ---- reading providers' usage ----

/** The fields of a Messages API `usage` this module reads (Usage and BetaUsage both have them). */
export interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /** Server tools the call ran (web search and fetch), when it ran any. */
  server_tool_use?: { web_search_requests?: number | null; web_fetch_requests?: number | null } | null;
}

const tokensFromApi = (u: ApiUsage): Tokens => ({
  fresh: u.input_tokens ?? 0,
  cacheRead: u.cache_read_input_tokens ?? 0,
  cacheWrite: u.cache_creation_input_tokens ?? 0,
  output: u.output_tokens ?? 0,
});

/**
 * Tokens from an SDK result. `modelUsage` covers every model call the query made (the SDK says to
 * prefer it); `usage` covers the main loop only, and is the fallback. A failed result whose counts
 * are all zero carries no information (the SDK zeroes them on crashes), so it counts as unreported.
 */
function tokensFromResult(r: SDKResultMessage): Tokens | null {
  const models = Object.values(r.modelUsage ?? {});
  let t: Tokens;
  if (models.length) {
    t = { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    for (const m of models) {
      t.fresh += m.inputTokens ?? 0;
      t.cacheRead += m.cacheReadInputTokens ?? 0;
      t.cacheWrite += m.cacheCreationInputTokens ?? 0;
      t.output += m.outputTokens ?? 0;
    }
  } else if (r.usage) {
    t = tokensFromApi(r.usage);
  } else return null;
  const failed = r.subtype !== "success" || r.is_error;
  if (failed && t.fresh + t.cacheRead + t.cacheWrite + t.output === 0) return null;
  return t;
}

/** The tracker this server process reports into. */
export const usage = new UsageTracker();

// ---- the mock provider ----

/** A deterministic size estimate: one token per four characters, rounded up. */
const estimate = (...parts: (string | undefined)[]) => Math.ceil(parts.reduce((n, p) => n + (p?.length ?? 0), 0) / 4);

/**
 * The mock model, reporting each call into the tracker with estimated token counts (no caching).
 * Deterministic for a given request, so tests can assert on it.
 */
export function withMockUsage(llm: LLM, tracker: UsageTracker = usage): LLM {
  const report = async <T,>(input: number, run: () => Promise<T>, out: (v: T) => number, web?: (v: T) => WebUse | null): Promise<T> => {
    try {
      const v = await run();
      tracker.recordCall("mock", { fresh: input, cacheRead: 0, cacheWrite: 0, output: out(v) }, { ok: true, web: web?.(v) ?? null });
      return v;
    } catch (err) {
      tracker.recordFailure("mock");
      throw err;
    }
  };
  return {
    ...llm,
    stream: (req, onText, signal) => report(estimate(req.system, req.context, req.prompt), () => llm.stream(req, onText, signal), (t) => estimate(t)),
    json: (req, signal) => report(estimate(req.system, req.context, req.prompt), () => llm.json(req, signal), (v) => estimate(JSON.stringify(v))),
    turn: (req, signal, onWeb) =>
      report(
        estimate(req.system, req.context, JSON.stringify(req.messages)),
        () => llm.turn(req, signal, onWeb),
        (v) => estimate(JSON.stringify(v.content)),
        (v) => {
          const n = spent(webOf(v.content).steps);
          return n.searches || n.fetches ? n : null;
        },
      ),
  };
}
