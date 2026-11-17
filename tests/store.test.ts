/** The library on disk: seeding and starter files; and (until step 2 removes them) the UI's document features: the root's children made, listed and addressed. */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UndoManager } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { LibraryStore } from "../server/library";
import { FormatError, serializeDoc } from "../src/core/format";
import { address, createDoc, deleteDoc, duplicateDoc, findTop, importDoc, listDocs, renameDoc, resolve } from "../src/core/library";
import { Doc, SYSTEM_ORIGIN, descendants, sections } from "../src/core/model";
import { SEED_TITLE, writeSeed } from "../src/core/seed";
import { seed } from "../src/seed/tree";

const prompt = readFileSync(new URL("../src/seed/prompt.txt", import.meta.url), "utf8");
const temp = () => mkdtempSync(join(tmpdir(), "ie-lib-"));
const quiet = () => {};
const MD = (title: string) => `# ${title}\n\nA root body with a phrase.\n\n## One\n\nSection text.\n\n^ "Section" gloss: a note\n`;

describe("the library on disk", () => {
  it("starts an empty data directory as one library with the first tree, written once", () => {
    const data = temp();
    const store = new LibraryStore(data, quiet).open();
    store.seedFirst((doc) => writeSeed(doc, prompt, seed));
    expect(store.list().map((d) => d.title)).toEqual([SEED_TITLE]);
    expect(store.main.snap().library).toBe(true);
    expect(JSON.parse(readFileSync(join(data, "library.json"), "utf8")).imported).toEqual(["infinite-expand"]);
    store.flush();
    // A second start loads the same library (same id) and writes nothing new.
    const again = new LibraryStore(data, quiet).open();
    again.seedFirst(() => {
      throw new Error("should not seed twice");
    });
    expect(again.id).toBe(store.id);
    expect(again.main.stateHash()).toBe(store.main.stateHash());
  });

  it("imports each starter file once, as a child of the root; a deleted one stays deleted and a broken one is skipped", () => {
    const data = temp();
    const lib = temp();
    writeFileSync(join(lib, "good-one.md"), MD("Good one"));
    writeFileSync(join(lib, "Second File.md"), MD("Second"));
    writeFileSync(join(lib, "broken.md"), MD("Broken").replace('"Section"', '"Missing"'));
    const logs: string[] = [];
    const store = new LibraryStore(data, (m) => logs.push(m)).open();
    store.importLibrary(lib);
    expect(store.list().map((d) => d.title)).toEqual(["Second", "Good one"]); // file-name order: "S" sorts before "g"
    expect(logs.join("\n")).toMatch(/skipped broken\.md:\n {2}library\/broken\.md:9: in “One”: quote not found: "Missing"/);

    deleteDoc(store.main, findTop(store.main.snap(), "good-one")!, "alice");
    store.save("main");
    const again = new LibraryStore(data, quiet).open();
    again.importLibrary(lib);
    expect(again.list().map((d) => d.title)).toEqual(["Second"]);
    // Once fixed, the broken file is picked up.
    writeFileSync(join(lib, "broken.md"), MD("Broken"));
    again.importLibrary(lib);
    expect(again.list().map((d) => d.title)).toEqual(["Second", "Broken"]);
  });
});

describe("the root's children (the UI's documents, until step 2)", () => {
  it("are created, renamed, duplicated and deleted as ordinary commits, with names made from their titles", () => {
    const lib = Doc.library("alice");
    const a = createDoc(lib, "My notes", "alice");
    const snap = () => lib.snap();
    expect(snap().nodes[a]).toMatchObject({ parent: snap().root, title: "My notes", by: "human" });
    const nameOf = (title: string) => {
      const id = createDoc(lib, title, "alice");
      return listDocs(snap()).find((d) => d.node === id)!.slug;
    };
    expect(nameOf("My notes")).toBe("my-notes");
    expect(nameOf("../../etc/passwd")).toBe("etc-passwd");
    // A name another child has too finds the first; the id finds each.
    expect(findTop(snap(), "my-notes")).toBe(a);
    expect(findTop(snap(), a)).toBe(a);
    const [inner] = lib.apply([{ op: "create", parent: a, title: "Inside" }], "add").created;
    expect(findTop(snap(), "inside")).toBeUndefined();

    renameDoc(lib, a, "Renamed", "alice");
    expect(listDocs(snap()).find((d) => d.node === a)).toMatchObject({ title: "Renamed", slug: "renamed" });
    const copy = duplicateDoc(lib, a, "Renamed (copy)", "alice");
    expect(listDocs(snap()).find((d) => d.node === copy)).toMatchObject({ title: "Renamed (copy)", slug: "renamed-copy" });
    expect(snap().nodes[snap().root].children.indexOf(copy)).toBe(snap().nodes[snap().root].children.indexOf(a) + 1);
    expect(sections(snap(), copy).map((id) => snap().nodes[id].title)).toEqual(["Inside"]);
    expect(sections(snap(), copy)[0]).not.toBe(inner); // a copy, not the same nodes

    // Delete is an ordinary delete: undo brings it back, content and all.
    const undo = new UndoManager(lib.loro, { mergeInterval: 0, excludeOriginPrefixes: [SYSTEM_ORIGIN] });
    lib.group = { start: () => undo.groupStart(), end: () => undo.groupEnd() };
    deleteDoc(lib, copy, "alice");
    expect(findTop(snap(), "renamed-copy")).toBeUndefined();
    expect(undo.undo()).toBe(true);
    lib.touch();
    const back = findTop(snap(), "renamed-copy")!;
    expect(snap().nodes[back].title).toBe("Renamed (copy)");
    expect(sections(snap(), back).map((id) => snap().nodes[id].title)).toEqual(["Inside"]);
  });

  it("import and export one tree in the text format; a file with a bad quote writes nothing", () => {
    const lib = Doc.library("alice");
    createDoc(lib, "Something else", "alice");
    const id = importDoc(lib, MD("Imported thing"), "thing.md");
    const snap = lib.snap();
    expect([id, ...descendants(snap, id)].every((n) => snap.nodes[n].by === "llm")).toBe(true);
    expect(serializeDoc(snap, id).text).toBe(MD("Imported thing"));
    const before = lib.stateHash();
    expect(() => importDoc(lib, MD("Bad").replace('"Section"', '"Nowhere"'), "bad.md")).toThrow(FormatError);
    expect(lib.stateHash()).toBe(before);
    expect(listDocs(lib.snap()).map((d) => d.slug)).toEqual(["something-else", "imported-thing"]);
  });

  it("have addresses: /doc/<name> for one, /doc/<name>/<node> for a node under it, / for the library", () => {
    const lib = Doc.library("alice");
    const a = importDoc(lib, MD("Tides"), "tides.md");
    const b = importDoc(lib, MD("Codes"), "codes.md");
    const snap = lib.snap();
    const one = sections(snap, a)[0];
    expect(address(snap, snap.root)).toBe("/");
    expect(address(snap, a)).toBe("/doc/tides");
    expect(address(snap, one)).toBe(`/doc/tides/${encodeURIComponent(one)}`);
    for (const id of [snap.root, a, one]) expect(resolve(snap, address(snap, id))).toEqual({ node: id });
    // The node id is what counts: a link whose node has moved to another document still finds it.
    lib.apply([{ op: "move", id: one, parent: b }], "move");
    expect(resolve(lib.snap(), `/doc/tides/${encodeURIComponent(one)}`)).toEqual({ node: one });
    expect(address(lib.snap(), one)).toBe(`/doc/codes/${encodeURIComponent(one)}`);
    expect(resolve(lib.snap(), `/n/${encodeURIComponent(one)}`)).toEqual({ node: one });
    expect(resolve(lib.snap(), "/doc/nothing")).toEqual({ missing: "nothing called “nothing”" });
    // A child of the root whose name another has too is addressed by its id as well.
    const twin = importDoc(lib, MD("Tides"), "tides-2.md");
    expect(address(lib.snap(), twin)).toBe(`/doc/tides/${encodeURIComponent(twin)}`);
    expect(resolve(lib.snap(), address(lib.snap(), twin))).toEqual({ node: twin });
    expect(address(lib.snap(), a)).toBe("/doc/tides");
  });
});
