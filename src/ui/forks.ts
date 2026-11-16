/**
 * The panes view's panes as a tree. Each pane may have several children ("forks"), each of which
 * continues its own trail to the right and may fork again. Every node remembers which child is
 * picked; following the picks from the root gives the focused branch, the trail the keys move along
 * (`store.trail`), so there is always exactly one. A plain trail is the tree with one child
 * everywhere.
 *
 * Pure functions on immutable trees: an operation copies the path it changes and shares the rest,
 * so a tree that did not change is the same object (the store memoises on identity). A node's `id`
 * names the pane for as long as it is open (keys, the hosts of article panes off the branch).
 */

export interface Tree<R, S = unknown> {
  ref: R;
  kids: Tree<R, S>[];
  /** Which child the branch goes on to (0 with none): the focused one, or the one last focused. */
  pick: number;
  id: number;
  /** Where the reader was when they last left this fork (to come back to). */
  seen?: S;
}

export type Same<R> = (a: R, b: R) => boolean;

let ids = 0;
export const leaf = <R, S>(ref: R): Tree<R, S> => ({ ref, kids: [], pick: 0, id: ++ids });

/** A plain trail as a tree. */
export function chain<R, S>(refs: R[]): Tree<R, S> | null {
  let t: Tree<R, S> | null = null;
  for (let i = refs.length - 1; i >= 0; i--) t = { ref: refs[i], kids: t ? [t] : [], pick: 0, id: ++ids };
  return t;
}

/** The nodes of the focused branch, from the root. */
export function path<R, S>(t: Tree<R, S> | null): Tree<R, S>[] {
  const out: Tree<R, S>[] = [];
  for (let n: Tree<R, S> | undefined = t ?? undefined; n; n = n.kids[n.pick]) out.push(n);
  return out;
}

/** Replace the node at depth i of the focused branch with f(node), copying the path above it. */
function at<R, S>(t: Tree<R, S>, i: number, f: (n: Tree<R, S>) => Tree<R, S>): Tree<R, S> {
  if (i <= 0) return f(t);
  const kid = t.kids[t.pick];
  if (!kid) return t;
  const kids = t.kids.slice();
  kids[t.pick] = at(kid, i - 1, f);
  return { ...t, kids };
}

/** The path of nodes from the root to the node with this id, or null. */
export function trace<R, S>(t: Tree<R, S> | null, id: number): Tree<R, S>[] | null {
  if (!t) return null;
  if (t.id === id) return [t];
  for (const k of t.kids) {
    const p = trace(k, id);
    if (p) return [t, ...p];
  }
  return null;
}

/** Every node, depth first, top row first, with its depth (its column). */
export function all<R, S>(t: Tree<R, S> | null, depth = 0, out: { node: Tree<R, S>; depth: number }[] = []) {
  if (!t) return out;
  out.push({ node: t, depth });
  for (const k of t.kids) all(k, depth + 1, out);
  return out;
}

/** How many leaves (rows at the far right) a subtree has. */
export function leaves<R, S>(t: Tree<R, S>): number {
  return t.kids.length ? t.kids.reduce((n, k) => n + leaves(k), 0) : 1;
}

/** Change the node with this id, copying the path to it. */
export function update<R, S>(t: Tree<R, S>, id: number, f: (n: Tree<R, S>) => Tree<R, S>): Tree<R, S> {
  if (t.id === id) return f(t);
  let changed = false;
  const kids = t.kids.map((k) => {
    const u = update(k, id, f);
    if (u !== k) changed = true;
    return u;
  });
  return changed ? { ...t, kids } : t;
}

/**
 * Open something to the right of pane i of the focused branch. If it is already open there (as any
 * of the forks) that fork is picked and kept as it is. Otherwise a fork adds a child below the
 * others; a plain open replaces the picked child (and everything right of it), or adds the first.
 */
export function open<R, S>(t: Tree<R, S>, i: number, ref: R, fork: boolean, same: Same<R>): Tree<R, S> {
  return at(t, i, (n) => {
    const k = n.kids.findIndex((c) => same(c.ref, ref));
    if (k >= 0) return k === n.pick ? n : { ...n, pick: k };
    if (!n.kids.length) return { ...n, kids: [leaf(ref)], pick: 0 };
    if (fork) return { ...n, kids: [...n.kids, leaf(ref)], pick: n.kids.length };
    const kids = n.kids.slice();
    kids[n.pick] = leaf(ref);
    return { ...n, kids };
  });
}

/** Close everything right of pane i of the focused branch, every fork of it included. */
export function closeRight<R, S>(t: Tree<R, S>, i: number): Tree<R, S> {
  return at(t, i, (n) => (n.kids.length ? { ...n, kids: [], pick: 0 } : n));
}

/** Remove a child of a node, picking the one that takes its place (the one below, else the one above). */
function dropKid<R, S>(n: Tree<R, S>, k: number): Tree<R, S> {
  const kids = n.kids.filter((_, j) => j !== k);
  const pick = k < n.pick ? n.pick - 1 : Math.max(0, Math.min(n.pick, kids.length - 1));
  return { ...n, kids, pick };
}

/** Close pane i of the focused branch (i ≥ 1) and everything right of it. Its siblings stay. */
export function closeAt<R, S>(t: Tree<R, S>, i: number): Tree<R, S> {
  if (i < 1) return t;
  return at(t, i - 1, (n) => (n.kids.length ? dropKid(n, n.pick) : n));
}

/** Close the child of pane i of the focused branch that shows this (whichever fork it is). */
export function closeChild<R, S>(t: Tree<R, S>, i: number, ref: R, same: Same<R>): Tree<R, S> {
  return at(t, i, (n) => {
    const k = n.kids.findIndex((c) => same(c.ref, ref));
    return k < 0 ? n : dropKid(n, k);
  });
}

/** Make the node with this id lie on the focused branch (its own picks below it kept). */
export function select<R, S>(t: Tree<R, S>, id: number): Tree<R, S> | null {
  if (t.id === id) return t;
  for (let k = 0; k < t.kids.length; k++) {
    const s = select(t.kids[k], id);
    if (s) return s === t.kids[k] && k === t.pick ? t : { ...t, kids: t.kids.map((c, j) => (j === k ? s : c)), pick: k };
  }
  return null;
}

/**
 * The fork above (delta −1) or below (+1) the focused branch, in the order the rows are drawn: from
 * the branch's last pane leftwards, the nearest pane with a sibling in that direction. Returns the
 * tree with that sibling picked and the depth it is at, or null at the top or bottom.
 */
export function sibling<R, S>(t: Tree<R, S>, delta: number): { tree: Tree<R, S>; depth: number } | null {
  const p = path(t);
  for (let d = p.length - 1; d >= 1; d--) {
    const parent = p[d - 1];
    const k = parent.pick + delta;
    if (k >= 0 && k < parent.kids.length) return { tree: at(t, d - 1, (n) => ({ ...n, pick: k })), depth: d };
  }
  return null;
}

/** Drop every pane whose ref fails `keep` (with everything right of it). Null if the root goes. Unchanged trees are returned as they are. */
export function prune<R, S>(t: Tree<R, S> | null, keep: (r: R) => boolean): Tree<R, S> | null {
  if (!t || !keep(t.ref)) return null;
  let changed = false;
  // The picked child, or the one that takes its place: as many kept children before it.
  let pick = 0;
  const kids: Tree<R, S>[] = [];
  t.kids.forEach((k, j) => {
    const p = prune(k, keep);
    if (p !== k) changed = true;
    if (p) kids.push(p);
    if (j === t.pick) pick = kids.length - (p ? 1 : 0);
  });
  if (!changed) return t;
  return { ...t, kids, pick: Math.max(0, Math.min(pick, kids.length - 1)) };
}

/**
 * Make the focused branch this list of refs, keeping every pane that is already on the way: where a
 * ref is already a child it is picked; where it is not, the picked child is replaced by the rest of
 * the list. Panes right of the list's end close. A different root starts again.
 */
export function withBranch<R, S>(t: Tree<R, S> | null, refs: R[], same: Same<R>): Tree<R, S> | null {
  if (!refs.length) return null;
  if (!t || !same(t.ref, refs[0])) return chain(refs);
  const go = (n: Tree<R, S>, i: number): Tree<R, S> => {
    if (i === refs.length) return n.kids.length ? { ...n, kids: [], pick: 0 } : n;
    const k = n.kids.findIndex((c) => same(c.ref, refs[i]));
    if (k < 0) {
      const rest = chain<R, S>(refs.slice(i))!;
      const kids = n.kids.length ? n.kids.map((c, j) => (j === n.pick ? rest : c)) : [rest];
      return { ...n, kids, pick: n.kids.length ? n.pick : 0 };
    }
    const sub = go(n.kids[k], i + 1);
    return sub === n.kids[k] && k === n.pick ? n : { ...n, kids: n.kids.map((c, j) => (j === k ? sub : c)), pick: k };
  };
  return go(t, 1);
}

/** As stored: refs (made storable by the caller), children and picks; no ids, nothing remembered. */
export interface Saved<R> {
  ref: R;
  kids?: Saved<R>[];
  pick?: number;
}

export function save<R, S, O>(t: Tree<R, S> | null, ref: (r: R) => O): Saved<O> | null {
  if (!t) return null;
  const out: Saved<O> = { ref: ref(t.ref) };
  if (t.kids.length) out.kids = t.kids.map((k) => save(k, ref)!);
  if (t.pick) out.pick = t.pick;
  return out;
}

/** Read a stored tree back, dropping whatever does not pass `ok` (and is not shaped like a tree). */
export function load<R, S>(o: unknown, ok: (r: unknown) => r is R): Tree<R, S> | null {
  if (!o || typeof o !== "object" || !ok((o as Saved<unknown>).ref)) return null;
  const s = o as Saved<unknown>;
  const kids = (Array.isArray(s.kids) ? s.kids : []).map((k) => load<R, S>(k, ok)).filter((k): k is Tree<R, S> => !!k);
  const pick = Math.max(0, Math.min(typeof s.pick === "number" ? Math.floor(s.pick) : 0, kids.length - 1));
  return { ref: s.ref as R, kids, pick, id: ++ids };
}

/** What was stored: the tree, or, from before there were forks, the trail as a tree with one branch. */
export function restore<R, S>(saved: unknown, trail: unknown[] | undefined, ok: (r: unknown) => r is R): Tree<R, S> | null {
  return saved ? load<R, S>(saved, ok) : chain<R, S>((trail ?? []).filter(ok));
}

/** Whether a tree is well formed: picks in range, no pane twice among siblings, ids unique. */
export function valid<R, S>(t: Tree<R, S> | null, same: Same<R>): boolean {
  const seen = new Set<number>();
  const ok = (n: Tree<R, S>): boolean => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    if (n.pick < 0 || n.pick >= Math.max(1, n.kids.length) || !Number.isInteger(n.pick)) return false;
    for (let a = 0; a < n.kids.length; a++) for (let b = a + 1; b < n.kids.length; b++) if (same(n.kids[a].ref, n.kids[b].ref)) return false;
    return n.kids.every(ok);
  };
  return !t || ok(t);
}
