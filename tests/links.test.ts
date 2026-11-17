/** Links and targets: in ops, in the hash and history, staleness, merge, the backlinks index, healing and applyLinks. */
import { UndoManager } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { LinkIndex, applyLinks, healLinks, linkIndex, nodeRef, resolveNode } from "../src/core/links";
import { Doc, OpError, SYSTEM_ORIGIN, isStale, notesOf, sections, staleness, type NodeId } from "../src/core/model";
import { formatTarget, parseTarget, parseTargetLoose, type Ref } from "../src/core/ref";
import { detectConflicts, history, mergeUpdate, resolveConflict, revertTo, verifyHistory } from "../src/core/repo";
import { commitExpansion } from "../src/llm/tasks";

const W = (title: string): Ref => ({ kind: "wiki", title, lang: "en" });

/** A library of two trees; the second has a section the first links to. */
function library() {
  const doc = Doc.library("tester");
  const lib = doc.snap().root;
  const { created } = doc.apply(
    [
      { op: "create", parent: lib, title: "Fixed points", body: "The Y combinator finds a fixed point. Octopus arms are not relevant." },
      { op: "create", parent: "$0" as NodeId, title: "Recursion", body: "Recursion without names uses self-application." },
      { op: "create", parent: lib, title: "Minds", body: "An octopus has a distributed nervous system." },
      { op: "create", parent: "$2" as NodeId, title: "Arms", body: "Each arm tastes what it touches." },
      { op: "create", parent: "$3" as NodeId, title: "Suckers", body: "Thousands of them." },
    ],
    "Base",
    { actor: "llm" },
  );
  const [fixed, recursion, minds, arms, suckers] = created;
  doc.apply([fixed, recursion, minds, arms, suckers].map((id) => ({ op: "bless" as const, id })), "Bless", { actor: "llm" });
  return { doc, lib, fixed, recursion, minds, arms, suckers };
}

const linkOn = (doc: Doc, node: NodeId, quote: string, ref: Ref) =>
  doc.apply([{ op: "create", parent: node, kind: "note", quote, ref }], `Link ${quote}`).created[0];

describe("targets in ops", () => {
  it("create and update carry a target; null removes it; a bad one is refused", () => {
    const { doc, fixed, arms } = library();
    const link = linkOn(doc, fixed, "Y combinator", W("fixed-point_combinator"));
    let n = doc.snap().nodes[link];
    expect(n.kind).toBe("note");
    expect(n.body).toBe("");
    expect(n.ref).toEqual({ kind: "wiki", title: "Fixed-point combinator", lang: "en" });
    doc.apply([{ op: "update", id: link, ref: { kind: "node", id: arms } }], "Retarget");
    expect(doc.snap().nodes[link].ref).toEqual({ kind: "node", id: arms });
    doc.apply([{ op: "update", id: fixed, ref: { kind: "url", url: "https://example.org/x", title: "Example" } }], "Section target");
    expect(doc.snap().nodes[fixed].ref).toMatchObject({ kind: "url", url: "https://example.org/x" });
    doc.apply([{ op: "update", id: fixed, ref: null }], "Untarget");
    expect(doc.snap().nodes[fixed].ref).toBeUndefined();
    for (const bad of [{ kind: "url", url: "javascript:alert(1)" }, { kind: "url", url: "ftp://x.org" }, { kind: "wiki", title: "" }, { kind: "wiki", title: "A|B" }, { kind: "wiki", title: "X", lang: "EN!" }, { kind: "node" }, { kind: "nope" }]) {
      expect(() => doc.apply([{ op: "update", id: link, ref: bad as never }], "Bad")).toThrow(OpError);
    }
    // A refused op leaves the target as it was.
    n = doc.snap().nodes[link];
    expect(n.ref).toEqual({ kind: "node", id: arms });
  });

  it("changing a target does not change authorship or pin", () => {
    const { doc, recursion } = library();
    doc.apply([{ op: "update", id: recursion, ref: W("Recursion") }], "Target", { actor: "human" });
    const n = doc.snap().nodes[recursion];
    expect(n.by).toBe("llm");
    expect(n.pinned).toBe(false);
  });
});

describe("the hash and history", () => {
  it("a target is part of the state hash, every commit verifies, and revert takes a link away", () => {
    const { doc, fixed } = library();
    const before = doc.stateHash();
    const mark = history(doc)[0];
    const link = linkOn(doc, fixed, "Octopus", W("Octopus"));
    const linked = doc.stateHash();
    expect(linked).not.toBe(before);
    doc.apply([{ op: "update", id: link, ref: W("Cephalopod") }], "Retarget");
    expect(doc.stateHash()).not.toBe(linked);
    expect(verifyHistory(doc).mismatches).toEqual([]);
    revertTo(doc, mark);
    expect(doc.snap().nodes[link]).toBeUndefined();
    expect(doc.stateHash()).toBe(before);
  });

  it("a tree without targets hashes as it did before targets existed", () => {
    // The row of a node with no target is unchanged, so old commits still verify: the first
    // tree's seed commits are checked by the seed tests; here, a library made now.
    const { doc } = library();
    expect(verifyHistory(doc).mismatches).toEqual([]);
  });
});

describe("staleness", () => {
  it("links never make their parent or siblings stale, and are never stale themselves", () => {
    const { doc, fixed, recursion } = library();
    const ids = [fixed, recursion];
    linkOn(doc, fixed, "Y combinator", W("Fixed-point combinator"));
    for (const id of ids) expect(isStale(doc.snap(), id)).toBe(false);
    // Edit the linked words: a note would go stale; a link does not.
    const link = notesOf(doc.snap(), fixed)[0];
    const body = doc.snap().nodes[fixed].body.replace("Y combinator", "Y Combinator");
    doc.apply([{ op: "update", id: fixed, body }, { op: "bless", id: fixed }], "Edit the words");
    expect(staleness(doc.snap(), link)).toEqual({ up: false, down: false, orphan: false });
    // A target on a section is not content: it changes nobody's staleness.
    doc.apply([{ op: "bless", id: recursion }], "Settle");
    doc.apply([{ op: "update", id: recursion, ref: W("Recursion (computer science)") }], "Section target");
    for (const id of [fixed, recursion]) expect(isStale(doc.snap(), id)).toBe(false);
  });
});

describe("one node per span", () => {
  it("an expansion of words that already carry a link takes the link's target", () => {
    const { doc, fixed } = library();
    const link = linkOn(doc, fixed, "Y combinator", W("Fixed-point combinator"));
    const body = doc.snap().nodes[fixed].body;
    const at = body.indexOf("Y combinator");
    const id = commitExpansion(doc, { node: fixed, range: [at, at + 12], quote: "Y combinator", form: "gloss", lens: "define" }, "a term that finds fixed points.");
    expect(id).toBe(link);
    const notes = notesOf(doc.snap(), fixed);
    expect(notes).toHaveLength(1);
    const n = doc.snap().nodes[link];
    expect(n.body).toBe("a term that finds fixed points");
    expect(n.ref).toEqual(W("Fixed-point combinator"));
    expect(n.form).toBe("gloss");
    expect(n.lens).toBe("define");
  });

  it("two replicas linking the same words both keep their link, and converge", () => {
    const { doc, fixed } = library();
    const other = doc.fork("other");
    linkOn(doc, fixed, "Octopus", W("Octopus"));
    linkOn(other, fixed, "Octopus", W("Cephalopod"));
    mergeUpdate(doc, other.loro.export({ mode: "update", from: doc.loro.version() }), other.loro.version().toJSON());
    mergeUpdate(other, doc.loro.export({ mode: "update", from: other.loro.version() }), doc.loro.version().toJSON());
    const snap = doc.snap();
    expect(notesOf(snap, fixed)).toHaveLength(2);
    expect(doc.stateHash()).toBe(other.stateHash());
  });

  it("concurrent retargets of one link are a conflict a person can settle", () => {
    const { doc, fixed } = library();
    const link = linkOn(doc, fixed, "Octopus", W("Octopus"));
    const base = doc.fork("base");
    const other = doc.fork("other");
    doc.apply([{ op: "update", id: link, ref: W("Cephalopod") }], "Ours");
    other.apply([{ op: "update", id: link, ref: W("Mollusca") }], "Theirs");
    const ours = { ...doc.snap(), nodes: { ...doc.snap().nodes } };
    const report = mergeUpdate(doc, other.loro.export({ mode: "update", from: doc.loro.version() }), other.loro.version().toJSON(), { full: true });
    const c = report.conflicts.find((x) => x.field === "ref");
    expect(c).toBeTruthy();
    expect([c!.a, c!.b].sort()).toEqual(["w:Cephalopod", "w:Mollusca"]);
    expect(detectConflicts(base.snap(), ours, other.snap(), doc.snap()).some((x) => x.field === "ref")).toBe(true);
    resolveConflict(doc, c!.id, "w:Mollusca", { by: "tester" });
    expect(doc.snap().nodes[link].ref).toEqual(W("Mollusca"));
  });
});

describe("the backlinks index", () => {
  it("is correct after links are added, moved, retargeted and deleted, and after undo", () => {
    const { doc, fixed, recursion, arms, suckers } = library();
    const ix = linkIndex(doc);
    const a = linkOn(doc, fixed, "Octopus", { kind: "node", id: arms });
    const b = linkOn(doc, recursion, "self-application", W("Fixed-point combinator"));
    expect(ix.linksTo(arms)).toEqual([a]);
    expect(ix.mentions("en", "fixed-point combinator")).toEqual([b]);
    // Moving the target keeps its id: still linked. Moving the link's section keeps it too.
    doc.apply([{ op: "move", id: arms, parent: fixed }], "Move the target");
    expect(ix.linksTo(arms)).toEqual([a]);
    doc.apply([{ op: "update", id: a, ref: nodeRef(doc.snap(), suckers) }], "Retarget");
    expect(ix.linksTo(arms)).toEqual([]);
    expect(ix.linksTo(suckers)).toEqual([a]);
    doc.apply([{ op: "delete", id: b }], "Unlink");
    expect(ix.mentions("en", "Fixed-point combinator")).toEqual([]);
    // Deleting the target leaves the link broken.
    const um = new UndoManager(doc.loro, { mergeInterval: 0, excludeOriginPrefixes: [SYSTEM_ORIGIN] });
    doc.group = { start: () => um.groupStart(), end: () => um.groupEnd() };
    doc.apply([{ op: "delete", id: suckers }], "Delete the target");
    expect(ix.broken()).toEqual([a]);
    um.undo();
    doc.touch();
    expect(healLinks(doc)).toBe(1);
    const back = doc.snap().nodes[a].ref as Ref & { kind: "node" };
    expect(back.id).not.toBe(suckers);
    expect(doc.snap().nodes[back.id!].title).toBe("Suckers");
    expect(ix.linksTo(back.id!)).toEqual([a]);
    expect(ix.broken()).toEqual([]);
    // Whatever happened, it agrees with an index built from scratch.
    const fresh = new LinkIndex(Doc.load(doc.snapshotBytes(), "check"));
    expect(fresh.linksTo(back.id!)).toEqual([a]);
    expect(fresh.articles()).toEqual(ix.articles());
  });

  it("follows a large batch of changes at the cost of the changes", () => {
    const { doc, lib } = library();
    const ix = linkIndex(doc);
    const ops = Array.from({ length: 200 }, (_, i) => ({ op: "create" as const, parent: lib, title: `Doc ${i}`, body: `About topic ${i}.` }));
    const made = doc.apply(ops, "Many").created;
    applyLinks(doc, made.map((id, i) => ({ node: id, quote: `topic ${i}`, target: W(`Topic ${i % 7}`) })));
    expect(ix.mentions("en", "Topic 3").length).toBe(made.filter((_, i) => i % 7 === 3).length);
  });
});

describe("healing", () => {
  it("a node link whose target is gone is found again by its titles from the library root, else stays broken", () => {
    const { doc, fixed, minds, arms } = library();
    const link = linkOn(doc, fixed, "Octopus", nodeRef(doc.snap(), arms));
    expect(doc.snap().nodes[link].ref).toEqual({ kind: "node", id: arms, path: ["Minds", "Arms"] });
    doc.apply([{ op: "delete", id: arms }], "Delete");
    expect(healLinks(doc)).toBe(0);
    expect(linkIndex(doc).broken()).toEqual([link]);
    const [again] = doc.apply([{ op: "create", parent: minds, title: "Arms", body: "Rewritten." }], "Recreate").created;
    expect(healLinks(doc)).toBe(1);
    expect((doc.snap().nodes[link].ref as { id: NodeId }).id).toBe(again);
    expect(resolveNode(doc.snap(), { kind: "node", path: ["minds", "arms"] })).toBe(again);
    // The root itself is the empty path; a relative path is read below the top of where it is written.
    expect(resolveNode(doc.snap(), { kind: "node", path: [] })).toBe(doc.snap().root);
    expect(resolveNode(doc.snap(), { kind: "node", path: ["Arms"], rel: true }, link)).toBeNull();
    expect(resolveNode(doc.snap(), { kind: "node", path: ["Arms"], rel: true }, again)).toBe(again);
  });

  it("where two trees have the same titles, a path is found in the tree it is written in first", () => {
    const { doc, lib, minds } = library();
    const [copy] = doc.apply([{ op: "copy", id: minds, parent: lib }], "Copy").created;
    const copyArms = sections(doc.snap(), copy)[0];
    const path = { kind: "node" as const, path: ["Minds", "Arms"] };
    expect(resolveNode(doc.snap(), path)).toBe(sections(doc.snap(), minds)[0]);
    expect(resolveNode(doc.snap(), path, sections(doc.snap(), copyArms)[0])).toBe(copyArms);
  });
});

describe("applyLinks", () => {
  it("links in one commit, skips what is already linked, merges into a note on the same words, and is idempotent", () => {
    const { doc, fixed, minds } = library();
    const [note] = doc.apply([{ op: "create", parent: minds, kind: "note", quote: "octopus", body: "A cephalopod." }], "Note").created;
    linkOn(doc, fixed, "Octopus", W("Squid"));
    const specs = [
      { node: fixed, quote: "Y combinator", target: W("Fixed-point combinator") },
      { node: fixed, quote: "Octopus", target: W("Octopus") },
      { node: minds, quote: "octopus", target: W("Octopus") },
      { node: minds, quote: "not in the text", target: W("Nothing") },
      { node: fixed, quote: "Y combinator", target: W("Fixed-point combinator") },
    ];
    const commits = history(doc).length;
    const first = applyLinks(doc, specs, { author: "linker", actor: "llm" });
    expect(history(doc).length).toBe(commits + 1);
    expect(first).toMatchObject({ merged: [note], occupied: 1, missing: 1, same: 1 });
    expect(first.created).toHaveLength(1);
    expect(doc.snap().nodes[note].ref).toEqual(W("Octopus"));
    expect(doc.snap().nodes[note].body).toBe("A cephalopod.");
    const second = applyLinks(doc, specs);
    expect(second).toMatchObject({ created: [], merged: [], same: 3, occupied: 1, missing: 1 });
    expect(history(doc).length).toBe(commits + 1);
    expect(sections(doc.snap(), fixed)).toHaveLength(1);
  });
});

describe("the text form of a target", () => {
  it("reads and writes every kind", () => {
    const cases: [string, Ref][] = [
      ["w:Fixed-point combinator", W("Fixed-point combinator")],
      ["w.fr:Point fixe", { kind: "wiki", title: "Point fixe", lang: "fr" }],
      ['"w:Star Wars: Episode IV"', W("Star Wars: Episode IV")],
      ["/Fixed points/Recursion/How Y works", { kind: "node", path: ["Fixed points", "Recursion", "How Y works"] }],
      ["./A\\/B/C", { kind: "node", path: ["A/B", "C"], rel: true }],
      ['/Minds/Arms ^"tastes what"', { kind: "node", path: ["Minds", "Arms"], quote: "tastes what" }],
      ["/", { kind: "node", path: [] }],
      ['https://example.org/a?b=c "A title"', { kind: "url", url: "https://example.org/a?b=c", title: "A title" }],
    ];
    for (const [text, ref] of cases) {
      expect(parseTarget(text)).toEqual(ref);
      expect(formatTarget(ref)).toBe(text);
    }
    expect(parseTargetLoose("octopus")).toEqual(W("Octopus"));
    expect(typeof parseTarget("javascript:alert(1)")).toBe("string");
  });
});

describe("the editor agent's tools", () => {
  it("create a link and set or remove a target, with node paths checked against the library", async () => {
    const { execTool } = await import("../src/llm/tasks");
    const { doc, fixed, recursion, arms } = library();
    const made = JSON.parse(execTool(doc, "create_node", { parent: fixed, title: "", body: "", quote: "Octopus", target: "/Minds/Arms" })).created as NodeId;
    expect(doc.snap().nodes[made].ref).toEqual({ kind: "node", id: arms, path: ["Minds", "Arms"] });
    expect(JSON.parse(execTool(doc, "read_node", { id: fixed })).notes[0].target).toBe("/Minds/Arms");
    // A node's id, or a path below the top of the node written in, does as well.
    execTool(doc, "update_node", { id: made, target: recursion });
    expect(doc.snap().nodes[made].ref).toEqual({ kind: "node", id: recursion, path: ["Fixed points", "Recursion"] });
    execTool(doc, "update_node", { id: made, target: "./Recursion" });
    expect(doc.snap().nodes[made].ref).toMatchObject({ id: recursion });
    const found = JSON.parse(execTool(doc, "find", { query: "tastes" })).matches[0];
    expect(found).toMatchObject({ id: arms, top: "Minds", path: "Minds › Arms" });
    execTool(doc, "update_node", { id: made, target: "w:Octopus" });
    expect(doc.snap().nodes[made].ref).toEqual(W("Octopus"));
    expect(JSON.parse(execTool(doc, "read_node", { id: fixed })).notes[0].target).toBe("w:Octopus");
    execTool(doc, "update_node", { id: fixed, target: "https://example.org/fp" });
    expect(doc.snap().nodes[fixed].ref).toEqual({ kind: "url", url: "https://example.org/fp" });
    execTool(doc, "update_node", { id: fixed, target: "" });
    expect(doc.snap().nodes[fixed].ref).toBeUndefined();
    expect(() => execTool(doc, "update_node", { id: made, target: "/Minds/No such section" })).toThrow(OpError);
    expect(() => execTool(doc, "update_node", { id: made, target: "javascript:alert(1)" })).toThrow(OpError);
  });
});
