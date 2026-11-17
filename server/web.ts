/**
 * Web research on the server: whether it is on (EX_WEB), the per-run caps (EX_WEB_SEARCHES,
 * EX_WEB_FETCHES), and the Messages API's web tools as the API-key route declares them.
 *
 * The browser asks for research on an agent turn; what it gets is decided here. With EX_WEB=off a
 * turn never carries web tools, whatever the browser asked, and the caps the browser sends are
 * replaced by the server's.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { TurnReq } from "../src/llm/types";
import { DEFAULT_LIMITS, type Research } from "../src/llm/web";

interface WebConfig {
  on: boolean;
  searches: number;
  fetches: number;
  /** Why it is off, when it is. */
  why?: string;
}

const count = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isInteger(n) && n >= 0 && n <= 50 ? n : d;
};

/** EX_WEB is on or off (default on, when there is a model at all); anything else is off, said once. */
export function webConfig(env: Record<string, string | undefined>, hasModel: boolean): WebConfig {
  const caps = { searches: count(env.EX_WEB_SEARCHES, DEFAULT_LIMITS.searches), fetches: count(env.EX_WEB_FETCHES, DEFAULT_LIMITS.fetches) };
  const wanted = env.EX_WEB ?? "on";
  if (!hasModel) return { on: false, ...caps, why: "no model is configured" };
  if (wanted === "off") return { on: false, ...caps, why: "EX_WEB=off" };
  if (wanted !== "on") return { on: false, ...caps, why: `EX_WEB=${wanted} is not on or off` };
  if (caps.searches === 0 && caps.fetches === 0) return { on: false, ...caps, why: "EX_WEB_SEARCHES and EX_WEB_FETCHES are both 0" };
  return { on: true, ...caps };
}

/** A turn as the server will run it: research only if it is on, and then with the server's caps. */
export function applyWebPolicy(req: TurnReq, cfg: WebConfig): TurnReq {
  if (!req.research || !cfg.on) {
    const { research: _, ...rest } = req;
    return rest;
  }
  const used = req.research.used;
  const clean = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0);
  const research: Research = {
    searches: cfg.searches,
    fetches: cfg.fetches,
    used: { searches: clean(used?.searches), fetches: clean(used?.fetches) },
    found: Array.isArray(req.research.found) ? req.research.found.filter((u): u is string => typeof u === "string").slice(0, 200) : [],
  };
  return { ...req, research };
}

/**
 * Models that take the `_20260209` web tools (Opus 4.6 and later, Sonnet 4.6 and later, Fable,
 * Mythos); older ones get the basic `web_search_20250305` / `web_fetch_20250910`.
 */
const modernWebTools = (model: string) => /claude-(fable|mythos|opus-5|sonnet-5|opus-4-[6-9]|sonnet-4-[6-9])/.test(model);

/** Text of a fetched page kept in the context, at most (approximate; the API truncates past it). */
const FETCH_MAX_TOKENS = 25_000;

/**
 * The web search and web fetch server tools for one agent run. The same definitions on every
 * request of the run: a paused or continued turn must be sent the tools it started with, and the
 * API counts `max_uses` across the whole turn, which here is the whole run (every request after
 * the first continues it with tool results only), so `max_uses` is the per-run cap.
 *
 * - `allowed_callers: ["direct"]` on the `_20260209` tools turns off dynamic filtering, which runs
 *   code in a sandbox to filter results: the owner wants search and fetch only, no code execution.
 * - `url_sources.client_tool_results: none`: a page may be fetched only if its address was in the
 *   person's message or in an earlier search or fetch result, not if it appears only in what our
 *   own tools returned (a node's text, which the model may have written itself).
 */
export function apiWebTools(model: string, r: Research): Anthropic.Beta.BetaToolUnion[] {
  const tools: Anthropic.Beta.BetaToolUnion[] = [];
  const modern = modernWebTools(model);
  const urlSources = { client_tool_results: { type: "none" as const } };
  if (r.searches > 0) {
    tools.push(
      modern
        ? { type: "web_search_20260209", name: "web_search", max_uses: r.searches, allowed_callers: ["direct"] }
        : { type: "web_search_20250305", name: "web_search", max_uses: r.searches },
    );
  }
  if (r.fetches > 0) {
    tools.push(
      modern
        ? { type: "web_fetch_20260209", name: "web_fetch", max_uses: r.fetches, allowed_callers: ["direct"], max_content_tokens: FETCH_MAX_TOKENS, url_sources: urlSources }
        : { type: "web_fetch_20250910", name: "web_fetch", max_uses: r.fetches, max_content_tokens: FETCH_MAX_TOKENS, url_sources: urlSources },
    );
  }
  return tools;
}
