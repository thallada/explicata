/**
 * The footer's usage figures, as seen from the browser: fetched from GET /api/usage on load, after
 * every model call the page makes, and once a minute while the page is visible. Kept apart from
 * the store; the store only wraps its model with `refreshAfterCalls`.
 */
import type { PlanWindow, UsageSummary } from "../../server/usage";
import type { LLM } from "../llm/types";

let current: UsageSummary | null = null;
const listeners = new Set<() => void>();

export const usageNow = () => current;
export function onUsage(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let inflight = false;
let again = false;

/** Fetch the summary. Calls that arrive while one is in flight fold into one more fetch after it. */
async function refreshUsage(): Promise<void> {
  if (inflight) {
    again = true;
    return;
  }
  inflight = true;
  try {
    do {
      again = false;
      try {
        const res = await fetch("/api/usage");
        if (res.ok) current = (await res.json()) as UsageSummary;
      } catch {
        /* offline: keep what we had */
      }
      for (const fn of listeners) fn();
    } while (again);
  } finally {
    inflight = false;
  }
}

const MINUTE = 60_000;
let timer: ReturnType<typeof setInterval> | undefined;
const onVisible = () => {
  if (!document.hidden) void refreshUsage();
};

/** Load now, then refresh once a minute while the page is visible. Returns a stop function. */
export function startUsage(): () => void {
  void refreshUsage();
  if (timer === undefined) {
    timer = setInterval(() => !document.hidden && void refreshUsage(), MINUTE);
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    clearInterval(timer);
    timer = undefined;
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** The same model, refreshing the usage figures after each call finishes (or fails). */
export function refreshAfterCalls(llm: LLM): LLM {
  const after = <T>(p: Promise<T>): Promise<T> => p.finally(() => void refreshUsage());
  return {
    ...llm,
    stream: (req, onText, signal) => after(llm.stream(req, onText, signal)),
    json: (req, signal) => after(llm.json(req, signal)),
    turn: (req, signal, onWeb) => after(llm.turn(req, signal, onWeb)),
  };
}

// ---- words ----

/** 950 → "950", 12_400 → "12k", 1_250_000 → "1.3M". */
function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

const num = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

/** A reset time, short: "17:00" today, "Sat 14:00" within a week, else "16 Nov". */
function when(iso: string, now: Date): string {
  const t = new Date(iso);
  const hm = t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (t.toDateString() === now.toDateString()) return hm;
  if (t.getTime() - now.getTime() < 6.5 * 86_400_000) return `${t.toLocaleDateString([], { weekday: "short" })} ${hm}`;
  return t.toLocaleDateString([], { day: "numeric", month: "short" });
}

/** A reset time, long: "Sat 16 Nov, 14:00 (in 2 days 5 hours)". */
function whenLong(iso: string, now: Date): string {
  const t = new Date(iso);
  const date = t.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const mins = Math.max(0, Math.round((t.getTime() - now.getTime()) / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const rel = d ? `${plural(d, "day")}${h ? ` ${plural(h, "hour")}` : ""}` : h ? `${plural(h, "hour")}${m ? ` ${plural(m, "minute")}` : ""}` : plural(m, "minute");
  return `${date} (in ${rel})`;
}

/** Share left, rounded down so it never overstates: 3.6 → "3%", 0.4 → "<1%". */
function left(usedPercent: number): string {
  const r = Math.max(0, 100 - usedPercent);
  return r > 0 && r < 1 ? "<1%" : `${Math.floor(r)}%`;
}

const passed = (iso: string | null, now: Date) => iso !== null && Date.parse(iso) <= now.getTime();

function windowLine(w: PlanWindow, now: Date): string {
  if (w.id === "overage") {
    if (w.usedPercent !== null) return `Extra usage: ${Math.round(w.usedPercent)}% used${w.resetsAt ? `, resets ${whenLong(w.resetsAt, now)}` : ""}`;
    return `Extra usage: ${w.status === "rejected" ? "not available" : "available"}`;
  }
  if (w.reset || passed(w.resetsAt, now)) return `${cap(w.label)} usage: reset since it was reported; the new figure arrives with the next call`;
  const pct = w.usedPercent === null ? `${cap(w.label)} usage: not reported` : `${left(w.usedPercent)} of ${w.label} usage left`;
  const status = w.status === "rejected" ? " (limit reached)" : w.status === "allowed_warning" ? " (close to the limit)" : "";
  return `${pct}${status}${w.resetsAt ? `, resets ${whenLong(w.resetsAt, now)}` : ""}`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface UsageView {
  plan: { text: string; title: string; attn: boolean; limited: boolean } | null;
  session: { text: string; title: string; calls: number } | null;
}

/** What the footer shows, in words. Null when there is no model. */
export function view(u: UsageSummary | null, now: Date = new Date()): UsageView | null {
  if (!u || !u.provider) return null;
  const s = u.session;
  const started = new Date(s.startedAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const lines = [`This session (since the server started, ${started}):`, plural(s.calls, "model call")];
  const notes = [s.failed ? `${num(s.failed)} failed` : "", s.unreported ? `${num(s.unreported)} without token counts` : ""].filter(Boolean);
  if (notes.length) lines[1] += ` (${notes.join(", ")})`;
  const cached = s.input.cacheRead || s.input.cacheWrite;
  lines.push(
    `${plural(s.input.total, "input token")}${cached ? `: ${num(s.input.fresh)} uncached, ${num(s.input.cacheRead)} read from cache, ${num(s.input.cacheWrite)} written to cache` : ""}`,
    plural(s.output, "output token"),
  );
  const web = s.web ?? { searches: 0, fetches: 0 };
  if (web.searches || web.fetches) lines.push(`Web research: ${plural(web.searches, "search", "searches")}, ${plural(web.fetches, "page")} fetched`);
  if (s.lastCall) lines.push(`Last call sent ${plural(s.lastCall.input, "input token")} (${new Date(s.lastCall.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})`);
  if (s.costUsd !== null) lines.push(`About $${s.costUsd.toFixed(2)} at API prices (Claude Code's estimate; the subscription is not charged per call)`);
  if (u.provider === "mock") lines.push("Mock model: token counts are estimates (4 characters per token).");

  let plan: UsageView["plan"] = null;
  const p = u.plan;
  if (p) {
    const title: string[] = [];
    const limited = p.limited && !passed(p.limitResetsAt, now);
    if (limited) {
      title.push(`Claude is refusing requests: ${p.limitLabel ? `${p.limitLabel} limit` : "usage limit"} reached.${p.limitResetsAt ? ` It resets ${whenLong(p.limitResetsAt, now)}.` : ""}`);
    }
    // The most constrained window first: it is the one the footer shows.
    const ordered = [...p.windows].sort((a, b) => Number(b.id === p.tightest) - Number(a.id === p.tightest));
    for (const w of ordered) title.push(windowLine(w, now));
    if (p.overage && !p.windows.some((w) => w.id === "overage") && (p.overage.status || p.overage.inUse !== null)) {
      title.push(p.overage.inUse ? "Extra usage: in use" : `Extra usage: ${p.overage.status === "rejected" ? "not available" : "available"}`);
    }
    if (p.updatedAt) {
      const at = new Date(p.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const from = p.source === "query" ? "looked up when the server started" : "reported with the last call";
      title.push(`As of ${at} (${from}). Use elsewhere (Claude Code, claude.ai) counts too and shows here after the next call.`);
    }
    const tight = p.windows.find((w) => w.id === p.tightest);
    if (limited) {
      plan = { text: `limit reached${p.limitResetsAt ? `, resets ${when(p.limitResetsAt, now)}` : ""}`, title: title.join("\n"), attn: true, limited: true };
    } else if (tight && tight.usedPercent !== null && !passed(tight.resetsAt, now)) {
      plan = { text: `${tight.label} ${left(tight.usedPercent)} left`, title: title.join("\n"), attn: p.warning, limited: false };
    } else {
      lines.push("", "Plan usage: not reported yet. Claude reports it with each call.");
      if (title.length) lines.push(...title);
    }
  }

  return {
    plan,
    session: {
      text: `${plural(s.calls, "call")} · ${tokens(s.input.total)} in · ${tokens(s.output)} out${web.searches || web.fetches ? ` · ${plural(web.searches, "search", "searches")}` : ""}`,
      title: lines.join("\n"),
      calls: s.calls,
    },
  };
}
