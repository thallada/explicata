/** Annotations on Wikipedia articles: finding an anchor again in a later revision, and the article nodes in the library. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { annotationsOf, articleNodes, articleParent, containers, fold, inArticles, makeAnchor, reanchor, type ArticleKey, type SectionText } from "../src/core/article";
import { Doc, isStale, staleness, tops, type NodeId, type Op } from "../src/core/model";
import { mergeUpdate, verifyHistory } from "../src/core/repo";
import type { Range } from "../src/core/text";

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
