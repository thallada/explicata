/** The seed tree against the prompt it was grown from: the first document of a new library. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Doc, descendants, isStale, notesOf, sections } from "../src/core/model";
import { verifyHistory } from "../src/core/repo";
import { SEED_SLUG, writeSeed } from "../src/core/seed";
import { overlaps, sentences, wordCount } from "../src/core/text";
import { seed } from "../src/seed/tree";

const prompt = readFileSync(new URL("../src/seed/prompt.txt", import.meta.url), "utf8");
const doc = Doc.library("seed");
const first = writeSeed(doc, prompt, seed);
const snap = doc.snap();
const root = snap.nodes[first];

describe("seed tree", () => {
  it("keeps the prompt verbatim as the document's text, written by a human and pinned, as a section of the library", () => {
    expect(root.body).toBe(prompt.trim());
    expect(root).toMatchObject({ by: "human", pinned: true, parent: snap.root, slug: SEED_SLUG });
    expect(snap.library).toBe(true);
  });

  it("traces every sentence of the prompt to at least one top-level section", () => {
    const anchors = sections(snap, first).flatMap((id) => snap.nodes[id].anchors);
    const all = sentences(root.body);
    expect(all.length).toBeGreaterThan(30);
    const uncovered = all.filter((s) => !anchors.some((a) => overlaps(s, [a.start, a.end])));
    expect(uncovered.map(([s, e]) => root.body.slice(s, e))).toEqual([]);
    // And the anchors really are the prompt's own words.
    for (const a of anchors) expect(a.text).toBe(a.quote);
  });

  it("is three sections deep with notes in every form, some nested", () => {
    const depth = (id: string): number => 1 + Math.max(0, ...sections(snap, id as never).map(depth));
    expect(depth(first) - 1).toBeGreaterThanOrEqual(3);
    const notes = descendants(snap, first).map((id) => snap.nodes[id]).filter((n) => n.kind === "note");
    expect(new Set(notes.map((n) => n.form))).toEqual(new Set(["gloss", "note", "passage"]));
    expect(notes.filter((n) => snap.nodes[n.parent!].kind === "note").length).toBeGreaterThanOrEqual(3);
    for (const n of notes.filter((n) => n.form === "gloss")) expect(wordCount(n.body)).toBeLessThanOrEqual(15);
    for (const n of Object.values(snap.nodes)) {
      const spans = notesOf(snap, n.id).flatMap((id) => snap.nodes[id].anchors.map((a) => [a.start, a.end] as [number, number]));
      for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) expect(overlaps(spans[i], spans[j])).toBe(false);
    }
  });

  it("starts with nothing stale and a history that verifies", () => {
    expect(Object.keys(snap.nodes).filter((id) => isStale(snap, id as never))).toEqual([]);
    const v = verifyHistory(doc);
    expect(v.mismatches).toEqual([]);
    // The library, the document, and one commit per top-level section.
    expect(v.checked).toBe(seed.length + 2);
  });
});
