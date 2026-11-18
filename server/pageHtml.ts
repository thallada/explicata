/**
 * A web page's HTML read the way a Wikipedia article is: its metadata, the part that is the text,
 * that text as a list of units (paragraphs, lists, tables, code, figures, quotations, headings),
 * a lead, and sections that open on their own. Used by server/page.ts; docs/pages.md says why
 * each rule is what it is.
 *
 *   1. Metadata: title, site, author, date, description, canonical address, each from the first
 *      source that has it (Open Graph, JSON-LD, <meta>, then the page itself). Absent means absent:
 *      nothing is guessed from layout or from Last-Modified.
 *   2. The container: the largest <article>, else <main>, else <body>, without navigation, asides,
 *      headers, footers, forms, and blocks named for comments, sharing, related posts, sidebars or
 *      newsletters.
 *   3. Units: the container flattened, runs of <br><br> made into paragraphs, images lifted out of
 *      paragraphs into figures of their own, layout tables walked through. A <video> with an https
 *      source, and a YouTube or Vimeo player, is a video: the click-to-play facade of
 *      src/core/video.ts, its still (a poster, YouTube's thumbnail) through /api/page/media. Any
 *      other iframe or embed is a link to it ("Embedded content from <host> ↗").
 *   4. Sections, from the first rule that fits: headings (h1, h2…), paragraphs that are only a
 *      numeral or only bold (p1, p2…), parts of about 600 words (c1, c2…), or none under 600 words.
 *      Every unit appears once, in order, in the lead or one section; headings become titles.
 *      Sections named like "See also" or "Comments" are dropped, and listed as dropped.
 *
 * Emitted with the allowlist emitter of server/wikiHtml.ts under `webPolicy`: links leave in a new
 * tab (Wikipedia links become data-wiki links), images go through /api/page/media.
 */
import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterTypes as T } from "parse5";
import type { WebSection } from "./page";
import { embedOf, youtubeStill, type Embed } from "../src/core/video";
import { DROP_TAGS, attr, classes, escapeText, isEl, open, render, textOf, tidy, videoFacade, wikiLink, type HtmlPolicy } from "./wikiHtml";

type Node = T.ChildNode;
type El = T.Element;
const HTML_NS = "http://www.w3.org/1999/xhtml";

/** What the page says about itself. */
export interface PageMeta {
  title?: string;
  site?: string;
  author?: string;
  /** ISO 8601, as the page gave it (a date, or a date and time). */
  published?: string;
  description?: string;
  canonical?: string;
}

export type Outline = "headings" | "pseudo" | "chunks" | "none";

export interface Unit {
  kind: "p" | "list" | "table" | "pre" | "figure" | "blockquote" | "heading" | "embed" | "video";
  /** h1…h6 for a heading. */
  level?: number;
  node: El;
  /** Its text, whitespace collapsed (a figure's or a video's is its caption). */
  text: string;
  words: number;
}

/**
 * One unit as kept in a snapshot, for arranging the page with a model: its kind, the opening of its
 * text, and (only in an outline a model may replace, parts by length) its HTML, so that new
 * sections can be made of the same units without reading the page again.
 */
export interface PageUnit {
  kind: Unit["kind"];
  /** Its text, at most UNIT_TEXT characters. */
  text: string;
  html?: string;
}
/** The most of a unit's text a snapshot keeps for arranging: more than a model is ever sent of it. */
const UNIT_TEXT = 400;

/** Where each unit went, by index into `units`: the check that nothing is lost or repeated. */
export interface Plan {
  units: Unit[];
  /** The h1 taken as the page's own title, if any. */
  title: number | null;
  lead: number[];
  sections: { id: string; heading: number | null; body: number[] }[];
  dropped: number[];
}

export type Extraction =
  | {
      ok: true;
      meta: PageMeta & { title: string; site: string };
      lead: string;
      leadFrom: "intro" | "page-description" | "none";
      sections: WebSection[];
      outline: Outline;
      words: number;
      hash: string;
      /** Every image address the html shows, videos' stills included (the media route serves only these). */
      media: string[];
      /** Headings of the sections left out as junk. */
      dropped: string[];
      /** The units of the lead and the sections, in reading order, for a model to arrange (server/pageArrange.ts). */
      units: PageUnit[];
      /** How many of `units` are the lead's. */
      leadUnits: number;
      plan: Plan;
    }
  | { ok: false; reason: "refused" | "empty"; message: string; meta: PageMeta & { title: string; site: string }; words: number };

// ---- thresholds ----

const ARTICLE_MIN_WORDS = 50;
/** Under this many words in the container a page is not shown (JS shells, stubs, landing pages). */
const MIN_WORDS = 150;
const SECTION_MIN_WORDS = 40;
const MIN_SECTIONS = 3;
const MIN_COVER = 0.5;
const LEAD_MIN_WORDS = 40;
const CHUNK_WORDS = 600;
const CHUNK_TITLE_WORDS = 8;
/** A line this short before a page's first paragraph is a title or a date, not text. */
const SHORT_LINE = 15;
const PSEUDO_MAX_CHARS = 80;
const SRCSET_MAX_W = 1600;
const MAX_LINK = 2000;

/** `<title>`s that are a bot check, not the page. Matched exactly, and only on the title. */
const CHALLENGE_TITLES = new Set(["just a moment...", "client challenge"]);

/**
 * Junk sections, by heading: lower case, punctuation and numbers gone ("12 Comments" is
 * "comments"), then matched whole, so "Notes on the design" is not junk.
 */
const JUNK_HEADINGS = new Set([
  "see also", "voir aussi", "references", "références", "notes", "notes and references", "references and notes",
  "notes et références", "références et notes", "footnotes", "comments", "commentaires", "responses", "leave a reply",
  "leave a comment", "related", "related posts", "related articles", "related stories", "read more", "lire aussi", "subscribe",
  "subscribe to our newsletter", "share", "share this", "share this post", "share this article", "partager", "contents",
  "table of contents", "sommaire", "in this article", "dans cet article", "external links", "liens externes",
  "further reading", "bibliography", "bibliographie",
]);

const REMOVE_TAGS = new Set(["nav", "aside", "header", "footer", "form", "dialog", "menu"]);
const REMOVE_ROLES = new Set(["navigation", "complementary", "banner", "contentinfo", "search", "dialog"]);
/** Class or id tokens that name junk blocks. */
const JUNK_NAME = /(^|[-_])(comments?|share|sharing|sharedaddy|related|sidebar|newsletter)([-_]|$)/i;

const PHRASING = new Set([
  "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "dfn", "em", "font", "i", "img", "kbd", "mark", "q", "s", "samp",
  "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr", "picture", "label", "del", "ins", "math", "big", "tt",
  "strike", "nobr", "acronym",
]);
const EMBEDS = new Set(["iframe", "video"]);

// ---- tree helpers ----

const words = (s: string) => (s.match(/\S+/g) ?? []).length;
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const tagOf = (n: Node) => (isEl(n) ? n.tagName.toLowerCase() : "");

function* walkEls(n: Node | T.Document | T.DocumentFragment): Generator<El> {
  for (const c of (n as { childNodes?: Node[] }).childNodes ?? []) {
    if (!isEl(c)) continue;
    yield c;
    // <template> content lives apart in parse5 and is never shown.
    yield* walkEls(c);
  }
}
const findEl = (n: Node | T.Document, test: (e: El) => boolean) => {
  for (const e of walkEls(n)) if (test(e)) return e;
  return null;
};

function el(tag: string, children: Node[]): El {
  return { nodeName: tag, tagName: tag, attrs: [], namespaceURI: HTML_NS, childNodes: children, parentNode: null } as unknown as El;
}

function detach(n: Node) {
  const parent = n.parentNode as { childNodes: Node[] } | null;
  if (!parent) return;
  const i = parent.childNodes.indexOf(n);
  if (i >= 0) parent.childNodes.splice(i, 1);
}

// ---- 1. metadata ----

function isoDate(raw: string | undefined): string | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  const iso = /^(\d{4}-\d{2}-\d{2})(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?/.exec(s);
  if (iso && !Number.isNaN(Date.parse(iso[1]))) return iso[0];
  const slash = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (slash) return `${slash[1]}-${slash[2].padStart(2, "0")}-${slash[3].padStart(2, "0")}`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

const ARTICLE_TYPES = new Set(["Article", "NewsArticle", "BlogPosting"]);

/** Every object in a JSON-LD value: arrays and @graph flattened. */
function ldObjects(v: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(v)) for (const x of v) ldObjects(x, out);
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    out.push(o);
    if (o["@graph"]) ldObjects(o["@graph"], out);
  }
  return out;
}
const types = (o: Record<string, unknown>) => (Array.isArray(o["@type"]) ? o["@type"] : [o["@type"]]).map(String);

/** JSON-LD: the article object's author (people only, joined), date and description. */
function readJsonLd(doc: T.Document): { author?: string; published?: string; description?: string } {
  const all: Record<string, unknown>[] = [];
  for (const s of walkEls(doc)) {
    if (s.tagName !== "script" || (attr(s, "type") ?? "").toLowerCase() !== "application/ld+json") continue;
    const raw = s.childNodes.map((c) => (c as T.TextNode).value ?? "").join("");
    try {
      ldObjects(JSON.parse(raw), all);
    } catch {
      // A broken block is skipped; others may still parse.
    }
  }
  const byId = new Map(all.filter((o) => typeof o["@id"] === "string").map((o) => [o["@id"] as string, o]));
  const article = all.find((o) => types(o).some((t) => ARTICLE_TYPES.has(t)));
  if (!article) return {};
  const names: string[] = [];
  for (let a of ldObjects(article.author ?? [])) {
    if (typeof a["@id"] === "string" && !a.name && byId.has(a["@id"])) a = byId.get(a["@id"])!;
    const t = types(a);
    if (typeof a.name === "string" && a.name.trim() && (t.includes("Person") || t.every((x) => x === "undefined"))) names.push(squash(a.name));
  }
  if (typeof article.author === "string" && article.author.trim()) names.push(squash(article.author));
  return {
    ...(names.length ? { author: [...new Set(names)].join(", ") } : {}),
    ...(typeof article.datePublished === "string" ? { published: article.datePublished } : {}),
    ...(typeof article.description === "string" && article.description.trim() ? { description: squash(article.description) } : {}),
  };
}

function readMeta(doc: T.Document, base: string): PageMeta & { titleTag?: string } {
  const metas = new Map<string, string[]>();
  let canonical: string | undefined;
  let titleTag: string | undefined;
  for (const e of walkEls(doc)) {
    if (e.tagName === "meta") {
      const key = (attr(e, "property") ?? attr(e, "name") ?? "").trim().toLowerCase();
      const content = attr(e, "content");
      if (key && content?.trim()) metas.set(key, [...(metas.get(key) ?? []), squash(content)]);
    } else if (e.tagName === "link" && !canonical && (attr(e, "rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")) {
      canonical = httpUrl(attr(e, "href"), base);
    } else if (e.tagName === "title" && titleTag === undefined) {
      titleTag = squash(e.childNodes.map((c) => (c as T.TextNode).value ?? "").join(""));
    }
  }
  const one = (k: string) => metas.get(k)?.[0];
  const ld = readJsonLd(doc);
  const h1 = findEl(doc, (e) => e.tagName === "h1");
  const authors = metas.get("citation_author");
  return {
    title: one("og:title") || titleTag || (h1 ? squash(textOf(h1)) : undefined) || undefined,
    titleTag,
    site: one("og:site_name"),
    author: ld.author ?? one("author") ?? (authors ? [...new Set(authors)].join(", ") : undefined),
    published: isoDate(ld.published) ?? isoDate(one("article:published_time")) ?? isoDate(one("citation_date") ?? one("citation_publication_date")),
    description: one("og:description") ?? one("description") ?? ld.description,
    canonical,
  };
}

/** A byline inside the container: rel=author, .author .fn, itemprop=author. */
function bylineIn(container: El): string | undefined {
  const tidyName = (s: string) => {
    const t = squash(s).replace(/^by\s+/i, "");
    return t && t.length <= 100 ? t : undefined;
  };
  for (const e of walkEls(container)) {
    if ((attr(e, "rel") ?? "").toLowerCase().split(/\s+/).includes("author") && e.tagName !== "link") {
      const t = tidyName(textOf(e));
      if (t) return t;
    }
  }
  for (const e of walkEls(container)) {
    if (!classes(e).has("author")) continue;
    const fn = findEl(e, (x) => classes(x).has("fn"));
    const t = fn && tidyName(textOf(fn));
    if (t) return t;
  }
  for (const e of walkEls(container)) {
    if (attr(e, "itemprop") !== "author") continue;
    const name = findEl(e, (x) => attr(x, "itemprop") === "name");
    const t = tidyName(name ? (attr(name, "content") ?? textOf(name)) : (attr(e, "content") ?? textOf(e)));
    if (t) return t;
  }
  return undefined;
}

// ---- 2. the container ----

function chooseContainer(body: El): El {
  let best: El | null = null;
  let bestWords = ARTICLE_MIN_WORDS - 1;
  for (const e of walkEls(body)) {
    if (e.tagName !== "article") continue;
    const n = words(textOf(e));
    if (n > bestWords) (best = e), (bestWords = n);
  }
  return best ?? findEl(body, (e) => e.tagName === "main" || attr(e, "role") === "main") ?? body;
}

function hiddenEl(e: El): boolean {
  return e.attrs.some((a) => a.name === "hidden") || attr(e, "aria-hidden") === "true" || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attr(e, "style") ?? "");
}

/** Take navigation, asides, headers, footers, forms and junk-named blocks out of the container. */
function clean(container: El) {
  // A <form> holding a page's worth of text is the page (ASP.NET wraps everything in one): unwrap it.
  for (const f of [...walkEls(container)].filter((e) => e.tagName === "form")) {
    if (words(f.childNodes.map(textOf).join(" ")) < MIN_WORDS) continue;
    const parent = f.parentNode as El;
    parent.childNodes.splice(parent.childNodes.indexOf(f), 1, ...f.childNodes);
    for (const c of f.childNodes) (c as { parentNode: unknown }).parentNode = parent;
  }
  const total = Math.max(1, words(textOf(container)));
  const doomed: El[] = [];
  const visit = (n: El) => {
    for (const c of n.childNodes) {
      if (!isEl(c)) continue;
      const tag = c.tagName.toLowerCase();
      const named = [...classes(c), attr(c, "id") ?? ""].some((t) => t && JUNK_NAME.test(t));
      // A junk-looking name on a block holding most of the text is a layout ("has-sidebar"), not junk.
      if (named && words(textOf(c)) > total / 2) visit(c);
      else if (REMOVE_TAGS.has(tag) || REMOVE_ROLES.has(attr(c, "role") ?? "") || hiddenEl(c) || (DROP_TAGS.has(tag) && !EMBEDS.has(tag)) || named) doomed.push(c);
      // A video keeps its <source>s, which are read for its address and never shown.
      else if (!EMBEDS.has(tag)) visit(c);
    }
  };
  visit(container);
  for (const d of doomed) detach(d);
}

// ---- 3. units ----

const BLOCKISH = new Set([
  "p", "div", "ul", "ol", "dl", "li", "table", "pre", "blockquote", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "section",
  "article", "main", "address", "hr", "details", "center", "fieldset", "iframe", "video", "figcaption", "summary", "dd", "dt",
]);

function hasBlock(n: El): boolean {
  return n.childNodes.some((c) => isEl(c) && (BLOCKISH.has(c.tagName) || hasBlock(c)));
}

/** Two or more <br> with only whitespace between them, anywhere under `n`. */
function hasBrRun(n: El): boolean {
  let run = 0;
  for (const c of n.childNodes) {
    if (isEl(c) && c.tagName === "br") {
      if (++run >= 2) return true;
    } else if (c.nodeName === "#text" && !(c as T.TextNode).value.trim()) continue;
    else if (c.nodeName === "#comment") continue;
    else run = 0;
    if (isEl(c) && hasBrRun(c)) return true;
  }
  return false;
}

const isImage = (n: Node) => isEl(n) && (n.tagName === "img" || n.tagName === "picture");

/** Whether a <table> is for layout (walked through) rather than data (kept as a table). */
function layoutTable(t: El): boolean {
  if (attr(t, "role") === "presentation" || attr(t, "role") === "none") return true;
  for (const e of walkEls(t)) {
    if (e.tagName === "table" || /^(p|div|ul|ol|h[1-6]|blockquote|pre|figure|iframe)$/.test(e.tagName)) return true;
    if ((e.tagName === "td" || e.tagName === "th") && (words(textOf(e)) > 80 || hasBrRun(e))) return true;
  }
  return false;
}

/** The best address for an image, or null: src, data-src, data-lazy-src, then srcset (≤ ~1600w). */
function imageSource(img: El, base: string, extraSrcsets: string[] = []): string | null {
  for (const k of ["width", "height"]) {
    const v = attr(img, k);
    if (v && /^\d+(px)?$/.test(v.trim()) && parseInt(v, 10) <= 2) return null;
  }
  for (const k of ["src", "data-src", "data-lazy-src"]) {
    const v = attr(img, k)?.trim();
    if (!v || /^data:/i.test(v)) continue;
    const u = httpUrl(v, base);
    if (u) return u;
  }
  for (const set of [attr(img, "srcset"), attr(img, "data-srcset"), ...extraSrcsets]) {
    const u = set && bestSrcset(set, base);
    if (u) return u;
  }
  return null;
}

function bestSrcset(set: string, base: string): string | null {
  const cands = set
    .split(/,\s+/)
    .map((c) => {
      const [url, d = "1x"] = c.trim().split(/\s+/);
      const m = /^(\d+(?:\.\d+)?)([wx])$/.exec(d);
      return { url, w: m?.[2] === "w" ? Number(m[1]) : null, x: m?.[2] === "x" ? Number(m[1]) : 1 };
    })
    .filter((c) => c.url && !/^data:/i.test(c.url));
  if (!cands.length) return null;
  const byW = cands.filter((c) => c.w !== null).sort((a, b) => a.w! - b.w!);
  const pick = byW.length ? ([...byW].reverse().find((c) => c.w! <= SRCSET_MAX_W) ?? byW[0]) : ([...cands].sort((a, b) => a.x - b.x).reverse().find((c) => c.x <= 2) ?? cands[0]);
  return httpUrl(pick.url, base) ?? null;
}

function httpUrl(raw: string | undefined, base: string): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const u = new URL(raw.trim(), base);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.href.length > MAX_LINK) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

/** An <img> or <picture>'s image element and the srcsets of its <source>s. */
function imageParts(n: El): { img: El | null; srcsets: string[] } {
  if (n.tagName === "img") return { img: n, srcsets: [] };
  const img = findEl(n, (e) => e.tagName === "img");
  const srcsets = [...walkEls(n)].filter((e) => e.tagName === "source").map((e) => attr(e, "srcset") ?? "").filter(Boolean);
  return { img, srcsets };
}

class Units {
  readonly list: Unit[] = [];
  constructor(private base: string) {}

  private push(kind: Unit["kind"], node: El, text: string, level?: number) {
    const t = squash(text);
    this.list.push({ kind, node, text: t, words: words(t), ...(level ? { level } : {}) });
  }

  private usableImage(n: El): boolean {
    const { img, srcsets } = imageParts(n);
    return !!img && imageSource(img, this.base, srcsets) !== null;
  }

  private figureText(n: El): string {
    if (n.tagName === "figure") {
      const cap = findEl(n, (e) => e.tagName === "figcaption");
      if (cap && squash(textOf(cap))) return textOf(cap);
    }
    const { img } = n.tagName === "figure" ? { img: findEl(n, (e) => e.tagName === "img") } : imageParts(n);
    return (img && attr(img, "alt")) ?? "";
  }

  /** Images under `n` (not inside a figure), each lifted out of the tree; the <picture> when there is one. */
  private liftImages(nodes: Node[]): El[] {
    const found: El[] = [];
    const visit = (list: Node[]) => {
      for (const c of [...list]) {
        if (!isEl(c)) continue;
        if (isImage(c)) found.push(c);
        else if (c.tagName !== "figure") visit(c.childNodes);
      }
    };
    visit(nodes);
    for (const f of found) detach(f);
    return found.filter((f) => this.usableImage(f));
  }

  /** Inline content: split at <br><br>, images made figures of their own, empty runs skipped. */
  private flush(nodes: Node[]) {
    const segments: Node[][] = [[]];
    let brs: Node[] = [];
    for (const n of nodes) {
      if (isEl(n) && n.tagName === "br") {
        brs.push(n);
        continue;
      }
      if (n.nodeName === "#text" && !(n as T.TextNode).value.trim() && brs.length) {
        brs.push(n);
        continue;
      }
      if (brs.filter((b) => isEl(b)).length >= 2) segments.push([]);
      else segments[segments.length - 1].push(...brs);
      brs = [];
      segments[segments.length - 1].push(n);
    }
    for (const seg of segments) {
      if (!seg.length) continue;
      const holder = el("p", seg);
      for (const c of seg) (c as { parentNode: unknown }).parentNode = holder;
      const imagesFirst = (() => {
        let text = false;
        for (const c of seg) {
          if (isEl(c) && (isImage(c) || findEl(c, (e) => isImage(e))) && !text) return true;
          if (squash(textOf(c))) text = true;
        }
        return false;
      })();
      const images = this.liftImages(holder.childNodes);
      // Leading and trailing <br>s are not content.
      const blank = (c: Node | undefined) => !!c && (tagOf(c) === "br" || (c.nodeName === "#text" && !(c as T.TextNode).value.trim()));
      while (blank(holder.childNodes[0])) holder.childNodes.shift();
      while (blank(holder.childNodes[holder.childNodes.length - 1])) holder.childNodes.pop();
      const text = textOf(holder);
      const figures = () => images.forEach((i) => this.push("figure", i, this.figureText(i)));
      if (imagesFirst) figures();
      if (words(text)) this.push("p", holder, text);
      if (!imagesFirst) figures();
    }
  }

  /** Walk a block's children: units for blocks, paragraphs for runs of inline content. */
  walk(nodes: Node[]) {
    let inline: Node[] = [];
    const flush = () => {
      if (inline.length) this.flush(inline);
      inline = [];
    };
    for (const n of [...nodes]) {
      if (!isEl(n)) {
        if (n.nodeName === "#text") inline.push(n);
        continue;
      }
      const tag = n.tagName.toLowerCase();
      if (DROP_TAGS.has(tag) && !EMBEDS.has(tag)) continue;
      if ((PHRASING.has(tag) || !BLOCKISH.has(tag) && n.namespaceURI !== HTML_NS) && !hasBlock(n) && !hasBrRun(n)) {
        inline.push(n);
        continue;
      }
      flush();
      if (/^h[1-6]$/.test(tag)) {
        const images = this.liftImages(n.childNodes);
        if (words(textOf(n))) this.push("heading", n, textOf(n), Number(tag[1]));
        images.forEach((i) => this.push("figure", i, this.figureText(i)));
      } else if (tag === "p") this.walk(n.childNodes);
      else if (tag === "ul" || tag === "ol" || tag === "dl") this.block("list", n);
      else if (tag === "pre") this.block("pre", n);
      else if (tag === "blockquote") this.block("blockquote", n);
      else if (tag === "table") layoutTable(n) ? this.walk(n.childNodes) : this.block("table", n);
      else if (tag === "figure") {
        const img = findEl(n, (e) => isImage(e) && !findAncestor(e, n, "figcaption"));
        const player = img ? null : figureVideo(n, this.base);
        if (img && this.usableImage(img)) this.push("figure", n, this.figureText(n));
        else if (player) this.push("video", n, this.figureText(n) || videoCaption(player.el, player.v));
        else this.walk(n.childNodes);
      } else if (EMBEDS.has(tag)) {
        const v = videoOf(n, this.base);
        const html = v ? "" : embedLink(n, tag, this.base);
        if (v) this.push("video", n, videoCaption(n, v));
        else if (html) this.push("embed", n, textOf(htmlEl(html)));
      } else if (tag === "hr") continue;
      else this.walk(n.childNodes);
    }
    flush();
  }

  /** A block kept whole; its paragraphs give up their images, which may not sit inside a <p>. */
  private block(kind: Unit["kind"], n: El) {
    for (const p of [...walkEls(n)].filter((e) => e.tagName === "p" || /^h[1-6]$/.test(e.tagName))) {
      const images = this.liftImages(p.childNodes);
      const parent = p.parentNode as El;
      const at = parent.childNodes.indexOf(p);
      parent.childNodes.splice(at + 1, 0, ...images);
      for (const i of images) (i as { parentNode: unknown }).parentNode = parent;
    }
    const text = textOf(n);
    if (words(text) || findEl(n, (e) => isImage(e))) this.push(kind, n, text);
  }
}

function findAncestor(e: El, stop: El, tag: string): boolean {
  for (let p = e.parentNode as El | null; p && p !== stop; p = p.parentNode as El | null) if (p.tagName === tag) return true;
  return false;
}

/** The text an emitted snippet of HTML shows (for an embed's link). */
function htmlEl(html: string): El {
  const doc = parse(`<body>${html}</body>`);
  return findEl(doc, (e) => e.tagName === "body")!;
}

// ---- videos ----

/** A video worth a facade: a file, or a player and its id; its still and size when known. */
interface Video {
  video?: string;
  embed?: Embed;
  id?: string;
  poster?: string;
  width?: number;
  height?: number;
}

const dim = (v: string | undefined) => (v && /^\d{1,5}$/.test(v.trim()) && Number(v) > 0 ? Number(v) : undefined);

/**
 * What a <video> or an iframe plays, or null: a <video>'s src (else its first <source> with one),
 * https only (the page's CSP lets the browser load media from https alone), with its poster; an
 * iframe of YouTube or Vimeo, by a valid id, with YouTube's thumbnail as its still.
 */
export function videoOf(n: El, base: string): Video | null {
  const tag = n.tagName.toLowerCase();
  if (tag === "iframe") {
    const u = httpUrl(attr(n, "src"), base);
    const e = u ? embedOf(u) : null;
    if (!e) return null;
    return { embed: e.embed, id: e.id, ...(e.embed === "youtube" ? { poster: youtubeStill(e.id) } : {}) };
  }
  if (tag !== "video") return null;
  const sources = [n, ...n.childNodes.filter((c): c is El => isEl(c) && c.tagName === "source")];
  const src = sources.map((e) => attr(e, "src")).find((x) => x?.trim() && !/^\s*data:/i.test(x));
  const u = httpUrl(src, base);
  if (!u || !u.startsWith("https://")) return null;
  const poster = attr(n, "poster");
  const p = poster && !/^\s*data:/i.test(poster) ? httpUrl(poster, base) : undefined;
  const width = dim(attr(n, "width"));
  const height = dim(attr(n, "height"));
  return { video: u, ...(p ? { poster: p } : {}), ...(width && height ? { width, height } : {}) };
}

/** A <figure>'s video, when it holds one (and no picture). */
function figureVideo(n: El, base: string): { el: El; v: Video } | null {
  const el = findEl(n, (e) => EMBEDS.has(e.tagName) && !findAncestor(e, n, "figcaption"));
  const v = el && videoOf(el, base);
  return el && v ? { el, v } : null;
}

/** A bare video's caption: its title, else its aria-label, else where it is from. */
function videoCaption(n: El, v: Video): string {
  const own = squash(attr(n, "title") ?? "") || squash(attr(n, "aria-label") ?? "");
  // A player's stock title says nothing.
  if (own && !/^(youtube|vimeo)( video)?( player)?$/i.test(own)) return own;
  const from = v.embed === "youtube" ? "YouTube" : v.embed === "vimeo" ? "Vimeo" : hostOf(v.video!);
  return `Video from ${from}`;
}

/** The facade for a video, its still kept for the media route; `caption` is safe HTML. */
function videoHtml(v: Video, caption: string, media: string[]): string {
  if (v.poster && !media.includes(v.poster)) media.push(v.poster);
  return videoFacade(v, v.poster ? `/api/page/media?u=${encodeURIComponent(v.poster)}` : null, caption);
}

// ---- emitting ----

/** "Embedded content from <host> ↗", linking to an iframe's or video's source. */
function embedLink(n: El, tag: string, base: string): string {
  if (!EMBEDS.has(tag)) return "";
  const raw = attr(n, "src") ?? (tag === "video" ? (findEl(n, (e) => e.tagName === "source" && !!attr(e, "src")) as El | null)?.attrs.find((a) => a.name === "src")?.value : undefined);
  const u = httpUrl(raw, base);
  if (!u) return "";
  const host = new URL(u).host.replace(/^www\./, "");
  return outLink(u, `Embedded content from ${escapeText(host)} ↗`);
}

const outLink = (u: string, inner: string) => open("a", [["data-url", u], ["href", u], ["target", "_blank"], ["rel", "noopener noreferrer"]]) + inner + "</a>";

const WIKI_HOST = /^([a-z][a-z0-9-]{1,15})\.(?:m\.)?wikipedia\.org$/;

function webLink(n: El, inner: string, base: string): string {
  const href = attr(n, "href")?.trim();
  // A link around an image would put the figure inside it: the image keeps its own link (data-full).
  if (!href || !inner.trim() || inner.includes("<figure") || href.startsWith("#")) return inner;
  const u = httpUrl(href, base);
  if (!u) return inner;
  const x = new URL(u);
  const wm = WIKI_HOST.exec(x.hostname);
  if (wm && x.pathname.startsWith("/wiki/") && x.pathname.length > 6 && !x.search) {
    const lang = wm[1];
    const as = { ...n, attrs: [...n.attrs.filter((a) => a.name !== "href"), { name: "href", value: `https://${lang}.wikipedia.org${x.pathname}${x.hash}` }] };
    return wikiLink(as, inner, lang, [["data-wiki-lang", lang]]);
  }
  return outLink(u, inner);
}

/** The policy for web pages: see the module comment. `media` collects every image address shown. */
function webPolicy(base: string, media: string[]): HtmlPolicy {
  const policy: HtmlPolicy = {
    link: (n, inner) => webLink(n, inner, base),
    table: (_n, inner) => `<table>${inner}</table>`,
    dropClass: () => false,
    hidden: hiddenEl,
    embed: (n, tag) => {
      const v = videoOf(n, base);
      return v ? videoHtml(v, escapeText(videoCaption(n, v)), media) : embedLink(n, tag, base);
    },
    image: (n, tag) => {
      if (tag !== "figure" && tag !== "img" && tag !== "picture") return null;
      const target = tag === "figure" ? findEl(n, (e) => isImage(e) && !findAncestor(e, n, "figcaption")) : n;
      const { img, srcsets } = target ? imageParts(target) : { img: null, srcsets: [] };
      const src = img && imageSource(img, base, srcsets);
      const player = tag === "figure" && !target ? figureVideo(n, base) : null;
      if (player) {
        // A video in a figure: the facade, with the figure's caption, else the video's own.
        const cap = findEl(n, (e) => e.tagName === "figcaption");
        const caption = cap ? tidy(render(cap.childNodes, { ...policy, image: (_e, t) => (t === "img" || t === "picture" || t === "figure" ? "" : null) })) : "";
        return videoHtml(player.v, caption || escapeText(videoCaption(player.el, player.v)), media);
      }
      if (!img || !src) {
        // A figure without a usable image (a quotation, some code): its contents.
        if (tag !== "figure") return "";
        return render(
          n.childNodes.map((c) => (isEl(c) && c.tagName === "figcaption" ? el("p", c.childNodes) : c)),
          policy,
        );
      }
      if (!media.includes(src)) media.push(src);
      const cap = tag === "figure" ? findEl(n, (e) => e.tagName === "figcaption") : null;
      const caption = cap ? tidy(render(cap.childNodes, { ...policy, image: (_e, t) => (t === "img" || t === "picture" || t === "figure" ? "" : null) })) : "";
      const alt = squash(attr(img, "alt") ?? "");
      const attrs: [string, string][] = [["src", `/api/page/media?u=${encodeURIComponent(src)}`], ["alt", alt]];
      for (const k of ["width", "height"]) {
        const v = attr(img, k)?.trim();
        if (v && /^\d{1,5}$/.test(v)) attrs.push([k, v]);
      }
      attrs.push(["loading", "lazy"], ["decoding", "async"], ["data-full", src]);
      const text = caption || (alt ? escapeText(alt) : "");
      return `<figure>${open("img", attrs)}${text ? `<figcaption>${text}</figcaption>` : ""}</figure>`;
    },
  };
  return policy;
}

function renderUnit(u: Unit, policy: HtmlPolicy): string {
  if (u.kind === "embed") return `<p>${policy.embed!(u.node, u.node.tagName)}</p>`;
  // A video is its facade, a figure of its own (never inside a paragraph).
  return tidy(render([u.node], policy));
}

// ---- 4. sections ----

function junk(heading: string): boolean {
  const h = heading
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return JUNK_HEADINGS.has(h);
}

interface Draft {
  heading: number | null;
  title: string;
  level: number;
  parent: number | null;
  body: number[];
}

/** Whether these sections make an outline: enough non-junk top sections, long enough, covering enough. */
function fits(drafts: Draft[], units: Unit[], total: number): boolean {
  const subtree = (i: number): number => {
    const d = drafts[i];
    let n = d.body.reduce((a, b) => a + units[b].words, d.heading !== null ? units[d.heading].words : 0);
    drafts.forEach((c, j) => c.parent === i && (n += subtree(j)));
    return n;
  };
  const tops = drafts.map((d, i) => ({ d, i })).filter(({ d }) => d.parent === null && !junk(d.title));
  const long = tops.filter(({ i }) => subtree(i) >= SECTION_MIN_WORDS);
  const cover = tops.reduce((a, { i }) => a + subtree(i), 0);
  return long.length >= MIN_SECTIONS && cover >= MIN_COVER * total;
}

/** Sections at headings. L is the shallowest of h2–h6 used twice; shallower headings count as L. */
function byHeadings(units: Unit[], order: number[]): { lead: number[]; drafts: Draft[] } | null {
  const counts = new Map<number, number>();
  for (const i of order) if (units[i].kind === "heading" && units[i].level! >= 2) counts.set(units[i].level!, (counts.get(units[i].level!) ?? 0) + 1);
  const L = [2, 3, 4, 5, 6].find((l) => (counts.get(l) ?? 0) >= 2);
  if (!L) return null;
  return split(units, order, (u) => (u.kind === "heading" ? Math.max(u.level!, L) : null));
}

const NUMERAL = /^(?:[ivxlcdm]+|\d{1,3})[.)]?$/i;

function strongOnly(n: Node, inStrong = false): boolean {
  if (n.nodeName === "#text") return inStrong || !(n as T.TextNode).value.trim();
  if (!isEl(n) || DROP_TAGS.has(n.tagName)) return true;
  const s = inStrong || n.tagName === "strong" || n.tagName === "b";
  return n.childNodes.every((c) => strongOnly(c, s));
}

/** Sections at paragraphs that are only a numeral ("II."), else only bold and short. */
function byPseudo(units: Unit[], order: number[], total: number): { lead: number[]; drafts: Draft[] } | null {
  const tests: ((u: Unit) => boolean)[] = [
    (u) => u.kind === "p" && NUMERAL.test(u.text),
    (u) => u.kind === "p" && u.text.length < PSEUDO_MAX_CHARS && strongOnly(u.node),
  ];
  for (const test of tests) {
    if (order.filter((i) => test(units[i])).length < MIN_SECTIONS) continue;
    const r = split(units, order, (u) => (test(u) ? 2 : null));
    if (fits(r.drafts, units, total)) return r;
  }
  return null;
}

/** Cut the units at boundaries (a level, or null), nesting deeper levels under shallower ones. */
function split(units: Unit[], order: number[], levelOf: (u: Unit) => number | null): { lead: number[]; drafts: Draft[] } {
  const lead: number[] = [];
  const drafts: Draft[] = [];
  const stack: number[] = [];
  for (const i of order) {
    const level = levelOf(units[i]);
    if (level === null) {
      (drafts.length ? drafts[drafts.length - 1].body : lead).push(i);
      continue;
    }
    while (stack.length && drafts[stack[stack.length - 1]].level >= level) stack.pop();
    drafts.push({ heading: i, title: units[i].text, level, parent: stack.length ? stack[stack.length - 1] : null, body: [] });
    stack.push(drafts.length - 1);
  }
  return { lead, drafts };
}

/**
 * Parts of about 600 words at unit boundaries, each titled by its first words. The opening leads
 * when it is a long paragraph, with whatever short lines come before it (a title, a date, a picture).
 */
function byChunks(units: Unit[], order: number[]): { lead: number[]; drafts: Draft[] } {
  let opening = -1;
  for (let k = 0; k < Math.min(order.length, 5); k++) {
    const u = units[order[k]];
    if (u.kind === "p" && u.words >= LEAD_MIN_WORDS) {
      opening = k;
      break;
    }
    if (u.words >= SHORT_LINE) break;
  }
  const lead = opening >= 0 ? order.slice(0, opening + 1) : [];
  const rest = order.slice(lead.length);
  const left = (from: number) => rest.slice(from).reduce((a, i) => a + units[i].words, 0);
  const drafts: Draft[] = [];
  let cur: number[] = [];
  let n = 0;
  rest.forEach((i, k) => {
    cur.push(i);
    n += units[i].words;
    // Cut here unless what is left would make a part too short to stand alone.
    if (n >= CHUNK_WORDS && left(k + 1) >= CHUNK_WORDS / 2) {
      drafts.push({ heading: null, title: "", level: 2, parent: null, body: cur });
      cur = [];
      n = 0;
    }
  });
  if (cur.length) drafts.push({ heading: null, title: "", level: 2, parent: null, body: cur });
  for (const d of drafts) {
    // Titled from its first unit of some length, so a short line ("Thanks") does not name it.
    const first = d.body.find((i) => units[i].words >= CHUNK_TITLE_WORDS) ?? d.body[0];
    const w = units[first].text.split(/\s+/).filter(Boolean);
    d.title = w.slice(0, CHUNK_TITLE_WORDS).join(" ").replace(/[,;:.]$/, "") + (w.length > CHUNK_TITLE_WORDS ? "…" : "");
  }
  return { lead, drafts };
}

// ---- the whole ----

const hostOf = (u: string) => {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return u;
  }
};

/** Plain text as a page: paragraphs at blank lines. */
export function plainToHtml(text: string): string {
  const paras = text.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
  return `<!doctype html><html><head></head><body>${paras.map((p) => `<p>${escapeText(p)}</p>`).join("\n")}</body></html>`;
}

/** Only the metadata (for a page that is refused or not a page, so the reader still sees what it is). */
export function pageMeta(html: string, url: string): PageMeta & { title: string; site: string } {
  const m = readMeta(parse(html), url);
  return finishMeta(m, url);
}

function finishMeta(m: PageMeta & { titleTag?: string }, url: string): PageMeta & { title: string; site: string } {
  const { titleTag: _t, ...meta } = m;
  return { ...strip(meta), title: m.title || hostOf(url), site: m.site || hostOf(url) };
}

const strip = <O extends object>(o: O): O => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as O;

/** Read a page: see the module comment. `url` is the address it was read from, after redirects. */
export function extractPage(html: string, url: string): Extraction {
  const doc = parse(html);
  const raw = readMeta(doc, url);
  if (raw.titleTag !== undefined && CHALLENGE_TITLES.has(raw.titleTag.toLowerCase())) {
    return { ok: false, reason: "refused", message: "The site answered with a bot check instead of the page.", meta: finishMeta({ ...raw, title: raw.title === raw.titleTag ? undefined : raw.title }, url), words: 0 };
  }
  const body = findEl(doc, (e) => e.tagName === "body") ?? el("body", []);
  const container = chooseContainer(body);
  // Found before cleaning: a byline and a date often sit in the article's own <header>.
  const byline = raw.author ? undefined : bylineIn(container);
  const time = raw.published ? undefined : findEl(container, (e) => e.tagName === "time" && !!attr(e, "datetime"));
  clean(container);
  const units = new Units(url);
  units.walk(container.childNodes);
  const list = units.list;
  const total = list.reduce((a, u) => a + u.words, 0);

  // The page's own h1, before any other heading, is its title rather than a section.
  const firstHeading = list.findIndex((u) => u.kind === "heading" && u.level! >= 2);
  const h1 = list.findIndex((u, i) => u.kind === "heading" && u.level === 1 && (firstHeading < 0 || i < firstHeading));
  const meta = finishMeta(
    {
      ...raw,
      title: raw.title || (h1 >= 0 ? list[h1].text : undefined),
      author: raw.author ?? byline,
      published: raw.published ?? isoDate(time ? attr(time, "datetime") : undefined),
    },
    url,
  );
  if (total < MIN_WORDS) {
    return { ok: false, reason: "empty", message: total ? `The page has too little text to show here (${total} words).` : "The page shows no text without running its scripts.", meta, words: total };
  }

  const order = list.map((_, i) => i).filter((i) => i !== h1);
  let outline: Outline;
  let shape = byHeadings(list, order);
  if (shape && fits(shape.drafts, list, total)) outline = "headings";
  else if ((shape = byPseudo(list, order, total))) outline = "pseudo";
  else if (total >= CHUNK_WORDS) (shape = byChunks(list, order)), (outline = "chunks");
  else (shape = { lead: order, drafts: [] }), (outline = "none");

  // Junk sections go, with everything under them.
  const gone = new Set<number>();
  shape.drafts.forEach((d, i) => {
    if ((d.parent !== null && gone.has(d.parent)) || (outline !== "chunks" && junk(d.title))) gone.add(i);
  });
  const prefix = outline === "headings" ? "h" : outline === "pseudo" ? "p" : "c";
  const ids = new Map<number, string>();
  let n = 0;
  shape.drafts.forEach((_, i) => !gone.has(i) && ids.set(i, `${prefix}${++n}`));

  const media: string[] = [];
  const policy = webPolicy(url, media);
  // Each unit is drawn once: kept for the sections, and for the units a model may arrange.
  const drawn = new Map<number, string>();
  const one = (i: number) => {
    let h = drawn.get(i);
    if (h === undefined) drawn.set(i, (h = renderUnit(list[i], policy)));
    return h;
  };
  const emit = (idx: number[]) => tidy(idx.map(one).join("\n"));
  const leadWords = shape.lead.reduce((a, i) => a + list[i].words, 0);
  const leadHtml = emit(shape.lead);
  let lead = leadHtml;
  let leadFrom: "intro" | "page-description" | "none" = leadHtml ? "intro" : "none";
  if (leadWords < LEAD_MIN_WORDS && meta.description) {
    // The short intro is kept after the description: no unit is ever left out.
    lead = tidy(`<p>${escapeText(meta.description)}</p>\n${leadHtml}`);
    leadFrom = "page-description";
  }
  const sections: WebSection[] = [];
  shape.drafts.forEach((d, i) => {
    if (gone.has(i)) return;
    sections.push({ id: ids.get(i)!, level: d.level, heading: d.title, parent: d.parent === null ? null : ids.get(d.parent)!, html: emit(d.body) });
  });
  const dropped = shape.drafts.filter((_, i) => gone.has(i) && !gone.has(shape.drafts[i].parent ?? -1)).map((d) => d.title);
  const plan: Plan = {
    units: list,
    title: h1 >= 0 ? h1 : null,
    lead: shape.lead,
    sections: shape.drafts.flatMap((d, i) => (gone.has(i) ? [] : [{ id: ids.get(i)!, heading: d.heading, body: d.body }])),
    dropped: shape.drafts.flatMap((d, i) => (gone.has(i) ? [...(d.heading !== null ? [d.heading] : []), ...d.body] : [])),
  };
  const hash = createHash("sha256")
    .update(list.map((u) => u.text).join("\n"))
    .digest("hex")
    .slice(0, 16);
  // The lead's units, then the sections' (titles among them), in reading order: never the title or a dropped unit.
  const out = new Set(plan.dropped);
  const kept: PageUnit[] = order
    .filter((i) => !out.has(i))
    .map((i) => ({ kind: list[i].kind, text: clipText(list[i].text, UNIT_TEXT), ...(outline === "chunks" ? { html: one(i) } : {}) }));
  return { ok: true, meta, lead, leadFrom, sections, outline, words: total, hash, media, dropped, units: kept, leadUnits: shape.lead.length, plan };
}

/** At most n characters of text, cut at a word, with "…" when cut. */
export function clipText(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  return `${cut.replace(/\s+\S*$/, "") || cut}…`;
}

/** The first sentence of some HTML's text, at most 300 characters. */
export function firstSentence(html: string): string {
  const text = squash(textOf(htmlEl(html)));
  const m = /^.+?[.!?](?=\s+["“'(\p{Lu}\d]|$)/u.exec(text);
  const s = m ? m[0] : text;
  return s.length > 300 ? `${s.slice(0, 299).replace(/\s+\S*$/, "")}…` : s;
}

