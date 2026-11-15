/**
 * Web research for the editor agent: what a run is allowed (per-run caps the server sets), what it
 * did (searches and pages read, as steps the page shows), and what it found (the URLs it may cite).
 *
 * Shared by the browser (runAgent keeps the run's list of retrieved URLs and checks every URL the
 * agent links against it), the server (the providers turn their own tool output into steps) and
 * the mock. The blocks read here are the Messages API's server tool blocks (`server_tool_use`,
 * `web_search_tool_result`, `web_fetch_tool_result`), which the API-key route returns as they are
 * and the mock imitates.
 */
import { hostOf } from "../core/ref";

/** Per-run caps on searches and fetches. Defaults; the server's IE_WEB_SEARCHES / IE_WEB_FETCHES win. */
export const DEFAULT_LIMITS = { searches: 5, fetches: 5 } as const;

export interface Research {
  /** Searches allowed in the whole run (set by the server). */
  searches: number;
  /** Pages that may be fetched in the whole run (set by the server). */
  fetches: number;
  /** How many of each earlier turns of this run used (the browser counts them). */
  used?: { searches: number; fetches: number };
  /** URLs this run has already retrieved, so a provider that cannot see earlier turns' results may fetch them. */
  found?: string[];
}

export type WebStep =
  | { kind: "search"; query: string; results?: number; error?: string }
  | { kind: "fetch"; url: string; title?: string; error?: string };

export interface WebSource {
  url: string;
  title?: string;
  /** Found as a search result, or read in full. */
  via: "search" | "fetch";
}

export interface WebReport {
  steps: WebStep[];
  sources: WebSource[];
}

/** A URL as compared for "was this retrieved": no fragment, no trailing slash on the path, host lower-cased. */
export function normUrl(u: string): string {
  try {
    const x = new URL(u.trim());
    x.hash = "";
    return !x.search && x.href.endsWith("/") ? x.href.slice(0, -1) : x.href;
  } catch {
    return u.trim();
  }
}

type AnyBlock = { type: string; [k: string]: unknown };

/**
 * The steps and sources in a turn's content, read from the server tool blocks. A step is counted at
 * its result block, which is when the API has run it (failed calls count, as the API counts them).
 * A call and its result can arrive in different responses (a call made beside a client tool call
 * runs at the start of the next request), so `earlier` is the run's earlier content, where the
 * call that a result answers may be.
 */
export function webOf(content: readonly unknown[], earlier: readonly unknown[] = []): WebReport {
  const steps: WebStep[] = [];
  const sources: WebSource[] = [];
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const raw of [...earlier, ...content]) {
    const b = raw as AnyBlock;
    if (b && typeof b === "object" && b.type === "server_tool_use") calls.set(String(b.id), { name: String(b.name), input: (b.input ?? {}) as Record<string, unknown> });
  }
  for (const raw of content) {
    const b = raw as AnyBlock;
    if (!b || typeof b !== "object") continue;
    if (b.type === "web_search_tool_result") {
      const step: WebStep & { kind: "search" } = { kind: "search", query: String(calls.get(String(b.tool_use_id))?.input.query ?? "") };
      if (Array.isArray(b.content)) {
        const hits = b.content as { url?: unknown; title?: unknown }[];
        for (const r of hits) if (typeof r.url === "string") sources.push({ url: r.url, title: typeof r.title === "string" ? r.title : undefined, via: "search" });
        step.results = hits.length;
      } else step.error = String((b.content as { error_code?: unknown })?.error_code ?? "error");
      steps.push(step);
    } else if (b.type === "web_fetch_tool_result") {
      const asked = String(calls.get(String(b.tool_use_id))?.input.url ?? "");
      const c = (b.content ?? {}) as Record<string, unknown>;
      if (c.type === "web_fetch_result") {
        const url = typeof c.url === "string" ? c.url : asked;
        const title = ((c.content as { title?: unknown } | undefined)?.title as string | null | undefined) ?? undefined;
        steps.push({ kind: "fetch", url, title: title || undefined });
        sources.push({ url, title: title || undefined, via: "fetch" });
        if (asked && normUrl(asked) !== normUrl(url)) sources.push({ url: asked, title: title || undefined, via: "fetch" });
      } else steps.push({ kind: "fetch", url: asked, error: String(c.error_code ?? "error") });
    }
  }
  return { steps, sources };
}

/** How many searches and fetches these steps spent (failed ones count, as the API counts them). */
export function spent(steps: readonly WebStep[]): { searches: number; fetches: number } {
  return { searches: steps.filter((s) => s.kind === "search").length, fetches: steps.filter((s) => s.kind === "fetch").length };
}

/** One line for the progress display: what the agent searched for, or which page it read. */
export function describeStep(s: WebStep): string {
  if (s.kind === "search") {
    if (s.error) return `search “${s.query}” failed (${s.error.replaceAll("_", " ")})`;
    return `searched “${s.query}”${s.results !== undefined ? `: ${s.results} result${s.results === 1 ? "" : "s"}` : ""}`;
  }
  if (s.error) return `could not read ${hostOf(s.url) || "a page"} (${s.error.replaceAll("_", " ")})`;
  return `read ${s.title ? `“${s.title}” · ` : ""}${hostOf(s.url)}`;
}

/**
 * Whether an ordinary request to the editor plainly asks for the web. A fixed rule, not a model
 * call: the request names looking something up, searching the web, or finding sources.
 */
const ASKS = /\b(look(s|ing)? (it |this |that |them |these |those )?up|search(es|ing)? (the web|online|the internet)|web search|on the web|find(ing)? (some |a few |good |reliable )?(sources?|references?|citations?)|(add|cite|with) (some |its |their )?(sources?|references?|citations?)|fact[- ]check)\b/i;
export const wantsResearch = (instruction: string): boolean => ASKS.test(instruction);
