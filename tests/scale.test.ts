/**
 * A library of about 5,000 nodes in 100 documents: an edit must cost what it touches, not the size
 * of the library. Timings are printed; the assertions are budgets well inside one 16 ms frame for
 * the work a keystroke does, and a comparison with a library a tenth the size.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LibraryStore } from "../server/library";
import { linkIndex } from "../src/core/links";
import { Doc, isStale, staleness, type NodeId, type Op } from "../src/core/model";
import { renderContext } from "../src/llm/prompts";

const SENTENCE = "This sentence is about something that matters here. Another follows it, with a few more words. ";

/** `docs` documents of 50 nodes each: 7 sections of 6 leaves, and a note. */
function synthetic(docs: number): Doc {
  const doc = Doc.library("scale");
  const lib = doc.snap().root;
  for (let d = 0; d < docs; d++) {
    const ops: Op[] = [{ op: "create", parent: lib, title: `Document ${d}`, body: SENTENCE.repeat(3) }];
    let n = 1;
    for (let s = 0; s < 7; s++) {
      const sec = n++;
      ops.push({ op: "create", parent: "$0" as NodeId, title: `Section ${d}.${s}`, body: SENTENCE.repeat(2) });
      for (let k = 0; k < 6; k++, n++) ops.push({ op: "create", parent: `$${sec}` as NodeId, title: `Leaf ${d}.${s}.${k}`, body: SENTENCE.repeat(2) });
    }
    ops.push({ op: "create", parent: "$0" as NodeId, kind: "note", quote: "something that matters", body: "A note." });
    // And a link to an article, shared by every tenth document, for the backlinks index to follow.
    ops.push({ op: "create", parent: "$0" as NodeId, kind: "note", quote: "Another follows", ref: { kind: "wiki", title: `Topic ${d % 10}`, lang: "en" } });
    for (let i = 0; i < n; i++) ops.push({ op: "bless", id: `$${i}` as NodeId });
    doc.apply(ops, `Document ${d}`, { actor: "llm" });
  }
  return doc;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Time a body edit end to end: the op, its commit (with the state hash), the snapshot, staleness along the path, and the context. */
function editCost(doc: Doc, rounds = 25) {
  const snap = doc.snap();
  const leaves = Object.values(snap.nodes).filter((n) => n.title.startsWith("Leaf"));
  const ms: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const leaf = leaves[(i * 977) % leaves.length];
    const t = performance.now();
    doc.apply([{ op: "update", id: leaf.id, body: `Edited ${i}. ${SENTENCE}` }], "Edit");
    const s = doc.snap();
    for (let p: NodeId | null = leaf.id; p; p = s.nodes[p].parent) staleness(s, p);
    renderContext(s, leaf.id);
    ms.push(performance.now() - t);
  }
  return median(ms);
}

describe("a large library", () => {
  it("costs what an edit touches: 5,000 nodes in 100 documents", () => {
    let t = performance.now();
    const big = synthetic(100);
    const built = performance.now() - t;
    const nodes = Object.keys(big.snap().nodes).length;
    expect(nodes).toBeGreaterThanOrEqual(5000);

    // Boot: what a browser or the server does with the stored library.
    const bytes = big.snapshotBytes();
    t = performance.now();
    const loaded = Doc.load(bytes, "reader");
    const first = loaded.snap();
    const boot = performance.now() - t;
    t = performance.now();
    loaded.stateHash();
    const firstHash = performance.now() - t;
    expect(Object.keys(first.nodes)).toHaveLength(nodes);
    expect(Object.keys(first.nodes).filter((id) => isStale(first, id as NodeId))).toEqual([]);

    // Navigation reads the snapshot without changing it: it must be the same object, at no cost.
    t = performance.now();
    for (let i = 0; i < 1000; i++) loaded.snap();
    const reread = (performance.now() - t) / 1000;
    expect(loaded.snap()).toBe(first);

    // Server start: open the stored library and list its documents, as server/index.ts does.
    const data = mkdtempSync(join(tmpdir(), "ie-scale-"));
    mkdirSync(join(data, "library"));
    writeFileSync(join(data, "library", "main.loro"), bytes);
    t = performance.now();
    const store = new LibraryStore(join(data, "library")).open();
    expect(store.titles()).toHaveLength(100);
    const serverStart = performance.now() - t;

    // The backlinks index follows every edit below; it is built once, here.
    t = performance.now();
    const ix = linkIndex(loaded);
    const indexed = performance.now() - t;
    expect(ix.mentions("en", "Topic 3")).toHaveLength(10);
    const edit = editCost(loaded);
    expect(ix.mentions("en", "Topic 3")).toHaveLength(10);
    const small = editCost(Doc.load(synthetic(10).snapshotBytes(), "reader"));
    console.log(
      `scale: ${nodes} nodes, ${(bytes.length / 1024).toFixed(0)} KB · built in ${built.toFixed(0)} ms · loaded and read in ${boot.toFixed(0)} ms · first state hash ${firstHash.toFixed(0)} ms · server store opened and listed in ${serverStart.toFixed(0)} ms · cached snapshot ${(reread * 1000).toFixed(1)} µs · backlinks index built in ${indexed.toFixed(1)} ms · body edit (op, commit, snapshot, staleness, context) median ${edit.toFixed(2)} ms at 100 documents, ${small.toFixed(2)} ms at 10`,
    );
    expect(edit).toBeLessThan(8);
    // An edit at a tenth of the size costs about the same: nothing it does walks the whole library.
    expect(edit).toBeLessThan(small * 3 + 2);
    expect(boot).toBeLessThan(2000);
  }, 120_000);
});
