/** The model-driven tasks, run end to end against the deterministic mock. */
import { describe, expect, it } from "vitest";
import { Doc, isStale, notesOf, retitleOps, sections, staleness, type NodeId } from "../src/core/model";
import { history, mergeBranch, verifyHistory } from "../src/core/repo";
import { mockLLM } from "../src/llm/mock";
import { cascade, commitExpansion, deepen, execTool, parseSections, reconcile, regenUp, resolveConflicts, runAgent, streamExpansion } from "../src/llm/tasks";
import { renderContext } from "../src/llm/prompts";
import { formFor } from "../src/core/text";

const llm = mockLLM();

function fixture() {
  const doc = Doc.create("alice", "Root", "The root summarises its parts.");
  const root = doc.snap().root;
  const ops = [
    { op: "create" as const, parent: root, title: "Part", body: "Part summarises its leaves. It has two of them." },
    { op: "create" as const, parent: "$0" as NodeId, title: "Leaf A", body: "Leaf A says the engine streams text." },
    { op: "create" as const, parent: "$0" as NodeId, title: "Leaf B", body: "Leaf B says anchors are cursors." },
    { op: "bless" as const, id: "$0" as NodeId },
    { op: "bless" as const, id: "$1" as NodeId },
    { op: "bless" as const, id: "$2" as NodeId },
    { op: "bless" as const, id: root },
  ];
  const { created } = doc.apply(ops, "Seed", { actor: "llm" });
  // The root here is a model-written summary, so it may be rewritten.
  doc.apply([{ op: "update", id: root, pinned: false }, { op: "bless", id: root }], "Unpin root");
  return { doc, root, part: created[0], a: created[1], b: created[2] };
}

describe("expansion", () => {
  it("streams a note and anchors it to the selection", async () => {
    const { doc, a } = fixture();
    const body = doc.snap().nodes[a].body;
    const start = body.indexOf("streams text");
    const req = { node: a, range: [start, start + 12] as [number, number], quote: "streams text", form: formFor("streams text"), lens: "define" };
    let streamed = "";
    const text = await streamExpansion(llm, doc.snap(), req, (d) => (streamed += d));
    expect(streamed).toBe(text);
    const id = commitExpansion(doc, req, text);
    const note = doc.snap().nodes[id];
    expect(note).toMatchObject({ kind: "note", form: "gloss", by: "llm", pinned: false, body: "mock gloss of streams text" });
    expect(note.anchors[0].text).toBe("streams text");
    expect(isStale(doc.snap(), id)).toBe(false);
    // A note does not make its parent's summary stale.
    expect(staleness(doc.snap(), a).up).toBe(false);
  });

  it("re-finds the selection if the text moved while generating, and refuses if it is gone", async () => {
    const { doc, a } = fixture();
    const req = { node: a, range: [18, 30] as [number, number], quote: "streams text", form: "gloss" as const, lens: "define" };
    doc.apply([{ op: "update", id: a, body: "Meanwhile, edited: Leaf A says the engine streams text." }], "Concurrent edit");
    const id = commitExpansion(doc, req, "x");
    expect(doc.snap().nodes[id].anchors[0].text).toBe("streams text");
    doc.apply([{ op: "update", id: a, body: "All gone." }], "Remove");
    expect(() => commitExpansion(doc, req, "y")).toThrow(/edited away/);
  });

  it("deepens a leaf into subsections without making it stale", async () => {
    const { doc, a } = fixture();
    const created = await deepen(llm, doc, a);
    expect(created).toHaveLength(2);
    expect(sections(doc.snap(), a).map((id) => doc.snap().nodes[id].title)).toEqual(["First part of Leaf A", "Second part of Leaf A"]);
    expect(Object.keys(doc.snap().nodes).filter((id) => isStale(doc.snap(), id as NodeId))).toEqual([]);
  });

  it("parses streamed sections", () => {
    expect(parseSections("preamble\n## One\nBody one.\n\nMore.\n## Two\nBody two.")).toEqual([
      { title: "One", body: "Body one.\n\nMore." },
      { title: "Two", body: "Body two." },
    ]);
  });
});

describe("cascade", () => {
  it("rewrites as far up as the resolver says, blesses the next level, and leaves nothing stale", async () => {
    const { doc, root, part, a } = fixture();
    doc.apply([{ op: "update", id: a, body: "Leaf A now says something different." }], "Human edit");
    expect(staleness(doc.snap(), part).up).toBe(true);
    const events = await cascade(llm, doc, a, "the body of “Leaf A” was edited");
    expect(events.map((e) => e.kind)).toEqual(["decide", "rewrite", "keep"]);
    expect(doc.snap().nodes[part].body).toBe("Re-summarised from: Leaf A; Leaf B.");
    expect(doc.snap().nodes[root].body).toBe("The root summarises its parts.");
    expect(Object.keys(doc.snap().nodes).filter((id) => isStale(doc.snap(), id as NodeId))).toEqual([]);
    expect(history(doc).slice(0, 2).map((c) => c.tag)).toEqual(["regen", "regen"]);
    expect(verifyHistory(doc).mismatches).toEqual([]);
  });

  it("never overwrites a pinned node: it is flagged and left", async () => {
    const { doc, part, a } = fixture();
    doc.apply([{ op: "update", id: part, body: "A human wrote this summary." }], "Human writes the parent");
    // That edit makes the leaves stale-down; accept them as they are for this test.
    doc.apply(sections(doc.snap(), part).map((id) => ({ op: "bless" as const, id })), "Accept");
    doc.apply([{ op: "update", id: a, body: "Leaf A changed again." }], "Human edit");
    const events = await cascade(llm, doc, a, "edit");
    expect(events.map((e) => e.kind)).toEqual(["decide", "locked"]);
    expect(doc.snap().nodes[part].body).toBe("A human wrote this summary.");
    expect(staleness(doc.snap(), part).up).toBe(true);
  });

  it("revises only the children that are on screen; the rest stay lazily stale", async () => {
    const { doc, part, a, b } = fixture();
    doc.apply([{ op: "update", id: part, body: "Part now says something new." }], "Human edits parent");
    await cascade(llm, doc, part, "edit", { rendered: (id) => id === a });
    expect(doc.snap().nodes[a].body).toMatch(/Revised to follow its parent/);
    expect(staleness(doc.snap(), a).down).toBe(false);
    expect(staleness(doc.snap(), b).down).toBe(true);
    // Opening the other child later reconciles it.
    expect(await reconcile(llm, doc, b)).toBe(true);
    expect(staleness(doc.snap(), b).down).toBe(false);
    // Revising children did not bounce staleness back up to the edited parent.
    expect(staleness(doc.snap(), part).up).toBe(false);
  });
});

describe("semantic merge", () => {
  it("has a model propose a resolution as its own reviewable commit", async () => {
    const { doc, a } = fixture();
    const other = doc.fork("bob");
    doc.apply([{ op: "update", id: a, body: "Leaf A says the engine always streams." }], "A");
    other.apply([{ op: "update", id: a, body: "Leaf A says the engine never streams." }], "B");
    const report = mergeBranch(doc, other, "bob");
    expect(report.conflicts).toHaveLength(1);
    expect(await resolveConflicts(llm, doc)).toBe(1);
    const c = doc.conflicts()[0];
    expect(c).toMatchObject({ status: "resolved", resolvedBy: "resolver", rationale: "mock: took the first side" });
    expect(doc.snap().nodes[a].body).toBe(c.a);
    expect(history(doc)[0]).toMatchObject({ tag: "resolve", actor: "llm" });
  });
});

describe("link marks in what the model writes", () => {
  it("are taken out of the stored text and handed over, with the node they belong to", async () => {
    const { doc, a } = fixture();
    const marks: [NodeId, string[]][] = [];
    const hooks = { nearby: async () => [{ handle: a, title: "Leaf A", document: "Root" }], marks: (id: NodeId, m: { phrase: string }[]) => marks.push([id, m.map((x) => x.phrase)]) };
    const created = await deepen(llm, doc, a, undefined, undefined, hooks);
    const bodies = created.map((c) => doc.snap().nodes[c].body);
    expect(bodies.join(" ")).not.toContain("[[");
    expect(bodies[0]).toBe("Mock body one. It elaborates the first half, as a cephalopod would.");
    expect(marks).toEqual([
      [created[0], ["cephalopod"]],
      [created[1], ["Leaf A", "no such article anywhere"]],
    ]);
    // A passage note: its marks go with the note.
    const body = doc.snap().nodes[a].body;
    const at = body.indexOf("streams text");
    const req = { node: a, range: [at, at + 12] as [number, number], quote: "streams text", form: "passage" as const, lens: "elaborate" };
    let got: string[] = [];
    const note = commitExpansion(doc, req, await streamExpansion(llm, doc.snap(), req), (_, m) => (got = m.map((x) => x.phrase)));
    expect(doc.snap().nodes[note].body).toContain("as far as the octopus.");
    expect(got).toEqual(["octopus"]);
  });

  it("are explained in the prompt with the nearby list, outside the cached context", async () => {
    const { doc, a } = fixture();
    let seen: { context: string; prompt: string } | null = null;
    const spy = { ...llm, stream: async (r: { context: string; prompt: string }, on: (d: string) => void) => ((seen = r), llm.stream(r as never, on)) } as typeof llm;
    await deepen(spy, doc, a, undefined, undefined, { nearby: async () => [{ handle: "1@2", title: "Elsewhere", document: "Other" }] });
    expect(seen!.prompt).toContain("Nearby in this library:\n- Elsewhere (in Other) [1@2]");
    expect(seen!.prompt).toContain("[[phrase]]");
    expect(seen!.context).not.toContain("Nearby");
  });
});

describe("editor agent", () => {
  it("edits a fork with the same ops as a person and merges back", async () => {
    const { doc, part } = fixture();
    const events: string[] = [];
    const result = await runAgent(llm, doc, 'add "Leaf C"', part, (e) => events.push(e.kind));
    expect(result.commits).toBe(1);
    expect(events).toEqual(["say", "tool", "say"]);
    expect(sections(doc.snap(), part).map((id) => doc.snap().nodes[id].title)).toEqual(["Leaf A", "Leaf B", "Leaf C"]);
    const commit = history(doc).find((c) => c.message.startsWith("Agent: add"))!;
    expect(commit).toMatchObject({ by: "agent", actor: "llm" });
    // The new child makes the parent stale-up, like any other edit.
    expect(staleness(doc.snap(), part).up).toBe(true);
  });

  it("merges with edits the person made while it worked", async () => {
    const { doc, part, a } = fixture();
    const slow = mockLLM({ delay: 5 });
    const running = runAgent(slow, doc, 'add "Leaf C"', part);
    doc.apply([{ op: "update", id: a, body: "Edited by the person meanwhile." }], "Concurrent human edit");
    const result = await running;
    expect(result.report.kind).toBe("merge");
    expect(doc.snap().nodes[a].body).toBe("Edited by the person meanwhile.");
    expect(sections(doc.snap(), part)).toHaveLength(3);
    expect(verifyHistory(doc).mismatches).toEqual([]);
  });

  it("gets refused ops back as tool errors instead of crashing", async () => {
    const { doc, part } = fixture();
    const events: { kind: string; text: string }[] = [];
    const result = await runAgent(llm, doc, "break", part, (e) => events.push(e));
    expect(events.find((e) => e.kind === "error")?.text).toMatch(/inside itself/);
    expect(result.commits).toBe(0);
  });

  it("can ask the link scanner for suggestions, and is told after a write how many there are", async () => {
    const { doc, part } = fixture();
    const asked: string[] = [];
    const hooks = {
      suggest: async (_: Doc, id: NodeId) => (asked.push(id), [{ quote: "leaves", target: "w:Leaf", tier: "suggest", score: 0.66, why: "a test" }]),
    };
    const listed = await runAgent(llm, doc, "suggest links", part, undefined, undefined, hooks);
    expect(listed.summary).toContain("w:Leaf");
    expect(listed.commits).toBe(0);
    const added = await runAgent(llm, doc, 'add "Leaf C"', part, undefined, undefined, hooks);
    expect(added.summary).toContain("1 link suggestion available");
    expect(asked).toHaveLength(2);
    // Without a scanner the tool says so instead of failing.
    expect((await runAgent(llm, doc, "suggest links", part)).summary).toContain("not available");
  });

  it("validates tool input", () => {
    const { doc, part } = fixture();
    expect(() => execTool(doc, "update_node", { id: part })).toThrow(/title, a body/);
    expect(() => execTool(doc, "read_node", { id: "999@1" })).toThrow(/no node/);
    expect(() => execTool(doc, "create_node", { parent: part, title: "x", body: "y", quote: "not in the body" })).toThrow(/quote not found/);
    expect(JSON.parse(execTool(doc, "find", { query: "cursors" })).matches[0].title).toBe("Leaf B");
    const read = JSON.parse(execTool(doc, "read_node", { id: part }));
    expect(read.sections.map((s: { title: string }) => s.title)).toEqual(["Leaf A", "Leaf B"]);
  });
});

describe("context", () => {
  it("is stable while notes are added, so the cached prefix survives expansions", async () => {
    const { doc, a } = fixture();
    const before = renderContext(doc.snap(), a);
    commitExpansion(doc, { node: a, range: [0, 6], quote: "Leaf A", form: "gloss", lens: "define" }, "a leaf");
    expect(notesOf(doc.snap(), a)).toHaveLength(1);
    expect(renderContext(doc.snap(), a)).toBe(before);
  });
});

// ---- in a library ----

/** A library of two model-written documents, Alpha (with a part and two leaves) and Beta. */
function libraryFixture() {
  const doc = Doc.library("alice");
  const lib = doc.snap().root;
  const write = (title: string) =>
    doc.apply(
      [
        { op: "create", parent: lib, title, body: `${title} summarises its part.` },
        { op: "create", parent: "$0" as NodeId, title: `${title} part`, body: `The ${title} part summarises its leaves.` },
        { op: "create", parent: "$1" as NodeId, title: `${title} leaf one`, body: `The first ${title} leaf says one thing.` },
        { op: "create", parent: "$1" as NodeId, title: `${title} leaf two`, body: `The second ${title} leaf says another.` },
        ...[0, 1, 2, 3].map((i) => ({ op: "bless" as const, id: `$${i}` as NodeId })),
      ],
      `Write ${title}`,
      { actor: "llm" },
    ).created;
  const [a, aPart, aLeaf] = write("Alpha");
  const [b, bPart, bLeaf] = write("Beta");
  return { doc, lib, a, aPart, aLeaf, b, bPart, bLeaf };
}

/** The mock, recording every request it is sent. */
function recording() {
  const sent: { task?: string; context?: string; vars?: Record<string, string> }[] = [];
  const base = mockLLM();
  const llm: typeof base = {
    ...base,
    stream: (req, onText, signal) => (sent.push(req), base.stream(req, onText, signal)),
    json: (req, signal) => (sent.push(req), base.json(req, signal)),
    turn: (req, signal) => (sent.push(req as never), base.turn(req, signal)),
  };
  return { llm, sent };
}

describe("context in a library", () => {
  it("is the focused node's document only, and stays byte-for-byte the same while other documents change", () => {
    const { doc, lib, aLeaf, b, bLeaf } = libraryFixture();
    const before = renderContext(doc.snap(), aLeaf);
    expect(before).toContain("# Alpha");
    expect(before).toContain("Alpha leaf two");
    expect(before).not.toContain("Beta");
    doc.apply([{ op: "update", id: bLeaf, body: "Beta changed a great deal." }], "Edit the other document");
    doc.apply([{ op: "create", parent: lib, title: "Gamma", body: "A third document." }], "New document");
    doc.apply(retitleOps(doc.snap(), b, "Beta renamed"), "Rename the other document");
    doc.apply([{ op: "update", id: lib, body: "The library's own text." }], "Write the library");
    expect(renderContext(doc.snap(), aLeaf)).toBe(before);
    // On the library itself, which is in no document, the context is the list of documents.
    expect(renderContext(doc.snap(), lib)).toBe("<library>\n- Alpha\n- Beta renamed\n- Gamma\n</library>");
  });

  it("every model task sends only the document it works in", async () => {
    const { doc, aLeaf, aPart, b } = libraryFixture();
    const { llm, sent } = recording();
    const body = doc.snap().nodes[aLeaf].body;
    await streamExpansion(llm, doc.snap(), { node: aLeaf, range: [4, 9], quote: body.slice(4, 9), form: "gloss", lens: "define" });
    doc.apply([{ op: "update", id: aLeaf, body: "Alpha's first leaf now says something new." }], "Edit");
    await cascade(llm, doc, aLeaf, "edited");
    await deepen(llm, doc, aLeaf);
    await reconcile(llm, doc, aPart);
    await runAgent(llm, doc, 'add "Another"', aPart);
    expect(sent.length).toBeGreaterThan(3);
    for (const req of sent) {
      const context = req.context ?? "";
      expect(context).toMatch(/^# (\[[^\]]+\] )?Alpha$/m); // the editor agent's outline carries ids
      expect(context).not.toContain("Beta");
    }
    expect(doc.snap().nodes[b].title).toBe("Beta");
  });

  it("a cascade stops at the document: the library above it is never asked about or rewritten", async () => {
    const { doc, lib, a, aPart, b } = libraryFixture();
    const { llm, sent } = recording();
    const libraryBefore = doc.snap().nodes[lib];
    // An edit to the document's part: the chain is the document alone, not the library above it.
    doc.apply([{ op: "update", id: aPart, body: "The Alpha part says something else now." }], "Edit the part");
    const events = await cascade(llm, doc, aPart, "edited");
    expect(sent.find((r) => r.task === "cascade")?.vars?.chain).toBe("1");
    expect(events.filter((e) => e.kind !== "revise").map((e) => [e.kind, e.node])).toEqual([["decide", a], ["rewrite", a]]);
    expect(doc.snap().nodes[a].body).toMatch(/^Re-summarised from: Alpha part/);
    const snap = doc.snap();
    expect(snap.nodes[lib].body).toBe(libraryBefore.body);
    expect(staleness(snap, lib)).toEqual({ up: false, down: false, orphan: false });
    // Rewriting a document's text leaves the other documents alone.
    expect(isStale(snap, b)).toBe(false);
    // And the model never writes the library itself.
    expect(await regenUp(llm, doc, lib)).toBe(false);
    await expect(deepen(llm, doc, lib)).rejects.toThrow(/does not write the library/);
    expect(() => execTool(doc, "update_node", { id: lib, body: "x" })).toThrow(/library itself/);
  });

  it("settles conflicts one document at a time, each with its own context", async () => {
    const { doc, aLeaf, bLeaf } = libraryFixture();
    const other = doc.fork("bob");
    doc.apply([{ op: "update", id: aLeaf, body: "Alpha: always." }, { op: "update", id: bLeaf, body: "Beta: always." }], "A");
    other.apply([{ op: "update", id: aLeaf, body: "Alpha: never." }, { op: "update", id: bLeaf, body: "Beta: never." }], "B");
    expect(mergeBranch(doc, other, "bob").conflicts).toHaveLength(2);
    const { llm, sent } = recording();
    expect(await resolveConflicts(llm, doc)).toBe(2);
    const calls = sent.filter((r) => r.task === "resolve");
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => (c.context!.includes("# Alpha") ? "Alpha" : c.context!.includes("# Beta") ? "Beta" : "?")).sort()).toEqual(["Alpha", "Beta"]);
  });
});
