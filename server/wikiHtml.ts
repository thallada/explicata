/**
 * Wikipedia's HTML made safe to show, and split into sections: an allowlist of elements and
 * attributes (MathML kept; images, references, boxes and navigation dropped), with every link
 * either naming an article (data-wiki) or leaving in a new tab. Used by server/wiki.ts.
 */
import { parseFragment, type DefaultTreeAdapterTypes as T } from "parse5";
import type { SectionInfo } from "./wiki";

type Node = T.ChildNode;
type El = T.Element;
const MATHML = "http://www.w3.org/1998/Math/MathML";

const DROP_TAGS = new Set([
  "script", "style", "link", "meta", "noscript", "iframe", "object", "embed", "form", "input", "button", "select",
  "textarea", "template", "svg", "audio", "video", "source", "track", "canvas", "map", "area", "base", "title", "head",
]);
const DROP_CLASSES = new Set([
  "mw-editsection", "reference", "mw-references-wrap", "references", "reflist", "refbegin", "mw-cite-backlink",
  "navbox", "navbox-styles", "vertical-navbox", "sidebar", "infobox", "metadata", "ambox", "ombox", "tmbox", "cmbox",
  "fmbox", "imbox", "mbox-small", "hatnote", "dablink", "rellink", "shortdescription", "noprint", "mw-empty-elt",
  "Z3988", "navbar", "catlinks", "toc", "mw-jump-link", "portalbox", "sistersitebox", "side-box", "authority-control",
  "mwe-math-fallback-image-inline", "mwe-math-fallback-image-display", "error", "mw-kartographer-container",
]);
const IMAGE_CLASSES = new Set(["thumb", "gallery", "mw-gallery-traditional", "tsingle", "multiimageinner"]);
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

const attr = (el: El, name: string) => el.attrs.find((a) => a.name === name)?.value;
const classes = (el: El) => new Set((attr(el, "class") ?? "").split(/\s+/).filter(Boolean));
const isEl = (n: Node): n is El => "tagName" in n;

function escapeText(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string) {
  return escapeText(s).replace(/"/g, "&quot;");
}

function textOf(n: Node): string {
  if (n.nodeName === "#text") return (n as T.TextNode).value;
  if (isEl(n)) {
    if (DROP_TAGS.has(n.tagName)) return "";
    return n.childNodes.map(textOf).join("");
  }
  return "";
}

function open(tag: string, attrs: [string, string][]) {
  return `<${tag}${attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("")}>`;
}

function emptyHtml(s: string) {
  return !s.replace(/<br>/g, "").trim();
}

function wikiLink(el: El, inner: string, lang: string): string {
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
    return open("a", attrs) + inner + "</a>";
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

function render(nodes: Node[], lang: string): string {
  let out = "";
  for (const n of nodes) out += renderNode(n, lang);
  return out;
}

function renderNode(n: Node, lang: string): string {
  if (n.nodeName === "#text") return escapeText((n as T.TextNode).value);
  if (!isEl(n)) return "";
  const tag = n.tagName.toLowerCase();
  if (DROP_TAGS.has(tag)) return "";
  const cls = classes(n);
  for (const c of cls) if (DROP_CLASSES.has(c) || c.startsWith("mbox-") || c.startsWith("box-")) return "";
  if (/display\s*:\s*none/i.test(attr(n, "style") ?? "")) return "";
  if (attr(n, "role") === "navigation") return "";
  if (n.namespaceURI === MATHML) {
    if (!MATH_TAGS.has(tag)) return "";
    const attrs = n.attrs.filter((a) => MATH_ATTRS.has(a.name)).map((a): [string, string] => [a.name, a.value]);
    return open(tag, attrs) + render(n.childNodes, lang) + `</${tag}>`;
  }
  // Images each carry their own licence and would load from upload.wikimedia.org: never kept.
  if (tag === "figure" || tag === "img" || tag === "picture" || [...cls].some((c) => IMAGE_CLASSES.has(c))) return "";
  switch (tag) {
    case "a":
      return wikiLink(n, render(n.childNodes, lang), lang);
    case "table":
      if (!cls.has("wikitable")) return "";
      return `<table>${render(n.childNodes, lang)}</table>`;
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const inner = render(n.childNodes, lang);
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
    const inner = render(n.childNodes, lang);
    if (emptyHtml(inner) && tag !== "td" && tag !== "th") return "";
    return open(tag, attrs) + inner + `</${tag}>`;
  }
  // Anything else (span, div, section, cite…): keep the contents, drop the element.
  return render(n.childNodes, lang);
}

/** Sanitise a fragment of Wikipedia HTML to the allowlist above. Output is safe to inject. */
export function sanitizeWikiHtml(html: string, lang: string): string {
  return tidy(render(parseFragment(html).childNodes, lang));
}

function tidy(html: string) {
  return html.replace(/\n{3,}/g, "\n\n").trim();
}

/** Search excerpts: keep the matches as <mark>, everything else as text. */
export function snippet(excerpt: string): { text: string; html: string } {
  let text = "";
  let html = "";
  const walk = (nodes: Node[], inMatch: boolean) => {
    for (const n of nodes) {
      if (n.nodeName === "#text") {
        const v = (n as T.TextNode).value;
        text += v;
        html += escapeText(v);
      } else if (isEl(n)) {
        const m = !inMatch && classes(n).has("searchmatch");
        if (m) html += "<mark>";
        walk(n.childNodes, inMatch || m);
        if (m) html += "</mark>";
      }
    }
  };
  walk(parseFragment(excerpt).childNodes, false);
  return { text, html };
}

function headingOf(n: Node): El | null {
  if (!isEl(n)) return null;
  if (/^h[2-6]$/.test(n.tagName)) return n;
  if (n.tagName === "div" && classes(n).has("mw-heading")) {
    return (n.childNodes.find((c) => isEl(c) && /^h[2-6]$/.test(c.tagName)) as El | undefined) ?? null;
  }
  return null;
}

/** Split a parsed page at its top-level headings and sanitise each part. */
export function splitArticle(html: string, lang: string): { lead: string; sections: (SectionInfo & { html: string })[] } {
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
  return {
    lead: tidy(render(lead.nodes, lang)),
    sections: rest.map((p) => ({ ...p.info!, html: tidy(render(p.nodes, lang)) })),
  };
}
