/**
 * A node's target: what it is about, elsewhere. A Wikipedia article, another node in the library,
 * or a web page. A note with a target and no body is a link; with a body it is a commentary on
 * something that also has an article. Targets are plain data in the node, so they replicate,
 * version, merge and undo like a title does.
 *
 * Also the one text form of a target, shared by the .md format, the command bar and the editor
 * agent's tools:
 *
 *   w:Fixed-point combinator          English Wikipedia (w.fr:Point fixe for another language)
 *   /fixed-points/Recursion/How Y works   a node, by document slug and section titles
 *   ./How Y works                     the same, inside the document it is written in
 *   /fixed-points/The idea ^"one repels them"   a note, by its section and its quote
 *   https://example.org/page "Title"  a web page, with an optional title
 *   "w:Star Wars: Episode IV"         any of them in quotes, when it contains ": "
 *
 * In a path, `\/`, `\^` and `\\` stand for a slash, a caret and a backslash inside a title.
 */
import type { NodeId } from "./model";

export type Ref =
  | { kind: "wiki"; title: string; lang: string; pageId?: number }
  /**
   * A node in the library. `id` is what counts; `doc` (a document's slug) and `path` (section
   * titles below the document, and a note's quote) let the link be found again when the id has
   * gone: undoing a delete re-creates nodes under new ids. A path with no `doc` is relative to the
   * document it is written in (only in a parsed file, before it is written into the library).
   */
  | { kind: "node"; id?: NodeId; doc?: string; path?: string[]; quote?: string }
  | { kind: "url"; url: string; title?: string };

const DEFAULT_LANG = "en";
const LANG = /^[a-z][a-z0-9-]{1,15}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** Characters MediaWiki never allows in a title. */
const ILLEGAL = /[#<>[\]|{}\u0000-\u001f\u007f]/;

export class RefError extends Error {}

/** How MediaWiki would spell a main-namespace title: spaces for underscores, first letter capital. */
export function wikiTitle(s: string): string {
  const t = s.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return t;
  const first = String.fromCodePoint(t.codePointAt(0)!);
  return first.toUpperCase() + t.slice(first.length);
}

/** Check a target from outside (an op, a file, a model) and return a clean copy. Throws RefError. */
export function validateRef(input: unknown): Ref {
  if (!input || typeof input !== "object") throw new RefError("a target must be an object");
  const r = input as Record<string, unknown>;
  const str = (v: unknown, name: string, max: number) => {
    if (typeof v !== "string") throw new RefError(`a target's ${name} must be a string`);
    if (v.length > max) throw new RefError(`a target's ${name} is longer than ${max} characters`);
    return v;
  };
  switch (r.kind) {
    case "wiki": {
      const title = wikiTitle(str(r.title, "title", 255));
      if (!title || ILLEGAL.test(title)) throw new RefError(`not a Wikipedia title: “${r.title}”`);
      const lang = r.lang === undefined ? DEFAULT_LANG : str(r.lang, "lang", 16);
      if (!LANG.test(lang)) throw new RefError(`not a Wikipedia language: ${lang}`);
      const out: Ref = { kind: "wiki", title, lang };
      if (r.pageId !== undefined) {
        if (!Number.isInteger(r.pageId) || (r.pageId as number) <= 0) throw new RefError("a page id must be a positive integer");
        out.pageId = r.pageId as number;
      }
      return out;
    }
    case "node": {
      const out: Ref = { kind: "node" };
      if (r.id !== undefined && r.id !== "") out.id = str(r.id, "id", 64) as NodeId;
      if (r.doc !== undefined) {
        const d = str(r.doc, "document", 64);
        if (!SLUG.test(d)) throw new RefError(`not a document slug: ${d}`);
        out.doc = d;
      }
      if (r.path !== undefined) {
        if (!Array.isArray(r.path) || r.path.length > 64) throw new RefError("a target's path must be a list of titles");
        out.path = r.path.map((t) => str(t, "path", 500));
      }
      if (r.quote !== undefined) out.quote = str(r.quote, "quote", 2000);
      if (!out.id && !out.path && !out.doc) throw new RefError("a node target needs an id or a path");
      return out;
    }
    case "url": {
      const url = str(r.url, "url", 2000).trim();
      let ok = false;
      try {
        ok = /^https?:$/.test(new URL(url).protocol) && /^https?:\/\//i.test(url);
      } catch {
        ok = false;
      }
      if (!ok) throw new RefError(`only http and https addresses can be linked: ${url}`);
      const out: Ref = { kind: "url", url };
      if (r.title !== undefined && r.title !== "") out.title = str(r.title, "title", 300).replace(/\s+/g, " ").trim();
      return out;
    }
    default:
      throw new RefError(`unknown kind of target: ${String(r.kind)}`);
  }
}

/** A canonical form, for hashing and comparing: the same target always gives the same value. */
export function canonRef(r: Ref): unknown[] {
  switch (r.kind) {
    case "wiki":
      return ["wiki", r.lang, r.title, r.pageId ?? null];
    case "node":
      return ["node", r.id ?? null, r.doc ?? null, r.path ?? null, r.quote ?? null];
    case "url":
      return ["url", r.url, r.title ?? null];
  }
}

/** Whether two targets name the same thing (a node by its id when both have one; a fallback hint does not count). */
export function sameTarget(a: Ref | undefined, b: Ref | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return !a && !b;
  if (a.kind === "wiki" && b.kind === "wiki") return a.lang === b.lang && a.title === b.title;
  if (a.kind === "url" && b.kind === "url") return a.url === b.url;
  if (a.kind === "node" && b.kind === "node") {
    if (a.id || b.id) return a.id === b.id;
    return a.doc === b.doc && JSON.stringify(a.path ?? []) === JSON.stringify(b.path ?? []) && (a.quote ?? "") === (b.quote ?? "");
  }
  return false;
}

/** The key a Wikipedia target is filed under. */
export const wikiKey = (lang: string, title: string) => `${lang}:${wikiTitle(title)}`;

// ---- the text form ----

const escapeSeg = (s: string) => s.replace(/[\\/^]/g, (c) => "\\" + c);

/** A string in quotes, with `\\`, `\"` and `\n` escaped: how the text form writes quotes, titles and lenses. */
export const quoteStr = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

/** Read a "quoted" string at s[i] === '"': the text and the index after the closing quote. */
export function readQuoted(s: string, i: number): [string, number] | null {
  let out = "";
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '"') return [out, j + 1];
    if (c === "\\" && j + 1 < s.length) {
      const n = s[j + 1];
      if (n === '"' || n === "\\") (out += n), j++;
      else if (n === "n") (out += "\n"), j++;
      else out += c;
    } else out += c;
  }
  return null;
}

/**
 * A target in the text form. A node target is written from its `doc` and `path`, so refresh them
 * first (`nodeRef` in links.ts); `here` is the slug of the document it is written in, which makes
 * a path inside that document relative.
 */
export function formatTarget(r: Ref, here?: string): string {
  let s: string;
  if (r.kind === "wiki") s = `${r.lang === DEFAULT_LANG ? "w" : `w.${r.lang}`}:${r.title}`;
  else if (r.kind === "url") return r.url + (r.title ? " " + quoteStr(r.title) : "");
  else {
    const segs = (r.path ?? []).map(escapeSeg).join("/");
    const head = !r.doc || r.doc === here ? "." : `/${r.doc}`;
    s = `${head}${segs || head === "." ? "/" : ""}${segs}`;
    if (r.quote !== undefined) s += ` ^${quoteStr(r.quote)}`;
  }
  // Unquoted, a target ends at ": " (where a note's text begins), so one that contains that is quoted.
  return /:(\s|$)/.test(s) || s.startsWith('"') ? quoteStr(s) : s;
}

const PREFIX = /^(w(?:\.[a-z][a-z0-9-]{1,15})?:|\.?\/|https?:\/\/)/i;

/** Whether text at this point would be read as a target (used to tell `-> target` from prose). */
export const looksLikeTarget = (s: string) => PREFIX.test(s) || (s.startsWith('"') && PREFIX.test(s.slice(1)));

/** Where an unquoted wiki title or path ends: at ": ", or a ":" that ends the text. Inside quotes, at the end. */
function stopAt(s: string, i: number, whole: boolean): number {
  if (whole) return s.length;
  for (let j = i; j < s.length; j++) if (s[j] === ":" && (j + 1 === s.length || /\s/.test(s[j + 1]))) return j;
  return s.length;
}

function parsePath(text: string): Ref | string {
  let rest = text;
  let quote: string | undefined;
  const caret = /(?:^|[^\\])\s\^"/.exec(rest);
  if (caret) {
    const at = rest.indexOf('^"', caret.index);
    const q = readQuoted(rest, at + 1);
    if (!q || rest.slice(q[1]).trim()) return "the quote after ^ is not closed";
    quote = q[0];
    rest = rest.slice(0, at).trimEnd();
  }
  const relative = rest.startsWith("./") || rest === ".";
  const body = relative ? rest.slice(2) : rest.slice(1);
  const segs: string[] = [];
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\" && i + 1 < body.length) cur += body[++i];
    else if (c === "/") segs.push(cur), (cur = "");
    else cur += c;
  }
  if (cur || body.endsWith("/")) segs.push(cur);
  if (relative) return { kind: "node", path: segs, ...(quote !== undefined ? { quote } : {}) };
  const [doc, ...path] = segs;
  if (!doc || !SLUG.test(doc)) return `not a document slug: “${doc ?? ""}”`;
  return { kind: "node", doc, path, ...(quote !== undefined ? { quote } : {}) };
}

/** Read the target that starts at s[i]. Returns it and where it ended, or why it is not one. */
export function readTarget(s: string, i: number, whole = false): { ref: Ref; end: number } | string {
  if (s[i] === '"' && !whole) {
    const q = readQuoted(s, i);
    if (!q) return "the target's quote is not closed";
    const inner = readTarget(q[0], 0, true);
    if (typeof inner === "string") return inner;
    if (inner.end !== q[0].length) return `unexpected text in the target: “${q[0].slice(inner.end)}”`;
    return { ref: inner.ref, end: q[1] };
  }
  const tail = s.slice(i);
  const wiki = /^w(?:\.([a-z][a-z0-9-]{1,15}))?:/i.exec(tail);
  try {
    if (wiki) {
      const end = stopAt(s, i + wiki[0].length, whole);
      return { ref: validateRef({ kind: "wiki", lang: wiki[1]?.toLowerCase() ?? DEFAULT_LANG, title: s.slice(i + wiki[0].length, end) }), end };
    }
    if (/^https?:\/\//i.test(tail)) {
      let end = i + (/^\S+/.exec(tail)?.[0].length ?? 0);
      if (s[end - 1] === ":" && (end === s.length || /\s/.test(s[end]))) end--;
      const url = s.slice(i, end);
      const t = /^\s+"/.exec(s.slice(end));
      if (t) {
        const q = readQuoted(s, end + t[0].length - 1);
        if (!q) return "the link's title is not closed";
        return { ref: validateRef({ kind: "url", url, title: q[0] }), end: q[1] };
      }
      return { ref: validateRef({ kind: "url", url }), end };
    }
    if (tail.startsWith("/") || tail.startsWith("./") || tail === ".") {
      const end = stopAt(s, i, whole);
      const ref = parsePath(s.slice(i, end).trimEnd());
      if (typeof ref === "string") return ref;
      return { ref: validateRef(ref), end };
    }
  } catch (err) {
    if (err instanceof RefError) return err.message;
    throw err;
  }
  return "a target is w:Title, /document/Section, ./Section or an http(s) address";
}

/** A whole string as a target, or why it is not one. */
export function parseTarget(text: string): Ref | string {
  const s = text.trim();
  const r = readTarget(s, 0);
  if (typeof r === "string") return r;
  if (s.slice(r.end).trim()) return `unexpected text after the target: “${s.slice(r.end).trim()}”`;
  return r.ref;
}

/** What a person types: a target in the text form, or else a Wikipedia title. */
export function parseTargetLoose(text: string): Ref | string {
  const s = text.trim();
  if (!s) return "give a target: w:Title, /document/Section or an address";
  if (looksLikeTarget(s)) return parseTarget(s);
  try {
    return validateRef({ kind: "wiki", title: s, lang: DEFAULT_LANG });
  } catch (err) {
    return (err as Error).message;
  }
}

/** A one-line description, for lists and messages. */
export function describeTarget(r: Ref): string {
  if (r.kind === "wiki") return `Wikipedia: ${r.title}${r.lang === DEFAULT_LANG ? "" : ` (${r.lang})`}`;
  if (r.kind === "url") return r.title ? `${r.title} (${hostOf(r.url)})` : r.url;
  return [r.doc, ...(r.path ?? [])].filter(Boolean).join(" › ") || "a node";
}

/** A page's site, for showing: its host without "www.". */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
