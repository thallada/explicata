/**
 * One library on disk: one Loro database, a snapshot per branch, in the library's own directory.
 *
 *   <data>/libraries/<id>/<branch>.loro    the library on that branch
 *
 * Branch names are percent-encoded into file names, so no request can name a file outside it.
 * Writes are gathered for a moment before they go to disk: with the whole library in one file, a
 * save per keystroke would rewrite the whole library each time. Replicas keep what has not been
 * saved and send it again, so a crash loses nothing that a browser still holds.
 *
 * The libraries themselves, their index and what is derived from each, are in libraries.ts.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Doc, tops } from "../src/core/model";
import { writeAtomic } from "./util";

export const validBranch = (b: string) => b.length > 0 && b.length <= 100 && !/[\u0000-\u001f]/.test(b);

/** How long writes are gathered before the library goes to disk. */
const SAVE_DELAY = 250;

export class LibraryStore {
  readonly branches = new Map<string, Doc>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Set once the library has been moved aside: nothing more is written. */
  closed = false;

  constructor(readonly dir: string) {}

  /** Load every branch. A directory without main is not a library. */
  open(): this {
    for (const f of readdirSync(this.dir)) {
      if (f.endsWith(".loro")) this.branches.set(decodeURIComponent(f.slice(0, -5)), Doc.load(readFileSync(join(this.dir, f)), "server"));
    }
    if (!this.branches.has("main")) throw new Error(`${this.dir} has no main.loro`);
    return this;
  }

  /** A new library in a new directory, written at once. */
  static create(dir: string, doc: Doc): LibraryStore {
    if (existsSync(join(dir, "main.loro"))) throw new Error(`${dir} already holds a library`);
    const store = new LibraryStore(dir);
    mkdirSync(dir, { recursive: true });
    store.branches.set("main", doc);
    store.save("main");
    return store;
  }

  get main(): Doc {
    return this.branches.get("main")!;
  }

  get id(): string {
    return this.main.libraryId ?? "";
  }

  /** The library's name: its root's title. */
  get title(): string {
    const snap = this.main.snap();
    return snap.nodes[snap.root].title;
  }

  /** The titles of the root's children on main, in order. */
  titles(): string[] {
    const snap = this.main.snap();
    return tops(snap).map((id) => snap.nodes[id].title);
  }

  // ---- writing ----

  /** Write a branch to disk now. */
  save(name: string) {
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
    const doc = this.branches.get(name);
    if (!doc || this.closed) return;
    writeAtomic(join(this.dir, `${encodeURIComponent(name)}.loro`), doc.snapshotBytes());
  }

  /** Write a branch to disk shortly, with whatever else arrives meanwhile. */
  saveSoon(name: string) {
    if (this.timers.has(name) || this.closed) return;
    this.timers.set(name, setTimeout(() => this.save(name), SAVE_DELAY));
  }

  /** Write everything still waiting. */
  flush() {
    for (const name of [...this.timers.keys()]) this.save(name);
  }

  /** Write what is waiting, then write nothing more (the directory is about to be moved aside). */
  close() {
    this.flush();
    this.closed = true;
  }

  /** A branch pushed by a replica that the server has not seen yet. */
  addBranch(name: string, doc: Doc) {
    this.branches.set(name, doc);
    this.save(name);
  }
}
