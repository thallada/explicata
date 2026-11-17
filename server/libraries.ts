/**
 * The libraries on disk. Each is a tree of its own, with its own history, and nothing in one refers
 * to anything in another: a library is its own Loro database, with its own id, and what is derived
 * from it (link suggestions, the reviewer's verdicts, vectors) is kept in its own directory.
 *
 *   <data>/libraries/index.json                  the libraries, in order: id, title, when made, whether deleted
 *   <data>/libraries/<id>/<branch>.loro          the library (library.ts)
 *   <data>/libraries/<id>/links/pending.json     link suggestions and the decisions about them (derived)
 *   <data>/libraries/<id>/vectors/nodes.*        its sections as vectors (derived)
 *   <data>/libraries/.deleted/<id>-<time>/       a deleted library, moved aside whole
 *
 * What holds no library's content is shared: <data>/wiki-cache/ and <data>/models/.
 *
 * A library's id is its database's id (`meta.library`, base 36), also its directory's name and the
 * `/l/<id>` of its addresses. Its name is its root's title; the index keeps a copy so it can be read
 * without opening the database.
 *
 * An empty data directory starts with one library, the first, which gets the seed and the starter
 * trees; a library made later starts with its root alone. A data directory in the single-library
 * layout from before (`<data>/library/main.loro`) is not opened: `npm run migrate` brings it over
 * (migrateLibraries.ts).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { LIBRARY_ID } from "../src/core/address";
import { FormatError } from "../src/core/format";
import { Doc, libraryNodeCount, retitleOps } from "../src/core/model";
import { writeText } from "../src/core/seed";
import { LibraryStore } from "./library";
import { HttpError, writeAtomic } from "./util";

export const LIBRARIES = "libraries";
/** What the single-library layout kept at the top of the data directory, all of it moved aside by the migration. */
export const OLD_FILES = ["library", "library.json", "links", "vectors"];

export interface LibraryEntry {
  id: string;
  title: string;
  /** When it was made (ISO). */
  created: string;
  /** When it was deleted (ISO), and where it was moved to, relative to the libraries directory. */
  deleted?: string;
  movedTo?: string;
}

/** A library as the API lists it. */
export interface LibraryInfo {
  id: string;
  title: string;
  created: string;
  /** Nodes under its top-level nodes (the root and the Wikipedia container not counted). */
  nodes: number;
  branches: string[];
}

export type Layout =
  | { kind: "empty" }
  | { kind: "libraries" }
  /** The single-library layout: <data>/library/main.loro and what goes with it. */
  | { kind: "old"; found: string[] }
  /** A migration that wrote the libraries but did not move the old files aside. */
  | { kind: "unfinished"; found: string[] }
  /** Older still: one database per document (<data>/docs/) or a single document (<data>/*.loro). */
  | { kind: "older"; found: string[] };

/** What a data directory holds. */
export function layout(data: string): Layout {
  const have = (f: string) => existsSync(join(data, f));
  const old = OLD_FILES.filter(have);
  if (have(join(LIBRARIES, "index.json"))) return old.length ? { kind: "unfinished", found: old } : { kind: "libraries" };
  if (have(join("library", "main.loro"))) return { kind: "old", found: old };
  const older = [...(have("docs") ? ["docs"] : []), ...(existsSync(data) ? readdirSync(data).filter((f) => f.endsWith(".loro")) : [])];
  if (older.length) return { kind: "older", found: older };
  if (old.length) return { kind: "old", found: old };
  return { kind: "empty" };
}

/** The data directory is not in the libraries layout: the server will not open it. */
export class NeedsMigration extends Error {}

/** One line saying what to do about a data directory the server cannot open. */
export function migrationNeeded(data: string, l: Layout): string | null {
  switch (l.kind) {
    case "empty":
    case "libraries":
      return null;
    case "old":
      return `${data} holds a library in the old single-library layout (${l.found.join(", ")}): stop any server using it and run \`npm run migrate\` (\`npm run migrate -- --check\` first for a dry run that writes nothing).`;
    case "unfinished":
      return `${data} holds both libraries/ and old files (${l.found.join(", ")}) from a migration that did not finish: run \`npm run migrate\` to move the old files aside.`;
    case "older":
      return `${data} holds data from before the single library (${l.found.join(", ")}): open it once with a version from before libraries (commit c4d6856) to bring it into one library, then run \`npm run migrate\`.`;
  }
}

/** A time stamp for directory names: 20261117-013500. */
export const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");

export function readIndex(dir: string): LibraryEntry[] {
  const raw = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { libraries?: LibraryEntry[] };
  if (!Array.isArray(raw.libraries)) throw new Error(`${join(dir, "index.json")} lists no libraries`);
  return raw.libraries.filter((e) => e && typeof e.id === "string" && LIBRARY_ID.test(e.id));
}

export const indexText = (entries: LibraryEntry[]) => JSON.stringify({ version: 1, libraries: entries }, null, 2) + "\n";

/**
 * Write each starter file (the text format) as a top of the library, in file name order. A file that
 * does not parse is logged and skipped; it never stops the server.
 */
export function importStarters(doc: Doc, dir: string, log: (msg: string) => void = console.log) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    try {
      const id = writeText(doc, readFileSync(join(dir, f), "utf8"), `library/${f}`);
      log(`library: imported ${f} as “${doc.snap().nodes[id].title}”`);
    } catch (err) {
      log(`library: skipped ${f}:\n  ${err instanceof FormatError ? err.problems.join("\n  ") : String(err)}`);
    }
  }
}

export class Libraries {
  readonly dir: string;
  entries: LibraryEntry[] = [];
  readonly stores = new Map<string, LibraryStore>();

  constructor(
    readonly data: string,
    private log: (msg: string) => void = console.log,
  ) {
    this.dir = join(data, LIBRARIES);
  }

  /**
   * Open every library. On an empty data directory, make the first library and hand it to `seed`
   * (the seed and the starter trees). Throws NeedsMigration on any other layout.
   */
  open(seed: (doc: Doc) => void): this {
    const l = layout(this.data);
    const why = migrationNeeded(this.data, l);
    if (why) throw new NeedsMigration(why);
    if (l.kind === "empty") {
      mkdirSync(this.dir, { recursive: true });
      const doc = Doc.library("server");
      seed(doc);
      this.add(doc);
      return this;
    }
    this.entries = readIndex(this.dir);
    for (const e of this.entries) {
      if (e.deleted) continue;
      const dir = join(this.dir, e.id);
      if (!existsSync(join(dir, "main.loro"))) {
        this.log(`libraries: “${e.title}” (${e.id}) is listed but ${dir} holds no main.loro; left out`);
        continue;
      }
      const store = new LibraryStore(dir).open();
      if (store.id !== e.id) this.log(`libraries: ${dir} holds library ${store.id}, not ${e.id}; opened as ${e.id}`);
      this.stores.set(e.id, store);
    }
    // Every library deleted by hand: start again with an empty one rather than with none.
    if (!this.stores.size) this.add(Doc.library("server"));
    return this;
  }

  /** A library's store, if it exists and is not deleted. */
  get(id: string): LibraryStore | undefined {
    return this.stores.get(id);
  }

  /** The first library in the index that is open. */
  first(): LibraryStore {
    for (const e of this.entries) {
      const s = this.stores.get(e.id);
      if (s) return s;
    }
    throw new Error("no library is open");
  }

  /** The open libraries, in order, with their names read from their roots. */
  list(): LibraryInfo[] {
    const out: LibraryInfo[] = [];
    let renamed = false;
    for (const e of this.entries) {
      const s = this.stores.get(e.id);
      if (!s) continue;
      const title = s.title;
      if (title !== e.title) {
        e.title = title;
        renamed = true;
      }
      out.push({ id: e.id, title, created: e.created, nodes: libraryNodeCount(s.main.snap()), branches: [...s.branches.keys()] });
    }
    if (renamed) this.saveIndex();
    return out;
  }

  /** A new library, with its root alone, at the end of the list. */
  create(title: string): LibraryStore {
    const name = cleanTitle(title);
    return this.add(Doc.library("server", undefined, name));
  }

  private add(doc: Doc): LibraryStore {
    const id = doc.libraryId!;
    if (this.entries.some((e) => e.id === id) || existsSync(join(this.dir, id))) throw new Error(`a library ${id} exists already`);
    const store = LibraryStore.create(join(this.dir, id), doc);
    this.stores.set(id, store);
    this.entries.push({ id, title: store.title, created: new Date().toISOString() });
    this.saveIndex();
    return store;
  }

  /** Rename a library: an ordinary commit on its root's title (on main), so it syncs and versions like any rename. */
  rename(id: string, title: string): LibraryStore {
    const store = this.need(id);
    const name = cleanTitle(title);
    const doc = store.main;
    const snap = doc.snap();
    if (snap.nodes[snap.root].title !== name) {
      doc.as("server", () => doc.apply(retitleOps(snap, snap.root, name), `Rename the library to “${name}”`, { actor: "human" }));
      store.save("main");
    }
    const e = this.entries.find((x) => x.id === id)!;
    e.title = name;
    this.saveIndex();
    return store;
  }

  /**
   * Delete a library: its directory is moved, whole and unchanged, to libraries/.deleted/<id>-<time>,
   * and the index keeps its entry, marked deleted. The last library cannot be deleted.
   */
  remove(id: string): string {
    const store = this.need(id);
    if (this.stores.size <= 1) throw new HttpError(409, "the last library cannot be deleted");
    store.close();
    const rel = join(".deleted", `${id}-${stamp()}`);
    mkdirSync(join(this.dir, ".deleted"), { recursive: true });
    renameSync(store.dir, join(this.dir, rel));
    this.stores.delete(id);
    const e = this.entries.find((x) => x.id === id)!;
    e.deleted = new Date().toISOString();
    e.movedTo = rel;
    this.saveIndex();
    return join(this.dir, rel);
  }

  private need(id: string): LibraryStore {
    const store = this.stores.get(id);
    if (!store) throw new HttpError(404, `no library ${id}`);
    return store;
  }

  saveIndex() {
    writeAtomic(join(this.dir, "index.json"), indexText(this.entries));
  }

  /** Write every library's waiting changes. */
  flush() {
    for (const s of this.stores.values()) s.flush();
  }
}

function cleanTitle(title: unknown): string {
  if (typeof title !== "string") throw new HttpError(400, "give the library a title");
  const t = title.replace(/\s+/g, " ").trim();
  if (!t) throw new HttpError(400, "give the library a title");
  if (t.length > 200) throw new HttpError(400, "a library's title is at most 200 characters");
  return t;
}

/** Whether a path is a directory (for the migration's checks). */
export const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
