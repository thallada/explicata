/**
 * The library in the browser: its branches as local replicas (kept in IndexedDB), the sync loop
 * with the server, and the subscription to the server's change notices.
 */
import { VersionVector } from "loro-crdt";
import { Doc } from "../core/model";
import { Repo, decodeVV, encodeVV, mergeUpdate, vvIncludes, type MergeReport } from "../core/repo";
import { libApi } from "./api";
import { idbGet, idbSet } from "./idb";

type VV = Map<`${number}`, number>;

export interface SessionHooks {
  /** A replica changed, locally or by sync. */
  changed(doc: Doc): void;
  /** A sync round ended; `ok` says whether the server answered. */
  synced(name: string, ok: boolean, report: MergeReport | null): void;
  /** The server's notice stream opened or failed. */
  connection(up: boolean): void;
  /** The server holds a different library than this page (its data directory was replaced). */
  foreign(): void;
  /** The server has no such library any more: it was deleted, perhaps while this page could not hear of it. */
  gone(): void;
  /** Any other notice from the server (a link job's progress). */
  message?(msg: Record<string, unknown>): void;
}

export async function failure(res: Response): Promise<Error & { body?: Record<string, unknown> }> {
  let message = `${res.status} ${res.statusText}`;
  let body: Record<string, unknown> | undefined;
  try {
    body = await res.json();
    message = String(body?.error ?? message);
  } catch {
    /* not JSON */
  }
  return Object.assign(new Error(message), { body });
}

export class Session {
  repo!: Repo;
  /** Set once the server turns out to hold another library: nothing more is sent to it. */
  foreign = false;
  private serverVV = new Map<string, VV>();
  private syncing = new Set<string>();
  private events: EventSource | null = null;
  /** Branches the server listed that are not stored here yet. */
  private missing: string[] = [];

  constructor(
    /** Stored replicas are keyed by the library's id: a replica of another library is never loaded into this one. */
    readonly library: string,
    private user: string,
    private clientId: string,
    private hooks: SessionHooks,
  ) {}

  private key(k: string) {
    return `lib:${this.library}:${k}`;
  }

  /**
   * Open the replicas stored locally; only if main is not among them, wait for the server.
   * Branches the server has and this browser does not arrive by sync afterwards.
   */
  async load(serverBranches: string[], online: boolean) {
    const names = new Set<string>([...((await idbGet<string[]>(this.key("branches"))) ?? []), ...serverBranches]);
    const docs = new Map<string, Doc>();
    for (const name of names) {
      const local = await idbGet<Uint8Array>(this.key(`branch:${name}`));
      if (local) docs.set(name, Doc.load(local, this.user));
    }
    const fetched = new Set<string>();
    if (!docs.has("main") && online) {
      const doc = await this.fetchBranch("main");
      if (doc) {
        docs.set("main", doc);
        fetched.add("main");
      }
    }
    if (!docs.has("main")) throw new Error("Could not open the library: the server is not reachable and nothing is stored in this browser.");
    this.repo = new Repo(docs.get("main")!);
    for (const [name, doc] of docs) {
      this.repo.branches.set(name, doc);
      this.watch(name, doc, fetched.has(name));
    }
    this.missing = [...names].filter((n) => !docs.has(n));
  }

  private async fetchBranch(name: string): Promise<Doc | null> {
    const res = await fetch(libApi(`/branch/${encodeURIComponent(name)}`));
    if (!res.ok) {
      if (res.status === 404 && (await failure(res)).message.startsWith("no library")) this.vanished();
      return null;
    }
    if (res.headers.get("x-library") !== this.library) {
      this.lost();
      return null;
    }
    const doc = Doc.load(new Uint8Array(await res.arrayBuffer()), this.user);
    this.serverVV.set(name, decodeVV(res.headers.get("x-vv")!));
    return doc;
  }

  /** Persist and sync a replica a moment after each change. `store`: it came from the server, so keep a copy now. */
  watch(name: string, doc: Doc, store = false) {
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let syncTimer: ReturnType<typeof setTimeout> | undefined;
    doc.onChange(() => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        void idbSet(this.key(`branch:${name}`), doc.snapshotBytes());
        void idbSet(this.key("branches"), [...this.repo.branches.keys()]);
      }, 60);
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => void this.sync(name), 60);
      this.hooks.changed(doc);
    });
    if (store) void idbSet(this.key(`branch:${name}`), doc.snapshotBytes());
    void idbSet(this.key("branches"), [...this.repo.branches.keys()]);
  }

  /** True when the server has everything these replicas have. */
  synced(): boolean {
    if (this.foreign) return true;
    for (const [name, doc] of this.repo?.branches ?? []) {
      const known = this.serverVV.get(name);
      if (!known || !vvIncludes(known, doc.loro.version().toJSON())) return false;
    }
    return true;
  }

  /** On the way out, hand the server anything it has not seen. A beacon outlives the page, but cannot carry headers, so the library goes in the query. */
  flush() {
    if (this.foreign) return;
    for (const [name, doc] of this.repo?.branches ?? []) {
      const known = this.serverVV.get(name);
      if (known && vvIncludes(known, doc.loro.version().toJSON())) continue;
      const bytes = known ? doc.loro.export({ mode: "update", from: new VersionVector(known) }) : doc.snapshotBytes();
      navigator.sendBeacon(libApi(`/sync/${encodeURIComponent(name)}?library=${encodeURIComponent(this.library)}`), new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
    }
  }

  /** A round for every branch, and fetch the ones only the server has. */
  async syncAll() {
    const names = [...this.repo.branches.keys(), ...this.missing.splice(0)];
    await Promise.all(names.map((n) => this.sync(n)));
  }

  /** One round with the server: push what it lacks, pull what we lack, then look for semantic conflicts. */
  async sync(name: string) {
    if (this.foreign || this.syncing.has(name)) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    const doc = this.repo.branches.get(name);
    if (!doc) {
      this.syncing.add(name);
      let ok = true;
      try {
        const fetched = await this.fetchBranch(name);
        if (fetched && !this.repo.branches.has(name)) {
          this.repo.branches.set(name, fetched);
          this.watch(name, fetched, true);
        }
      } catch {
        ok = false; // offline: try again on the next notice
      } finally {
        this.syncing.delete(name);
      }
      return this.hooks.synced(name, ok, null);
    }
    const known = this.serverVV.get(name);
    const mine = doc.loro.version().toJSON();
    this.syncing.add(name);
    let report: MergeReport | null = null;
    let ok = false;
    try {
      const bytes = !known ? doc.snapshotBytes() : vvIncludes(known, mine) ? new Uint8Array() : doc.loro.export({ mode: "update", from: new VersionVector(known) });
      const res = await fetch(libApi(`/sync/${encodeURIComponent(name)}`), {
        method: "POST",
        headers: { "x-vv": encodeVV(mine), "x-client": this.clientId, "x-library": this.library, "content-type": "application/octet-stream" },
        body: bytes as BodyInit,
      });
      if (!res.ok) {
        if (res.status === 409) this.lost();
        const err = await failure(res);
        if (res.status === 404 && err.message.startsWith("no library")) this.vanished();
        throw err;
      }
      const theirs = decodeVV(res.headers.get("x-vv")!);
      report = mergeUpdate(doc, new Uint8Array(await res.arrayBuffer()), theirs);
      this.serverVV.set(name, theirs);
      ok = true;
    } catch {
      report = null;
    } finally {
      this.syncing.delete(name);
      this.hooks.synced(name, ok, report);
    }
    // Anything committed during the round (including a detected conflict) goes out in the next one.
    const server = this.serverVV.get(name);
    if (ok && server && !vvIncludes(server, this.repo.branches.get(name)!.loro.version().toJSON())) void this.sync(name);
  }

  private lost() {
    if (this.foreign) return;
    this.foreign = true;
    this.disconnect();
    this.hooks.foreign();
  }

  /** The library is gone from the server: stop sending, and say so once. */
  vanished() {
    if (this.foreign) return;
    this.foreign = true;
    this.disconnect();
    this.hooks.gone();
  }

  /** Listen for other writers. */
  connect() {
    if (this.events || this.foreign) return;
    const events = new EventSource(libApi("/events"));
    events.onmessage = (e) => {
      const msg = JSON.parse(e.data) as { branch?: string; from?: string };
      if (msg.branch && msg.from !== this.clientId) void this.sync(msg.branch);
      else if (!msg.branch) this.hooks.message?.(msg);
    };
    events.onopen = () => {
      this.hooks.connection(true);
      // Back after an outage (or just connected): exchange whatever either side missed.
      void this.syncAll();
    };
    events.onerror = () => {
      this.hooks.connection(false);
      // A refused connection is tried again by the browser; an answer that is not a stream (a 404
      // for a library deleted while this page was away) ends it for good. Ask why, and go on
      // listening unless the library is gone.
      if (events.readyState === EventSource.CLOSED && this.events === events) {
        this.events = null;
        void this.probe();
      }
    };
    this.events = events;
  }

  /** After the notice stream ended: whether the library is still there (then listen again), gone, or the server unreachable (ask again later). */
  private async probe(wait = 1000) {
    if (this.foreign) return;
    let status = 0;
    let message = "";
    try {
      const res = await fetch(libApi("/state"));
      status = res.status;
      if (!res.ok) message = (await failure(res)).message;
    } catch {
      /* unreachable */
    }
    if (this.foreign) return;
    if (status === 404 && message.startsWith("no library")) return this.vanished();
    if (status >= 200 && status < 300) return this.connect();
    setTimeout(() => void this.probe(Math.min(wait * 2, 30_000)), wait);
  }

  disconnect() {
    this.events?.close();
    this.events = null;
  }
}
