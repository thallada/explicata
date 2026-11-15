/**
 * Git-shaped operations over the CRDT: history, verified checkout, revert, branches, and a merge
 * that is structural first (the CRDT, deterministic) and semantic second (three-way comparison
 * against the merge base, producing conflict records for a model or a person to resolve).
 */
import { VersionVector, type LoroText, type OpId, type PeerID } from "loro-crdt";
import { healLinks } from "./links";
import { Doc, NOLINK, OpError, anchorLost, label, setNolink, type CommitMeta, type Conflict, type NodeId, type NodeSnap, type Op, type Snap, descendants } from "./model";
import { canonRef, formatTarget, parseTarget, validateRef, type Ref } from "./ref";
import { clip, digest } from "./text";

/** A run of one peer's ops. */
export interface Span {
  peer: PeerID;
  counter: number;
  length: number;
}

export interface Commit {
  /** `${counter}@${peer}` of the commit's last op: a stable name for this point in history. */
  id: string;
  peer: PeerID;
  lamport: number;
  /** Unix seconds. */
  time: number;
  message: string;
  by: string;
  actor: string;
  tag?: string;
  /** Recorded SHA-256 of the tree state at this commit, if the commit carries one. */
  hash?: string;
  parents: string[];
  frontiers: OpId[];
  /** The ops the commit is made of. */
  spans: Span[];
}

const opName = (o: OpId) => `${o.counter}@${o.peer}`;

export function history(doc: Doc): Commit[] {
  const out: Commit[] = [];
  const parse = (message: string | undefined): Partial<CommitMeta> => {
    if (!message) return {};
    try {
      return JSON.parse(message);
    } catch {
      return { m: message };
    }
  };
  for (const changes of doc.loro.getAllChanges().values()) {
    for (let i = 0; i < changes.length; i++) {
      const first = changes[i];
      // One commit can be stored as several consecutive changes: Loro splits large ones, and
      // commits early when a deleted cursor is resolved mid-transaction. They carry the same
      // commit id; the commit starts at the first and its state is the state after the last.
      let c = first;
      let meta = parse(c.message);
      for (let next = changes[i + 1]; next && meta.n; next = changes[i + 1]) {
        const follows = next.deps.length === 1 && next.deps[0].peer === c.peer && next.deps[0].counter === c.counter + c.length - 1;
        const nextMeta = parse(next.message);
        if (!follows || nextMeta.n !== meta.n) break;
        c = next;
        meta = { ...meta, ...nextMeta };
        i++;
      }
      const last = { peer: c.peer, counter: c.counter + c.length - 1 };
      out.push({
        id: opName(last),
        peer: c.peer,
        lamport: c.lamport + c.length - 1,
        time: c.timestamp,
        message: meta.m ?? "(undo/redo)",
        by: meta.by ?? "?",
        actor: meta.a ?? "human",
        tag: meta.t,
        hash: meta.h,
        parents: first.deps.map(opName),
        frontiers: [last],
        spans: [{ peer: c.peer, counter: first.counter, length: c.counter + c.length - first.counter }],
      });
    }
  }
  // Newest first. Lamport order is consistent with causality; peer breaks ties deterministically.
  return out.sort((a, b) => b.lamport - a.lamport || (a.peer < b.peer ? 1 : -1));
}

/** A read-only replica of the document as it stood at a commit. */
export function at(doc: Doc, commit: Pick<Commit, "frontiers">): Doc {
  return new Doc(doc.loro.forkAt(commit.frontiers), doc.author);
}

/**
 * The nodes some ops wrote to, read from the containers they changed: a node's data map shares
 * the node's id, and its body sits under it. Tree ops are read for what they created, moved or
 * deleted. Nodes that have since been deleted are still named (by id).
 */
export function touched(doc: Doc, spans: Span[]): { nodes: Set<NodeId>; deleted: Set<NodeId>; unknown: boolean } {
  const nodes = new Set<NodeId>();
  const deleted = new Set<NodeId>();
  let unknown = false;
  for (const s of spans) {
    if (s.length <= 0) continue;
    let tree = false;
    for (const cid of doc.loro.getChangedContainersIn({ peer: s.peer, counter: s.counter }, s.length)) {
      if (cid === "cid:root-tree:Tree") tree = true;
      if (cid.startsWith("cid:root-")) continue;
      const m = /^cid:(\d+@\d+):(\w+)$/.exec(cid);
      if (!m) continue;
      if (m[2] === "Map") nodes.add(m[1] as NodeId);
      else {
        const path = doc.loro.getPathToContainer(cid);
        if (path?.[0] === "tree" && typeof path[1] === "string") nodes.add(path[1] as NodeId);
        else unknown = true;
      }
    }
    if (!tree) continue;
    for (const change of doc.loro.exportJsonInIdSpan(s)) {
      for (const op of change.ops) {
        const c = op.content as { type?: string; target?: string; parent?: string };
        if (!op.container.endsWith(":Tree") || !c.target) continue;
        if (c.type === "delete") deleted.add(c.target as NodeId);
        else {
          nodes.add(c.target as NodeId);
          if (c.parent) nodes.add(c.parent as NodeId);
        }
      }
    }
  }
  return { nodes, deleted, unknown };
}

export interface Verification {
  checked: number;
  unhashed: number;
  mismatches: { id: string; message: string; recorded: string; actual: string }[];
}

/**
 * Check out every commit and confirm the tree hashes to what the commit recorded. One detached
 * replica walks the commits oldest first: a checkout moves it from one state to the next, where
 * forking a fresh replica for each would replay the library's history every time. A detached
 * replica can resolve an anchor whose characters were deleted later differently from the replica
 * that made the commit, so a mismatch is checked again in a fresh fork before it is reported.
 */
export function verifyHistory(doc: Doc): Verification {
  const result: Verification = { checked: 0, unhashed: 0, mismatches: [] };
  const walker = doc.fork();
  for (const c of history(doc).reverse()) {
    if (!c.hash) {
      result.unhashed++;
      continue;
    }
    walker.loro.checkout(c.frontiers);
    walker.reread();
    let actual = walker.stateHash();
    if (actual !== c.hash) actual = at(doc, c).stateHash();
    result.checked++;
    if (actual !== c.hash) result.mismatches.push({ id: c.id, message: c.message, recorded: c.hash, actual });
  }
  return result;
}

/** Point a node's anchors back at the spans they had in `was`, if they have moved since. */
function reanchor(doc: Doc, id: NodeId, was: NodeSnap, now: NodeSnap) {
  const same = was.anchors.length === now.anchors.length && was.anchors.every((a, i) => a.start === now.anchors[i].start && a.end === now.anchors[i].end);
  const node = doc.tree.getNodeByID(id);
  const parent = node?.parent();
  if (same || !was.anchors.length || !node || !parent) return;
  node.data.set("anchors", doc.makeAnchors(parent, was.anchors.map((a) => [a.start, a.end])) as never);
  doc.mark(id);
}

/** Roll the whole tree back to a commit by writing the inverse as a new commit. History is kept. */
export function revertTo(doc: Doc, commit: Commit) {
  const target = at(doc, commit).snap();
  if (doc.snap().library && !target.library) throw new OpError("that commit is from before the library existed; revert one document to it instead");
  doc.begin(`Revert to “${clip(commit.message, 60)}”`, "human", "revert");
  doc.loro.revertTo(commit.frontiers);
  doc.reread();
  // A reverted deletion comes back as new characters and new nodes, which old cursors do not
  // point at. The two trees have the same shape, so walk them together and re-anchor.
  const now = doc.snap();
  const fix = (was: NodeId, is: NodeId) => {
    const w = target.nodes[was];
    const n = now.nodes[is];
    if (!w || !n) return;
    reanchor(doc, is, w, n);
    w.children.forEach((c, i) => n.children[i] && fix(c, n.children[i]));
  };
  fix(target.root, now.root);
  doc.commit(`Revert to “${clip(commit.message, 60)}”`, "human", "revert");
}

/**
 * Roll one subtree (a document) back to how it stood at a commit, leaving the rest of the library
 * as it is now. Nodes that still exist keep their ids and are moved, rewritten and re-anchored to
 * match; nodes deleted since come back as copies under new ids; nodes added since are deleted.
 * The document node itself stays where it is now.
 */
export function revertDocTo(doc: Doc, commit: Commit, id: NodeId) {
  const target = at(doc, commit).snap();
  const now = doc.snap();
  if (!target.nodes[id]) throw new OpError(`“${clip(label(now, id), 40)}” did not exist yet at “${clip(commit.message, 40)}”`);
  if (!now.nodes[id]) throw new OpError("that node no longer exists");
  const message = `Revert “${clip(label(now, id), 40)}” to “${clip(commit.message, 50)}”`;
  const tree = doc.tree;
  const alive = (x: NodeId) => !!tree.getNodeByID(x) && !tree.isNodeDeleted(x);
  const wanted = new Set([id, ...descendants(target, id)]);
  doc.begin(message, "human", "revert");
  const place = (tid: NodeId, parent: NodeId | null, index: number) => {
    const t = target.nodes[tid];
    if (!alive(tid)) {
      doc.graft(target, tid, parent!, { index });
      return;
    }
    const n = tree.getNodeByID(tid)!;
    if (parent) {
      const from = n.parent()!;
      const at = (from.children() ?? []).findIndex((c) => c.id === tid);
      if (from.id !== parent || at !== index) {
        tree.move(tid, parent, index);
        doc.mark(from.id);
        doc.mark(parent);
      }
    }
    doc.mark(tid);
    const d = n.data;
    for (const [key, value] of [["kind", t.kind], ["title", t.title], ["by", t.by], ["pinned", t.pinned], ["up", t.seenUp], ["down", t.seenDown]] as const) {
      if (d.get(key) !== value) d.set(key, value);
    }
    for (const [key, value] of [["form", t.form], ["lens", t.lens]] as const) {
      if (value === undefined) d.get(key) !== undefined && d.delete(key);
      else if (d.get(key) !== value) d.set(key, value);
    }
    if (!t.ref) d.get("ref") !== undefined && d.delete("ref");
    else if (JSON.stringify(canonRef(t.ref)) !== JSON.stringify(d.get("ref") ? canonRef(d.get("ref") as Ref) : null)) d.set("ref", t.ref as never);
    // Declined phrases only ever grow; going back to a commit forgets the ones added since.
    for (const k of d.keys()) if (k.startsWith(NOLINK) && !t.nolink?.includes(k.slice(NOLINK.length))) d.delete(k);
    if (t.nolink?.length) setNolink(n, t.nolink);
    const body = d.get("body") as LoroText | undefined;
    if (body && body.toString() !== t.body) {
      body.update(t.body);
      doc.markAnchoredIn(body.id);
    }
    t.children.forEach((c, i) => place(c, tid, i));
  };
  place(id, null, 0);
  // What was added since goes; then a second pass puts the survivors back in order.
  for (const x of descendants(doc.snap(), id)) {
    if (!wanted.has(x) && alive(x)) {
      doc.mark(tree.getNodeByID(x)!.parent()!.id);
      tree.delete(x);
    }
  }
  place(id, null, 0);
  // Re-anchor what no longer points where it pointed then.
  const snap = doc.snap();
  for (const x of wanted) if (snap.nodes[x] && x !== id) reanchor(doc, x, target.nodes[x], snap.nodes[x]);
  doc.commit(message, "human", "revert");
}

/**
 * Re-attach notes whose anchor was lost but whose quoted text is back in the parent's body, as
 * happens when a deletion is undone: the text returns as new characters that old cursors do not
 * point at. Returns how many were re-anchored.
 */
export function healAnchors(doc: Doc): number {
  const snap = doc.snap();
  const ops: Op[] = [];
  for (const n of Object.values(snap.nodes)) {
    if (n.kind !== "note" || !n.parent || !n.anchors.length || !n.anchors.every(anchorLost)) continue;
    const quote = n.anchors[0].quote;
    const at = quote ? snap.nodes[n.parent].body.indexOf(quote) : -1;
    if (at >= 0) ops.push({ op: "update", id: n.id, anchors: [[at, at + quote.length]] }, { op: "bless", id: n.id, dir: "down" });
  }
  if (ops.length) doc.apply(ops, `Re-anchor ${ops.length / 2} note${ops.length > 2 ? "s" : ""} to restored text`, { actor: "llm", tag: "regen" });
  // Links to nodes that came back under new ids are found again the same way, from what they recorded.
  healLinks(doc);
  return ops.length / 2;
}

// ---- version-vector arithmetic ----

type VV = Map<PeerID, number>;
const vvOf = (doc: Doc): VV => doc.loro.version().toJSON();

function vvMin(a: VV, b: VV): VV {
  const out: VV = new Map();
  for (const [peer, n] of a) {
    const m = Math.min(n, b.get(peer) ?? 0);
    if (m > 0) out.set(peer, m);
  }
  return out;
}

export const vvIncludes = (a: VV, b: VV) => [...b].every(([peer, n]) => (a.get(peer) ?? 0) >= n);

/** The ops in `to` that `from` lacks. */
function spansBetween(from: VV, to: VV): Span[] {
  const out: Span[] = [];
  for (const [peer, n] of to) {
    const m = from.get(peer) ?? 0;
    if (n > m) out.push({ peer, counter: m, length: n - m });
  }
  return out;
}

export const encodeVV = (vv: VV) => JSON.stringify([...vv]);
export const decodeVV = (s: string): VV => new Map(JSON.parse(s));

// ---- merge ----

export interface MergeReport {
  /** nothing: already contained. forward: the other side was strictly ahead. merge: histories had diverged. */
  kind: "nothing" | "forward" | "merge";
  conflicts: Conflict[];
  /** For a real merge: the three states it was computed from, for anything that wants to look further. */
  base?: Snap;
  ours?: Snap;
  theirs?: Snap;
}

/**
 * Bring another replica's changes in. `bytes` is its update, `theirVV` its version.
 * The CRDT does the structural merge; what it cannot see is then looked for by comparing
 * base, ours and theirs node by node.
 *
 * Comparing whole states costs the size of the library, so unless `full` is asked for, it is
 * done only when the two sides could disagree: when they wrote to a node in common, or one side
 * deleted something. Sync rounds take the short way; explicit merges ask for the states.
 */
export function mergeUpdate(doc: Doc, bytes: Uint8Array, theirVV: VV, opts: { full?: boolean } = {}): MergeReport {
  const ourVV = vvOf(doc);
  if (vvIncludes(ourVV, theirVV)) return { kind: "nothing", conflicts: [] };
  if (vvIncludes(theirVV, ourVV)) {
    doc.loro.import(bytes);
    doc.touch();
    return { kind: "forward", conflicts: [] };
  }
  const mine = opts.full ? null : touched(doc, spansBetween(theirVV, ourVV));
  // A copy: a snapshot taken before a write answers lookups but cannot be enumerated (see Doc.patch).
  const oursNow = opts.full ? { ...doc.snap(), nodes: { ...doc.snap().nodes } } : null;
  doc.loro.import(bytes);
  doc.touch();
  if (mine) {
    const theirs = touched(doc, spansBetween(ourVV, theirVV));
    const overlap = [...mine.nodes].some((id) => theirs.nodes.has(id));
    const deletes = (mine.deleted.size && theirs.nodes.size + theirs.deleted.size) || (theirs.deleted.size && mine.nodes.size);
    if (!overlap && !deletes && !mine.unknown && !theirs.unknown) return { kind: "merge", conflicts: [] };
  }
  const merged = doc.snap();
  const stateAt = (vv: VV) => new Doc(doc.loro.forkAt(doc.loro.vvToFrontiers(new VersionVector(vv)))).snap();
  const ours = oursNow ?? stateAt(ourVV);
  const base = stateAt(vvMin(ourVV, theirVV));
  const theirs = stateAt(theirVV);
  const found = detectConflicts(base, ours, theirs, merged);
  const known = new Set(doc.conflicts().map((c) => c.id));
  const fresh = found.filter((c) => !known.has(c.id));
  if (fresh.length) {
    for (const c of fresh) doc.conflictMap.set(c.id, JSON.stringify(c));
    doc.touch();
    doc.commit(`Detected ${fresh.length} semantic conflict${fresh.length > 1 ? "s" : ""}`, "llm", "conflict");
  }
  return { kind: "merge", conflicts: fresh, base, ours, theirs };
}

/** Merge a branch (another Doc) into this one, leaving a merge commit that names it. */
export function mergeBranch(doc: Doc, other: Doc, name: string): MergeReport {
  const report = mergeUpdate(doc, other.loro.export({ mode: "update", from: doc.loro.version() }), vvOf(other), { full: true });
  if (report.kind === "merge") {
    const n = report.conflicts.length;
    doc.loro.getMap("meta").set("merges", ((doc.loro.getMap("meta").get("merges") as number) ?? 0) + 1);
    doc.commit(`Merge ${name}${n ? ` (${n} conflict${n > 1 ? "s" : ""} to review)` : ""}`, "human", "merge");
  }
  return report;
}

/** The semantic conflicts a structural merge leaves behind. Pure: same inputs, same records. */
export function detectConflicts(base: Snap, ours: Snap, theirs: Snap, merged: Snap): Conflict[] {
  const out: Conflict[] = [];
  const ids = new Set<NodeId>([...Object.keys(ours.nodes), ...Object.keys(theirs.nodes)] as NodeId[]);
  const order = (x: string, y: string): [string, string] => (x <= y ? [x, y] : [y, x]);

  for (const id of ids) {
    const b = base.nodes[id];
    const o = ours.nodes[id];
    const t = theirs.nodes[id];
    if (!b) continue; // created on one side only: nothing to disagree with
    if (o && t) {
      // Both sides changed the same field to different things. The CRDT's interleaving is
      // well-formed text that neither author wrote.
      for (const field of ["title", "body"] as const) {
        if (o[field] !== b[field] && t[field] !== b[field] && o[field] !== t[field]) {
          const [a, bb] = order(o[field], t[field]);
          out.push({
            id: digest(["edit-edit", id, field, a, bb].join("\u0000")),
            type: "edit-edit",
            node: id,
            field,
            title: merged.nodes[id]?.title ?? b.title,
            base: b[field],
            a,
            b: bb,
            merged: merged.nodes[id]?.[field] ?? "",
            status: "open",
          });
        }
      }
      // Both sides pointed the same node at different targets: the CRDT keeps one; say which was lost.
      const [rb, ro, rt] = [b, o, t].map((n) => refText(n.ref));
      if (ro !== rb && rt !== rb && ro !== rt) {
        const [a, bb] = order(ro, rt);
        out.push({
          id: digest(["edit-edit", id, "ref", a, bb].join("\u0000")),
          type: "edit-edit",
          node: id,
          field: "ref",
          title: merged.nodes[id] ? label(merged, id) : b.title,
          base: rb,
          a,
          b: bb,
          merged: refText(merged.nodes[id]?.ref),
          status: "open",
        });
      }
    } else if (!!o !== !!t) {
      // One side deleted the node (or an ancestor); the other kept working in it.
      const kept = (o ? ours : theirs) as Snap;
      const k = kept.nodes[id];
      const parentGone = b.parent && !(o ? theirs : ours).nodes[b.parent];
      if (parentGone) continue; // reported once, at the top of the deleted subtree
      const touchedHere = [id, ...descendants(kept, id)].filter((x) => {
        const was = base.nodes[x];
        const now = kept.nodes[x];
        return !was || was.title !== now.title || was.body !== now.body || refText(was.ref) !== refText(now.ref);
      });
      if (!touchedHere.length) continue;
      out.push({
        id: digest(["edit-delete", id, k.title, k.body].join("\u0000")),
        type: "edit-delete",
        node: id,
        field: "body",
        title: k.title || b.title,
        base: b.body,
        a: k.body,
        b: "",
        merged: "",
        status: "open",
        parent: b.parent ?? undefined,
      });
    }
  }
  return out.sort((x, y) => (x.id < y.id ? -1 : 1));
}

/**
 * Settle a conflict by writing a chosen text as an ordinary commit. The record keeps what was
 * there before, so the decision can be reopened.
 */
export function resolveConflict(
  doc: Doc,
  id: string,
  text: string,
  how: { by: string; rationale?: string; actor?: "human" | "llm" },
) {
  const c = doc.conflicts().find((x) => x.id === id);
  if (!c) throw new Error(`no such conflict: ${id}`);
  const snap = doc.snap();
  const actor = how.actor ?? "human";
  const record: Conflict = { ...c, status: "resolved", resolved: text, rationale: how.rationale, resolvedBy: how.by };
  doc.conflictMap.set(id, JSON.stringify(record));
  doc.touch();
  const message = `Resolve conflict in “${clip(c.title, 40)}” (${how.by})`;
  if (c.type === "edit-edit" && c.field === "ref" && snap.nodes[c.node]) {
    const ref = readRefText(text);
    if (typeof ref === "string") throw new OpError(`not a target: ${ref}`);
    doc.apply([{ op: "update", id: c.node, ref }], message, { actor, tag: "resolve" });
  } else if (c.type === "edit-edit" && snap.nodes[c.node]) {
    doc.apply([{ op: "update", id: c.node, [c.field!]: text }], message, { actor, tag: "resolve" });
  } else if (c.type === "edit-delete" && text && c.parent && snap.nodes[c.parent] && !snap.nodes[c.node]) {
    // Restoring: tree nodes cannot be undeleted, so the kept text comes back as a new node.
    doc.apply([{ op: "create", parent: c.parent, title: c.title, body: text }], message, { actor, tag: "resolve" });
  } else if (c.type === "contradiction" && snap.nodes[c.node] && text !== snap.nodes[c.node].body) {
    doc.apply([{ op: "update", id: c.node, body: text }], message, { actor, tag: "resolve" });
  } else {
    doc.commit(message, actor, "resolve");
  }
}

/** Undo a resolution: put back what the merge produced and mark the conflict open again. */
export function reopenConflict(doc: Doc, id: string) {
  const c = doc.conflicts().find((x) => x.id === id);
  if (!c || c.status !== "resolved") return;
  const { resolved: _r, rationale: _why, resolvedBy: _by, ...rest } = c;
  doc.conflictMap.set(id, JSON.stringify({ ...rest, status: "open" }));
  doc.touch();
  const snap = doc.snap();
  if (c.field === "ref" && snap.nodes[c.node]) {
    const ref = readRefText(c.merged);
    doc.apply([{ op: "update", id: c.node, ref: typeof ref === "string" ? null : ref }], `Reopen conflict in “${clip(c.title, 40)}”`, { actor: "llm", tag: "resolve" });
  } else if ((c.type === "edit-edit" || c.type === "contradiction") && snap.nodes[c.node]) {
    doc.apply([{ op: "update", id: c.node, [c.field ?? "body"]: c.merged }], `Reopen conflict in “${clip(c.title, 40)}”`, {
      actor: "llm",
      tag: "resolve",
    });
  } else {
    doc.commit(`Reopen conflict in “${clip(c.title, 40)}”`, "human", "resolve");
  }
}

// ---- branches ----

/** A set of named replicas of one library. */
export class Repo {
  branches = new Map<string, Doc>();
  current = "main";

  constructor(main: Doc) {
    this.branches.set("main", main);
  }

  get doc(): Doc {
    return this.branches.get(this.current)!;
  }

  /** Create a branch from the current one, optionally from an earlier commit. */
  branch(name: string, from?: Commit): Doc {
    if (this.branches.has(name)) throw new Error(`branch exists: ${name}`);
    const doc = from ? at(this.doc, from).fork() : this.doc.fork();
    doc.author = this.doc.author;
    this.branches.set(name, doc);
    return doc;
  }

  switch(name: string) {
    if (!this.branches.has(name)) throw new Error(`no such branch: ${name}`);
    this.current = name;
  }

  merge(from: string): MergeReport {
    const other = this.branches.get(from);
    if (!other) throw new Error(`no such branch: ${from}`);
    return mergeBranch(this.doc, other, from);
  }
}

/** A target as text for a conflict record ("" for none): what a person reads and what resolving it parses back. */
function refText(r: Ref | undefined): string {
  // A node target is kept whole (its id is what counts), the others in their text form.
  return !r ? "" : r.kind === "node" ? JSON.stringify(r) : formatTarget(r);
}

function readRefText(text: string): Ref | null | string {
  if (!text) return null;
  if (text.startsWith("{")) {
    try {
      return validateRef(JSON.parse(text));
    } catch (err) {
      return (err as Error).message;
    }
  }
  return parseTarget(text);
}
