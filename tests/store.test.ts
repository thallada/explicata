/** The library on disk: seeding, starter documents, documents as subtrees, and slugs that cannot escape. */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UndoManager } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { LibraryStore } from "../server/library";
import { FormatError, serializeDoc } from "../src/core/format";
import { address, createDoc, deleteDoc, duplicateDoc, importDoc, listDocs, renameDoc, resolve } from "../src/core/library";
import { Doc, OpError, SYSTEM_ORIGIN, descendants, findDoc, sections } from "../src/core/model";
import { SEED_SLUG, writeSeed } from "../src/core/seed";
import { seed } from "../src/seed/tree";

const prompt = readFileSync(new URL("../src/seed/prompt.txt", import.meta.url), "utf8");
const temp = () => mkdtempSync(join(tmpdir(), "ie-lib-"));
const quiet = () => {};
const MD = (title: string) => `# ${title}\n\nA root body with a phrase.\n\n## One\n\nSection text.\n\n^ "Section" gloss: a note\n`;

describe("the library on disk", () => {
  it("starts an empty data directory as one library with the first document, written once", () => {
    const data = temp();
    const store = new LibraryStore(data, quiet).open();
    store.seedFirst((doc) => writeSeed(doc, prompt, seed));
    expect(store.list().map((d) => d.slug)).toEqual([SEED_SLUG]);
    expect(store.main.snap().library).toBe(true);
    expect(JSON.parse(readFileSync(join(data, "library.json"), "utf8")).imported).toEqual([SEED_SLUG]);
    store.flush();
    // A second start loads the same library (same id) and writes nothing new.
    const again = new LibraryStore(data, quiet).open();
    again.seedFirst(() => {
      throw new Error("should not seed twice");
    });
    expect(again.id).toBe(store.id);
    expect(again.main.stateHash()).toBe(store.main.stateHash());
  });

  it("imports each starter file once, as a document; a deleted one stays deleted and a broken one is skipped", () => {
    const data = temp();
    const lib = temp();
    writeFileSync(join(lib, "good-one.md"), MD("Good one"));
    writeFileSync(join(lib, "Second File.md"), MD("Second"));
    writeFileSync(join(lib, "broken.md"), MD("Broken").replace('"Section"', '"Missing"'));
    const logs: string[] = [];
    const store = new LibraryStore(data, (m) => logs.push(m)).open();
    store.importLibrary(lib);
    expect(store.list().map((d) => d.slug)).toEqual(["second-file", "good-one"]); // file-name order: "S" sorts before "g"
    expect(logs.join("\n")).toMatch(/skipped broken\.md:\n {2}library\/broken\.md:9: in “One”: quote not found: "Missing"/);

    deleteDoc(store.main, findDoc(store.main.snap(), "good-one")!, "alice");
    store.save("main");
    const again = new LibraryStore(data, quiet).open();
    again.importLibrary(lib);
    expect(again.list().map((d) => d.slug)).toEqual(["second-file"]);
    // Once fixed, the broken file is picked up.
    writeFileSync(join(lib, "broken.md"), MD("Broken"));
    again.importLibrary(lib);
    expect(again.list().map((d) => d.slug)).toEqual(["second-file", "broken"]);
  });
});

describe("documents", () => {
  it("are created, renamed, duplicated and deleted as ordinary commits, with slugs that stay inside the data directory", () => {
    const lib = Doc.library("alice");
    const a = createDoc(lib, "My notes", "alice");
    const snap = () => lib.snap();
    expect(snap().nodes[a]).toMatchObject({ parent: snap().root, title: "My notes", slug: "my-notes", by: "human" });
    const slugOf = (title: string) => {
      const id = createDoc(lib, title, "alice");
      return snap().nodes[id].slug;
    };
    expect(slugOf("My notes")).toBe("my-notes-2");
    expect(slugOf("../../etc/passwd")).toBe("etc-passwd");
    expect(slugOf("Import")).toBe("import-2"); // a word of the URL scheme, not a document
    for (const bad of ["..", "../x", "a/b", "A", "", "x".repeat(70)]) {
      expect(() => lib.apply([{ op: "update", id: a, slug: bad }], "bad slug")).toThrow(OpError);
    }
    expect(() => lib.apply([{ op: "update", id: a, slug: "my-notes-2" }], "taken")).toThrow(/another document/);
    // Only a document has a slug.
    const [inner] = lib.apply([{ op: "create", parent: a, title: "Inside" }], "add").created;
    expect(snap().nodes[inner].slug).toBeUndefined();
    expect(() => lib.apply([{ op: "update", id: inner, slug: "inside" }], "x")).toThrow(/only a document/);

    renameDoc(lib, a, "Renamed", "alice");
    expect(snap().nodes[a]).toMatchObject({ title: "Renamed", slug: "my-notes" }); // the slug, and so links, stay
    const copy = duplicateDoc(lib, a, "Renamed (copy)", "alice");
    expect(snap().nodes[copy]).toMatchObject({ title: "Renamed (copy)", slug: "renamed-copy" });
    expect(snap().nodes[snap().root].children.indexOf(copy)).toBe(snap().nodes[snap().root].children.indexOf(a) + 1);
    expect(sections(snap(), copy).map((id) => snap().nodes[id].title)).toEqual(["Inside"]);
    expect(sections(snap(), copy)[0]).not.toBe(inner); // a copy, not the same nodes

    // Delete is an ordinary delete: undo brings the document back, content, slug and all.
    const undo = new UndoManager(lib.loro, { mergeInterval: 0, excludeOriginPrefixes: [SYSTEM_ORIGIN] });
    lib.group = { start: () => undo.groupStart(), end: () => undo.groupEnd() };
    deleteDoc(lib, copy, "alice");
    expect(findDoc(snap(), "renamed-copy")).toBeUndefined();
    expect(undo.undo()).toBe(true);
    lib.touch();
    const back = findDoc(snap(), "renamed-copy")!;
    expect(snap().nodes[back].title).toBe("Renamed (copy)");
    expect(sections(snap(), back).map((id) => snap().nodes[id].title)).toEqual(["Inside"]);
  });

  it("import and export one document in the text format; a file with a bad quote writes nothing", () => {
    const lib = Doc.library("alice");
    createDoc(lib, "Something else", "alice");
    const id = importDoc(lib, MD("Imported thing"), "thing.md", { slug: "thing" });
    const snap = lib.snap();
    expect([id, ...descendants(snap, id)].every((n) => snap.nodes[n].by === "llm")).toBe(true);
    expect(serializeDoc(snap, id).text).toBe(MD("Imported thing"));
    const before = lib.stateHash();
    expect(() => importDoc(lib, MD("Bad").replace('"Section"', '"Nowhere"'), "bad.md")).toThrow(FormatError);
    expect(lib.stateHash()).toBe(before);
    expect(listDocs(lib.snap()).map((d) => d.slug)).toEqual(["something-else", "thing"]);
  });

  it("have addresses: /doc/<slug> for a document, /doc/<slug>/<node> for a node in it, / for the library", () => {
    const lib = Doc.library("alice");
    const a = importDoc(lib, MD("Tides"), "tides.md", { slug: "tides" });
    const b = importDoc(lib, MD("Codes"), "codes.md", { slug: "codes" });
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
    expect(resolve(lib.snap(), "/doc/nothing")).toEqual({ missing: "no document “nothing”" });
  });
});
