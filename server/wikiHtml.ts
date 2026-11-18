/**
 * Wikipedia's HTML made safe to show, and split into sections: an allowlist of elements and
 * attributes (MathML kept; references, boxes and navigation dropped), with every link either
 * naming an article (data-wiki) or leaving in a new tab. Used by server/wiki.ts.
 *
 * Images and videos are kept as figures (docs/wikipedia.md §3): thumbnails, galleries and the
 * infobox's main image (lifted to the top of the lead, the infobox itself still dropped), each
 * shown through the app's own image route (/api/wiki/media) and each linked to its File page,
 * which is its credit: the image's `data-full` is that page, opened by a click. Icons, flags and
 * other small images are not kept, nor anything inside a box that is dropped, nor an image with no
 * File page to credit it. A video is the click-to-play facade of src/core/video.ts.
 *
 * The emitter is shared with web pages (server/pageHtml.ts) through an `HtmlPolicy`: what a link,
 * a table, an image or an embed becomes, and which classes and attributes mark junk, is the
 * policy's to say; the allowlist itself is the same for both. `wikiPolicy` is Wikipedia's.
 */
import { parseFragment, type DefaultTreeAdapterTypes as T } from "parse5";
import type { Embed } from "../src/core/video";
import type { SectionInfo } from "./wiki";

type Node = T.ChildNode;
type El = T.Element;
const MATHML = "http://www.w3.org/1998/Math/MathML";

/** Elements never emitted, nor counted as text. */
export const DROP_TAGS = new Set([
  "script", "style", "link", "meta", "noscript", "iframe", "object", "embed", "form", "input", "button", "select",
  "textarea", "template", "svg", "audio", "video", "source", "track", "canvas", "map", "area", "base", "title", "head",
]);
const DROP_CLASSES = new Set([
  "mw-editsection", "reference", "mw-references-wrap", "references", "reflist", "refbegin", "mw-cite-backlink",
  "navbox", "navbox-styles", "vertical-navbox", "sidebar", "infobox", "metadata", "ambox", "ombox", "tmbox", "cmbox",
  "fmbox", "imbox", "mbox-small", "hatnote", "dablink", "rellink", "shortdescription", "noprint", "mw-empty-elt",
  "Z3988", "navbar", "catlinks", "toc", "mw-jump-link", "portalbox", "sistersitebox", "side-box", "authority-control",
  "mwe-math-fallback-image-inline", "mwe-math-fallback-image-display", "error", "mw-kartographer-container",
  "flagicon",
]);
/** Blocks that hold a picture or several, besides <figure>: old-style thumbnails, multiple images. */
const THUMB_CLASSES = new Set(["thumb", "tsingle", "multiimageinner"]);
/** Classes Wikipedia puts on icons, flags and other images that are not pictures of the subject. */
const ICON_CLASSES = new Set(["noviewer", "flagicon", "flagdeco", "mbox-image", "mw-kartographer-map"]);
/** A picture declared narrower or shorter than this is an icon, a flag or a button. */
const ICON_MAX_PX = 50;
/** The only host Wikipedia's images and videos are taken from. */
export const UPLOAD_HOST = "upload.wikimedia.org";
/** The app's route for Wikipedia's images (server/wikiRoutes.ts). */
const WIKI_MEDIA_ROUTE = "/api/wiki/media?u=";
const ALLOWED = new Set([
  "p", "br", "hr", "b", "strong", "i", "em", "u", "s", "sub", "sup", "code", "kbd", "var", "samp", "small", "blockquote",
  "q", "ul", "ol", "li", "dl", "dt", "dd", "pre", "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td",
  "abbr", "bdi", "mark",
]);
const VOID = new Set(["br", "hr"]);
const MATH_TAGS = new Set([
  "math", "semantics", "mrow", "mi", "mo", "mn", "ms", "mtext", "mspace", "msub", "msup", "msubsup", "mfrac", "msqrt",
  "mroot", "mover", "munder", "munderover", "mtable", "mtr", "mtd", "mstyle", "mpadded", "mphantom", "menclose",
  "merror", "mmultiscripts", "mprescripts", "none",
]);
const MATH_ATTRS = new Set([
  "display", "mathvariant", "stretchy", "displaystyle", "scriptlevel", "fence", "separator", "accent", "accentunder",
  "lspace", "rspace", "linethickness", "columnalign", "rowalign", "notation", "largeop", "movablelimits", "symmetric",
  "minsize", "maxsize", "width", "height", "depth", "alttext",
]);
/** Namespaces whose links are unwrapped rather than offered as articles (canonical English names and aliases). */
const NON_ARTICLE_NS = new Set([
  "talk", "user", "user talk", "wikipedia", "wikipedia talk", "wp", "project", "file", "file talk", "image", "media",
  "mediawiki", "template", "template talk", "help", "help talk", "category", "category talk", "portal", "draft",
  "timedtext", "module", "special", "book", "education program", "gadget", "gadget definition", "topic", "h", "cat",
  "t", "mos", "wikt", "wiktionary", "commons", "meta", "m", "s", "q", "n", "b", "v", "voy", "d", "species", "mw",
]);

export const attr = (el: El, name: string) => el.attrs.find((a) => a.name === name)?.value;
export const classes = (el: El) => new Set((attr(el, "class") ?? "").split(/\s+/).filter(Boolean));
export const isEl = (n: Node): n is El => "tagName" in n;

/** The first element under `n` (not `n` itself), depth first, that passes `test`, not looking inside `skip`. */
function find(n: El | Node[], test: (e: El) => boolean, skip: (e: El) => boolean = () => false): El | null {
  for (const c of Array.isArray(n) ? n : n.childNodes) {
    if (!isEl(c) || skip(c)) continue;
    if (test(c)) return c;
    const deeper = find(c, test, skip);
    if (deeper) return deeper;
  }
  return null;
}

export function escapeText(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string) {
  return escapeText(s).replace(/"/g, "&quot;");
}

/** The text of a node, without what the emitter always drops (scripts, styles, forms…). */
export function textOf(n: Node): string {
  if (n.nodeName === "#text") return (n as T.TextNode).value;
  if (isEl(n)) {
    if (DROP_TAGS.has(n.tagName)) return "";
    return n.childNodes.map(textOf).join("");
  }
  return "";
}

export function open(tag: string, attrs: [string, string][]) {
  return `<${tag}${attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("")}>`;
}

function emptyHtml(s: string) {
  return !s.replace(/<br>/g, "").trim();
}

/**
 * What differs between sources. Every hook sees an element the allowlist would otherwise handle
 * its own way; the emitter calls them at fixed points, so a policy cannot let through an element
 * or attribute that is not on the allowlist except by writing it itself (as `image` does).
 */
export interface HtmlPolicy {
  /** An <a>, given its rendered contents: a link, or the contents alone. */
  link(el: El, inner: string): string;
  /** A <table>, given its rendered contents: kept, or "" to drop it. */
  table(el: El, inner: string): string;
  /** Whether an element is junk by its classes alone (Wikipedia's references and boxes). */
  dropClass(cls: Set<string>): boolean;
  /** figure, img, picture and the like: what to emit ("" drops it), or null if `el` is not an image. */
  image(el: El, tag: string, cls: Set<string>): string | null;
  /** iframe, video, object, embed, audio: what to emit instead of dropping them silently. */
  embed?(el: El, tag: string): string;
  /** Hidden by markup beyond `display: none` (Wikipedia needs no such rule). */
  hidden?(el: El): boolean;
}

/**
 * Wikipedia: wiki links named, tables only when `wikitable`, boxes dropped, pictures and videos
 * kept as figures (see the module comment). `media` collects every image address shown, for the
 * image route to serve those and no others.
 */
function wikiPolicy(lang: string, media: string[] = []): HtmlPolicy {
  const policy: HtmlPolicy = {
    link: (el, inner) => wikiLink(el, inner, lang),
    table: (el, inner) => (classes(el).has("wikitable") ? `<table>${inner}</table>` : ""),
    dropClass: (cls) => {
      for (const c of cls) if (DROP_CLASSES.has(c) || c.startsWith("mbox-") || c.startsWith("box-")) return true;
      return false;
    },
    image: (el, tag, cls) => {
      const fig = (container: El, caption: Node[]) => wikiFigure(container, caption, policy, lang, media);
      if (tag === "figure") return fig(el, find(el, (e) => e.tagName === "figcaption")?.childNodes ?? []);
      if (tag === "ul" && (cls.has("gallery") || [...cls].some((c) => c.startsWith("mw-gallery-")))) {
        // A gallery: each box a figure with its text as the caption, the gallery's own caption a paragraph.
        const out: string[] = [];
        for (const li of el.childNodes) {
          if (!isEl(li)) continue;
          const lc = classes(li);
          if (lc.has("gallerycaption")) {
            const cap = tidy(render(li.childNodes, captionPolicy(policy)));
            if (!emptyHtml(cap)) out.push(`<p>${cap}</p>`);
          } else if (lc.has("gallerybox")) out.push(fig(li, find(li, (e) => classes(e).has("gallerytext"))?.childNodes ?? []));
        }
        return out.filter(Boolean).join("\n");
      }
      if ([...cls].some((c) => THUMB_CLASSES.has(c))) {
        // Several pictures side by side (Template:Multiple image): one figure each, the shared caption after them.
        const singles: El[] = [];
        const collect = (n: El) => n.childNodes.forEach((c) => isEl(c) && (classes(c).has("tsingle") ? singles.push(c) : collect(c)));
        collect(el);
        const capOf = (n: El) => find(n, (e) => classes(e).has("thumbcaption") || e.tagName === "figcaption", (e) => classes(e).has("tsingle"));
        if (!singles.length) return fig(el, capOf(el)?.childNodes ?? []);
        const out = singles.map((t) => fig(t, capOf(t)?.childNodes ?? []));
        const shared = capOf(el);
        const cap = shared ? tidy(render(shared.childNodes, captionPolicy(policy))) : "";
        if (!emptyHtml(cap)) out.push(`<p>${cap}</p>`);
        return out.filter(Boolean).join("\n");
      }
      // Any other picture (inline in a sentence, in a table cell): not kept. A figure may not sit inside a paragraph.
      return tag === "img" || tag === "picture" ? "" : null;
    },
  };
  return policy;
}

/** A policy that keeps no pictures: for captions. */
const captionPolicy = (p: HtmlPolicy): HtmlPolicy => ({ ...p, image: (_e, t) => (t === "img" || t === "picture" || t === "figure" ? "" : null) });

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** An address on upload.wikimedia.org (protocol-relative or http made https), or null. */
function uploadUrl(raw: string | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  try {
    const u = new URL(s.startsWith("//") ? `https:${s}` : s);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.hostname !== UPLOAD_HOST || u.username || u.password || u.port) return null;
    u.protocol = "https:";
    return u.href.length <= 2000 ? u.href : null;
  } catch {
    return null;
  }
}

const px = (v: string | undefined) => (v && /^\d{1,5}$/.test(v.trim()) ? Number(v.trim()) : null);

/**
 * Which rendition of a Wikipedia picture to show, or null for an icon. The largest of src and its
 * srcset up to 2x (a 250 px thumbnail's 500 px one): never a size the page does not list, which
 * Wikimedia may not have made, and never the original unless the page shows it at its own size.
 */
function wikiRendition(img: El): { src: string; width?: number; height?: number } | null {
  const w = px(attr(img, "width"));
  const h = px(attr(img, "height"));
  if ((w !== null && w < ICON_MAX_PX) || (h !== null && h < ICON_MAX_PX)) return null;
  const cands: { url: string; x: number }[] = [];
  const src = uploadUrl(attr(img, "src"));
  if (src) cands.push({ url: src, x: 1 });
  for (const c of (attr(img, "srcset") ?? "").split(/,\s+/)) {
    const [u, d = "1x"] = c.trim().split(/\s+/);
    const m = /^(\d+(?:\.\d+)?)x$/.exec(d);
    const url = uploadUrl(u);
    if (url && m && Number(m[1]) <= 2) cands.push({ url, x: Number(m[1]) });
  }
  const pick = cands.sort((a, b) => b.x - a.x)[0];
  if (!pick) return null;
  return { src: pick.url, ...(w && h ? { width: Math.round(w * pick.x), height: Math.round(h * pick.x) } : {}) };
}

/** The File page a picture or video links to, on the article's own wiki: its author and licence are there. */
function filePage(container: El, lang: string): string | null {
  const page = (href: string | undefined) => {
    const m = href && /^(?:\/wiki\/|\.\/|https:\/\/[a-z][a-z0-9-]{1,15}\.wikipedia\.org\/wiki\/)([^?#\s"<>:/]+:[^?#\s"<>]+)(?:[?#].*)?$/.exec(href.trim());
    return m ? `https://${lang}.wikipedia.org/wiki/${m[1]}` : null;
  };
  const a = find(container, (e) => e.tagName === "a" && (classes(e).has("mw-file-description") || classes(e).has("image")));
  const fromLink = a && page(attr(a, "href"));
  if (fromLink) return fromLink;
  // A video names its file on itself instead.
  const v = find(container, (e) => e.tagName === "video");
  if (!v) return null;
  const title = attr(v, "data-mwtitle")?.trim();
  return page(attr(v, "resource")) ?? (title && !/[\s#<>[\]|{}?]/.test(title.replace(/ /g, "_")) ? `https://${lang}.wikipedia.org/wiki/File:${encodeURIComponent(title.replace(/ /g, "_"))}` : null);
}

/**
 * One picture or video of a Wikipedia article as a figure: the first under `container` (not in its
 * caption), its caption rendered (links kept, pictures not), its File page as `data-full`. "" when
 * there is none worth keeping (an icon, an image from elsewhere, no File page, a sound).
 */
function wikiFigure(container: El, caption: Node[], policy: HtmlPolicy, lang: string, media: string[]): string {
  const inCaption = (e: El) => caption.includes(e) || e.childNodes.some((c) => caption.includes(c));
  const el = find(container, (e) => e.tagName === "img" || e.tagName === "video", inCaption);
  const file = filePage(container, lang);
  if (!el || !file) return "";
  const iconic = (e: El) => [...classes(e)].some((c) => ICON_CLASSES.has(c));
  for (let p: El | null = el; p; p = p === container ? null : (p.parentNode as El | null)) if (iconic(p)) return "";
  const cap = tidy(render(caption, captionPolicy(policy)));
  const keep = (u: string) => (media.includes(u) || media.push(u), WIKI_MEDIA_ROUTE + encodeURIComponent(u));
  if (el.tagName === "video") {
    const v = wikiVideo(el);
    if (!v) return "";
    return videoFacade({ video: v.src, width: v.width, height: v.height, file }, v.poster ? keep(v.poster) : null, emptyHtml(cap) ? "" : cap);
  }
  const r = wikiRendition(el);
  if (!r) return "";
  const alt = squash(attr(el, "alt") ?? "");
  const attrs: [string, string][] = [["src", keep(r.src)], ["alt", alt]];
  if (r.width && r.height) attrs.push(["width", String(r.width)], ["height", String(r.height)]);
  attrs.push(["loading", "lazy"], ["decoding", "async"], ["data-full", file]);
  const text = !emptyHtml(cap) ? cap : alt ? escapeText(alt) : "";
  return `<figure>${open("img", attrs)}${text ? `<figcaption>${text}</figcaption>` : ""}</figure>`;
}

/**
 * A Wikipedia video: one of its sources on upload.wikimedia.org (a WebM of 360 to 720 lines when
 * there is one, else the first), its still, and its size. Null when no source is on that host.
 */
function wikiVideo(v: El): { src: string; poster?: string; width?: number; height?: number } | null {
  const sources = [v, ...v.childNodes.filter((c): c is El => isEl(c) && c.tagName === "source")]
    .map((e) => ({ url: uploadUrl(attr(e, "src")), type: attr(e, "type") ?? "", w: px(attr(e, "data-width")), h: px(attr(e, "data-height")) }))
    .filter((x): x is { url: string; type: string; w: number | null; h: number | null } => !!x.url);
  if (!sources.length) return null;
  const mid = sources.filter((x) => x.type.startsWith("video/webm") && x.h !== null && x.h >= 360 && x.h <= 720).sort((a, b) => b.h! - a.h!);
  const pick = mid[0] ?? sources[0];
  const poster = uploadUrl(attr(v, "poster"));
  const w = pick.w ?? px(attr(v, "width"));
  const h = pick.h ?? px(attr(v, "height"));
  return { src: pick.url, ...(poster ? { poster } : {}), ...(w && h ? { width: w, height: h } : {}) };
}

/**
 * A video as the click-to-play facade of src/core/video.ts: a file (`video`) or a player and its
 * id, its size when known, the File page that credits it, its still (an address on the app's own
 * route, or null) and its caption (HTML already made safe).
 */
export function videoFacade(v: { video?: string; embed?: Embed; id?: string; width?: number; height?: number; file?: string }, still: string | null, caption: string): string {
  const attrs: [string, string][] = [["class", "video"]];
  if (v.embed && v.id) attrs.push(["data-embed", v.embed], ["data-id", v.id]);
  else if (v.video) attrs.push(["data-video", v.video]);
  const size: [string, string][] = v.width && v.height ? [["width", String(v.width)], ["height", String(v.height)]] : [];
  attrs.push(...size.map(([k, x]): [string, string] => [`data-${k}`, x]));
  if (v.file) attrs.push(["data-file", v.file]);
  const img = still ? open("img", [["src", still], ["alt", ""], ...size, ["loading", "lazy"], ["decoding", "async"]]) : "";
  return `${open("figure", attrs)}${img}${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>`;
}

/**
 * The infobox's main picture, as a figure for the top of the lead (the infobox itself is dropped):
 * the picture in its `infobox-image` cell, else the cell of its first picture worth keeping, with
 * the cell's `infobox-caption`. "" when the lead has no infobox or it has no such picture.
 */
function infoboxFigure(nodes: Node[], policy: HtmlPolicy, lang: string, media: string[]): string {
  const box = find(nodes, (e) => classes(e).has("infobox"));
  if (!box) return "";
  // Not inside a box within the box (a navbox, a nested infobox).
  const skip = (e: El) => policy.dropClass(classes(e));
  let cell = find(box, (e) => classes(e).has("infobox-image"), skip);
  if (!cell) {
    const img = find(box, (e) => e.tagName === "img" && wikiRendition(e) !== null, skip);
    for (let p = img?.parentNode as El | null | undefined; p && p !== box && !cell; p = p.parentNode as El | null) if (p.tagName === "td" || p.tagName === "th") cell = p;
  }
  if (!cell) return "";
  return wikiFigure(cell, find(cell, (e) => classes(e).has("infobox-caption"))?.childNodes ?? [], policy, lang, media);
}

/** An article link in the data-wiki form, for a link to `https://<lang>.wikipedia.org/wiki/…` or `/wiki/…`. */
export function wikiLink(el: El, inner: string, lang: string, extra: [string, string][] = []): string {
  const href = attr(el, "href") ?? "";
  const cls = classes(el);
  if (!href || cls.has("new") || cls.has("mw-selflink") || href.includes("redlink=1")) return inner;
  if (href.startsWith("#")) {
    if (/^#cite[_-]/.test(href)) return "";
    return `<a data-wiki-anchor="${escapeAttr(safeDecode(href.slice(1)).replace(/_/g, " "))}">${inner}</a>`;
  }
  if (href.startsWith("/wiki/") || href.startsWith(`https://${lang}.wikipedia.org/wiki/`)) {
    const path = href.slice(href.indexOf("/wiki/") + 6);
    const [rawTitle, rawFrag] = path.split("#", 2);
    const title = safeDecode(rawTitle).replace(/_/g, " ");
    const ns = /^([^:]+):(\S)/.exec(title)?.[1];
    if (ns && (NON_ARTICLE_NS.has(ns.toLowerCase()) || (lang !== "en" && !/\s/.test(ns)))) return inner;
    const attrs: [string, string][] = [["href", `https://${lang}.wikipedia.org/wiki/${rawTitle}`], ["data-wiki", title]];
    if (rawFrag) attrs.push(["data-wiki-fragment", safeDecode(rawFrag).replace(/_/g, " ")]);
    return open("a", [...attrs, ...extra]) + inner + "</a>";
  }
  const abs = href.startsWith("//") ? `https:${href}` : href;
  if (/^https?:\/\/[^\s]+$/i.test(abs)) {
    return open("a", [["href", abs], ["rel", "noopener noreferrer nofollow"], ["target", "_blank"]]) + inner + "</a>";
  }
  return inner;
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Elements an embed hook is offered before they are dropped. */
const EMBED_TAGS = new Set(["iframe", "video", "audio", "object", "embed"]);

/** Nodes emitted under a policy: only the allowlist, plus what the policy's hooks write. */
export function render(nodes: Node[], p: HtmlPolicy): string {
  let out = "";
  for (const n of nodes) out += renderNode(n, p);
  return out;
}

function renderNode(n: Node, p: HtmlPolicy): string {
  if (n.nodeName === "#text") return escapeText((n as T.TextNode).value);
  if (!isEl(n)) return "";
  const tag = n.tagName.toLowerCase();
  if (p.embed && EMBED_TAGS.has(tag)) return p.embed(n, tag);
  if (DROP_TAGS.has(tag)) return "";
  const cls = classes(n);
  if (p.dropClass(cls)) return "";
  if (/display\s*:\s*none/i.test(attr(n, "style") ?? "")) return "";
  if (attr(n, "role") === "navigation") return "";
  if (p.hidden?.(n)) return "";
  if (n.namespaceURI === MATHML) {
    if (!MATH_TAGS.has(tag)) return "";
    const attrs = n.attrs.filter((a) => MATH_ATTRS.has(a.name)).map((a): [string, string] => [a.name, a.value]);
    return open(tag, attrs) + render(n.childNodes, p) + `</${tag}>`;
  }
  const image = p.image(n, tag, cls);
  if (image !== null) return image;
  switch (tag) {
    case "a":
      return p.link(n, render(n.childNodes, p));
    case "table":
      return p.table(n, render(n.childNodes, p));
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const inner = render(n.childNodes, p);
      return emptyHtml(inner) ? "" : `<p><strong>${inner}</strong></p>`;
    }
  }
  if (ALLOWED.has(tag)) {
    const attrs: [string, string][] = [];
    if (tag === "td" || tag === "th") {
      for (const k of ["colspan", "rowspan"]) if (/^\d{1,3}$/.test(attr(n, k) ?? "")) attrs.push([k, attr(n, k)!]);
    }
    if (tag === "ol" && /^-?\d{1,6}$/.test(attr(n, "start") ?? "")) attrs.push(["start", attr(n, "start")!]);
    if (VOID.has(tag)) return open(tag, attrs);
    const inner = render(n.childNodes, p);
    if (emptyHtml(inner) && tag !== "td" && tag !== "th") return "";
    return open(tag, attrs) + inner + `</${tag}>`;
  }
  // Anything else (span, div, section, cite…): keep the contents, drop the element.
  return render(n.childNodes, p);
}

/** Sanitise a fragment of Wikipedia HTML to the allowlist above. Output is safe to inject. */
export function sanitizeWikiHtml(html: string, lang: string): string {
  return tidy(render(parseFragment(html).childNodes, wikiPolicy(lang)));
}

export function tidy(html: string) {
  return html.replace(/\n{3,}/g, "\n\n").trim();
}

function headingOf(n: Node): El | null {
  if (!isEl(n)) return null;
  if (/^h[2-6]$/.test(n.tagName)) return n;
  if (n.tagName === "div" && classes(n).has("mw-heading")) {
    return (n.childNodes.find((c) => isEl(c) && /^h[2-6]$/.test(c.tagName)) as El | undefined) ?? null;
  }
  return null;
}

/** Split a parsed page at its top-level headings and sanitise each part; `media` is every image address the parts show. */
export function splitArticle(html: string, lang: string): { lead: string; sections: (SectionInfo & { html: string })[]; media: string[] } {
  const frag = parseFragment(html);
  // The parser wraps everything in <div class="mw-parser-output">.
  let top: Node[] = frag.childNodes;
  const wrapper = top.find((n) => isEl(n) && classes(n).has("mw-parser-output"));
  if (wrapper && isEl(wrapper)) top = wrapper.childNodes;
  // Parsoid output wraps sections in <section>: flatten them so headings are top level.
  const flat: Node[] = [];
  const flatten = (nodes: Node[]) => {
    for (const n of nodes) (isEl(n) && n.tagName === "section" ? flatten(n.childNodes) : flat.push(n));
  };
  flatten(top);

  const parts: { info: SectionInfo | null; nodes: Node[] }[] = [{ info: null, nodes: [] }];
  const stack: SectionInfo[] = [];
  for (const n of flat) {
    const h = headingOf(n);
    if (!h) {
      parts[parts.length - 1].nodes.push(n);
      continue;
    }
    const level = Number(h.tagName[1]);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const info: SectionInfo = {
      id: parts.length,
      level,
      heading: textOf(h).replace(/\s+/g, " ").trim(),
      anchor: attr(h, "id") ?? "",
      number: null,
      parent: stack.length ? stack[stack.length - 1].id : 0,
    };
    stack.push(info);
    parts.push({ info, nodes: [] });
  }
  const [lead, ...rest] = parts;
  const media: string[] = [];
  const policy = wikiPolicy(lang, media);
  // The infobox's picture first, then the lead as it is (its infobox dropped).
  const pictured = infoboxFigure(lead.nodes, policy, lang, media);
  return {
    lead: tidy((pictured ? `${pictured}\n` : "") + render(lead.nodes, policy)),
    sections: rest.map((p) => ({ ...p.info!, html: tidy(render(p.nodes, policy)) })),
    media,
  };
}
