/**
 * Wikipedia in the browser: what the server's /api/wiki routes return, kept per title so a pane,
 * a popup and an inset showing the same article share one request. Nothing here blocks: a view
 * asks for an article and draws whatever state it is in (loading, ready, missing, unreachable…),
 * and is told to draw again when that changes.
 *
 * Article HTML arrives sanitised by the server (server/wiki.ts). It is cleaned again here before it
 * is put into the page, because it came from outside: only an allowlist of elements and
 * attributes survives, and every link either names an article (data-wiki) or opens a new tab.
 */
import type { Attribution, FullArticle as Article, Sense, Summary, TitleSuggestion as Suggestion } from "../../server/wiki";
import type { SectionText } from "../core/article";
import { wikiKey, wikiTitle } from "../core/ref";
import { buildText, type ArticleText } from "./articleText";

export type { Article, Attribution, Suggestion };
type WikiSection = Article["sections"][number];

/** Why something could not be shown, in words a reader can act on. */
type Problem = { reason: "missing" | "offline" | "rate-limited" | "off" | "error"; message: string };

type Loadable<T> = { state: "loading" } | { state: "ready"; value: T; stale?: boolean } | ({ state: "failed"; at: number } & Problem);

/** A failure other than "missing" is asked again after this long, not on every redraw. */
const RETRY_MS = 20_000;

/** What the server said about Wikipedia when the page loaded. */
export interface WikiConfig {
  mode: "live" | "mock" | "off";
  lang: string;
  contact: boolean;
}

let config: WikiConfig = { mode: "live", lang: "en", contact: false };
let onChange: () => void = () => {};
/** Told once, the first time a request is slow or refused, if no contact is configured. */
let onSlow: (() => void) | null = null;

export function configureWiki(c: Partial<WikiConfig> | undefined, changed: () => void, slow: () => void) {
  if (c) config = { ...config, ...c };
  onChange = changed;
  onSlow = slow;
}
export const wikiConfig = () => config;

const summaries = new Map<string, Loadable<Summary>>();
const articles = new Map<string, Loadable<Article>>();
const senses = new Map<string, Loadable<Sense[]>>();

/** How long a request may take before the reader is told why Wikipedia is slow. */
const SLOW_MS = 2000;

async function get<T>(path: string, key: string, signal?: AbortSignal): Promise<{ ok: true; value: T; stale?: boolean } | ({ ok: false } & Problem)> {
  if (config.mode === "off") return { ok: false, reason: "off", message: "Wikipedia is turned off on this server (EX_WIKI=off)." };
  const slow = setTimeout(() => slowOnce(), SLOW_MS);
  try {
    const res = await fetch(path, { signal });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && body.ok) return { ok: true, value: body[key] as T, stale: !!body.stale };
    const reason = String(body.reason ?? "");
    if (reason === "rate-limited") slowOnce();
    if (res.status === 404 || reason === "missing") return { ok: false, reason: "missing", message: String(body.message ?? "There is no such article.") };
    if (reason === "off") return { ok: false, reason: "off", message: String(body.message ?? "Wikipedia is turned off on this server.") };
    if (reason === "offline") return { ok: false, reason: "offline", message: "Wikipedia could not be reached. It is tried again in a little while." };
    if (reason === "rate-limited") return { ok: false, reason: "rate-limited", message: "Wikipedia asked for fewer requests; try again in a minute." };
    return { ok: false, reason: "error", message: String(body.message ?? `The server answered ${res.status}.`) };
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    return { ok: false, reason: "offline", message: "The local server could not be reached." };
  } finally {
    clearTimeout(slow);
  }
}

function slowOnce() {
  // The mock has no contact either, and a slow fixture, so the hint can be tested without the network.
  if (config.contact || config.mode === "off" || !onSlow) return;
  const fn = onSlow;
  onSlow = null;
  fn();
}

function load<T>(cache: Map<string, Loadable<T>>, key: string, path: string, field: string): Loadable<T> {
  const have = cache.get(key);
  if (have && (have.state !== "failed" || have.reason === "missing" || have.reason === "off" || Date.now() - have.at < RETRY_MS)) return have;
  cache.set(key, { state: "loading" });
  void get<T>(path, field).then((r) => {
    cache.set(key, r.ok ? { state: "ready", value: r.value, stale: r.stale } : { state: "failed", at: Date.now(), reason: r.reason, message: r.message });
    onChange();
  });
  return cache.get(key)!;
}

const q = (title: string, extra = "") => `title=${encodeURIComponent(title)}${extra}`;

/** An article's summary: the extract, its description, whether it is a disambiguation page. */
export function summary(title: string, lang = config.lang): Loadable<Summary> {
  return load(summaries, wikiKey(lang, title), `/api/wiki/summary?${q(wikiTitle(title))}`, "summary");
}

/** The whole article in one request: the lead and every section, each sanitised. */
export function article(title: string, lang = config.lang): Loadable<Article> {
  return load(articles, wikiKey(lang, title), `/api/wiki/article?${q(wikiTitle(title), "&full=1")}`, "article");
}

/** The articles a disambiguation page lists. */
export function sensesOf(title: string, lang = config.lang): Loadable<Sense[]> {
  return load(senses, wikiKey(lang, title), `/api/wiki/senses?${q(wikiTitle(title))}`, "senses");
}

/** An article's summary if it is here already, without asking for anything. */
export function known(title: string, lang = config.lang): Summary | undefined {
  const s = summaries.get(wikiKey(lang, title));
  return s?.state === "ready" ? s.value : undefined;
}

/**
 * The summary only if the server has it cached, within a short wait: grounding for a model prompt,
 * which must never wait on Wikipedia.
 */
export async function cachedExtract(title: string, ms = 300): Promise<{ title: string; extract: string } | null> {
  const have = known(title);
  if (have?.extract) return { title: have.title, extract: have.extract };
  if (config.mode === "off") return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(`/api/wiki/summary?${q(wikiTitle(title), "&cached=1")}`, { signal: ac.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { summary?: Summary };
    return body.summary?.extract ? { title: body.summary.title, extract: body.summary.extract } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Title suggestions for the link picker. The caller aborts a superseded request, which the server then never sends. */
export async function suggest(text: string, signal: AbortSignal): Promise<Suggestion[] | Problem> {
  const r = await get<Suggestion[]>(`/api/wiki/suggest?q=${encodeURIComponent(text.slice(0, 200))}&limit=6`, "suggestions", signal);
  return r.ok ? r.value : { reason: r.reason, message: r.message };
}

// ---- untrusted HTML ----

const KEEP = new Set([
  "p", "br", "hr", "b", "strong", "i", "em", "u", "s", "sub", "sup", "code", "kbd", "var", "samp", "small", "blockquote",
  "q", "ul", "ol", "li", "dl", "dt", "dd", "pre", "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "abbr",
  "bdi", "mark", "a", "math", "semantics", "mrow", "mi", "mo", "mn", "ms", "mtext", "mspace", "msub", "msup", "msubsup",
  "mfrac", "msqrt", "mroot", "mover", "munder", "munderover", "mtable", "mtr", "mtd", "mstyle", "mpadded", "mphantom",
  "menclose", "merror", "mmultiscripts", "mprescripts", "none",
]);
const ATTRS = new Set(["colspan", "rowspan", "start", "data-wiki", "data-wiki-fragment", "data-wiki-anchor", "display", "mathvariant", "stretchy", "displaystyle", "scriptlevel", "fence", "separator", "accent", "accentunder", "lspace", "rspace", "linethickness", "columnalign", "rowalign", "notation", "largeop", "movablelimits", "symmetric", "minsize", "maxsize", "width", "height", "depth", "alttext"]);
/** Elements whose content goes with them. */
const DROP = new Set(["script", "style", "iframe", "object", "embed", "svg", "link", "meta", "base", "form", "template", "noscript", "video", "audio", "img", "picture", "figure", "source", "canvas", "title", "head", "input", "button", "select", "textarea"]);

/**
 * Clean article HTML once more, in an inert document (DOMParser runs no script and loads nothing):
 * allowlisted elements and attributes only, wiki links kept as data-wiki, other links only if
 * http(s) and then in a new tab without an opener.
 */
function cleanHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const walk = (el: Element) => {
    for (const child of [...el.children]) {
      const tag = child.localName;
      if (DROP.has(tag)) {
        child.remove();
        continue;
      }
      walk(child);
      if (!KEEP.has(tag)) {
        child.replaceWith(...child.childNodes);
        continue;
      }
      const href = tag === "a" ? child.getAttribute("href") : null;
      for (const a of [...child.attributes]) if (!ATTRS.has(a.name)) child.removeAttribute(a.name);
      if (tag === "a") {
        if (child.hasAttribute("data-wiki")) child.setAttribute("href", `https://${config.lang}.wikipedia.org/wiki/${encodeURIComponent(child.getAttribute("data-wiki")!.replace(/ /g, "_"))}`);
        else if (href && /^https?:\/\//i.test(href)) {
          child.setAttribute("href", href);
          child.setAttribute("target", "_blank");
          child.setAttribute("rel", "noopener noreferrer nofollow");
        }
      }
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

/** A piece of article HTML as text to select in (articleText.ts). Remembered per string. */
const texts = new Map<string, ArticleText>();
export function articleText(html: string): ArticleText {
  let out = texts.get(html);
  if (out) return out;
  out = buildText(new DOMParser().parseFromString(`<body>${cleanHtml(html)}</body>`, "text/html").body);
  if (texts.size > 400) texts.delete(texts.keys().next().value as string);
  texts.set(html, out);
  return out;
}

/** The headings down to a section (0: the lead, []): how an annotation names where it is. */
export function sectionPath(a: Article, id: number): string[] {
  const out: string[] = [];
  for (let s = a.sections.find((x) => x.id === id); s; s = a.sections.find((x) => x.id === s!.parent)) out.unshift(s.heading);
  return out;
}

/** Every section's text with its headings, the lead first: what annotations are found again in. Remembered per article. */
const sectionLists = new WeakMap<Article, { ids: number[]; secs: SectionText[] }>();
export function sectionTexts(a: Article): { ids: number[]; secs: SectionText[] } {
  let out = sectionLists.get(a);
  if (!out) {
    out = { ids: [0, ...a.sections.map((s) => s.id)], secs: [{ path: [], text: articleText(a.lead).text }, ...a.sections.map((s) => ({ path: sectionPath(a, s.id), text: articleText(s.html).text }))] };
    sectionLists.set(a, out);
  }
  return out;
}

/** The address of a past revision of an article. */
export const revisionUrl = (title: string, rev: number, lang = config.lang) => `https://${lang}.wikipedia.org/w/index.php?title=${encodeURIComponent(wikiTitle(title).replace(/ /g, "_"))}&oldid=${rev}`;

/**
 * The sections under one (0: the top level) that have something to show: the sanitiser empties
 * Notes and References, and a row that opens onto nothing is noise.
 */
export function sectionsUnder(a: Article, parent: number): WikiSection[] {
  return a.sections.filter((x) => x.parent === parent && (x.html.trim() !== "" || a.sections.some((y) => y.parent === x.id)));
}

/** The address of an article on Wikipedia itself. */
export const wikiUrl = (title: string, lang = config.lang) => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(wikiTitle(title).replace(/ /g, "_"))}`;
