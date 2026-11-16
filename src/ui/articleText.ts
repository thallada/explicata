/**
 * An article's sanitised HTML as text the keys can select in, the same way they select in a node's
 * body: one string per section, paragraphs separated by a blank line, so sentences(), words(),
 * ranges, anchors and the renderer all count the same characters.
 *
 * What is text (selectable, and where an anchor can attach): paragraphs, list items, definition
 * list entries and block quotes, with everything inline in them (links, italics, bold, sub- and
 * superscripts, code). An inline formula counts as its glyphs' text and is selected and drawn
 * whole: a selection that touches it highlights all of it. What is not: tables and preformatted
 * blocks, which are shown as they are but carry no offsets. Whitespace is collapsed as the browser
 * collapses it. Citation markers and the rest are gone already (server/wikiHtml.ts). A section's
 * text is its own: nothing spans two sections.
 */
import type { Range } from "../core/text";

/** What the walk needs of a DOM node: the browser's, or a stand-in in the tests. */
export interface DomLike {
  nodeType: number;
  localName?: string;
  data?: string;
  textContent: string | null;
  childNodes: ArrayLike<DomLike>;
  attributes?: ArrayLike<{ name: string; value: string }>;
  outerHTML?: string;
}

/** An inline element around some text. */
export interface Mark {
  tag: string;
  attrs: [string, string][];
}
/** A stretch of a paragraph with the same inline elements around it; a formula is a run of its own. */
export interface Run {
  s: number;
  e: number;
  marks: Mark[];
  math?: string;
}
export type Block =
  /** A paragraph: `p` when it was one in the HTML, else loose text in a list item and the like. */
  | { k: "para"; p: boolean; s: number; e: number; runs: Run[] }
  | { k: "el"; tag: string; attrs: [string, string][]; kids: Block[] }
  | { k: "raw"; html: string };

export interface ArticleText {
  text: string;
  blocks: Block[];
  /** The links to other articles, in reading order. */
  links: { range: Range; title: string }[];
}

const STRUCT = new Set(["ul", "ol", "li", "dl", "dt", "dd", "blockquote"]);
const OPAQUE = new Set(["table", "pre", "hr"]);

const attrsOf = (n: DomLike): [string, string][] => Array.from(n.attributes ?? [], (a) => [a.name, a.value]);
const same = (a: Mark[], b: Mark[]) => a.length === b.length && a.every((m, i) => m === b[i]);

export function buildText(root: DomLike): ArticleText {
  let text = "";
  let out: Block[] = [];
  const blocks = out;
  let para: { p: boolean; s: number; runs: Run[] } | null = null;
  let inP = false;
  /** A space is owed before the next text, in the marks it was written in. */
  let space: Mark[] | null = null;
  const marks: Mark[] = [];

  const push = (str: string, m: Mark[], math?: string) => {
    if (!para) {
      if (text) text += "\n\n";
      para = { p: inP, s: text.length, runs: [] };
    }
    if (space) {
      const sp = space;
      space = null;
      push(" ", sp);
    }
    const last = para.runs[para.runs.length - 1];
    const s = text.length;
    text += str;
    if (!math && last && !last.math && same(last.marks, m)) last.e = text.length;
    else para.runs.push(math ? { s, e: text.length, marks: m, math } : { s, e: text.length, marks: m });
  };
  const add = (raw: string) => {
    const t = raw.replace(/\s+/g, " ");
    const m = marks.slice();
    for (let i = 0; i < t.length; ) {
      if (t[i] === " ") {
        if (para) space ??= m;
        i++;
        continue;
      }
      let j = t.indexOf(" ", i);
      if (j < 0) j = t.length;
      push(t.slice(i, j), m);
      i = j;
    }
  };
  const flush = () => {
    if (para) out.push({ k: "para", ...para, e: text.length });
    para = null;
    space = null;
  };
  const visit = (n: DomLike) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) add(c.data ?? "");
      if (c.nodeType !== 1) continue;
      const tag = c.localName ?? "";
      if (tag === "math") {
        const t = (c.textContent ?? "").replace(/\s+/g, " ").trim();
        if (t) push(t, marks.slice(), c.outerHTML ?? "");
      } else if (OPAQUE.has(tag)) {
        flush();
        out.push({ k: "raw", html: c.outerHTML ?? "" });
      } else if (tag === "p") {
        flush();
        inP = true;
        visit(c);
        flush();
        inP = false;
      } else if (STRUCT.has(tag)) {
        flush();
        const el: Block = { k: "el", tag, attrs: attrsOf(c), kids: [] };
        out.push(el);
        const was = out;
        out = el.kids;
        visit(c);
        flush();
        out = was;
      } else if (tag === "br") add(" ");
      else {
        marks.push({ tag, attrs: attrsOf(c) });
        visit(c);
        marks.pop();
      }
    }
  };
  visit(root);
  flush();

  // A link is the runs inside one <a data-wiki>.
  const links: ArticleText["links"] = [];
  const seen = new Map<Mark, number>();
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.k === "el") walk(b.kids);
      if (b.k !== "para") continue;
      for (const r of b.runs) {
        const a = r.marks.find((m) => m.tag === "a" && m.attrs.some(([k]) => k === "data-wiki"));
        if (!a) continue;
        const i = seen.get(a);
        if (i !== undefined) links[i].range[1] = r.e;
        else {
          seen.set(a, links.length);
          links.push({ range: [r.s, r.e], title: a.attrs.find(([k]) => k === "data-wiki")![1] });
        }
      }
    }
  };
  walk(blocks);
  return { text, blocks, links };
}
