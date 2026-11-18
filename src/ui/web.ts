/**
 * Web pages in the browser: what the server's /api/page routes return (server/page.ts), kept per
 * address so a pane, the column's page and a node's inset showing one page share one request. In
 * the manner of wiki.ts: nothing blocks; a view asks for a page and draws whatever state it is in
 * (loading, ready, not shown and why), and is told to draw again when that changes.
 *
 * Only a page the reader opens is asked for. An inset folded under a section, and a link's card,
 * ask the server's cache alone (summary &cached=1), which never reads the site. The page's HTML
 * arrives sanitised and is cleaned again where it is drawn (wiki.ts articleText, with `web` set).
 * Two actions the reader takes on a page replace what is kept here: Reload (read it again) and
 * Arrange (a model's summary, and sections for a page divided only by length).
 */
import type { WebArticle, WebSection, WebSummary, WebUnusable } from "../../server/page";
import { normUrl } from "../llm/web";

export type { WebArticle, WebSection, WebSummary, WebUnusable };

/** Why a page is not shown: the server's reason and its words, with what it knew of the page. */
export type WebProblem = Pick<WebUnusable, "message" | "title" | "description" | "site"> & { reason: WebUnusable["reason"] | "uncached" };

type Loadable<T> = { state: "loading" } | { state: "ready"; value: T; cached: boolean } | ({ state: "failed"; at: number } & WebProblem);

/** A failure that may pass (the site down, the server unreachable) is asked again after this long. */
const RETRY_MS = 20_000;
/** Reasons that stand for this page load: the site answered, and answered no (the server keeps them a day). */
const LASTING = new Set<WebProblem["reason"]>(["robots", "refused", "type", "empty", "too-large", "off", "uncached"]);

/** What the server said about web pages when the page loaded (EX_PAGES). */
export interface PagesConfig {
  mode: "live" | "mock" | "off";
  /** Whether a model may arrange a page here (a model, and EX_PAGES_ARRANGE not off). */
  arrange?: boolean;
}

let config: PagesConfig = { mode: "live" };
let onChange: () => void = () => {};

export function configurePages(c: Partial<PagesConfig> | undefined, changed: () => void) {
  if (c) config = { ...config, ...c };
  onChange = changed;
}

const articles = new Map<string, Loadable<WebArticle>>();
const summaries = new Map<string, Loadable<WebSummary>>();

/** The words for each reason, where the server gave none. */
const PLAIN: Record<WebProblem["reason"], string> = {
  robots: "The site asks programs like this one not to read this page.",
  refused: "The site refused to let this program read the page.",
  type: "This address is not a web page that can be shown here.",
  empty: "The page has too little text to show here.",
  "too-large": "The page is too large to read here.",
  offline: "The site could not be reached. It is tried again in a little while.",
  error: "The page could not be read.",
  off: "Reading web pages is turned off on this server (EX_PAGES=off).",
  uncached: "This page has not been read yet.",
};

async function get<T>(path: string, field: string): Promise<{ ok: true; value: T; cached: boolean } | ({ ok: false } & WebProblem)> {
  if (config.mode === "off") return { ok: false, reason: "off", message: PLAIN.off };
  try {
    const res = await fetch(path);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && body.ok) return { ok: true, value: body[field] as T, cached: !!body.cached };
    const reason = (typeof body.reason === "string" && body.reason in PLAIN ? body.reason : "error") as WebProblem["reason"];
    const str = (k: string) => (typeof body[k] === "string" && body[k] ? { [k]: body[k] as string } : {});
    return { ok: false, reason, message: typeof body.message === "string" && body.message ? body.message : res.status === 400 ? "This is not an address that can be read." : PLAIN[reason], ...str("title"), ...str("description"), ...str("site") };
  } catch {
    return { ok: false, reason: "offline", message: "The local server could not be reached." };
  }
}

function load<T>(cache: Map<string, Loadable<T>>, key: string, path: string, field: string): Loadable<T> {
  const have = cache.get(key);
  if (have && (have.state !== "failed" || LASTING.has(have.reason) || Date.now() - have.at < RETRY_MS)) return have;
  cache.set(key, { state: "loading" });
  void get<T>(path, field).then((r) => {
    cache.set(key, r.ok ? { state: "ready", value: r.value, cached: r.cached } : { state: "failed", at: Date.now(), ...stripOk(r) });
    onChange();
  });
  return cache.get(key)!;
}

const stripOk = <P extends { ok: false }>({ ok: _, ...rest }: P) => rest;

/** A page as a lead and sections: read once by the server, kept in its cache until Reload. */
export function article(url: string): Loadable<WebArticle> {
  return load(articles, normUrl(url), `/api/page/article?url=${encodeURIComponent(url)}`, "article");
}

/** A page as far as it has been asked for, without asking for it. */
export const knownArticle = (url: string): Loadable<WebArticle> | undefined => articles.get(normUrl(url));

/** A page's title, site, author and first sentence, from the server's cache only: never a request to the site. */
export function cachedSummary(url: string): Loadable<WebSummary> {
  const a = articles.get(normUrl(url));
  if (a?.state === "ready") return { state: "ready", value: summaryOf(a.value), cached: true };
  return load(summaries, normUrl(url), `/api/page/summary?url=${encodeURIComponent(url)}&cached=1`, "summary");
}

function summaryOf(a: WebArticle): WebSummary {
  const at = a.attribution;
  return { url: a.url, requested: a.requested, title: a.title, site: at.site, author: at.author, published: at.published, description: a.description, sentence: firstSentence(a.lead || a.sections[0]?.html || "") };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

/** The first sentence of some HTML's text, at most 300 characters, as the server's summary gives it (shown as text, never as HTML). */
export function firstSentence(html: string): string {
  const text = html
    .replace(/<figure[\s\S]*?<\/figure>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e])
    .replace(/\s+/g, " ")
    .trim();
  const m = /^.+?[.!?](?=\s+["“'(\p{Lu}\d]|$)/u.exec(text);
  const s = m ? m[0] : text;
  return s.length > 300 ? `${s.slice(0, 299).replace(/\s+\S*$/, "")}…` : s;
}

// ---- what the reader does to a page ----

/** What an action on a page came to: the page as it now is, or why not, in words. */
export type Acted<X = object> = ({ ok: true; article: WebArticle } & X) | { ok: false; reason: string; message: string };

async function post<X>(route: "reload" | "arrange", url: string): Promise<Acted<X>> {
  if (config.mode === "off") return { ok: false, reason: "off", message: PLAIN.off };
  try {
    const res = await fetch(`/api/page/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && body.ok && body.article) {
      articles.set(normUrl(url), { state: "ready", value: body.article as WebArticle, cached: false });
      summaries.delete(normUrl(url));
      return body as unknown as Acted<X>;
    }
    const reason = typeof body.reason === "string" ? body.reason : "error";
    const message = typeof body.message === "string" && body.message ? body.message : `The server answered ${res.status}.`;
    // A page that still cannot be shown: shown as such, with the new reason.
    if (route === "reload" && reason in PLAIN) articles.set(normUrl(url), { state: "failed", at: Date.now(), reason: reason as WebProblem["reason"], message, ...strs(body, "title", "description", "site") });
    return { ok: false, reason, message };
  } catch {
    return { ok: false, reason: "offline", message: "The local server could not be reached." };
  }
}

const strs = (body: Record<string, unknown>, ...ks: string[]) => Object.fromEntries(ks.filter((k) => typeof body[k] === "string" && body[k]).map((k) => [k, body[k] as string]));

/** Read a page again (R). `stale`: it no longer answers, and the last copy is kept (with why). */
export const reloadPage = (url: string) => post<{ stale?: string }>("reload", url);

/** Have a model summarise a page, and arrange one divided only by length into sections (s). Never reads the page again. */
export const arrangePage = (url: string) => post<{ called: boolean; arranged: "sections" | "summary"; note?: string }>("arrange", url);

/** How long the link picker waits for a page's title before linking without one. */
const TITLE_WAIT_MS = 2500;

/**
 * A page's own title, for the link picker's "Address": the reader has just chosen this page, so
 * the server reads it now (and keeps it, so opening it next is immediate). Null when it gives
 * none (only its host), cannot be read, or takes longer than `wait`.
 */
export async function pageTitle(url: string, wait = TITLE_WAIT_MS): Promise<string | null> {
  if (config.mode === "off") return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), wait);
  try {
    const res = await fetch(`/api/page/summary?url=${encodeURIComponent(url)}`, { signal: ac.signal });
    const body = (await res.json().catch(() => ({}))) as { summary?: { title?: unknown }; title?: unknown };
    const t = body.summary?.title ?? body.title;
    if (typeof t !== "string") return null;
    const title = t.replace(/\s+/g, " ").trim().slice(0, 300);
    return title && title !== siteOf(url) ? title : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether the server lets a model arrange pages. */
export const canArrange = () => config.arrange !== false;

/** What a pane showing a web page (or a section of one) goes by, as a key: `u:<address>`, `#<section>` after it. */
export const webKey = (url: string, sec?: string) => `u:${normUrl(url)}${sec ? `#${sec}` : ""}`;

/** The sections directly under one (null: the top level). */
export function sectionsUnder(a: WebArticle, parent: string | null): WebSection[] {
  return a.sections.filter((x) => x.parent === parent);
}

/** What a page goes by: its title once it has arrived, else its site. */
export function pageName(url: string): string {
  const a = article(url);
  return a.state === "ready" ? a.value.title : siteOf(url);
}

/** A page's host, as the head shows it: without "www.". */
export function siteOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An ISO date (or date and time) for reading: "9 Aug 2000", the day as the page wrote it (no time zone moves it); else as it came. */
export function readDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(iso.trim());
  if (!m || +m[2] < 1 || +m[2] > 12) return iso;
  return `${m[3] ? `${+m[3]} ` : ""}${MONTHS[+m[2] - 1]} ${m[1]}`;
}

/** The head's byline: author, site and date, only those the page gives. */
export function byline(a: { author?: string; site?: string; published?: string }): string {
  return [a.author, a.site, a.published && readDate(a.published)].filter(Boolean).join(" · ");
}

/** The footer's sentence: where the text is from, who wrote it, when it was read, and what was changed. */
export function attributionText(at: WebArticle["attribution"]): string {
  const parts = [`From “${at.title}”`];
  if (at.author) parts[0] += ` by ${at.author}`;
  parts[0] += `, ${at.site}`;
  if (at.published) parts[0] += `, published ${readDate(at.published)}`;
  const read = readDate(at.retrieved);
  const adapted = at.adapted.length ? ` Adapted: ${at.adapted.join("; ")}.` : "";
  return `${parts[0]}. ${at.stale ? `The page no longer answers; last read ${read}.` : `Read ${read}.`}${adapted}`;
}
