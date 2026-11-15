/**
 * The document model: a tree of nodes in a Loro CRDT, one op API for every writer, and
 * staleness that is computed from content hashes rather than stored.
 *
 * A node is a title and a body. Its kind says how it hangs off its parent:
 *   section — a structural child, listed in the parent's outline
 *   note    — an expansion anchored to one or more spans of the parent's body
 * Anchors are pairs of CRDT cursors, so they keep pointing at the same words while the
 * text around them is edited.
 *
 * The whole library is one such tree. Its root is the library itself (flagged `library` in its
 * data); the root's sections are the documents, each with a slug for its address. Everything
 * else (notes, anchors, ops, staleness, history, merge) is the same wherever a node sits, except
 * that the root and the documents are not reconciled with each other: a document is not a
 * summary of the library, nor the library of its documents.
 */
import { Cursor, LoroDoc, LoroText, type LoroEventBatch, type LoroMap, type LoroTreeNode, type TreeID } from "loro-crdt";
import { RefError, canonRef, validateRef, type Ref } from "./ref";
import { digest, sha256, slugify, words, type Form, type Range } from "./text";

export type { Ref } from "./ref";

export type NodeId = TreeID;
export type Kind = "section" | "note";
export type Actor = "human" | "llm";

export interface Anchor {
  start: number;
  end: number;
  /** The anchored text when the anchor was made. */
  quote: string;
  /** The anchored text now. */
  text: string;
}

export interface NodeSnap {
  id: NodeId;
  parent: NodeId | null;
  kind: Kind;
  title: string;
  body: string;
  by: Actor;
  /** Pinned nodes are flagged when stale but never rewritten by a model. Human edits pin. */
  pinned: boolean;
  form?: Form;
  lens?: string;
  /** A document's address (only meaningful on the library root's sections). */
  slug?: string;
  /** What the node is about, elsewhere (see ref.ts). A note with a target and no body is a link. */
  ref?: Ref;
  /**
   * Phrases in this node's text that a writer declined to link (normalised, see links/extract).
   * Kept in the library, so a rejection syncs between replicas and survives edits elsewhere in
   * the node; each phrase is a key of its own in the node's map ("nolink:<phrase>"), so two
   * replicas declining at once both keep theirs.
   */
  nolink?: string[];
  anchors: Anchor[];
  seenUp: string;
  seenDown: string;
  children: NodeId[];
  depth: number;
}

/**
 * A snapshot is immutable. Successive snapshots of one Doc share the NodeSnap objects of nodes
 * that did not change, and a changed node's ancestors are copied, so anything computed from a
 * NodeSnap and its subtree can be remembered against that object.
 */
export interface Snap {
  root: NodeId;
  nodes: Record<NodeId, NodeSnap>;
  /** The root is a library, and its sections are documents. */
  library: boolean;
}

export type Op =
  | {
      op: "create";
      parent: NodeId;
      index?: number;
      kind?: Kind;
      title?: string;
      body?: string;
      /** Spans of the parent's body, as offsets. */
      anchors?: Range[];
      /** Alternative to anchors: anchor to the first occurrence of this text in the parent's body. */
      quote?: string;
      form?: Form;
      lens?: string;
      /** For a new document (a section of the library root): its address. Made from the title if left out. */
      slug?: string;
      /** What the node is about, elsewhere. A note with a target and no body is a link. */
      ref?: Ref;
    }
  /** `ref: null` removes the target. Changing a target is not a change of content: it leaves authorship and staleness alone. */
  /** `nolink` adds phrases the writer declined to link; like a target, it is not a change of content. */
  | { op: "update"; id: NodeId; title?: string; body?: string; pinned?: boolean; form?: Form; lens?: string; anchors?: Range[]; slug?: string; ref?: Ref | null; nolink?: string[] }
  /** Swap in new content and drop everything beneath the node. */
  | { op: "replace"; id: NodeId; title: string; body: string }
  | { op: "delete"; id: NodeId }
  | { op: "move"; id: NodeId; parent: NodeId; index?: number }
  /** Copy a node and everything beneath it, as it stands, to a new place; optionally under a new title. */
  | { op: "copy"; id: NodeId; parent: NodeId; index?: number; title?: string }
  /** Declare the node consistent with its children (up), its parent (down), or both. */
  | { op: "bless"; id: NodeId; dir?: "up" | "down" | "both" };

export interface CommitMeta {
  /** Identifies the commit. One commit can be stored as several Loro changes; they share this. */
  n: string;
  /** Message. */
  m: string;
  /** Author name. */
  by: string;
  /** human | llm */
  a: Actor;
  /** SHA-256 of the canonical tree state after this commit. Carried by the commit's last change. */
  h?: string;
  /** Optional tag: merge, revert, regen, resolve… */
  t?: string;
}

export class OpError extends Error {}

export type PatchListener = (was: Map<NodeId, NodeSnap | undefined> | null, nodes: Record<NodeId, NodeSnap>) => void;

/** A document's slug: also a path segment, so nothing that could leave its directory. */
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** Slugs that are words in the URL scheme rather than documents. */
const RESERVED = new Set(["import"]);
export const LIBRARY_TITLE = "Library";

/**
 * Commits the system makes on its own account (reconciling after an edit, recording or settling a
 * conflict, marking a merge) are labelled so that a person's undo steps over them: `u` after a
 * delete should bring the node back, not undo the bookkeeping that followed the delete.
 */
export const SYSTEM_ORIGIN = "sys";
const originOf = (m: CommitMeta) =>
  m.t === "merge" || m.t === "conflict" || (m.a === "llm" && (m.t === "regen" || m.t === "resolve")) ? SYSTEM_ORIGIN : "user";

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let peerSource: (() => bigint) | null = null;
/** Replace the source of peer ids. Fixtures use this to get the same node ids on every run. */
export function setPeerSource(fn: (() => bigint) | null) {
  peerSource = fn;
}

export function randomPeer(): bigint {
  if (peerSource) return peerSource();
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return (BigInt(a[0] & 0x1fffff) << 32n) | BigInt(a[1]);
}

interface StoredAnchor {
  s: string;
  e: string;
  q: string;
}

/** Write the fields every root has. */
export function initRoot(n: LoroTreeNode, title: string, body: string, actor: Actor) {
  n.data.set("kind", "section");
  n.data.set("title", title);
  (n.data.setContainer("body", new LoroText()) as LoroText).insert(0, body);
  n.data.set("by", actor);
  n.data.set("pinned", actor === "human");
  n.data.set("up", "");
  n.data.set("down", "");
}

export class Doc {
  readonly loro: LoroDoc;
  author: string;
  private cache: Snap | null = null;
  /** Nodes written since `cache` was read. Only they (and what hangs off them) are read again. */
  private dirty = new Set<NodeId>();
  /** Something changed that a partial read cannot follow (a new root, a checkout): read it all. */
  private stale = true;
  /**
   * Nodes by the text their anchors' cursors live in. That is the parent's body, except for a
   * note that has been moved to another parent: its cursors still point into the old one's text,
   * and an edit there moves them.
   */
  private anchoredIn = new Map<string, Set<NodeId>>();
  private conflictCache: Conflict[] | null = null;
  /** The commit being assembled, if any. */
  private txn: CommitMeta | null = null;
  /** Called around each commit, so an undo manager can treat its parts as one step. */
  group: { start(): void; end(): void } | null = null;
  private listeners = new Set<() => void>();
  private patchListeners = new Set<PatchListener>();

  constructor(loro: LoroDoc, author = "anon") {
    this.loro = loro;
    this.author = author;
    loro.setRecordTimestamp(true);
    loro.setChangeMergeInterval(-1);
    loro.subscribe((e) => {
      this.noteEvents(e);
      this.touch();
    });
  }

  /** A single tree, not a library: what documents were before there was one (and what tests build). */
  static create(author: string, title: string, body: string, actor: Actor = "human"): Doc {
    const loro = new LoroDoc();
    loro.setPeerId(randomPeer());
    const doc = new Doc(loro, author);
    doc.begin("Create document", actor);
    initRoot(loro.getTree("tree").createNode(), title, body, actor);
    doc.commit("Create document", actor);
    return doc;
  }

  /** An empty library. Its id is kept in the database, so a replica of another library is never mistaken for it. */
  static library(author: string, id = randomPeer().toString(36)): Doc {
    const loro = new LoroDoc();
    loro.setPeerId(randomPeer());
    const doc = new Doc(loro, author);
    doc.begin("Create the library", "human");
    const root = loro.getTree("tree").createNode();
    initRoot(root, LIBRARY_TITLE, "", "human");
    root.data.set("library", true);
    loro.getMap("meta").set("library", id);
    doc.commit("Create the library", "human");
    return doc;
  }

  static load(bytes: Uint8Array, author: string): Doc {
    const loro = new LoroDoc();
    loro.setPeerId(randomPeer());
    loro.import(bytes);
    return new Doc(loro, author);
  }

  /** An independent replica with its own peer id (a branch, or an agent's workspace). */
  fork(author = this.author): Doc {
    const loro = this.loro.fork();
    loro.setPeerId(randomPeer());
    return new Doc(loro, author);
  }

  /** Run some writes under another author's name. */
  as<T>(author: string, fn: () => T): T {
    const was = this.author;
    this.author = author;
    try {
      return fn();
    } finally {
      this.author = was;
    }
  }

  /** The library's id, if this is a library. */
  get libraryId(): string | undefined {
    return this.loro.getMap("meta").get("library") as string | undefined;
  }

  snapshotBytes(): Uint8Array {
    return this.loro.export({ mode: "snapshot" });
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Follow the snapshot as it is patched: called with the entries a patch replaced (as they were;
   * undefined for a new node) and the new record, or with null when the snapshot was read whole.
   * What is derived from many nodes (the backlinks index) is kept current this way at the cost of
   * what changed.
   */
  onPatch(fn: PatchListener): () => void {
    this.patchListeners.add(fn);
    return () => this.patchListeners.delete(fn);
  }

  /** Tell listeners the document changed. What changed is already known from Loro's events. */
  touch() {
    this.conflictCache = null;
    for (const fn of this.listeners) fn();
  }

  /** A node was written directly (not through apply): read it again before the next snapshot. */
  mark(id: NodeId) {
    this.dirty.add(id);
  }

  /** Forget the snapshot entirely, after a write too broad to follow node by node. */
  reread() {
    this.stale = true;
  }

  private noteEvents(e: LoroEventBatch) {
    if (e.by === "checkout") this.stale = true;
    for (const ev of e.events) {
      if (ev.path[0] !== "tree") continue;
      if (ev.diff.type === "tree") {
        for (const it of ev.diff.diff) {
          this.dirty.add(it.target);
          const to = it.action === "delete" ? undefined : it.parent;
          const from = it.action === "create" ? undefined : it.oldParent;
          if (to) this.dirty.add(to);
          if (from) this.dirty.add(from);
          // A node becoming a root, or ceasing to be one, changes what the snapshot is rooted at.
          if ((it.action !== "delete" && !to) || (it.action !== "create" && !from)) this.stale = true;
        }
      } else if (typeof ev.path[1] === "string") {
        this.dirty.add(ev.path[1] as NodeId);
        if (ev.diff.type === "text") this.markAnchoredIn(ev.target);
      }
    }
  }

  /** A text was written directly: read again the nodes anchored in it. */
  markAnchoredIn(text: string) {
    for (const id of this.anchoredIn.get(text) ?? []) this.dirty.add(id);
  }

  // ---- reading ----

  get tree() {
    return this.loro.getTree("tree");
  }

  snap(): Snap {
    if (this.cache && !this.stale && !this.dirty.size) return this.cache;
    // Resolving a cursor whose character has been deleted makes Loro commit whatever is pending.
    // Naming the commit first means that early part is still recognisably part of it.
    this.arm();
    let snap = this.cache && !this.stale ? this.patch(this.cache) : null;
    if (!snap) {
      this.stale = false;
      this.dirty.clear();
      snap = this.read();
    }
    this.arm();
    return (this.cache = snap);
  }

  private arm() {
    if (this.txn) this.loro.setNextCommitOptions({ message: JSON.stringify(this.txn), origin: originOf(this.txn) });
  }

  /** One node's own fields. Its children are filled in by the caller. */
  private readNode(n: LoroTreeNode, parent: NodeId | null, parentBody: string, depth: number): NodeSnap {
    const d = (n.data as LoroMap).toJSON() as Record<string, unknown>;
    const snap: NodeSnap = {
      id: n.id,
      parent,
      kind: (d.kind as Kind) ?? "section",
      title: (d.title as string) ?? "",
      body: (d.body as string) ?? "",
      by: (d.by as Actor) ?? "llm",
      pinned: !!d.pinned,
      anchors: parent ? this.resolveAnchors(d.anchors as StoredAnchor[] | undefined, parentBody, n.id) : [],
      seenUp: (d.up as string) ?? "",
      seenDown: (d.down as string) ?? "",
      children: [],
      depth,
    };
    if (d.form) snap.form = d.form as Form;
    if (d.lens) snap.lens = d.lens as string;
    if (d.slug) snap.slug = d.slug as string;
    if (d.ref && typeof d.ref === "object") snap.ref = d.ref as Ref;
    const declined = Object.keys(d).filter((k) => k.startsWith(NOLINK)).map((k) => k.slice(NOLINK.length)).sort();
    if (declined.length) snap.nolink = declined;
    return snap;
  }

  /** Read a subtree whole, handing each node to `put`. */
  private readTree(n: LoroTreeNode, parent: NodeSnap | null, depth: number, put: (n: NodeSnap) => void) {
    const snap = this.readNode(n, parent?.id ?? null, parent?.body ?? "", depth);
    put(snap);
    for (const c of n.children() ?? []) {
      snap.children.push(c.id);
      this.readTree(c, snap, depth + 1, put);
    }
  }

  private read(): Snap {
    const roots = this.tree.roots();
    if (!roots.length) throw new Error("document has no root");
    const nodes: Record<NodeId, NodeSnap> = {};
    this.readTree(roots[0], null, 0, (n) => (nodes[n.id] = n));
    this.older = null;
    for (const fn of this.patchListeners) fn(null, nodes);
    return { root: roots[0].id, nodes, library: !!roots[0].data.get("library") };
  }

  /**
   * The previous snapshot's view, whose prototype is the record the newest snapshot owns.
   * See `patch`.
   */
  private older: Record<NodeId, NodeSnap> | null = null;

  /**
   * The previous snapshot with the dirty nodes read again. A node is read with its children's
   * ids; children that are new are read whole, children that moved in are read again, and
   * children anchored to its body have their anchors resolved again. Every node
   * whose entry was replaced has its ancestors copied, so a NodeSnap never changes.
   *
   * Copying a record of every node on each change would cost the size of the library, so the
   * newest snapshot owns the record and the patch writes into it. The snapshot it replaces is
   * handed a small view instead: the entries that changed, as they were, over the record (and
   * the view before that is re-pointed at this one, so each older snapshot still reads what it
   * read). An old snapshot answers lookups exactly; enumerating one (Object.keys and the like)
   * sees only its own changed entries, so anything that enumerates a snapshot it took before a
   * write must copy it first, as `mergeUpdate` does.
   */
  private patch(prev: Snap): Snap | null {
    const dirty = this.dirty;
    this.dirty = new Set();
    const roots = this.tree.roots();
    if (roots.length !== 1 || roots[0].id !== prev.root) return null;
    const nodes = prev.nodes;
    const was = new Map<NodeId, NodeSnap | undefined>();
    const replaced = new Set<NodeId>();
    const put = (n: NodeSnap) => {
      if (!was.has(n.id)) was.set(n.id, nodes[n.id]);
      nodes[n.id] = n;
      replaced.add(n.id);
    };
    const gone = (id: NodeId) => !this.tree.getNodeByID(id) || this.tree.isNodeDeleted(id);
    // A deleted node's children went with it, unless they had moved away first (then they are read where they are now).
    const drop = (id: NodeId) => {
      const n = nodes[id];
      if (!n) return;
      if (!was.has(id)) was.set(id, n);
      delete nodes[id];
      replaced.delete(id);
      for (const c of n.children) if (gone(c)) drop(c);
    };
    const depthOf = (n: LoroTreeNode) => {
      let d = 0;
      for (let p = n.parent(); p; p = p.parent()) d++;
      return d;
    };
    const done = new Set<NodeId>();
    const later: NodeId[] = [];

    const reread = (n: LoroTreeNode, depth: number) => {
      if (done.has(n.id)) return;
      done.add(n.id);
      const p = n.parent();
      const before = nodes[n.id];
      const parentBody = p ? (nodes[p.id] && done.has(p.id) ? nodes[p.id].body : ((p.data.get("body") as LoroText | undefined)?.toString() ?? "")) : "";
      const snap = this.readNode(n, p?.id ?? null, parentBody, depth);
      const kids = n.children() ?? [];
      snap.children = kids.map((c) => c.id);
      // Nodes are often marked more than once for one write (by the op, then by Loro's event);
      // an entry that reads back the same is kept, so nothing computed from it is thrown away.
      if (!before || !sameNode(before, snap)) put(snap);
      for (const c of kids) {
        const cur = nodes[c.id];
        if (!cur) this.readTree(c, snap, depth + 1, put);
        else if (cur.parent !== snap.id || cur.depth !== depth + 1) reread(c, depth + 1);
        // Anchors are resolved against the text's history, not its string: a merge can move them
        // while the body reads the same, so they are resolved again whenever the parent is read.
        else if (!done.has(c.id)) {
          const anchors = this.resolveAnchors(c.data.get("anchors") as StoredAnchor[] | undefined, snap.body, c.id);
          if (JSON.stringify(anchors) !== JSON.stringify(cur.anchors)) put({ ...cur, anchors });
        }
      }
      // A child that left was deleted (drop it) or moved (make sure its new place is read).
      for (const c of before?.children ?? []) {
        if (snap.children.includes(c)) continue;
        if (gone(c)) drop(c);
        else later.push(c, this.tree.getNodeByID(c)!.parent()?.id ?? c);
      }
    };

    const live: [LoroTreeNode, number][] = [];
    for (const id of dirty) {
      if (gone(id)) drop(id);
      else {
        const n = this.tree.getNodeByID(id)!;
        live.push([n, depthOf(n)]);
      }
    }
    live.sort((a, b) => a[1] - b[1]);
    for (const [n, depth] of live) reread(n, depth);
    for (const id of later) {
      if (done.has(id) || gone(id)) continue;
      const n = this.tree.getNodeByID(id)!;
      reread(n, depthOf(n));
    }

    const copied = new Set<NodeId>();
    for (const id of [...replaced]) {
      for (let p = nodes[id]?.parent; p && !copied.has(p); p = nodes[p]?.parent ?? null) {
        if (!replaced.has(p)) put({ ...nodes[p] });
        copied.add(p);
      }
    }
    if (!was.size) return prev;
    for (const fn of this.patchListeners) fn(was, nodes);
    // The snapshot being replaced keeps what it saw: a view of the changed entries over the record.
    const view = Object.create(nodes) as Record<NodeId, NodeSnap>;
    for (const [id, n] of was) view[id] = n!;
    if (this.older) Object.setPrototypeOf(this.older, view);
    this.older = view;
    prev.nodes = view;
    return { root: prev.root, nodes, library: prev.library };
  }

  private resolveAnchors(stored: StoredAnchor[] | undefined, parentBody: string, id: NodeId): Anchor[] {
    if (!stored?.length) return [];
    const out: Anchor[] = [];
    for (const a of stored) {
      const sc = Cursor.decode(unb64(a.s));
      const text = sc.containerId();
      let ids = this.anchoredIn.get(text);
      if (!ids) this.anchoredIn.set(text, (ids = new Set()));
      ids.add(id);
      const s = this.loro.getCursorPos(sc);
      const e = this.loro.getCursorPos(Cursor.decode(unb64(a.e)));
      if (!s || !e) continue;
      const start = Math.min(s.offset, parentBody.length);
      // The end cursor sits on the last anchored character. If that character has been deleted
      // the cursor reports where it used to be, which is already the exclusive end.
      const end = Math.min(e.update ? e.offset : e.offset + 1, parentBody.length);
      out.push({ start, end: Math.max(start, end), quote: a.q, text: parentBody.slice(start, Math.max(start, end)) });
    }
    return out.sort((x, y) => x.start - y.start);
  }

  /**
   * Canonical serialisation: the same tree always produces the same string. A single tree is
   * written out row by row, as it always was, so commits made before the library still verify.
   * A library is hashed node by node (a Merkle tree), so a commit costs the path to what changed
   * rather than the whole library.
   */
  canonical(snap = this.snap()): string {
    if (snap.library) return JSON.stringify(["library", subtreeHash(snap, snap.root)]);
    const rows: unknown[] = [];
    const visit = (id: NodeId) => {
      rows.push(row(snap.nodes[id]));
      snap.nodes[id].children.forEach(visit);
    };
    visit(snap.root);
    return JSON.stringify(rows);
  }

  stateHash(): string {
    return sha256(this.canonical());
  }

  /** A subtree's content with node identity factored out (ids replaced by position). */
  shape(snap = this.snap(), from = snap.root): string {
    const visit = (id: NodeId): unknown => {
      const n = snap.nodes[id];
      const row: unknown[] = [n.kind, n.title, n.body, n.by, n.pinned, n.form ?? null, n.lens ?? null, n.anchors.map((a) => [a.start, a.end]), n.children.map(visit)];
      // A node target is compared by where its target sits, since ids differ between copies.
      if (n.ref) row.push(n.ref.kind === "node" ? ["node", n.ref.id && snap.nodes[n.ref.id] ? position(snap, n.ref.id) : [n.ref.doc ?? null, n.ref.path ?? null], n.ref.quote ?? null] : canonRef(n.ref));
      return row;
    };
    return JSON.stringify(visit(from));
  }

  // ---- writing ----

  /** Name the commit that the following writes belong to. */
  begin(message: string, actor: Actor = "human", tag?: string) {
    this.txn = { n: Math.random().toString(36).slice(2, 10), m: message, by: this.author, a: actor };
    if (tag) this.txn.t = tag;
    this.group?.start();
    this.arm();
  }

  commit(message: string, actor: Actor = "human", tag?: string) {
    if (!this.txn) this.begin(message, actor, tag);
    const meta = this.txn!;
    this.arm();
    const h = this.stateHash();
    // A write of its own, so the closing change is never empty and always carries the hash.
    this.loro.getMap("meta").set("n", meta.n);
    this.txn = null;
    this.loro.commit({ message: JSON.stringify({ ...meta, h }), origin: originOf(meta) });
    this.group?.end();
    this.touch();
  }

  private node(id: NodeId): LoroTreeNode {
    const n = this.tree.getNodeByID(id);
    if (!n || this.tree.isNodeDeleted(id)) throw new OpError(`no such node: ${id}`);
    return n;
  }

  private bodyOf(n: LoroTreeNode): LoroText {
    return (n.data.get("body") as LoroText | undefined) ?? (n.data.setContainer("body", new LoroText()) as LoroText);
  }

  /** Encode spans of a node's body as stored cursor pairs. */
  makeAnchors(parent: LoroTreeNode, ranges: Range[], quotes?: string[]): StoredAnchor[] {
    const text = this.bodyOf(parent);
    const body = text.toString();
    const out: StoredAnchor[] = [];
    ranges.forEach(([start, end], i) => {
      start = Math.max(0, Math.min(start, body.length));
      end = Math.max(start, Math.min(end, body.length));
      if (end <= start) throw new OpError("anchor is empty");
      const s = text.getCursor(start, 0);
      const e = text.getCursor(end - 1, 0);
      if (!s || !e) throw new OpError("could not anchor");
      out.push({ s: b64(s.encode()), e: b64(e.encode()), q: quotes?.[i] ?? body.slice(start, end) });
    });
    return out;
  }

  /**
   * The slug a node may take as a document: the one asked for if free, else one made from the
   * hint. None if the node is not a section of the library root. Read from Loro, not a snapshot,
   * because it runs for every op.
   */
  private slugFor(n: LoroTreeNode, asked: string | undefined, hint: string): string | undefined {
    const lib = n.parent();
    if (!lib || lib.parent() || !lib.data.get("library")) {
      if (asked !== undefined) throw new OpError("only a document (a section of the library) has a slug");
      return undefined;
    }
    const taken = new Set((lib.children() ?? []).filter((c) => c.id !== n.id).map((c) => c.data.get("slug") as string | undefined));
    if (asked !== undefined) {
      if (!SLUG.test(asked) || RESERVED.has(asked)) throw new OpError(`not a valid slug: ${asked}`);
      if (taken.has(asked)) throw new OpError(`another document has the slug ${asked}`);
      return asked;
    }
    return freeSlug(hint, taken);
  }

  /**
   * Write a copy of a subtree (from this document or another) under `parent`, as it stands:
   * content, authorship, pins and the hashes it was last reconciled with. Must run inside a commit.
   */
  graft(src: Snap, from: NodeId, parent: NodeId, opts: { index?: number; slug?: string; title?: string } = {}): NodeId {
    const { index, slug, title } = opts;
    const into = this.node(parent);
    const visit = (id: NodeId, under: LoroTreeNode, at?: number): NodeId => {
      const s = src.nodes[id];
      const n = at === undefined ? under.createNode() : under.createNode(at);
      n.data.set("kind", s.kind);
      n.data.set("title", id === from && title !== undefined ? title : s.title);
      (n.data.setContainer("body", new LoroText()) as LoroText).insert(0, s.body);
      n.data.set("by", s.by);
      n.data.set("pinned", s.pinned);
      if (s.form) n.data.set("form", s.form);
      if (s.lens) n.data.set("lens", s.lens);
      if (s.ref) n.data.set("ref", s.ref as never);
      if (s.nolink?.length) setNolink(n, s.nolink);
      n.data.set("up", s.seenUp);
      n.data.set("down", s.seenDown);
      // The copy's anchors are offsets into its parent's body, which is a copy too; except at the
      // top, where they would be offsets into a different text unless it lands beside the original.
      const kept = id !== from || parent === s.parent ? s.anchors.filter((a) => a.end > a.start) : [];
      if (kept.length) n.data.set("anchors", this.makeAnchors(under, kept.map((a) => [a.start, a.end]), kept.map((a) => a.quote)) as never);
      this.mark(n.id);
      for (const c of s.children) visit(c, n);
      return n.id;
    };
    const count = into.children()?.length ?? 0;
    const top = visit(from, into, Math.max(0, Math.min(index ?? count, count)));
    this.mark(parent);
    const n = this.node(top);
    const free = this.slugFor(n, slug, (title ?? src.nodes[from].title) || "untitled");
    if (free) n.data.set("slug", free);
    return top;
  }

  /**
   * Apply a batch of ops as one commit. This is the only write path: the keyboard, the editor
   * agent and the HTTP endpoint all come through here.
   */
  apply(ops: Op[], message: string, opts: { actor?: Actor; tag?: string } = {}): { created: NodeId[] } {
    const actor = opts.actor ?? "human";
    this.begin(message, actor, opts.tag);
    const created: NodeId[] = [];
    const authored = new Set<NodeId>();
    const blessings: { id: NodeId; dir: "up" | "down" | "both" }[] = [];
    let failure: unknown;
    // "$n" names the nth node created earlier in the same batch.
    const r = (x: NodeId) => (x.startsWith("$") ? (created[+x.slice(1)] ?? x) : x);
    try {
      for (const raw of ops) {
        const op = { ...raw } as Op;
        if ("id" in op) op.id = r(op.id);
        if ("parent" in op) op.parent = r(op.parent);
        switch (op.op) {
          case "create": {
            const parent = this.node(op.parent);
            const kind: Kind = op.kind ?? (op.anchors || op.quote ? "note" : "section");
            let ranges = op.anchors;
            if (!ranges && op.quote) {
              const at = this.bodyOf(parent).toString().indexOf(op.quote);
              if (at < 0) throw new OpError(`quote not found in parent body: "${op.quote}"`);
              ranges = [[at, at + op.quote.length]];
            }
            if (kind === "note" && !ranges?.length) throw new OpError("a note needs an anchor or a quote");
            const count = parent.children()?.length ?? 0;
            const n = parent.createNode(Math.max(0, Math.min(op.index ?? count, count)));
            this.mark(parent.id);
            this.mark(n.id);
            n.data.set("kind", kind);
            n.data.set("title", op.title ?? "");
            (n.data.setContainer("body", new LoroText()) as LoroText).insert(0, op.body ?? "");
            n.data.set("by", actor);
            n.data.set("pinned", actor === "human");
            if (op.form) n.data.set("form", op.form);
            if (op.lens) n.data.set("lens", op.lens);
            if (op.ref) n.data.set("ref", checkRef(op.ref) as never);
            if (ranges?.length) n.data.set("anchors", this.makeAnchors(parent, ranges) as never);
            const slug = kind === "section" ? this.slugFor(n, op.slug, op.title || "untitled") : undefined;
            if (op.slug && kind !== "section") throw new OpError("only a document (a section of the library) has a slug");
            if (slug) n.data.set("slug", slug);
            created.push(n.id);
            authored.add(n.id);
            break;
          }
          case "update": {
            const n = this.node(op.id);
            this.mark(n.id);
            if (op.title !== undefined && op.title !== n.data.get("title")) n.data.set("title", op.title);
            if (op.body !== undefined) {
              this.bodyOf(n).update(op.body);
              this.markAnchoredIn(this.bodyOf(n).id);
            }
            if (op.form) n.data.set("form", op.form);
            if (op.lens) n.data.set("lens", op.lens);
            if (op.ref === null) n.data.get("ref") !== undefined && n.data.delete("ref");
            else if (op.ref) n.data.set("ref", checkRef(op.ref) as never);
            if (op.nolink?.length) {
              if (!op.nolink.every((p) => typeof p === "string" && p.length > 0 && p.length <= 200)) throw new OpError("nolink takes phrases of 1 to 200 characters");
              setNolink(n, op.nolink);
            }
            if (op.anchors) {
              const parent = n.parent();
              if (!parent) throw new OpError("the root has nothing to anchor to");
              n.data.set("anchors", this.makeAnchors(parent, op.anchors) as never);
            }
            if (op.slug !== undefined && op.slug !== n.data.get("slug")) n.data.set("slug", this.slugFor(n, op.slug, "")!);
            if (op.title !== undefined || op.body !== undefined) {
              n.data.set("by", actor);
              n.data.set("pinned", actor === "human");
              authored.add(n.id);
            }
            if (op.pinned !== undefined) n.data.set("pinned", op.pinned);
            break;
          }
          case "replace": {
            const n = this.node(op.id);
            this.mark(n.id);
            n.data.set("title", op.title);
            this.bodyOf(n).update(op.body);
            this.markAnchoredIn(this.bodyOf(n).id);
            n.data.set("by", actor);
            n.data.set("pinned", actor === "human");
            for (const c of n.children() ?? []) this.tree.delete(c.id);
            authored.add(n.id);
            break;
          }
          case "delete": {
            const n = this.node(op.id);
            if (!n.parent()) throw new OpError("the root cannot be deleted");
            this.mark(n.parent()!.id);
            this.mark(n.id);
            this.tree.delete(op.id);
            break;
          }
          case "move": {
            const n = this.node(op.id);
            const parent = this.node(op.parent);
            if (!n.parent()) throw new OpError("the root cannot be moved");
            for (let p: LoroTreeNode | undefined = parent; p; p = p.parent()) {
              if (p.id === op.id) throw new OpError("a node cannot be moved inside itself");
            }
            const sameParent = n.parent()!.id === parent.id;
            const count = (parent.children()?.length ?? 0) - (sameParent ? 1 : 0);
            this.mark(n.parent()!.id);
            this.mark(parent.id);
            this.mark(n.id);
            this.tree.move(op.id, op.parent, Math.max(0, Math.min(op.index ?? count, count)));
            // A section that becomes a document needs an address; one it had before is kept if still free.
            if (!sameParent && n.data.get("kind") !== "note") {
              const had = n.data.get("slug") as string | undefined;
              let slug: string | undefined;
              try {
                slug = this.slugFor(n, had, (n.data.get("title") as string) || "untitled");
              } catch {
                slug = this.slugFor(n, undefined, (n.data.get("title") as string) || "untitled");
              }
              if (slug && slug !== had) n.data.set("slug", slug);
            }
            break;
          }
          case "copy": {
            this.node(op.id);
            const top = this.graft(this.snap(), op.id, op.parent, { index: op.index, title: op.title });
            created.push(top);
            // A new name is not new content: as with a rename, the sections stay consistent with it.
            if (op.title !== undefined) for (const c of sections(this.snap(), top)) blessings.push({ id: c, dir: "down" });
            break;
          }
          case "bless":
            this.node(op.id);
            blessings.push({ id: op.id, dir: op.dir ?? "both" });
            break;
        }
      }
    } catch (err) {
      failure = err;
    }
    // Writing a node is a statement that it is consistent with its surroundings as they now stand.
    const snap = this.snap();
    for (const id of authored) if (snap.nodes[id]) blessings.push({ id, dir: "both" });
    for (const { id, dir } of blessings) {
      const n = this.tree.getNodeByID(id);
      if (!n || !snap.nodes[id]) continue;
      this.mark(id);
      if (dir !== "down") n.data.set("up", upInput(snap, id));
      if (dir !== "up") n.data.set("down", downInput(snap, id));
    }
    this.commit(message, actor, opts.tag);
    if (failure) throw failure;
    return { created };
  }

  // ---- conflict records (kept in the document so they replicate and version like everything else) ----

  get conflictMap() {
    return this.loro.getMap("conflicts");
  }

  conflicts(): Conflict[] {
    if (this.conflictCache) return this.conflictCache;
    const out: Conflict[] = [];
    for (const v of Object.values(this.conflictMap.toJSON() as Record<string, string>)) {
      try {
        out.push(JSON.parse(v));
      } catch {
        /* ignore a malformed record rather than break the reader */
      }
    }
    return (this.conflictCache = out.sort((a, b) => (a.id < b.id ? -1 : 1)));
  }
}

export interface Conflict {
  id: string;
  type: "edit-edit" | "edit-delete" | "contradiction";
  /** The node in question (for a contradiction, the first of the pair). */
  node: NodeId;
  /** For a contradiction: the other node. */
  other?: NodeId;
  /** For edit-edit: which field both sides changed. For "ref", the sides are targets in their text form. */
  field?: "title" | "body" | "ref";
  title: string;
  base: string;
  /** The two sides, in a replica-independent order. */
  a: string;
  b: string;
  /** What the CRDT produced on its own. */
  merged: string;
  status: "open" | "resolved";
  resolved?: string;
  rationale?: string;
  resolvedBy?: string;
  /** For edit-delete: where the deleted node lived. */
  parent?: NodeId;
}

const refString = (r: Ref | undefined) => (r ? JSON.stringify(canonRef(r)) : "");

/** Declined phrases are keys of the node's own map: a key each, so concurrent additions all survive. */
export const NOLINK = "nolink:";
export function setNolink(n: LoroTreeNode, phrases: string[]) {
  for (const p of phrases) if (n.data.get(NOLINK + p) === undefined) n.data.set(NOLINK + p, 1);
}
const sameNode = (a: NodeSnap, b: NodeSnap) =>
  refString(a.ref) === refString(b.ref) && (a.nolink ?? []).join("\u0000") === (b.nolink ?? []).join("\u0000") && a.parent === b.parent && a.kind === b.kind && a.title === b.title && a.body === b.body && a.by === b.by && a.pinned === b.pinned &&
  a.form === b.form && a.lens === b.lens && a.slug === b.slug && a.seenUp === b.seenUp && a.seenDown === b.seenDown && a.depth === b.depth &&
  a.children.length === b.children.length && a.children.every((c, i) => c === b.children[i]) &&
  a.anchors.length === b.anchors.length && a.anchors.every((x, i) => x.start === b.anchors[i].start && x.end === b.anchors[i].end && x.quote === b.anchors[i].quote && x.text === b.anchors[i].text);

// ---- hashing ----

const row = (n: NodeSnap) => {
  const r: unknown[] = [n.id, n.parent, n.kind, n.title, n.body, n.by, n.pinned, n.form ?? null, n.lens ?? null, n.anchors.map((a) => [a.start, a.end]), n.seenUp, n.seenDown];
  // Optional fields go last, and only when set, so commits made before they existed still verify.
  if (n.slug || n.ref || n.nolink) r.push(n.slug ?? null);
  if (n.ref || n.nolink) r.push(n.ref ? canonRef(n.ref) : null);
  if (n.nolink) r.push(n.nolink);
  return r;
};

const hashes = new WeakMap<NodeSnap, string>();
/** A node's row and its children's hashes, hashed: remembered per NodeSnap, which never changes. */
function subtreeHash(snap: Snap, id: NodeId): string {
  const n = snap.nodes[id];
  let h = hashes.get(n);
  if (!h) hashes.set(n, (h = sha256(JSON.stringify([row(n), n.children.map((c) => subtreeHash(snap, c))]))));
  return h;
}

// ---- the library ----

/** The library's documents: the root's sections. In a single tree, the root is the one document. */
export function documents(snap: Snap): NodeId[] {
  return snap.library ? sections(snap, snap.root) : [snap.root];
}

export const isLibraryRoot = (snap: Snap, id: NodeId) => snap.library && id === snap.root;

/** The document a node belongs to: its ancestor among the library's sections. None for the library root itself. */
export function docOf(snap: Snap, id: NodeId): NodeId | null {
  let n = snap.nodes[id];
  if (!n) return null;
  if (!snap.library) return snap.root;
  if (!n.parent) return null;
  while (n.parent !== snap.root) n = snap.nodes[n.parent!];
  return n.id;
}

/** The document with this slug. If two replicas gave the same slug at once, the first in the library wins. */
export function findDoc(snap: Snap, slug: string): NodeId | undefined {
  return documents(snap).find((d) => snap.nodes[d].slug === slug);
}

/** A free slug made from a hint, numbered if it is taken. */
export function freeSlug(hint: string, taken: Set<string | undefined>): string {
  const base = slugify(hint);
  const free = (s: string) => !RESERVED.has(s) && !taken.has(s);
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    const s = `${base.slice(0, 58)}-${n}`;
    if (free(s)) return s;
  }
}

// ---- staleness: computed, never stored ----

export const sections = (snap: Snap, id: NodeId) => snap.nodes[id].children.filter((c) => snap.nodes[c].kind === "section");

/**
 * Hash of what a node's body should be a summary of: its section children, in order. The
 * library's body is not a summary of its documents, so it has nothing to be stale against.
 */
function upInput(snap: Snap, id: NodeId): string {
  if (isLibraryRoot(snap, id)) return "";
  const kids = sections(snap, id);
  if (!kids.length) return "";
  return digest(JSON.stringify(kids.map((c) => [snap.nodes[c].title, snap.nodes[c].body])));
}

/**
 * Hash of what a node elaborates: its anchored text, or failing that its parent's title and body.
 * A document does not elaborate the library, so, like a root, it elaborates nothing.
 */
function downInput(snap: Snap, id: NodeId): string {
  const n = snap.nodes[id];
  if (!n.parent) return "";
  if (n.anchors.length) return digest(JSON.stringify(n.anchors.map((a) => a.text)));
  if (n.kind === "section" && isLibraryRoot(snap, n.parent)) return "";
  const p = snap.nodes[n.parent];
  return digest(JSON.stringify([p.title, p.body]));
}

export interface Staleness {
  /** The children changed since this node was last reconciled with them. */
  up: boolean;
  /** The parent text (or anchored quote) changed since this node was last reconciled with it. */
  down: boolean;
  /** A note whose anchored text has been deleted. */
  orphan: boolean;
}

/**
 * Whether an anchor no longer points at what it was made for. Cursors survive on single
 * characters, so after a heavy rewrite an anchor can still span *something*; if under half the
 * quoted words are left in it, the text it was about is gone.
 */
export function anchorLost(a: Anchor): boolean {
  if (a.end <= a.start) return true;
  if (a.text === a.quote) return false;
  const lower = (t: string) => words(t).map(([s, e]) => t.slice(s, e).toLowerCase());
  const quoted = lower(a.quote);
  if (!quoted.length) return true;
  const now = new Set(lower(a.text));
  return quoted.filter((w) => now.has(w)).length * 2 < quoted.length;
}

/**
 * A node's staleness depends on its own entry, its children's and its parent's. A NodeSnap is
 * replaced whenever anything beneath it changes, so the answer can be remembered against the
 * node's entry (and its parent's): it carries over from one snapshot to the next for every node
 * an edit did not reach, which in a large library is nearly all of them.
 */
const memo = new WeakMap<NodeSnap, { parent: NodeSnap | undefined; s: Staleness }>();

export function staleness(snap: Snap, id: NodeId): Staleness {
  const n = snap.nodes[id];
  const parent = n.parent ? snap.nodes[n.parent] : undefined;
  const seen = memo.get(n);
  if (seen && seen.parent === parent) return seen.s;
  const orphan = n.kind === "note" && (!n.anchors.length || n.anchors.every(anchorLost));
  // A link has no text of its own to fall out of date: it is never stale, so it never asks a model
  // to rewrite it, and nothing else looks at it (a parent summarises its sections, not its notes).
  const s = isLink(n) ? { up: false, down: false, orphan } : { up: n.seenUp !== upInput(snap, id), down: n.seenDown !== downInput(snap, id), orphan };
  memo.set(n, { parent, s });
  return s;
}

export const isStale = (snap: Snap, id: NodeId) => {
  const s = staleness(snap, id);
  return s.up || s.down || s.orphan;
};

// ---- small tree helpers ----

/** A link: a note with a target and no text of its own. */
export const isLink = (n: NodeSnap) => n.kind === "note" && !!n.ref && !n.body.trim();

/** A node's position as child indices from the root: what identifies it across copies of a tree. */
function position(snap: Snap, id: NodeId): number[] {
  const out: number[] = [];
  for (let n = snap.nodes[id]; n?.parent; n = snap.nodes[n.parent]) out.unshift(snap.nodes[n.parent].children.indexOf(n.id));
  return out;
}

/** An op's target, checked: a bad one is refused like any other bad op. */
function checkRef(r: unknown): Ref {
  try {
    return validateRef(r);
  } catch (err) {
    if (err instanceof RefError) throw new OpError(err.message);
    throw err;
  }
}

export const notesOf = (snap: Snap, id: NodeId) => snap.nodes[id].children.filter((c) => snap.nodes[c].kind === "note");

export function ancestors(snap: Snap, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  for (let p = snap.nodes[id]?.parent; p; p = snap.nodes[p].parent) out.push(p);
  return out;
}

/** Ancestors up to and including the node's document: never the library root. */
export function ancestorsInDoc(snap: Snap, id: NodeId): NodeId[] {
  const out = ancestors(snap, id);
  return snap.library ? out.filter((a) => a !== snap.root) : out;
}

export function descendants(snap: Snap, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const visit = (x: NodeId) => snap.nodes[x].children.forEach((c) => (out.push(c), visit(c)));
  visit(id);
  return out;
}

/** A note's display title: its own, or the text it is anchored to. */
export function label(snap: Snap, id: NodeId): string {
  const n = snap.nodes[id];
  if (n.title) return n.title;
  if (n.anchors.length) return `“${n.anchors[0].text || n.anchors[0].quote}”`;
  return "(untitled)";
}

/**
 * Ops that rename a document (the library's section, or a single tree's root). A new name is not
 * new content: the sections under it are declared still consistent with it, and it keeps the pin it had.
 */
export function retitleOps(snap: Snap, id: NodeId, title: string): Op[] {
  const n = snap.nodes[id];
  return [
    { op: "update", id, title },
    { op: "update", id, pinned: n.pinned },
    ...sections(snap, id).map((c): Op => ({ op: "bless", id: c, dir: "down" })),
  ];
}
