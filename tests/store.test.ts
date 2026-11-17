/** The libraries on disk (seeding and starter files), and a node with everything under it: imported, exported, copied, moved and addressed wherever it is. */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Libraries, importStarters, readIndex } from "../server/libraries";
import { FormatError, serializeDoc } from "../src/core/format";
import { LIBRARY_ID, address, inLibrary, resolve, splitLibrary } from "../src/core/address";
import { resolveNode } from "../src/core/links";
import { Doc, descendants, isStale, sections, staleness, tops } from "../src/core/model";
import { SEED_TITLE, importTree, writeSeed } from "../src/core/seed";
import { seed } from "../src/seed/tree";

const prompt = readFileSync(new URL("../src/seed/prompt.txt", import.meta.url), "utf8");
const temp = () => mkdtempSync(join(tmpdir(), "ie-lib-"));
const quiet = () => {};
const MD = (title: string) => `# ${title}\n\nA root body with a phrase.\n\n## One\n\nSection text.\n\n^ "Section" gloss: a note\n`;

describe("the libraries on disk", () => {
  it("starts an empty data directory as one library with the first tree, written once", () => {
    const data = temp();
    let seeded = 0;
    const libs = new Libraries(data, quiet).open((doc) => (seeded++, writeSeed(doc, prompt, seed)));
    const store = libs.first();
    expect(seeded).toBe(1);
    expect(store.titles()).toEqual([SEED_TITLE]);
    expect(store.main.snap().library).toBe(true);
    expect(readIndex(join(data, "libraries")).map((e) => e.id)).toEqual([store.id]);
    store.flush();
    // A second start loads the same library (same id) and seeds nothing.
    const again = new Libraries(data, quiet).open(() => {
      throw new Error("should not seed twice");
    });
    expect(again.first().id).toBe(store.id);
    expect(again.first().main.stateHash()).toBe(store.main.stateHash());
  });

  it("writes the starter files, in file name order, into the first library only; a broken one is skipped", () => {
    const data = temp();
    const lib = temp();
    writeFileSync(join(lib, "good-one.md"), MD("Good one"));
    writeFileSync(join(lib, "Second File.md"), MD("Second"));
    writeFileSync(join(lib, "broken.md"), MD("Broken").replace('"Section"', '"Missing"'));
    const logs: string[] = [];
    const libs = new Libraries(data, quiet).open((doc) => importStarters(doc, lib, (m) => logs.push(m)));
    expect(libs.first().titles()).toEqual(["Second", "Good one"]); // file-name order: "S" sorts before "g"
    expect(logs.join("\n")).toMatch(/skipped broken\.md:\n {2}library\/broken\.md:9: in “One”: quote not found: "Missing"/);
    // A new library starts with its root alone, whatever the starter directory holds.
    const work = libs.create("Work");
    expect(work.titles()).toEqual([]);
    expect(work.title).toBe("Work");
  });
});

describe("a node and everything under it, wherever it is", () => {
  const LINKED = `# Imported\n\nA root body with a phrase.\n\n## One\n\nSection text.\n\n^ "Section" gloss: a note\n^ "text" link -> ./One\n`;

  it("is imported under any node, its paths below the file's top stored from the library root, and exported back the same", () => {
    const lib = Doc.library("alice");
    const tides = importTree(lib, MD("Tides"), "tides.md");
    const one = sections(lib.snap(), tides)[0];
    // Under a section two levels down, at the end of its children.
    const id = importTree(lib, LINKED, "linked.md", { parent: one });
    let snap = lib.snap();
    expect(snap.nodes[id].parent).toBe(one);
    expect(snap.nodes[one].children.at(-1)).toBe(id);
    expect([id, ...descendants(snap, id)].every((n) => snap.nodes[n].by === "llm")).toBe(true);
    const inner = sections(snap, id)[0];
    const link = snap.nodes[inner].children.map((c) => snap.nodes[c]).find((c) => c.ref)!;
    expect(link.ref).toMatchObject({ kind: "node", id: inner, path: ["Tides", "One", "Imported", "One"] });
    expect(resolveNode(snap, { kind: "node", path: ["Tides", "One", "Imported", "One"] })).toBe(inner);
    // Nothing starts out stale under it; only the node it went under has a new section to summarise.
    for (const n of [id, ...descendants(snap, id)]) expect(isStale(snap, n)).toBe(false);
    expect(staleness(snap, one).up).toBe(true);
    // Exported from where it is, its own paths are written relative to it again.
    expect(serializeDoc(snap, id).text).toBe(LINKED);
    // At a place among the children, when asked.
    const first = importTree(lib, MD("First"), "first.md", { parent: tides, index: 0 });
    snap = lib.snap();
    expect(snap.nodes[tides].children[0]).toBe(first);
    // A file with a bad quote writes nothing, wherever it was to go.
    const before = lib.stateHash();
    expect(() => importTree(lib, MD("Bad").replace('"Section"', '"Nowhere"'), "bad.md", { parent: inner })).toThrow(FormatError);
    expect(lib.stateHash()).toBe(before);
  });

  it("is copied just after itself with everything under it, and the copy's links inside it still point into the original", () => {
    const lib = Doc.library("alice");
    const tides = importTree(lib, MD("Tides"), "tides.md");
    const id = importTree(lib, LINKED, "linked.md", { parent: sections(lib.snap(), tides)[0] });
    const parent = lib.snap().nodes[id].parent!;
    const [copy] = lib.apply([{ op: "copy", id, parent, index: lib.snap().nodes[parent].children.indexOf(id) + 1, title: "Imported (copy)" }], "Duplicate").created;
    const snap = lib.snap();
    expect(snap.nodes[parent].children.indexOf(copy)).toBe(snap.nodes[parent].children.indexOf(id) + 1);
    expect(sections(snap, copy).map((c) => snap.nodes[c].title)).toEqual(["One"]);
    expect(sections(snap, copy)[0]).not.toBe(sections(snap, id)[0]);
    for (const n of [copy, ...descendants(snap, copy)]) expect(isStale(snap, n)).toBe(false);
  });

  it("is moved under any other node, never under itself", () => {
    const lib = Doc.library("alice");
    const a = importTree(lib, MD("Alpha"), "a.md");
    const b = importTree(lib, MD("Beta"), "b.md");
    const deep = sections(lib.snap(), b)[0];
    lib.apply([{ op: "move", id: a, parent: deep }], "Move under");
    expect(lib.snap().nodes[a].parent).toBe(deep);
    expect(() => lib.apply([{ op: "move", id: b, parent: sections(lib.snap(), a)[0] }], "Move under itself")).toThrow(/inside itself/);
    // And back to the top of the library.
    lib.apply([{ op: "move", id: a, parent: lib.snap().root }], "Move to the top");
    expect(tops(lib.snap())).toEqual([b, a]);
  });

  it("has an address made of its id alone: /n/<id>, and / for the library root", () => {
    const lib = Doc.library("alice");
    const a = importTree(lib, MD("Tides"), "tides.md");
    const b = importTree(lib, MD("Codes"), "codes.md");
    const snap = lib.snap();
    const one = sections(snap, a)[0];
    expect(address(snap, snap.root)).toBe("/");
    expect(address(snap, a)).toBe(`/n/${encodeURIComponent(a)}`);
    expect(address(snap, one)).toBe(`/n/${encodeURIComponent(one)}`);
    for (const id of [snap.root, a, one]) expect(resolve(snap, address(snap, id))).toEqual({ node: id });
    // A moved node keeps its address; a renamed one too.
    lib.apply([{ op: "move", id: one, parent: b }, { op: "update", id: one, title: "Renamed" }], "move and rename");
    expect(address(lib.snap(), one)).toBe(`/n/${encodeURIComponent(one)}`);
    expect(resolve(lib.snap(), `/n/${encodeURIComponent(one)}`)).toEqual({ node: one });
    // What names nothing says so (the page then shows the library): a gone node, an old `/doc/…` address, anything else.
    expect(resolve(lib.snap(), "/n/999%40999")).toEqual({ missing: "no node 999@999" });
    expect(resolve(lib.snap(), "/doc/tides")).toEqual({ missing: "no page /doc/tides" });
    expect(resolve(lib.snap(), "/n/%E0%A4%A")).toMatchObject({ missing: expect.any(String) });
  });

  it("is addressed under its library: /l/<library>/n/<id>; an address without a library is read in the one last used", () => {
    expect(inLibrary("abc", "/")).toBe("/l/abc");
    expect(inLibrary("abc", "/n/1%402")).toBe("/l/abc/n/1%402");
    expect(splitLibrary("/l/abc")).toEqual({ library: "abc", part: "/" });
    expect(splitLibrary("/l/abc/n/1%402")).toEqual({ library: "abc", part: "/n/1%402" });
    expect(splitLibrary("/l/abc/w/en/Octopus")).toEqual({ library: "abc", part: "/w/en/Octopus" });
    expect(splitLibrary("/")).toEqual({ library: null, part: "/" });
    expect(splitLibrary("/n/1%402")).toEqual({ library: null, part: "/n/1%402" });
    expect(splitLibrary("/doc/tides")).toEqual({ library: null, part: "/doc/tides" });
    const lib = Doc.library("alice");
    expect(LIBRARY_ID.test(lib.libraryId!)).toBe(true);
  });

  it("is copied into another library whole by graft: flags, notes on the root's text, and a map of old ids to new", () => {
    const from = Doc.library("alice");
    const root = from.snap().root;
    const [top, , box] = from.apply(
      [
        { op: "update", id: root, body: "Root text with words." },
        { op: "create", parent: root, title: "Top", body: "Some text." },
        { op: "create", parent: root, kind: "note", quote: "words", body: "On the root." },
        { op: "create", parent: root, kind: "section", title: "Wikipedia", body: "", articles: true },
      ],
      "make",
    ).created;
    from.apply([{ op: "update", id: top, pinned: false, nolink: ["text"] }], "flags");
    const src = from.snap();
    const into = Doc.library("bob");
    const to = into.snap().root;
    into.begin("copy", "human");
    (into.tree.getNodeByID(to)!.data.get("body") as { insert(i: number, t: string): void }).insert(0, src.nodes[root].body);
    const ids = new Map();
    for (const c of src.nodes[root].children) into.graft(src, c, to, { keepAnchors: true, ids });
    into.commit("copy", "human");
    const got = into.snap();
    expect(ids.size).toBe(3);
    const note = got.nodes[ids.get(src.nodes[root].children[1])];
    expect(note.anchors.map((a) => a.text)).toEqual(["words"]);
    expect(got.nodes[ids.get(box)].articles).toBe(true);
    expect(got.nodes[ids.get(top)]).toMatchObject({ title: "Top", pinned: false, nolink: ["text"] });
    // Without keepAnchors, a note at the top of a graft into another text loses its anchors, as before.
    into.begin("again", "human");
    const lone = into.graft(src, src.nodes[root].children[1], to);
    into.commit("again", "human");
    expect(into.snap().nodes[lone].anchors).toEqual([]);
    // The Wikipedia flag goes only where create allows it: under a library root.
    const nested = from.apply([{ op: "copy", id: box, parent: top }], "copy box").created[0];
    expect(from.snap().nodes[nested].articles).toBeUndefined();
  });
});
