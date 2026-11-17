/** The text format: parsing, its errors, and export → import giving back the same tree. */
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FormatError, canonBody, parseDoc, serializeDoc } from "../src/core/format";
import { Doc, descendants, isStale, notesOf, sections, type NodeId } from "../src/core/model";
import { writeSeed, writeText, writeTree, type BuildOptions } from "../src/core/seed";
import { slugify } from "../src/core/text";
import type { SeedNode, SeedNote } from "../src/seed/types";
import type { Ref } from "../src/core/ref";
import { seed } from "../src/seed/tree";

const SAMPLE = `# Document title

Root body: one paragraph.

Another paragraph of the root.

## Top-level section title

Body paragraphs with an exact quote, another "quoted" bit, and a third quote. Inline markup is only *emphasis* and \`code\`.

^ "exact quote" gloss define: a few words shown inline
^ "another \\"quoted\\" bit" note why: one to three sentences shown in the margin.
^ "a third quote" passage: first paragraph of a longer inset note.

  A continuation paragraph, indented two spaces. Blank lines inside a note are
  allowed as long as the next non-blank line is still indented.
  ^ "continuation paragraph" note: a nested note, anchored in the note it is indented under.
    ^ "nested note" gloss: two deep
^ "Body paragraphs" note how would this fail?: a custom question as the lens.

### Child section title

Child body.

#### Grandchild

Deep.

## Second section

Last.
`;

/** A tree written into a fresh library: the library, and the tree's top. */
function build(top: SeedNode) {
  const doc = Doc.library("test");
  return { doc, id: writeTree(doc, top) };
}
function fromText(text: string, name: string, opts: BuildOptions = {}) {
  const doc = Doc.library("test");
  return { doc, id: writeText(doc, text, name, opts) };
}

const problems = (text: string, name = "doc.md"): string[] => {
  try {
    parseDoc(text, name);
    return [];
  } catch (err) {
    if (!(err instanceof FormatError)) throw err;
    return err.problems;
  }
};

describe("parsing", () => {
  it("reads headings as tree depth and ^ lines as notes, nested by indentation", () => {
    const d = parseDoc(SAMPLE);
    expect(d.title).toBe("Document title");
    expect(d.body).toBe("Root body: one paragraph.\n\nAnother paragraph of the root.");
    expect(d.children!.map((c) => c.title)).toEqual(["Top-level section title", "Second section"]);
    const top = d.children![0];
    expect(top.body).toBe('Body paragraphs with an exact quote, another "quoted" bit, and a third quote. Inline markup is only *emphasis* and `code`.');
    expect(top.children![0].title).toBe("Child section title");
    expect(top.children![0].children![0]).toEqual({ title: "Grandchild", body: "Deep." });
    const [a, b, c, e] = top.notes!;
    expect(a).toEqual({ quote: "exact quote", form: "gloss", lens: "define", body: "a few words shown inline" });
    expect(b).toMatchObject({ quote: 'another "quoted" bit', form: "note", lens: "why" });
    expect(c.form).toBe("passage");
    expect(c.lens).toBe("elaborate"); // absent means elaborate
    // Wrapped lines join with a space; paragraphs stay paragraphs.
    expect(c.body).toBe(
      "first paragraph of a longer inset note.\n\nA continuation paragraph, indented two spaces. Blank lines inside a note are allowed as long as the next non-blank line is still indented.",
    );
    expect(c.notes![0]).toMatchObject({ quote: "continuation paragraph", form: "note", body: "a nested note, anchored in the note it is indented under." });
    expect(c.notes![0].notes![0]).toMatchObject({ quote: "nested note", form: "gloss", body: "two deep" });
    expect(e).toMatchObject({ quote: "Body paragraphs", lens: "how would this fail?" });
  });

  it("builds a document with nothing stale, authored by the model, notes anchored to their first occurrence", () => {
    const { doc, id } = fromText(SAMPLE, "sample", { verb: "Import" });
    const snap = doc.snap();
    const mine = [id, ...descendants(snap, id)];
    expect(mine.filter((x) => isStale(snap, x as NodeId))).toEqual([]);
    expect(mine.every((x) => snap.nodes[x].by === "llm" && !snap.nodes[x].pinned)).toBe(true);
    const top = sections(snap, id)[0];
    const quoted = notesOf(snap, top).map((id) => snap.nodes[id].anchors[0]);
    for (const a of quoted) expect(a.text).toBe(a.quote);
    expect(quoted[0].start).toBe(snap.nodes[top].body.indexOf("exact quote"));
  });

  it("keeps a line break that ends in a backslash, and unescapes lines that start with # ^ or \\", () => {
    const d = parseDoc("# T\n\nfirst line\\\nsecond line\n\\# not a heading\n\\^ not a note\n\\\\ a backslash\n");
    expect(d.body).toBe("first line\nsecond line # not a heading ^ not a note \\ a backslash");
  });

  it("names the document, the line, the section and the quote when a quote is not in its parent", () => {
    const text = `# Doc\n\nRoot text.\n\n## Alpha\n\nAlpha body.\n\n^ "missing words" note: x\n^ "Alpha" passage: inner text\n  ^ "not inside" gloss: y\n`;
    expect(problems(text, "lib/doc.md")).toEqual([
      `lib/doc.md:9: in “Alpha”: quote not found: "missing words"`,
      `lib/doc.md:11: in “Alpha”, in the note on "Alpha": quote not found: "not inside"`,
    ]);
  });

  it("reports syntax problems with their lines, all at once", () => {
    const text = [
      "# Doc", "", "Body.", "", "### Too deep", "", "^ \"Body\" sidenote: x", "^ \"Body note: x", "^ Body note: x",
      "  ^ \"Body\" note: x", "^ \"Body\" note no colon", "", "# Second root",
    ].join("\n");
    const p = problems(text);
    expect(p).toHaveLength(7);
    expect(p[0]).toMatch(/^doc\.md:5: .*a level is skipped/);
    expect(p[1]).toMatch(/^doc\.md:7: unknown form "sidenote"/);
    expect(p[2]).toMatch(/^doc\.md:8: the quote is not closed/);
    expect(p[3]).toMatch(/^doc\.md:9: expected a "quoted" text/);
    expect(p[4]).toMatch(/^doc\.md:10: .*no note above it/);
    expect(p[5]).toMatch(/^doc\.md:11: expected ':'/);
    expect(p[6]).toMatch(/^doc\.md:13: a file has one "# " heading/);
    expect(problems("Just text.\n")[0]).toMatch(/text before the "# Title" heading/);
    expect(problems("")).toEqual([`doc.md: no "# Title" heading`]);
  });

  it("makes safe file names from titles and file names", () => {
    expect(slugify("Tuning & Temperament")).toBe("tuning-temperament");
    expect(slugify("Ça va? Déjà vu!")).toBe("ca-va-deja-vu");
    expect(slugify("../../etc/passwd")).toBe("etc-passwd");
    expect(slugify("***")).toBe("untitled");
  });
});

// ---- round trip ----

/** A small deterministic generator, driven by a seed fast-check chooses (and shrinks). */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]) => xs[int(xs.length)];
  return { int, pick, chance: (p: number) => next() < p };
}
const WORDS = ["tree", "node", "anchor", "merge", "stale", "a", "fork", "*gloss*", "`code`", "say", "it:", "“curly”", "x\\y", 'the "quoted"', '"', "\\", "#", "^", "##", "^up", "café", "end.", "->", "w:x", "a/b", "/up"];
const ARTICLES = ["Octopus", "Fixed-point combinator", "Star Wars: Episode IV", "C++", "AC/DC", "Café", 'The "Quoted" One', "Ends with a colon:", "W:x"];
const URLS = ["https://example.org/a?b=c", "http://x.y/z_(w)", "https://example.org/p#frag"];
const URL_TITLES = [undefined, "A page", 'Its "title": here'];

function randomTree(seed: number): SeedNode {
  const r = rng(seed);
  const line = () => Array.from({ length: 1 + r.int(7) }, () => r.pick(WORDS)).join(" ");
  const body = (max: number) => Array.from({ length: r.int(max + 1) }, () => Array.from({ length: 1 + (r.chance(0.2) ? 1 : 0) }, line).join("\n")).join("\n\n");
  const title = () => (r.chance(0.1) ? "" : Array.from({ length: 1 + r.int(4) }, () => r.pick(WORDS)).join(" "));
  const quoteIn = (text: string): string | null => {
    const spans = [...text.matchAll(/\S+/g)].map((m) => [m.index!, m.index! + m[0].length]);
    if (!spans.length) return null;
    const i = r.int(spans.length);
    const j = Math.min(spans.length - 1, i + r.int(4));
    return text.slice(spans[i][0], spans[j][1]);
  };
  const LENSES = ["elaborate", "define", "why", "example", "challenge", "what if it: fails?", 'a "quoted" lens', "a -> w:fake", "x -> y"];
  // Node targets are filled in once the whole tree exists (see below).
  const pending: { target?: Ref }[] = [];
  const target = (holder: { target?: Ref }) => {
    const k = r.int(10);
    if (k < 3) holder.target = { kind: "wiki", title: r.pick(ARTICLES), lang: r.chance(0.8) ? "en" : "fr" };
    else if (k < 5) {
      const title = r.pick(URL_TITLES);
      holder.target = { kind: "url", url: r.pick(URLS), ...(title ? { title } : {}) };
    } else if (k < 7) pending.push(holder);
  };
  const notes = (parent: string, depth: number): SeedNote[] | undefined => {
    const out: SeedNote[] = [];
    for (let i = r.int(depth === 0 ? 3 : 2); i >= 0 && parent; i--) {
      const quote = quoteIn(parent);
      if (!quote) break;
      if (r.chance(0.2)) {
        // A link: a target and no text.
        const link: SeedNote = { quote, form: "link", body: "" };
        do target(link);
        while (!link.target && !pending.includes(link));
        out.push(link);
        continue;
      }
      const b = body(2) || "short";
      const n: SeedNote = { quote, form: r.pick(["gloss", "note", "passage"] as const), lens: r.pick(LENSES), body: b };
      if (r.chance(0.3)) target(n);
      // Nest at least two deep now and then.
      const kids = depth < 2 && r.chance(0.5) ? notes(b, depth + 1) : undefined;
      if (kids?.length) n.notes = kids;
      out.push(n);
    }
    return out.length ? out : undefined;
  };
  const node = (depth: number): SeedNode => {
    const b = body(3);
    const n: SeedNode = { title: title(), body: b };
    if (r.chance(0.2)) target(n);
    const ns = notes(b, 0);
    if (ns) n.notes = ns;
    const kids = depth < 3 ? Array.from({ length: r.int(depth === 0 ? 4 : 3) }, () => node(depth + 1)) : [];
    if (kids.length) n.children = kids;
    return n;
  };
  const top = node(0);
  // A node target names a section of this tree by its titles below the top (relative, as the format
  // writes one inside the subtree it exports). Only sections reachable by unique titles: a path is
  // read by the first title that matches, so a duplicate title names its first holder.
  const paths: string[][] = [[]];
  const walk = (n: SeedNode, path: string[]) => {
    const seen = new Set<string>();
    for (const c of n.children ?? []) {
      const first = !seen.has(c.title);
      seen.add(c.title);
      if (!first || !c.title.trim()) continue;
      paths.push([...path, c.title]);
      walk(c, [...path, c.title]);
    }
  };
  walk(top, []);
  for (const h of pending) h.target = { kind: "node", path: r.pick(paths), rel: true };
  return top;
}

const depthOfNotes = (n: SeedNote | SeedNode): number => Math.max(0, ...(n.notes ?? []).map((c) => 1 + depthOfNotes(c)), ...("children" in n ? (n.children ?? []).map(depthOfNotes) : []));

describe("export and import", () => {
  it("round-trips random trees: same shape, same text the second time", () => {
    let deep = 0;
    const kinds = new Set<string>();
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
        const tree = randomTree(seed);
        if (depthOfNotes(tree) >= 3) deep++;
        const a = build(tree);
        const { text, skipped } = serializeDoc(a.doc.snap(), a.id);
        expect(skipped).toEqual({ orphans: 0, inNotes: 0 });
        for (const m of text.matchAll(/ -> ("?)(w[.:]|\.\/|https?)/g)) kinds.add(m[2].replace(/s$/, ""));
        if (/\^ "[^\n]*" link -> /.test(text)) kinds.add("link");
        if (/^#+ .* -> /m.test(text)) kinds.add("heading");
        expect(parseDoc(text)).toEqual(tree);
        const b = fromText(text, `seed ${seed}`);
        expect(b.doc.shape(undefined, b.id)).toBe(a.doc.shape(undefined, a.id));
        expect(serializeDoc(b.doc.snap(), b.id).text).toBe(text);
      }),
      { numRuns: 120 },
    );
    expect(deep).toBeGreaterThan(5); // notes nested two deep under a note were exercised
    // Every kind of target was written and read back: Wikipedia (two languages), a node path, a URL, links, headings.
    expect([...kinds].sort()).toEqual(["./", "heading", "http", "link", "w.", "w:"].sort());
  }, 60_000);

  it("exports the current text of each anchor, and skips orphaned notes and sections under notes, counting them", () => {
    const { doc, id } = fromText(SAMPLE, "sample");
    let snap = doc.snap();
    const top = sections(snap, id)[0];
    const [gloss, , passage] = notesOf(snap, top);
    // Edit inside an anchor (it follows the words), delete another's words (orphaned), and hang a section under a note.
    const body = snap.nodes[top].body.replace("exact quote", "exact, edited quote").replace("Body paragraphs", "Words");
    doc.apply([{ op: "update", id: top, body }, { op: "create", parent: passage, kind: "section", title: "Under a note", body: "x" }], "edit");
    snap = doc.snap();
    expect(snap.nodes[gloss].anchors[0].text).toBe("exact, edited quote");
    const { text, skipped } = serializeDoc(snap, id);
    expect(skipped).toEqual({ orphans: 1, inNotes: 1 });
    expect(text).toContain(`^ "exact, edited quote" gloss define:`);
    expect(text).not.toContain("Under a note");
    const again = fromText(text, "again");
    const s2 = again.doc.snap();
    expect(notesOf(s2, sections(s2, again.id)[0])).toHaveLength(3);
  });

  it("writes bodies the parser would read back: blank lines collapsed, lines trimmed", () => {
    expect(canonBody("  one  \n two\n\n\n\nthree \n \n")).toBe("one\ntwo\n\nthree");
  });

  it("exports the first tree without losing a note", () => {
    const prompt = readFileSync(new URL("../src/seed/prompt.txt", import.meta.url), "utf8");
    const doc = Doc.library("test");
    const first = writeSeed(doc, prompt, seed);
    const { text, skipped } = serializeDoc(doc.snap(), first);
    expect(skipped).toEqual({ orphans: 0, inNotes: 0 });
    const back = fromText(text, "infinite-expand");
    const count = (d: Doc, id: NodeId, kind: string) => descendants(d.snap(), id).filter((x) => d.snap().nodes[x].kind === kind).length;
    expect(count(back.doc, back.id, "note")).toBe(count(doc, first, "note"));
    expect(count(back.doc, back.id, "section")).toBe(count(doc, first, "section"));
  });
});

describe("node targets in the text format", () => {
  const A = `# Alpha\n\nAlpha text, which mentions Beta.\n\n^ "Beta" link -> /Beta/Gamma\n\n## Part\n\nThe part, which mentions the leaf.\n\n^ "the leaf" link -> ./Part/Leaf\n\n### Leaf\n\nThe leaf.\n`;
  const B = `# Beta\n\nBeta text.\n\n## Gamma\n\nGamma text.\n`;

  it("writes a path from the library root, or below the exported subtree's top with ./, and reads both back", () => {
    const doc = Doc.library("test");
    const b = writeText(doc, B, "beta.md");
    const a = writeText(doc, A, "alpha.md");
    let snap = doc.snap();
    const part = sections(snap, a)[0];
    const leaf = sections(snap, part)[0];
    const gamma = sections(snap, b)[0];
    const [toBeta] = notesOf(snap, a);
    const [toLeaf] = notesOf(snap, part);
    expect(snap.nodes[toBeta].ref).toEqual({ kind: "node", id: gamma, path: ["Beta", "Gamma"] });
    expect(snap.nodes[toLeaf].ref).toEqual({ kind: "node", id: leaf, path: ["Alpha", "Part", "Leaf"] });
    expect(serializeDoc(snap, a).text).toBe(A);
    // Exported from lower down, a path inside the subtree is relative to it; one outside it is from the root.
    const lower = serializeDoc(snap, part).text;
    expect(lower).toContain(`^ "the leaf" link -> ./Leaf`);
    // Moved elsewhere, the target is written from where it is now.
    doc.apply([{ op: "move", id: gamma, parent: a }], "Move");
    snap = doc.snap();
    expect(serializeDoc(snap, a).text).toContain(`^ "Beta" link -> ./Gamma`);
  });

  it("reads a relative path in its own tree, even where another top has the same titles", () => {
    const doc = Doc.library("test");
    const first = writeText(doc, A, "alpha.md");
    const second = writeText(doc, A, "alpha-again.md");
    const snap = doc.snap();
    const leafOf = (top: NodeId) => sections(snap, sections(snap, top)[0])[0];
    const linkIn = (top: NodeId) => snap.nodes[notesOf(snap, sections(snap, top)[0])[0]].ref;
    expect(linkIn(first)).toMatchObject({ id: leafOf(first) });
    expect(linkIn(second)).toMatchObject({ id: leafOf(second) });
    // A path to a tree that is not there yet is kept, and found when it arrives.
    const b = writeText(doc, B, "beta.md");
    expect(doc.snap().nodes[notesOf(doc.snap(), first)[0]].ref).toMatchObject({ id: sections(doc.snap(), b)[0] });
  });
});
