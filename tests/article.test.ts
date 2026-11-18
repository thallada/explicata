/**
 * Annotations on Wikipedia articles and web pages: finding an anchor again in a later revision (or
 * a page read again, or arranged by a model and so cut into other sections), and the article and
 * page nodes in the library, with the data kept before pages could be annotated still read as it was.
 */
import fc from "fast-check";
import { parseFragment, type DefaultTreeAdapterTypes as T } from "parse5";
import { describe, expect, it } from "vitest";
import { CONTAINER_TITLE, annotationsOf, articleNodes, articleParent, containers, fold, inArticles, makeAnchor, pageRev, reanchor, type ArticleKey, type SectionText } from "../src/core/article";
import { Doc, isStale, staleness, tops, type NodeId, type Op } from "../src/core/model";
import { mergeUpdate, verifyHistory } from "../src/core/repo";
import { sentences, type Range } from "../src/core/text";
import { mockLLM } from "../src/llm/mock";
import { buildText, type DomLike } from "../src/ui/articleText";
import { pageSectionTexts } from "../src/ui/web";
import { PageClient, type WebArticle } from "../server/page";
import { Arranger, DailyBudget } from "../server/pageArrange";
import { MOCK_CHANGING_LINE, MOCK_PAGES, makeMockPageFetch } from "../server/pageMock";

// ---- re-anchoring ----

const VOCAB = ["the", "octopus", "arm", "tastes", "what", "it", "touches", "nerve", "cord", "brain", "sucker", "Ink", "Hoyle", "state", "of", "carbon-12", "fusion", "star"];
const PUNCT = [" ", " ", " ", ", ", ". ", "; ", " (", ") "];

/** A random text of words and punctuation. */
const textArb = fc.array(fc.tuple(fc.constantFrom(...VOCAB), fc.constantFrom(...PUNCT)), { minLength: 8, maxLength: 60 }).map((ws) => ws.map(([w, p]) => w + p).join("").trim());

/** A quote of whole words from the text: its range. */
function wordsRange(text: string, from: number, count: number): Range | null {
  const ws = [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu)];
  if (!ws.length) return null;
  const a = ws[from % ws.length];
  const b = ws[Math.min(ws.length - 1, (from % ws.length) + count - 1)];
  return [a.index!, b.index! + b[0].length];
}

/** An edit to a text: insert, delete or replace a span. Tracks where a range moves, or that it was touched. */
type Edit = { at: number; del: number; ins: string };
const editArb = fc.record({ at: fc.nat(), del: fc.nat({ max: 12 }), ins: fc.oneof(fc.constant(""), fc.constantFrom(...VOCAB).map((w) => ` ${w} `), fc.string({ maxLength: 6 })) });

function applyEdit(text: string, e: Edit, r: Range | null): { text: string; r: Range | null } {
  const at = e.at % (text.length + 1);
  const del = Math.min(e.del, text.length - at);
  const out = text.slice(0, at) + e.ins + text.slice(at + del);
  if (!r) return { text: out, r };
  const shift = e.ins.length - del;
  // An edit touching the quote, or right at its edges, may change its words: stop tracking it.
  if (at + del >= r[0] && at <= r[1]) return { text: out, r: null };
  return { text: out, r: at < r[0] ? [r[0] + shift, r[1] + shift] : r };
}

describe("reanchor", () => {
  it("finds the quote where it moved to while it survives, and never puts it on other words", () => {
    fc.assert(
      fc.property(textArb, fc.nat(), fc.integer({ min: 1, max: 4 }), fc.array(editArb, { maxLength: 8 }), (text, from, count, edits) => {
        const r = wordsRange(text, from, count);
        if (!r) return;
        const a = makeAnchor(text, r, ["Section"], 1);
        let cur: { text: string; r: Range | null } = { text, r };
        for (const e of edits) cur = applyEdit(cur.text, e, cur.r);
        const secs: SectionText[] = [{ path: [], text: "A lead with nothing in it." }, { path: ["Section"], text: cur.text }];
        const got = reanchor(a, secs);
        if ("detached" in got) {
          // Detached only when the words are nowhere, even tolerantly.
          expect(fold(cur.text).s.includes(fold(a.q).s) && cur.r !== null).toBe(false);
          return;
        }
        // Wherever it lands, it is on the same words (up to case, punctuation and spacing).
        const landed = secs[got.sec].text.slice(got.range[0], got.range[1]);
        expect(fold(landed).s).toBe(fold(a.q).s);
        // While the quote survived untouched and occurs once, it is found exactly there.
        const once = cur.text.indexOf(a.q) >= 0 && cur.text.indexOf(a.q) === cur.text.lastIndexOf(a.q);
        if (cur.r && once) expect(got).toEqual({ sec: 1, range: cur.r });
      }),
      { numRuns: 1500 },
    );
  });

  it("reports an anchor detached when its words were deleted, never anchoring it elsewhere", () => {
    fc.assert(
      fc.property(textArb, fc.nat(), fc.integer({ min: 1, max: 3 }), fc.array(editArb, { maxLength: 5 }), (text, from, count, edits) => {
        const r = wordsRange(text, from, count);
        if (!r) return;
        const a = makeAnchor(text, r, ["Section"], 1);
        let cur = text.slice(0, r[0]) + text.slice(r[1]);
        for (const e of edits) cur = applyEdit(cur, e, null).text;
        // Take out every remaining occurrence too, in any case or spacing.
        const fq = fold(a.q).s;
        for (let guard = 0; fold(cur).s.includes(fq) && guard < 50; guard++) {
          const f = fold(cur);
          const i = f.s.indexOf(fq);
          cur = cur.slice(0, f.at[i]) + cur.slice(f.at[i + fq.length - 1] + 1);
        }
        const got = reanchor(a, [{ path: [], text: "Lead." }, { path: ["Section"], text: cur }]);
        expect(got).toEqual({ detached: true, sec: 1 });
      }),
      { numRuns: 1000 },
    );
  });

  it("prefers its own section, then the same words elsewhere, then a tolerant match; tells repeats apart by context", () => {
    const secs: SectionText[] = [
      { path: [], text: "The Hoyle state is an excited state of carbon-12." },
      { path: ["Prediction"], text: "Hoyle predicted the state. Later, the state was found." },
      { path: ["Structure"], text: "Its structure: three alpha particles." },
    ];
    const at = (sec: number, q: string, nth = 0) => {
      let i = -1;
      for (let k = 0; k <= nth; k++) i = secs[sec].text.indexOf(q, i + 1);
      return makeAnchor(secs[sec].text, [i, i + q.length], secs[sec].path, 7);
    };
    // The second "the state" in Prediction, by its context.
    expect(reanchor(at(1, "the state", 1), secs)).toEqual({ sec: 1, range: [34, 43] });
    // Moved to another section.
    expect(reanchor({ ...at(2, "three alpha particles"), sec: ["Prediction"] }, secs)).toEqual({ sec: 2, range: [15, 36] });
    // Edited: case and punctuation differ.
    const edited = secs.map((s, i) => (i === 2 ? { ...s, text: "Its structure: Three-alpha particles, loosely bound." } : s));
    const r = reanchor(at(2, "three alpha particles"), edited);
    expect("range" in r && edited[2].text.slice(r.range[0], r.range[1])).toBe("Three-alpha particles");
    // Not inside another word.
    expect(reanchor(makeAnchor("a state b", [2, 7], [], 1), [{ path: [], text: "restated twice" }])).toEqual({ detached: true, sec: 0 });
    // Its section gone: detached with no section.
    expect(reanchor({ ...at(2, "three alpha particles"), q: "gone words" }, secs.slice(0, 2))).toEqual({ detached: true, sec: null });
  });
});

// ---- the article nodes ----

const OCTOPUS: ArticleKey = { lang: "en", title: "Octopus", pageId: 1200106 };

/** One annotation on an article, with whatever the library lacks for it, in one commit. */
function annotate(doc: Doc, a: ArticleKey, q: string, body = `About ${q}.`): NodeId {
  const { ops, parent } = articleParent(doc.snap(), a);
  const note: Op = { op: "create", parent, kind: "note", form: "gloss", body, wanchor: { sec: [], q, pre: "", post: "", rev: 1 } };
  const { created } = doc.apply([...ops, note], `Annotate ${q}`, { actor: "llm" });
  return created[created.length - 1];
}

function library() {
  const doc = Doc.library("tester");
  doc.apply([{ op: "create", parent: doc.snap().root, title: "Minds", body: "An octopus has arms." }], "Base");
  return doc;
}

const sync = (a: Doc, b: Doc) => {
  mergeUpdate(a, b.loro.export({ mode: "update", from: a.loro.version() }), b.loro.version().toJSON());
  mergeUpdate(b, a.loro.export({ mode: "update", from: b.loro.version() }), a.loro.version().toJSON());
};

describe("article nodes", () => {
  it("are made on the first annotation, once; the container is not one of the root's sections and nothing in it goes stale", () => {
    const doc = library();
    const before = tops(doc.snap());
    expect(containers(doc.snap())).toEqual([]);
    const first = annotate(doc, OCTOPUS, "arms");
    const second = annotate(doc, { lang: "en", title: "octopus" }, "suckers");
    const snap = doc.snap();
    expect(containers(snap)).toHaveLength(1);
    expect(articleNodes(snap, OCTOPUS)).toHaveLength(1);
    expect(annotationsOf(snap, OCTOPUS)).toEqual([first, second]);
    // Found by page id under another title (a rename), and not by a different page id.
    expect(articleNodes(snap, { lang: "en", title: "Octopodes", pageId: 1200106 })).toHaveLength(1);
    expect(articleNodes(snap, { lang: "fr", title: "Octopus" })).toHaveLength(0);
    // Not one of the root's sections: not listed, no count.
    expect(tops(snap)).toEqual(before);
    expect(tops(snap)).toHaveLength(1);
    const box = containers(snap)[0];
    expect(inArticles(snap, first) && inArticles(snap, box) && !inArticles(snap, tops(snap)[0])).toBe(true);
    for (const id of [box, articleNodes(snap, OCTOPUS)[0], first, second]) expect(isStale(snap, id)).toBe(false);
    // An annotation is edited like any note, and stays fresh.
    doc.apply([{ op: "update", id: first, body: "Eight of them." }], "Edit");
    expect(staleness(doc.snap(), first)).toEqual({ up: false, down: false, orphan: false });
    expect(verifyHistory(doc).mismatches).toEqual([]);
  });

  it("two replicas annotating the same new article converge, and read as one article", () => {
    const doc = library();
    const other = doc.fork("other");
    const mine = annotate(doc, OCTOPUS, "arms");
    const theirs = annotate(other, OCTOPUS, "ink");
    sync(doc, other);
    expect(doc.stateHash()).toBe(other.stateHash());
    for (const d of [doc, other]) {
      const snap = d.snap();
      // Each made the container and the article's node; both are kept, and read as one.
      expect(articleNodes(snap, OCTOPUS)).toHaveLength(2);
      expect(new Set(annotationsOf(snap, OCTOPUS))).toEqual(new Set([mine, theirs]));
      expect(tops(snap)).toHaveLength(1);
    }
    // The next annotation goes under the same node on either replica.
    expect(articleParent(doc.snap(), OCTOPUS)).toEqual(articleParent(other.snap(), OCTOPUS));
    expect(articleParent(doc.snap(), OCTOPUS).ops).toEqual([]);
  });

  it("an article anchor is checked like any op input", () => {
    const doc = library();
    const { ops, parent } = articleParent(doc.snap(), OCTOPUS);
    expect(() => doc.apply([...ops, { op: "create", parent, kind: "note", body: "x", wanchor: { sec: "lead", q: "x", pre: "", post: "", rev: 1 } as never }], "Bad")).toThrow(/headings/);
    expect(() => doc.apply([{ op: "create", parent: tops(doc.snap())[0], title: "Box", articles: true }], "Bad")).toThrow(/container/);
  });
});

// ---- web pages ----

const PAGE: ArticleKey = { url: "https://tracing.example.org/posts/following-a-request", title: "Following one request" };

describe("page nodes", () => {
  it("are filed by address as normUrl compares them, beside the articles in the one container, their target the page", () => {
    const doc = library();
    const art = annotate(doc, OCTOPUS, "arms");
    const first = annotate(doc, PAGE, "the request");
    const second = annotate(doc, { url: `${PAGE.url}/#the-queue` }, "a queue");
    const snap = doc.snap();
    expect(containers(snap)).toHaveLength(1);
    expect(snap.nodes[containers(snap)[0]].title).toBe(CONTAINER_TITLE);
    const nodes = articleNodes(snap, PAGE);
    expect(nodes).toHaveLength(1);
    expect(articleNodes(snap, { url: `${PAGE.url}#x` })).toEqual(nodes);
    expect(snap.nodes[nodes[0]].ref).toEqual({ kind: "url", url: PAGE.url, title: "Following one request" });
    expect(snap.nodes[nodes[0]].title).toBe("Following one request");
    expect(annotationsOf(snap, PAGE)).toEqual([first, second]);
    expect(annotationsOf(snap, OCTOPUS)).toEqual([art]);
    // Another page, or an article titled as the page's address, is not this page.
    expect(articleNodes(snap, { url: "https://tracing.example.org/posts/another" })).toEqual([]);
    expect(articleNodes(snap, { lang: "en", title: PAGE.url })).toEqual([]);
    // A page with no title known is named by its address.
    annotate(doc, { url: "https://notes.example.org/a" }, "words");
    expect(doc.snap().nodes[articleNodes(doc.snap(), { url: "https://notes.example.org/a" })[0]].title).toBe("https://notes.example.org/a");
    // Like an article's: not one of the root's sections, nothing in it goes stale.
    expect(tops(doc.snap())).toHaveLength(1);
    expect(inArticles(snap, first) && inArticles(snap, nodes[0])).toBe(true);
    for (const id of [nodes[0], first, second]) expect(isStale(snap, id)).toBe(false);
    expect(verifyHistory(doc).mismatches).toEqual([]);
  });

  it("the data kept before pages could be annotated reads as it did: the container titled Wikipedia keeps its articles' notes, and takes pages' too", () => {
    const doc = library();
    const root = doc.snap().root;
    // As the app wrote it then: the container, an article's node, an annotation.
    const anchor = { sec: ["Description"], q: "eight arms", pre: "has ", post: ".", rev: 1180000000 };
    const { created } = doc.apply(
      [
        { op: "create", parent: root, kind: "section", title: "Wikipedia", body: "", articles: true },
        { op: "create", parent: "$0" as NodeId, kind: "section", title: "Octopus", body: "", ref: { kind: "wiki", lang: "en", title: "Octopus", pageId: 1200106 } },
        { op: "create", parent: "$1" as NodeId, kind: "note", form: "note", body: "Old.", wanchor: anchor },
      ],
      "Annotate before pages",
      { actor: "llm" },
    );
    expect(annotationsOf(doc.snap(), OCTOPUS)).toEqual([created[2]]);
    expect(articleParent(doc.snap(), OCTOPUS)).toEqual({ ops: [], parent: created[1] });
    const page = annotate(doc, PAGE, "the request");
    const snap = doc.snap();
    expect(containers(snap)).toEqual([created[0]]);
    expect(snap.nodes[created[0]].title).toBe("Wikipedia");
    expect(snap.nodes[articleNodes(snap, PAGE)[0]].parent).toBe(created[0]);
    expect(annotationsOf(snap, OCTOPUS)).toEqual([created[2]]);
    expect(annotationsOf(snap, PAGE)).toEqual([page]);
    expect(snap.nodes[created[2]].wanchor).toEqual(anchor);
  });

  it("a page's copy is an anchor's revision as a whole number taken from its content's digest", () => {
    expect(pageRev("00ff00ff00ff1234")).toBe(0x00ff00ff00ff);
    expect(pageRev("ffffffffffffffff")).toBe(0xffffffffffff);
    expect(pageRev("")).toBe(0);
    expect(pageRev("not hex")).toBe(0);
    const doc = library();
    const { ops, parent } = articleParent(doc.snap(), PAGE);
    const wanchor = { sec: [], q: "x", pre: "", post: "", rev: pageRev("ffffffffffffffff") };
    const { created } = doc.apply([...ops, { op: "create", parent, kind: "note", body: "y", wanchor }], "Page note");
    expect(doc.snap().nodes[created[created.length - 1]].wanchor).toEqual(wanchor);
  });
});

/** A parse5 node as the little of the DOM the text walk uses (as in articleText.test.ts). */
function adapt(n: T.Node): DomLike {
  if (n.nodeName === "#text") return { nodeType: 3, data: (n as T.TextNode).value, textContent: (n as T.TextNode).value, childNodes: [] };
  if (!("tagName" in n)) return { nodeType: 8, textContent: "", childNodes: [] };
  const el = n as T.Element;
  const text = (x: T.Node): string => (x.nodeName === "#text" ? (x as T.TextNode).value : "childNodes" in x ? (x as T.Element).childNodes.map(text).join("") : "");
  return { nodeType: 1, localName: el.tagName, textContent: text(el), childNodes: el.childNodes.map(adapt), attributes: el.attrs, outerHTML: "" };
}
const textOfHtml = (html: string) => buildText({ nodeType: 11, textContent: "", childNodes: parseFragment(html).childNodes.map(adapt) }).text;

async function read(pages: PageClient, url: string): Promise<WebArticle> {
  const r = await pages.article(url);
  if (!r.ok) throw new Error(`could not read ${url}`);
  return r.value;
}

/** The page's text as a whole, its sections joined as one, and where each section starts in it. */
function whole(secs: SectionText[]) {
  let at = 0;
  const off = secs.map((s) => {
    const o = at;
    if (s.text) at += s.text.length + 2;
    return o;
  });
  return { text: secs.map((s) => s.text).filter(Boolean).join("\n\n"), off };
}

describe("notes on a web page's words", () => {
  it("with their section gone (a page cut anew), are taken where their surroundings agree best, in whichever section", () => {
    const secs: SectionText[] = [
      { path: [], text: "A lead." },
      { path: ["Before it the tide…"], text: "Before it the tide turned. After that, nothing." },
      { path: ["The keeper saw the…"], text: "The keeper saw the tide turned at dawn." },
    ];
    const a = makeAnchor(secs[2].text, [15, 30], ["Mock part two"], 1);
    expect(reanchor(a, secs)).toEqual({ sec: 2, range: [15, 30] });
  });

  it("are found again when a model arranges the page, which cuts it into other sections: on the same words, wherever they now are", async () => {
    const pages = new PageClient({ fetch: makeMockPageFetch(), spacingMs: 0, persist: false });
    const before = await read(pages, MOCK_PAGES.essay);
    expect(before.outline).toBe("chunks");
    const arranged = await new Arranger({ pages: () => pages, llm: () => mockLLM(), budget: new DailyBudget(null, 20) }).arrange(MOCK_PAGES.essay);
    if (!arranged.ok) throw new Error(arranged.message);
    const after = arranged.article;
    expect(after.outline).toBe("model");
    const a = pageSectionTexts(before, textOfHtml);
    const b = pageSectionTexts(after, textOfHtml);
    expect(b.ids).toEqual([null, "m1", "m2", "m3"]);
    expect(b.secs.map((s) => s.path)).not.toEqual(a.secs.map((s) => s.path));
    const wa = whole(a.secs);
    const wb = whole(b.secs);
    // The same words, cut elsewhere.
    expect(wb.text).toBe(wa.text);
    let checked = 0;
    a.secs.forEach((s, i) => {
      for (const r of sentences(s.text)) {
        const anchor = makeAnchor(s.text, r, s.path, pageRev(before.hash));
        const got = reanchor(anchor, b.secs);
        if ("detached" in got) throw new Error(`lost “${anchor.q}”`);
        expect(b.secs[got.sec].text.slice(got.range[0], got.range[1])).toBe(anchor.q);
        // Words found once in the page are found exactly where they are.
        if (wa.text.indexOf(anchor.q) === wa.text.lastIndexOf(anchor.q)) expect(wb.off[got.sec] + got.range[0]).toBe(wa.off[i] + r[0]);
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(50);
  });

  it("read again with other text: a note whose words remain is found in the parts as they are now cut; one whose words are gone is detached", async () => {
    const pages = new PageClient({ fetch: makeMockPageFetch(), spacingMs: 0, persist: false });
    const first = await read(pages, MOCK_PAGES.changing);
    expect(first.outline).toBe("chunks");
    const a = pageSectionTexts(first, textOfHtml);
    const i = a.secs.findIndex((s) => s.text.includes(MOCK_CHANGING_LINE));
    const at = a.secs[i].text.indexOf(MOCK_CHANGING_LINE);
    const gone = makeAnchor(a.secs[i].text, [at, at + MOCK_CHANGING_LINE.length], a.secs[i].path, pageRev(first.hash));
    const last = a.secs[a.secs.length - 1];
    const kept = makeAnchor(last.text, sentences(last.text).at(-1)!, last.path, pageRev(first.hash));
    const again = await pages.reload(MOCK_PAGES.changing);
    if (!again.ok) throw new Error("the page was not read again");
    const second = again.value;
    expect(pageRev(second.hash)).not.toBe(pageRev(first.hash));
    const b = pageSectionTexts(second, textOfHtml);
    expect(b.secs.map((s) => s.path)).not.toEqual(a.secs.map((s) => s.path));
    expect(reanchor(gone, b.secs)).toMatchObject({ detached: true });
    const got = reanchor(kept, b.secs);
    expect("range" in got && b.secs[got.sec].text.slice(got.range[0], got.range[1])).toBe(kept.q);
  });
});
