/**
 * Migration from one database per document (and from the single-document layout before that) to
 * one library: every document's content equal, histories kept, conflicts still open, the old files
 * untouched, and a second start that does nothing.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { LibraryStore } from "../server/library";
import { Doc, descendants, isStale, tops, type NodeId } from "../src/core/model";
import { at, history, mergeBranch, revertSubtreeTo, revertTo, verifyHistory } from "../src/core/repo";

const temp = () => mkdtempSync(join(tmpdir(), "ie-migrate-"));

/** A document as the per-document version made them: a single tree, with notes, a pin and a form. */
function oldDoc(title: string) {
  const doc = Doc.create("alice", title, "Alpha is first. Beta is second. Gamma is third.");
  const root = doc.snap().root;
  doc.apply(
    [
      { op: "create", parent: root, title: "One", body: "The first child, with a phrase worth a note." },
      { op: "create", parent: root, title: "Two", body: "The second child." },
      { op: "create", parent: root, kind: "note", quote: "Beta", form: "gloss", lens: "define", body: "the second letter" },
      { op: "create", parent: "$0" as NodeId, kind: "note", quote: "a phrase worth a note", form: "passage", body: "A passage." },
      { op: "bless", id: root },
    ],
    "Pre-generate",
    { actor: "llm" },
  );
  return doc;
}

/** Every file under a directory, with a hash of its bytes. */
function sums(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

function write(data: string, id: string, branches: Record<string, Doc>, mtime: number) {
  const dir = join(data, "docs", id);
  mkdirSync(dir, { recursive: true });
  for (const [name, doc] of Object.entries(branches)) {
    writeFileSync(join(dir, `${encodeURIComponent(name)}.loro`), doc.snapshotBytes());
    utimesSync(join(dir, `${encodeURIComponent(name)}.loro`), mtime, mtime);
  }
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ uid: createHash("md5").update(id).digest("hex").slice(0, 12), created: "2026-11-01T00:00:00Z" }));
}

describe("migration from the per-document layout", () => {
  it("builds one library from every document's main branch, keeping content, histories and open conflicts, and touches nothing old", () => {
    const data = temp();
    // The first document, with work on it: a human edit (a pin), and an open conflict from a merge.
    const first = oldDoc("Infinite Expand");
    const one = first.snap().nodes[first.snap().root].children[0];
    first.apply([{ op: "update", id: one, body: "A person rewrote this, keeping a phrase worth a note." }], "Human edit");
    const bob = first.fork("bob");
    first.apply([{ op: "update", id: one, title: "One, says main" }], "Main retitles");
    bob.apply([{ op: "update", id: one, title: "One, says bob" }], "Bob retitles");
    mergeBranch(first, bob, "bob");
    expect(first.conflicts().filter((c) => c.status === "open")).toHaveLength(1);
    const alt = first.fork();
    alt.apply([{ op: "update", id: alt.snap().root, title: "On alt" }], "alt edit");
    const tides = oldDoc("The tides");
    // A duplicate began as a byte copy of another document, so it shares that document's history.
    const copy = Doc.load(tides.snapshotBytes(), "x");
    copy.apply([{ op: "update", id: copy.snap().root, title: "The tides (copy)" }], "Duplicate");
    write(data, "infinite-expand", { main: first, alt }, 1_700_000_000);
    write(data, "tides", { main: tides }, 1_700_000_300);
    write(data, "tides-copy", { main: copy }, 1_700_000_200);
    writeFileSync(join(data, "library.json"), JSON.stringify({ imported: ["infinite-expand", "tides"] }));
    const before = sums(data);
    const oldCommits = history(first).length;

    const logs: string[] = [];
    const store = new LibraryStore(data, (m) => logs.push(m)).open();
    const lib = store.main;
    const snap = lib.snap();

    // One library: the first document first, then most recently changed first.
    expect(snap.library).toBe(true);
    expect(store.titles()).toEqual(["Infinite Expand", "The tides", "The tides (copy)"]);
    const [nFirst, nTides, nCopy] = tops(snap);
    for (const [node, old] of [[nFirst, first], [nTides, tides], [nCopy, copy]] as const) {
      expect(lib.shape(snap, node)).toBe(old.shape());
      // Exactly what was stale before is stale now (the first document's edits left its root out of date).
      const was = old.snap();
      expect([node, ...descendants(snap, node)].filter((n) => isStale(snap, n)).length).toBe(Object.keys(was.nodes).filter((n) => isStale(was, n as NodeId)).length);
    }
    expect(isStale(snap, snap.root)).toBe(false);
    // Kept documents keep their node ids, so anchors and conflict records still point at them.
    expect(nFirst).toBe(first.snap().root);
    expect(nTides).toBe(tides.snap().root);
    expect(nCopy).not.toBe(copy.snap().root);
    expect(lib.conflicts().filter((c) => c.status === "open").map((c) => c.node)).toEqual([one]);
    expect(snap.nodes[one].pinned).toBe(true);

    // The first document's history is the library's history from before it existed, and verifies.
    const h = history(lib);
    expect(h[0]).toMatchObject({ tag: "migrate", message: "Gather 3 documents into the library" });
    expect(h.filter((c) => ["Human edit", "Main retitles", "Bob retitles"].includes(c.message) || c.message.startsWith("Merge bob"))).toHaveLength(4);
    expect(h.length).toBe(oldCommits + history(tides).length + 1); // the copy's history is not carried
    expect(verifyHistory(lib)).toMatchObject({ unhashed: 0, mismatches: [] });
    const then = at(lib, h.find((c) => c.message === "Human edit")!).snap();
    expect(then.library).toBe(false);
    expect(then.nodes[then.root].title).toBe("Infinite Expand");
    expect(then.nodes[one].body).toBe("A person rewrote this, keeping a phrase worth a note.");
    // Reverting the whole library to before it existed is refused; reverting the document to then works.
    const humanEdit = h.find((c) => c.message === "Human edit")!;
    expect(() => revertTo(lib, humanEdit)).toThrow(/before the library existed/);
    revertSubtreeTo(lib, humanEdit, first.snap().root);
    expect(lib.snap().nodes[one].title).toBe("One");
    expect(lib.shape(lib.snap(), nTides)).toBe(tides.shape());
    expect(verifyHistory(lib).mismatches).toEqual([]);

    // The old directory is renamed, every byte as it was; the record says what was and was not carried.
    const moved = readdirSync(data).find((f) => f.startsWith("docs.migrated-"))!;
    expect(existsSync(join(data, "docs"))).toBe(false);
    const after = sums(data);
    for (const [file, hash] of Object.entries(before)) expect(after[file.replace(/^docs\//, `${moved}/`)]).toBe(hash);
    const record = JSON.parse(readFileSync(join(data, "library", "migrated.json"), "utf8"));
    expect(record.docs.map((d: { slug: string; history: string }) => [d.slug, d.history])).toEqual([["infinite-expand", "kept"], ["tides", "kept"], ["tides-copy", "copied"]]);
    expect(record.branchesNotCarried).toEqual([{ doc: "infinite-expand", branch: "alt" }]);
    expect(Object.keys(record.docs[0].versions).sort()).toEqual(["alt", "main"]);
    expect(logs.join("\n")).toMatch(/infinite-expand: alt/);
    expect(logs.join("\n")).toMatch(/tides-copy .*copied as content/);

    // A second start is a no-op.
    store.save("main");
    const settled = sums(data);
    const again: string[] = [];
    const store2 = new LibraryStore(data, (m) => again.push(m)).open();
    expect(again).toEqual([]);
    expect(sums(data)).toEqual(settled);
    expect(store2.main.stateHash()).toBe(lib.stateHash());
  });

  it("migrates the single-document layout's flat files the same way", () => {
    const data = temp();
    const main = oldDoc("Infinite Expand");
    const alt = main.fork();
    alt.apply([{ op: "update", id: alt.snap().root, title: "On alt" }], "alt edit");
    writeFileSync(join(data, "main.loro"), main.snapshotBytes());
    writeFileSync(join(data, "my%20branch.loro"), alt.snapshotBytes());
    writeFileSync(join(data, "notes.txt"), "not a branch");
    const logs: string[] = [];
    const store = new LibraryStore(data, (m) => logs.push(m)).open();
    const snap = store.main.snap();
    expect(store.titles()).toEqual(["Infinite Expand"]);
    expect(store.main.shape(snap, tops(snap)[0])).toBe(main.shape());
    expect(readdirSync(data).filter((f) => f.endsWith(".loro"))).toEqual([]);
    expect(existsSync(join(data, "notes.txt"))).toBe(true); // anything else is left alone
    const flat = readdirSync(data).find((f) => f.startsWith("flat.migrated-"))!;
    expect(readdirSync(join(data, flat)).sort()).toEqual(["main.loro", "my%20branch.loro"]);
    expect(readFileSync(join(data, flat, "main.loro")).equals(Buffer.from(main.snapshotBytes()))).toBe(true);
    expect(logs.join("\n")).toMatch(/infinite-expand: my branch/);
  });

  it("starts a fresh library when there is nothing to migrate", () => {
    const data = temp();
    const store = new LibraryStore(data, () => {}).open();
    expect(store.main.snap().library).toBe(true);
    expect(store.titles()).toEqual([]);
    expect(readdirSync(data)).toEqual(["library"]);
  });
});
