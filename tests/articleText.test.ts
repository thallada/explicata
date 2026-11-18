/**
 * Article HTML as selectable text (src/ui/articleText.ts), on the mock articles as the server
 * sanitises them, parsed with parse5 in place of the browser's DOMParser: what is text, what is
 * not, links and formulas, and that every sentence anchors and re-anchors to itself.
 */
import { parseFragment, serializeOuter, type DefaultTreeAdapterTypes as T } from "parse5";
import { describe, expect, it } from "vitest";
import { makeAnchor, reanchor } from "../src/core/article";
import { sentences } from "../src/core/text";
import { buildText, type Block, type DomLike } from "../src/ui/articleText";
import { WikiClient } from "../server/wiki";
import { mockWikiFetch } from "../server/wikiMock";

/** A parse5 node as the little of the DOM the walk uses. */
function adapt(n: T.Node): DomLike {
  if (n.nodeName === "#text") return { nodeType: 3, data: (n as T.TextNode).value, textContent: (n as T.TextNode).value, childNodes: [] };
  if (!("tagName" in n)) return { nodeType: 8, textContent: "", childNodes: "childNodes" in n ? (n as T.ParentNode).childNodes.map(adapt) : [] };
  const el = n as T.Element;
  const text = (x: T.Node): string => (x.nodeName === "#text" ? (x as T.TextNode).value : "childNodes" in x ? (x as T.Element).childNodes.map(text).join("") : "");
  return { nodeType: 1, localName: el.tagName, textContent: text(el), childNodes: el.childNodes.map(adapt), attributes: el.attrs, outerHTML: serializeOuter(el) };
}
const build = (html: string) => buildText({ nodeType: 11, textContent: "", childNodes: parseFragment(html).childNodes.map(adapt) });

async function article(title: string) {
  const r = await new WikiClient({ fetch: mockWikiFetch, spacingMs: 0, persist: false, offlineHoldMs: 0 }).article(title, { sections: true });
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

const kinds = (bs: Block[]): string[] => bs.flatMap((b) => (b.k === "el" ? [b.tag, ...kinds(b.kids)] : [b.k]));

describe("article text", () => {
  it("is the paragraphs' visible text, links as ranges of it, a formula as one run", async () => {
    const a = await article("Fixed-point combinator");
    const lead = build(a.lead);
    expect(lead.text).toMatch(/^In mathematics and computer science, a fixed-point combinator \(or fixpoint combinator\) is a higher-order function that, given a function f, returns a fixed point of f: a value x with f\(x\) = x\. In the untyped lambda calculus/);
    expect(lead.text).not.toMatch(/ {2}|\n(?!\n)|\[1\]/);
    expect(lead.links.map((l) => [lead.text.slice(...l.range), l.title])).toEqual([
      ["lambda calculus", "Lambda calculus"],
      ["Haskell Curry", "Haskell Curry"],
      ["recursion", "Recursion (computer science)"],
    ]);
    const y = build(a.sections.find((s) => s.heading === "Y combinator")!.html);
    const runs = y.blocks.flatMap((b) => (b.k === "para" ? b.runs : []));
    const math = runs.filter((r) => r.math);
    expect(math).toHaveLength(1);
    expect(y.text.slice(math[0].s, math[0].e)).toBe("Y=λf.(λx.f(xx))(λx.f(xx))");
    expect(math[0].math).toMatch(/^<math/);
    // Code and italics are inline runs of the same text.
    expect(runs.some((r) => r.marks.some((m) => m.tag === "code") && y.text.slice(r.s, r.e) === "(λx.x x)(λx.x x)")).toBe(true);
  });

  it("makes a paragraph of each list item; a table is shown but carries no text", async () => {
    const m = build((await article("Mercury")).lead);
    expect(kinds(m.blocks)).toEqual(["para", "ul", "li", "para", "li", "para", "li", "para"]);
    expect(m.text.split("\n\n")).toEqual(["Mercury commonly refers to:", "Mercury (planet), the planet closest to the Sun", "Mercury (element), a metallic chemical element with the symbol Hg", "Mercury (mythology), a Roman god"]);
    const t = build(`<p>Before.</p><table><tbody><tr><td>cell text</td></tr></tbody></table><p>After <i>it</i>.</p><pre>code  block</pre>`);
    expect(t.text).toBe("Before.\n\nAfter it.");
    expect(kinds(t.blocks)).toEqual(["para", "raw", "para", "raw"]);
  });

  it("keeps every paragraph's offsets in its runs, and every sentence of every section anchors back to itself", async () => {
    for (const title of ["Fixed-point combinator", "Octopus", "Hoyle state", "Mercury", "Carbon-12"]) {
      const a = await article(title);
      const secs = [{ path: [] as string[], html: a.lead }, ...a.sections.map((s) => ({ path: [s.heading], html: s.html }))].map((s) => ({ path: s.path, t: build(s.html) }));
      for (const [i, s] of secs.entries()) {
        const paras = s.t.blocks.flatMap(function all(b: Block): Block[] {
          return b.k === "el" ? b.kids.flatMap(all) : [b];
        }).filter((b) => b.k === "para");
        for (const p of paras) if (p.k === "para") expect(p.runs.map((r) => s.t.text.slice(r.s, r.e)).join("")).toBe(s.t.text.slice(p.s, p.e));
        for (const r of sentences(s.t.text)) {
          const got = reanchor(makeAnchor(s.t.text, r, s.path, a.revisionId), secs.map((x) => ({ path: x.path, text: x.t.text })));
          expect(got).toEqual({ sec: i, range: r });
        }
      }
    }
  });

  it("an annotation made on an article's text before pictures were kept lands on the same words once its figures' captions are text too", async () => {
    // Grey heron as the sanitiser now makes it, and as the old one did (the same text, no figures).
    const a = await article("Grey heron");
    const parts = [{ path: [] as string[], html: a.lead }, ...a.sections.map((s) => ({ path: [s.heading], html: s.html }))];
    const now = parts.map((p) => ({ path: p.path, t: build(p.html) }));
    const before = parts.map((p) => ({ path: p.path, t: build(p.html.replace(/<figure[^]*?<\/figure>/g, "").replace(/<p>Herons at the weir<\/p>/, "")) }));
    expect(now[0].t.text.startsWith("An adult at a weir\n\nThe grey heron")).toBe(true);
    expect(before[0].t.text.startsWith("The grey heron")).toBe(true);
    const secsNow = now.map((x) => ({ path: x.path, text: x.t.text }));
    let checked = 0;
    for (const [i, s] of before.entries()) {
      // Every sentence, and a word the captions also use ("weir", "heron"), wherever it occurs.
      const ranges = [...sentences(s.t.text), ...[...s.t.text.matchAll(/\b(weir|heron)\b/g)].map((m): [number, number] => [m.index!, m.index! + m[0].length])];
      for (const r of ranges) {
        const anchor = makeAnchor(s.t.text, r, s.path, a.revisionId);
        const got = reanchor(anchor, secsNow);
        if ("detached" in got) throw new Error(`detached: ${anchor.q}`);
        expect(got.sec).toBe(i);
        // The same words, in the same place: the text around them is the text that was around them.
        const t = secsNow[got.sec].text;
        expect(t.slice(...got.range)).toBe(anchor.q);
        expect(t.slice(Math.max(0, got.range[0] - anchor.pre.length), got.range[0])).toBe(anchor.pre);
        expect(t.slice(got.range[1], got.range[1] + anchor.post.length)).toBe(anchor.post);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});
