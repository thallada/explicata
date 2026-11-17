/**
 * The library on disk: one Loro database, a snapshot per branch.
 *
 *   <data>/library/<branch>.loro    the library on that branch
 *   <data>/library/migrated.json    what was brought over from the per-document layout, if anything was
 *   <data>/library.json             starter files already imported (by file name), so a deleted one stays deleted
 *
 * Branch names are percent-encoded into file names, so no request can name a file outside it.
 * Writes are gathered for a moment before they go to disk: with the whole library in one file, a
 * save per keystroke would rewrite the whole library each time. Replicas keep what has not been
 * saved and send it again, so a crash loses nothing that a browser still holds.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FormatError } from "../src/core/format";
import { Doc, tops } from "../src/core/model";
import { writeText } from "../src/core/seed";
import { slugify } from "../src/core/text";
import { SEED_KEY, migrate } from "./migrate";
import { writeAtomic } from "./util";

export const validBranch = (b: string) => b.length > 0 && b.length <= 100 && !/[\u0000-\u001f]/.test(b);

/** How long writes are gathered before the library goes to disk. */
const SAVE_DELAY = 250;

export class LibraryStore {
  readonly branches = new Map<string, Doc>();
  readonly dir: string;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(readonly data: string, private log: (msg: string) => void = console.log) {
    this.dir = join(data, "library");
  }

  /** Migrate an older layout if there is one and no library yet, then load every branch. */
  open(): this {
    if (!existsSync(this.dir)) migrate(this.data, this.log);
    mkdirSync(this.dir, { recursive: true });
    for (const f of readdirSync(this.dir)) {
      if (f.endsWith(".loro")) this.branches.set(decodeURIComponent(f.slice(0, -5)), Doc.load(readFileSync(join(this.dir, f)), "server"));
    }
    if (!this.branches.has("main")) {
      this.branches.set("main", Doc.library("server"));
      this.save("main");
    }
    return this;
  }

  get main(): Doc {
    return this.branches.get("main")!;
  }

  get id(): string {
    return this.main.libraryId ?? "";
  }

  /** The titles of the root's children on main, in order. */
  titles(): string[] {
    const snap = this.main.snap();
    return tops(snap).map((id) => snap.nodes[id].title);
  }

  /** What the migration recorded, for browsers that still hold replicas of the old documents. */
  migrated(): unknown {
    try {
      return JSON.parse(readFileSync(join(this.dir, "migrated.json"), "utf8"));
    } catch {
      return null;
    }
  }

  // ---- writing ----

  /** Write a branch to disk now. */
  save(name: string) {
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
    const doc = this.branches.get(name);
    if (!doc) return;
    writeAtomic(join(this.dir, `${encodeURIComponent(name)}.loro`), doc.snapshotBytes());
  }

  /** Write a branch to disk shortly, with whatever else arrives meanwhile. */
  saveSoon(name: string) {
    if (this.timers.has(name)) return;
    this.timers.set(name, setTimeout(() => this.save(name), SAVE_DELAY));
  }

  /** Write everything still waiting. */
  flush() {
    for (const name of [...this.timers.keys()]) this.save(name);
  }

  /** A branch pushed by a replica that the server has not seen yet. */
  addBranch(name: string, doc: Doc) {
    this.branches.set(name, doc);
    this.save(name);
  }

  // ---- starter files ----

  private libraryFile() {
    return join(this.data, "library.json");
  }
  imported(): string[] {
    try {
      return JSON.parse(readFileSync(this.libraryFile(), "utf8")).imported ?? [];
    } catch {
      return [];
    }
  }
  markImported(id: string) {
    const ids = this.imported();
    if (!ids.includes(id)) writeFileSync(this.libraryFile(), JSON.stringify({ imported: [...ids, id] }, null, 2) + "\n");
  }

  /** The first tree, written once. Like a starter file, it is not written again after being deleted. */
  seedFirst(write: (doc: Doc) => void) {
    if (this.imported().includes(SEED_KEY)) return;
    write(this.main);
    this.save("main");
    this.markImported(SEED_KEY);
    this.log("seeded the first tree from src/seed");
  }

  /**
   * Import each starter file that has never been imported (by its file name), as a child of the
   * root at its end. A file that does not parse is logged and skipped (and tried again next start);
   * it never stops the server.
   */
  importLibrary(dir: string) {
    if (!existsSync(dir)) return;
    const done = new Set(this.imported());
    let changed = false;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
      const key = slugify(f.slice(0, -3));
      if (done.has(key)) continue;
      try {
        const text = readFileSync(join(dir, f), "utf8");
        const id = writeText(this.main, text, `library/${f}`);
        this.markImported(key);
        changed = true;
        this.log(`library: imported ${f} as “${this.main.snap().nodes[id].title}”`);
      } catch (err) {
        this.log(`library: skipped ${f}:\n  ${err instanceof FormatError ? err.problems.join("\n  ") : String(err)}`);
      }
    }
    if (changed) this.save("main");
  }
}
