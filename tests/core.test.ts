import { UndoManager } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { Doc, SYSTEM_ORIGIN, ancestorsBelowRoot, isStale, linkOnly, retitleOps, staleness, sections, notesOf, topOf, tops, type NodeId } from "../src/core/model";
import { healAnchors, history, verifyHistory, revertTo, revertSubtreeTo, mergeBranch, mergeUpdate, resolveConflict, reopenConflict, at, touched, Repo } from "../src/core/repo";
import { formFor, paragraphs, sentences, sha256, words } from "../src/core/text";

function fixture() {
  const doc = Doc.create("alice", "Root", "Alpha is first. Beta is second. Gamma is third.");
  const root = doc.snap().root;
  const { created } = doc.apply(
    [
      { op: "create", parent: root, title: "One", body: "The first child." },
      { op: "create", parent: root, title: "Two", body: "The second child." },
      { op: "create", parent: root, kind: "note", quote: "Beta", form: "gloss", body: "the second Greek letter" },
      { op: "bless", id: root },
    ],
    "Add children",
    { actor: "llm" },
  );
  return { doc, root, one: created[0], two: created[1], note: created[2] };
}

describe("text", () => {
  it("hashes like SHA-256", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256("é".repeat(200))).toHaveLength(64);
  });
  it("segments paragraphs, sentences and words", () => {
    const body = "One two. Three “four.” Five!\n\nSix (see x.com/y). Seven";
    expect(paragraphs(body).map(([s, e]) => body.slice(s, e))).toEqual(["One two. Three “four.” Five!", "Six (see x.com/y). Seven"]);
    expect(sentences(body).map(([s, e]) => body.slice(s, e))).toEqual(["One two.", "Three “four.”", "Five!", "Six (see x.com/y).", "Seven"]);
    expect(words("don’t stop-gap x.y").map(([s, e]) => "don’t stop-gap x.y".slice(s, e))).toEqual(["don’t", "stop-gap", "x.y"]);
  });
  it("picks the display form from the size of the selection", () => {
    expect(formFor("CRDT")).toBe("gloss");
    expect(formFor("a resolver decides how far the cascade goes")).toBe("note");
    expect(formFor("One sentence here. And another one. And then a third one follows.")).toBe("passage");
  });
});

describe("anchors", () => {
  it("follow their text through edits around them", () => {
    const { doc, root, note } = fixture();
    expect(doc.snap().nodes[note].anchors[0]).toMatchObject({ start: 16, end: 20, text: "Beta" });
    doc.apply([{ op: "update", id: root, body: "Zero comes before. Alpha is first. Beta is second, they say. Gamma is third." }], "Edit around");
    const a = doc.snap().nodes[note].anchors[0];
    expect(a.text).toBe("Beta");
    expect(doc.snap().nodes[root].body.slice(a.start, a.end)).toBe("Beta");
    expect(staleness(doc.snap(), note).down).toBe(false);
  });
  it("go stale when the anchored words change and orphan when they are deleted", () => {
    const { doc, root, note } = fixture();
    doc.apply([{ op: "update", id: root, body: "Alpha is first. Gamma is third." }], "Delete Beta");
    const s = staleness(doc.snap(), note);
    expect(s.orphan).toBe(true);
    expect(s.down).toBe(true);
  });
});

describe("orphans", () => {
  it("a rewrite that leaves stray characters still orphans the note, and restored text is re-anchored", () => {
    const { doc, root, note } = fixture();
    const original = doc.snap().nodes[root].body;
    doc.apply([{ op: "update", id: root, body: "A total rewrite, sharing only letters by accident." }], "Rewrite");
    expect(staleness(doc.snap(), note).orphan).toBe(true);
    expect(healAnchors(doc)).toBe(0);
    doc.apply([{ op: "update", id: root, body: original }], "Put it back");
    expect(healAnchors(doc)).toBe(1);
    expect(doc.snap().nodes[note].anchors[0].text).toBe("Beta");
    expect(staleness(doc.snap(), note)).toEqual({ up: false, down: false, orphan: false });
  });
});

describe("staleness", () => {
  it("is clean after a consistent write", () => {
    const { doc, root, one, two } = fixture();
    for (const id of [root, one, two]) expect(staleness(doc.snap(), id)).toEqual({ up: false, down: false, orphan: false });
  });
  it("flows up from an edited child and down from an edited parent", () => {
    const { doc, root, one, two } = fixture();
    doc.apply([{ op: "update", id: one, body: "The first child, rewritten." }], "Edit child");
    expect(staleness(doc.snap(), root).up).toBe(true);
    expect(staleness(doc.snap(), one)).toMatchObject({ up: false, down: false });
    expect(staleness(doc.snap(), two).down).toBe(false);
    // Regenerating the parent from its children blesses the children, so the cascade does not loop.
    doc.apply(
      [{ op: "update", id: root, body: "Alpha is first, rewritten. Beta is second. Gamma is third." }, ...[one, two].map((id) => ({ op: "bless" as const, id, dir: "down" as const }))],
      "Regenerate parent",
      { actor: "llm" },
    );
    for (const id of [root, one, two]) expect(staleness(doc.snap(), id)).toMatchObject({ up: false, down: false });
    doc.apply([{ op: "update", id: root, body: "Something else entirely about Beta." }], "Human edits parent");
    expect(staleness(doc.snap(), one).down).toBe(true);
    expect(staleness(doc.snap(), two).down).toBe(true);
    expect(doc.snap().nodes[root].pinned).toBe(true);
  });
  it("adding or removing a child makes the parent stale", () => {
    const { doc, root, two } = fixture();
    doc.apply([{ op: "delete", id: two }], "Delete child");
    expect(staleness(doc.snap(), root).up).toBe(true);
    doc.apply([{ op: "bless", id: root, dir: "up" }], "Accept");
    expect(staleness(doc.snap(), root).up).toBe(false);
  });
});

describe("ops", () => {
  it("replace drops the subtree; move refuses cycles; delete refuses the root", () => {
    const { doc, root, one, two } = fixture();
    const { created } = doc.apply([{ op: "create", parent: one, title: "Deep", body: "x" }], "Add");
    doc.apply([{ op: "move", id: two, parent: created[0] }], "Move");
    expect(doc.snap().nodes[two].parent).toBe(created[0]);
    expect(() => doc.apply([{ op: "move", id: one, parent: two }], "Cycle")).toThrow(/inside itself/);
    expect(() => doc.apply([{ op: "delete", id: root }], "Delete root")).toThrow(/root/);
    doc.apply([{ op: "replace", id: one, title: "One again", body: "fresh" }], "Replace");
    expect(doc.snap().nodes[one].children).toEqual([]);
    expect(doc.snap().nodes[two]).toBeUndefined();
    expect(sections(doc.snap(), root)).toEqual([one]);
    expect(notesOf(doc.snap(), root)).toHaveLength(1);
  });
  it("reorders among siblings", () => {
    const { doc, root, one, two } = fixture();
    doc.apply([{ op: "move", id: two, parent: root, index: 0 }], "Reorder");
    expect(sections(doc.snap(), root)).toEqual([two, one]);
  });
});

describe("history", () => {
  it("records a verifiable state hash on every commit and reproduces each state exactly", () => {
    const { doc, root, one } = fixture();
    doc.apply([{ op: "update", id: one, body: "v2" }], "Edit one");
    const states = [doc.canonical()];
    const shape = doc.shape();
    doc.apply([{ op: "delete", id: one }], "Delete one");
    doc.apply([{ op: "update", id: root, title: "Root!" }], "Rename");
    const h = history(doc);
    expect(h.map((c) => c.message)).toEqual(["Rename", "Delete one", "Edit one", "Add children", "Create the tree"]);
    expect(verifyHistory(doc)).toEqual({ checked: 5, unhashed: 0, mismatches: [] });
    expect(at(doc, h[2]).canonical()).toBe(states[0]);
    revertTo(doc, h[2]);
    // Reverting a deletion re-creates the node, so the content matches but its id is new.
    expect(doc.shape()).toBe(shape);
    expect(verifyHistory(doc).mismatches).toEqual([]);
    expect(history(doc)[0].tag).toBe("revert");
  });
});

describe("history with orphaned notes", () => {
  it("keeps commit messages and hashes when a note's anchored text has been deleted", () => {
    // Resolving a cursor whose character is gone makes Loro commit early. Every commit after
    // that used to lose its message.
    const { doc, root, one } = fixture();
    doc.apply([{ op: "update", id: root, body: "Entirely different text." }], "Rewrite root", { actor: "llm", tag: "regen" });
    doc.apply([{ op: "update", id: one, body: "Later edit." }], "Later edit");
    doc.apply([{ op: "create", parent: root, title: "Three", body: "x" }], "Add three");
    const h = history(doc);
    expect(h.slice(0, 3).map((c) => [c.message, c.by])).toEqual([["Add three", "alice"], ["Later edit", "alice"], ["Rewrite root", "alice"]]);
    expect(h[2].tag).toBe("regen");
    expect(h.every((c) => c.hash)).toBe(true);
    expect(verifyHistory(doc)).toEqual({ checked: h.length, unhashed: 0, mismatches: [] });
    const b = doc.fork("bob");
    b.apply([{ op: "update", id: one, body: "Bob's edit." }], "Bob");
    doc.apply([{ op: "update", id: root, title: "Root 2" }], "Retitle");
    mergeBranch(doc, b, "bob");
    expect(history(doc)[0]).toMatchObject({ tag: "merge", message: "Merge bob" });
    expect(verifyHistory(doc).mismatches).toEqual([]);
    revertTo(doc, history(doc).find((c) => c.message === "Later edit")!);
    expect(history(doc)[0]).toMatchObject({ tag: "revert" });
    expect(history(doc).filter((c) => c.message === "(undo/redo)")).toEqual([]);
    expect(verifyHistory(doc).mismatches).toEqual([]);
  });
});

describe("undo", () => {
  it("steps over the system's own commits and treats a split commit as one step", () => {
    const { doc, root, one } = fixture();
    // An orphaned note, so that later commits are stored as more than one change.
    doc.apply([{ op: "update", id: root, body: "Entirely different text." }], "Rewrite root");
    const undo = new UndoManager(doc.loro, { mergeInterval: 0, excludeOriginPrefixes: [SYSTEM_ORIGIN] });
    doc.group = { start: () => undo.groupStart(), end: () => undo.groupEnd() };
    doc.apply([{ op: "delete", id: one }], "Delete one");
    expect(sections(doc.snap(), root).map((id) => doc.snap().nodes[id].title)).toEqual(["Two"]);
    // The model reconciles afterwards.
    doc.apply([{ op: "bless", id: root, dir: "up" }], "Keep root", { actor: "llm", tag: "regen" });
    expect(undo.undo()).toBe(true);
    doc.touch();
    expect(sections(doc.snap(), root).map((id) => doc.snap().nodes[id].title).sort()).toEqual(["One", "Two"]);
    expect(undo.redo()).toBe(true);
    doc.touch();
    expect(sections(doc.snap(), root).map((id) => doc.snap().nodes[id].title)).toEqual(["Two"]);
  });
});

describe("merge", () => {
  it("merges disjoint edits cleanly", () => {
    const { doc, one, two } = fixture();
    const repo = new Repo(doc);
    const b = repo.branch("b");
    doc.apply([{ op: "update", id: one, body: "A's edit." }], "A");
    b.apply([{ op: "update", id: two, body: "B's edit." }], "B");
    const report = repo.merge("b");
    expect(report).toMatchObject({ kind: "merge", conflicts: [] });
    expect(doc.snap().nodes[one].body).toBe("A's edit.");
    expect(doc.snap().nodes[two].body).toBe("B's edit.");
    expect(history(doc)[0].tag).toBe("merge");
    expect(verifyHistory(doc).mismatches).toEqual([]);
  });
  it("fast-forwards and no-ops", () => {
    const { doc, one } = fixture();
    const b = doc.fork();
    b.apply([{ op: "update", id: one, body: "ahead" }], "B");
    expect(mergeBranch(doc, b, "b").kind).toBe("forward");
    expect(mergeBranch(doc, b, "b").kind).toBe("nothing");
    expect(doc.snap().nodes[one].body).toBe("ahead");
  });
  it("finds the conflict a text CRDT cannot see, and resolves it reviewably", () => {
    const { doc, one } = fixture();
    const b = doc.fork("bob");
    doc.apply([{ op: "update", id: one, body: "The first child is always pre-generated." }], "A");
    b.apply([{ op: "update", id: one, body: "The first child is never pre-generated." }], "B");
    const report = mergeBranch(doc, b, "b");
    expect(report.conflicts).toHaveLength(1);
    const c = report.conflicts[0];
    expect(c).toMatchObject({ type: "edit-edit", node: one, field: "body", status: "open", base: "The first child." });
    expect([c.a, c.b].sort()).toEqual(["The first child is always pre-generated.", "The first child is never pre-generated."]);
    // The mechanical merge is well-formed text that neither side wrote.
    expect(c.merged).toBe(doc.snap().nodes[one].body);
    expect([c.a, c.b]).not.toContain(c.merged);

    resolveConflict(doc, c.id, c.a, { by: "alice", rationale: "A is right" });
    expect(doc.snap().nodes[one].body).toBe(c.a);
    expect(doc.conflicts()[0]).toMatchObject({ status: "resolved", resolved: c.a, resolvedBy: "alice" });
    reopenConflict(doc, c.id);
    expect(doc.snap().nodes[one].body).toBe(c.merged);
    expect(doc.conflicts()[0].status).toBe("open");
    expect(verifyHistory(doc).mismatches).toEqual([]);

    // The other replica, merging the other way, converges on the same tree and the same record.
    mergeBranch(b, doc, "main");
    expect(b.canonical()).toBe(doc.canonical());
    expect(b.conflicts()).toEqual(doc.conflicts());
  });
  it("finds an edit that the other side deleted, and can restore it", () => {
    const { doc, root, one } = fixture();
    const b = doc.fork("bob");
    doc.apply([{ op: "delete", id: one }], "A deletes");
    b.apply([{ op: "create", parent: one, title: "Detail", body: "B kept working here." }], "B extends");
    const report = mergeBranch(doc, b, "b");
    expect(report.conflicts).toHaveLength(1);
    const c = report.conflicts[0];
    expect(c).toMatchObject({ type: "edit-delete", node: one, parent: root });
    expect(doc.snap().nodes[one]).toBeUndefined();
    resolveConflict(doc, c.id, c.a, { by: "alice" });
    const restored = sections(doc.snap(), root).map((id: NodeId) => doc.snap().nodes[id].title);
    expect(restored).toContain("One");
  });
});

// ---- the library: one tree, whose root's children are nodes like any other ----

/** A library of two tops, each with a part, a leaf, and a note. */
function library() {
  const doc = Doc.library("alice");
  const lib = doc.snap().root;
  const make = (title: string) =>
    doc.apply(
      [
        { op: "create", parent: lib, title, body: `${title} is about one thing. It has a part.` },
        { op: "create", parent: "$0" as NodeId, title: `${title} part`, body: `The part of ${title} has a phrase worth a note.` },
        { op: "create", parent: "$1" as NodeId, title: `${title} leaf`, body: `A leaf of ${title}.` },
        { op: "create", parent: "$1" as NodeId, kind: "note", quote: "a phrase worth a note", body: "The note." },
        { op: "bless", id: "$0" as NodeId },
        { op: "bless", id: "$1" as NodeId },
      ],
      `Write ${title}`,
      { actor: "llm" },
    ).created;
  const [a, aPart, aLeaf, aNote] = make("Alpha");
  const [b, bPart, bLeaf] = make("Beta");
  return { doc, lib, a, aPart, aLeaf, aNote, b, bPart, bLeaf };
}
const staleIds = (doc: Doc) => Object.keys(doc.snap().nodes).filter((id) => isStale(doc.snap(), id as NodeId));

describe("library", () => {
  it("the root is never stale, and an edit inside a top-level tree marks neither the root nor the other trees", () => {
    const { doc, lib, a, aPart, aLeaf, aNote, b } = library();
    expect(staleIds(doc)).toEqual([]);
    doc.apply([{ op: "update", id: a, body: "Alpha is now about something else." }], "Edit a top's text");
    // Its own sections now elaborate text that changed; nothing outside it does.
    expect(staleIds(doc)).toEqual([aPart]);
    doc.apply([{ op: "bless", id: aPart }], "Accept");
    doc.apply([{ op: "update", id: aLeaf, body: "A rewritten leaf." }], "Edit a leaf");
    expect(staleIds(doc)).toEqual([aPart]);
    doc.apply([{ op: "update", id: aPart, body: "A rewritten part." }], "Edit the part");
    // Up to its top, which now summarises a changed part; down to its leaf and the note whose words went.
    const inAlpha = [a, aLeaf, aNote].sort();
    expect(staleIds(doc).sort()).toEqual(inAlpha);
    // Renaming, adding and deleting top-level nodes changes the library's sections, which it does not summarise.
    doc.apply(retitleOps(doc.snap(), b, "Beta renamed"), "Rename");
    doc.apply([{ op: "create", parent: lib, title: "Gamma", body: "New." }], "New top");
    doc.apply([{ op: "delete", id: b }], "Delete a top");
    expect(staleIds(doc).sort()).toEqual(inAlpha);
    expect(staleness(doc.snap(), lib)).toEqual({ up: false, down: false, orphan: false });
    // The library's own text is the reader's; editing it marks no top.
    doc.apply([{ op: "update", id: lib, body: "My library." }], "Write the library's text");
    expect(staleIds(doc).sort()).toEqual(inAlpha);
    expect(topOf(doc.snap(), lib)).toBeNull();
    expect(topOf(doc.snap(), aLeaf)).toBe(a);
    expect(ancestorsBelowRoot(doc.snap(), aLeaf)).toEqual([doc.snap().nodes[aLeaf].parent, a]);
  });

  it("moves a node from one top-level tree to another with an ordinary move; its notes keep their anchors and undo moves it back", () => {
    const { doc, a, aPart, aNote, b } = library();
    const undo = new UndoManager(doc.loro, { mergeInterval: 0, excludeOriginPrefixes: [SYSTEM_ORIGIN] });
    doc.group = { start: () => undo.groupStart(), end: () => undo.groupEnd() };
    doc.apply([{ op: "move", id: aPart, parent: b }], "Move Alpha's part into Beta");
    let snap = doc.snap();
    expect(snap.nodes[aPart].parent).toBe(b);
    expect(topOf(snap, aPart)).toBe(b);
    expect(snap.nodes[aNote].anchors[0].text).toBe("a phrase worth a note");
    expect(sections(snap, a)).toEqual([]);
    // Both tops' summaries are now out of date, as with any move.
    expect(staleness(snap, a).up && staleness(snap, b).up).toBe(true);
    expect(verifyHistory(doc).mismatches).toEqual([]);
    expect(undo.undo()).toBe(true);
    doc.touch();
    snap = doc.snap();
    expect(snap.nodes[aPart].parent).toBe(a);
    expect(snap.nodes[aNote].anchors[0].text).toBe("a phrase worth a note");
    // Moved to the root, it is a top like any other: nothing is stored to make it one.
    doc.apply([{ op: "move", id: aPart, parent: snap.root }], "Move it to the top");
    expect(topOf(doc.snap(), aPart)).toBe(aPart);
    expect(tops(doc.snap())).toEqual([a, b, aPart]);
  });

  it("loads a library whose nodes still carry slugs from before step 1 (and node targets naming one), ignoring them", () => {
    const { doc, a, aLeaf, b } = library();
    // As an older version wrote them: a slug on each top, and a target naming its top by that slug.
    const old = doc.fork();
    old.apply([{ op: "create", parent: b, kind: "note", quote: "Beta", ref: { kind: "node", id: aLeaf, path: ["Alpha part"] } }], "Link");
    const link = notesOf(old.snap(), b)[0];
    const hash = old.stateHash();
    old.tree.getNodeByID(a)!.data.set("slug", "alpha");
    old.tree.getNodeByID(b)!.data.set("slug", "beta");
    old.tree.getNodeByID(link)!.data.set("ref", { kind: "node", id: aLeaf, doc: "alpha", path: ["Alpha part"] } as never);
    old.loro.commit();
    const back = Doc.load(old.snapshotBytes(), "reader");
    const snap = back.snap();
    expect(Object.keys(snap.nodes[a])).not.toContain("slug");
    expect(back.shape(snap, a)).toBe(doc.shape(doc.snap(), a));
    expect(back.stateHash()).toBe(hash);
    // The old target still goes where it went, and writing works as ever.
    expect(snap.nodes[link].ref).toMatchObject({ kind: "node", id: aLeaf });
    back.apply([{ op: "update", id: b, title: "Beta renamed" }], "Rename");
    expect(back.snap().nodes[b].title).toBe("Beta renamed");
  });

  it("copies a subtree whole: content, notes with their anchors, authorship", () => {
    const { doc, aPart, b } = library();
    doc.apply([{ op: "update", id: aPart, pinned: true }], "Pin");
    const [copy] = doc.apply([{ op: "copy", id: aPart, parent: b }], "Copy").created;
    const snap = doc.snap();
    expect(copy).not.toBe(aPart);
    expect(doc.shape(snap, copy)).toBe(doc.shape(snap, aPart));
    expect(snap.nodes[copy]).toMatchObject({ parent: b, by: "llm", pinned: true });
    const note = notesOf(snap, copy)[0];
    expect(snap.nodes[note].anchors[0].text).toBe("a phrase worth a note");
  });

  it("reverts one top-level tree to a commit and leaves the others as they are now", () => {
    const { doc, a, aPart, aLeaf, b, bLeaf } = library();
    const mark = history(doc)[0];
    doc.apply([{ op: "update", id: aLeaf, body: "Changed later." }], "Change a leaf");
    doc.apply([{ op: "delete", id: aPart }], "Delete a part");
    doc.apply([{ op: "create", parent: a, title: "Added later" }], "Add a section");
    doc.apply([{ op: "update", id: bLeaf, body: "Beta changed later too." }], "Change the other top");
    const beta = doc.shape(doc.snap(), b);
    revertSubtreeTo(doc, mark, a);
    const snap = doc.snap();
    expect(doc.shape(snap, a)).toBe(doc.shape(at(doc, mark).snap(), a));
    expect(doc.shape(snap, b)).toBe(beta);
    expect(snap.nodes[bLeaf].body).toBe("Beta changed later too.");
    expect(history(doc)[0].tag).toBe("revert");
    expect(verifyHistory(doc).mismatches).toEqual([]);
  });

  it("names the nodes a commit wrote, and syncs edits in different top-level trees without comparing whole states", () => {
    const { doc, aLeaf, bLeaf } = library();
    doc.apply([{ op: "update", id: aLeaf, body: "Edited." }], "Edit");
    expect([...touched(doc, history(doc)[0].spans).nodes]).toContain(aLeaf);
    const other = doc.fork("bob");
    doc.apply([{ op: "update", id: aLeaf, body: "Mine." }], "Mine");
    other.apply([{ op: "update", id: bLeaf, body: "Theirs." }], "Theirs");
    const quick = mergeUpdate(doc, other.loro.export({ mode: "update", from: doc.loro.version() }), other.loro.version().toJSON());
    expect(quick).toEqual({ kind: "merge", conflicts: [] });
    // Edits to one node on both sides are still found.
    const third = doc.fork("carol");
    doc.apply([{ op: "update", id: bLeaf, body: "Mine again." }], "Mine again");
    third.apply([{ op: "update", id: bLeaf, body: "Carol's." }], "Carol");
    const found = mergeUpdate(doc, third.loro.export({ mode: "update", from: doc.loro.version() }), third.loro.version().toJSON());
    expect(found.conflicts.map((c) => [c.type, c.node])).toEqual([["edit-edit", bLeaf]]);
  });
});

describe("a section that is only a link", () => {
  it("is a section with a Wikipedia or web target and nothing of its own: no text, no sections", () => {
    const { doc, root, one } = fixture();
    const { created } = doc.apply(
      [
        { op: "create", parent: root, title: "Octopuses", body: "", ref: { kind: "wiki", title: "Octopus", lang: "en" } },
        { op: "create", parent: root, title: "A trace", body: "", ref: { kind: "url", url: "https://tracing.example.org/posts/following-a-request" } },
        { op: "create", parent: root, title: "Elsewhere", body: "", ref: { kind: "node", id: one } },
        { op: "create", parent: root, title: "Nothing", body: "" },
      ],
      "Add links",
    );
    const [wiki, web, node, plain] = created;
    expect(linkOnly(doc.snap(), wiki)).toBe(true);
    expect(linkOnly(doc.snap(), web)).toBe(true);
    // A link to a node is not an article; a section with no target is not a link.
    expect(linkOnly(doc.snap(), node)).toBe(false);
    expect(linkOnly(doc.snap(), plain)).toBe(false);
    expect(linkOnly(doc.snap(), root)).toBe(false);
    // Text of its own (not just white space), or a section inside, makes it a section like any other.
    doc.apply([{ op: "update", id: wiki, body: "  \n " }], "Blank");
    expect(linkOnly(doc.snap(), wiki)).toBe(true);
    doc.apply([{ op: "update", id: wiki, body: "Eight arms." }], "Text");
    expect(linkOnly(doc.snap(), wiki)).toBe(false);
    doc.apply([{ op: "create", parent: web, title: "Inside", body: "" }], "Inside");
    expect(linkOnly(doc.snap(), web)).toBe(false);
    // A note is never one, whatever it links to; nor is a node that is gone.
    const [note] = doc.apply([{ op: "create", parent: one, kind: "note", quote: "first", body: "", ref: { kind: "wiki", title: "First", lang: "en" } }], "Link").created;
    expect(linkOnly(doc.snap(), note)).toBe(false);
    expect(linkOnly(doc.snap(), "nope" as NodeId)).toBe(false);
  });
});
