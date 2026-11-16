/**
 * The panes view's panes as a forest. Each pane may have several children ("forks"), each of which
 * continues its own trail to the right and may fork again; a pane's column is its depth. The first
 * tree starts at the top node; the others are orphans: pinned panes that stayed open when a pane
 * they were opened from closed, each keeping the column it was in.
 *
 * Every node remembers which child is picked; following the picks from the root of the focused
 * tree gives the focused branch, the trail the keys move along (`store.trail`), so there is always
 * exactly one. A plain trail is one tree with one child everywhere.
 *
 * Pure functions on immutable trees: an operation copies the path it changes and shares the rest,
 * so a forest that did not change is the same object (the store memoises on identity). A node's
 * `id` names the pane for as long as it is open (keys, curves, the hosts of article panes off the
 * branch).
 *
 * Each pane has its branch's colour (`hue`), fixed when it opens: a pane opened as its parent's first
 * child takes its parent's, any further child starts the next colour of the palette, so a plain trail
 * is one colour and each fork starts a new one. The first tree's root trail has none (plain ink).
 */

/** How many colours branches cycle through (style.css `--hue-0` …). */
export const HUES = 7;

export interface Tree<R, S = unknown> {
  ref: R;
  kids: Tree<R, S>[];
  /** Which child the branch goes on to (0 with none): the focused one, or the one last focused. */
  pick: number;
  id: number;
  /** Where the reader was when they last left this pane by [ or ] (to come back to). */
  seen?: S;
  /** Pinned: stays open when a pane it was opened from closes, is never replaced by a plain open, and never collapses. */
  pinned?: boolean;
  /** On the root of an orphan: the column it stays in. */
  col?: number;
  /** Its place in its column, once the panes there have been put in an order by hand (dragged); unranked panes follow, in tree order. */
  rank?: number;
  /** Its branch's colour, 0 to HUES − 1; none on the first tree's root trail. Kept for the pane's life. */
  hue?: number;
}

/** The trees, the first starting at the top node; `at` is the one the focused branch is in. */
export interface Forest<R, S = unknown> {
  trees: Tree<R, S>[];
  at: number;
  /** How many branch colours have been started: the next is this one, round the palette. */
  hues?: number;
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

/** A forest of one tree (none for no refs). */
export const plain = <R, S>(refs: R[]): Forest<R, S> => {
  const t = chain<R, S>(refs);
  return { trees: t ? [t] : [], at: 0 };
};

/** A tree with this colour on every pane (none: as it is). */
const tint = <R, S>(t: Tree<R, S>, hue: number | undefined): Tree<R, S> => (hue === undefined ? t : { ...t, hue, kids: t.kids.map((k) => tint(k, hue)) });

/** Colours started by one operation: the next of the palette each time, never the parent's own. */
function palette(f: Forest<unknown, unknown>) {
  let n = f.hues ?? 0;
  return {
    next(parent?: number): number {
      let h = n++ % HUES;
      if (h === parent) h = n++ % HUES;
      return h;
    },
    /** The forest, counting the colours started. */
    done<R, S>(g: Forest<R, S>): Forest<R, S> {
      return n === (g.hues ?? 0) ? g : { ...g, hues: n };
    },
  };
}

/** The column a tree's root is in. */
export const colOf = (t: Tree<unknown, unknown>) => t.col ?? 0;

/** The focused tree. */
export const focused = <R, S>(f: Forest<R, S>): Tree<R, S> | null => f.trees[f.at] ?? null;

/** The nodes of a tree's focused branch, from the root. */
export function path<R, S>(t: Tree<R, S> | null): Tree<R, S>[] {
  const out: Tree<R, S>[] = [];
  for (let n: Tree<R, S> | undefined = t ?? undefined; n; n = n.kids[n.pick]) out.push(n);
  return out;
}

/** Replace the node at depth i of a tree's focused branch with f(node), copying the path above it. */
function at<R, S>(t: Tree<R, S>, i: number, f: (n: Tree<R, S>) => Tree<R, S>): Tree<R, S> {
  if (i <= 0) return f(t);
  const kid = t.kids[t.pick];
  if (!kid) return t;
  const kids = t.kids.slice();
  kids[t.pick] = at(kid, i - 1, f);
  return { ...t, kids };
}

/** The path of nodes from a tree's root to the node with this id, or null. */
export function trace<R, S>(t: Tree<R, S> | null, id: number): Tree<R, S>[] | null {
  if (!t) return null;
  if (t.id === id) return [t];
  for (const k of t.kids) {
    const p = trace(k, id);
    if (p) return [t, ...p];
  }
  return null;
}

/** Where a pane is: its tree, and the path to it from that tree's root. */
export function find<R, S>(f: Forest<R, S>, id: number): { ti: number; path: Tree<R, S>[] } | null {
  for (let ti = 0; ti < f.trees.length; ti++) {
    const p = trace(f.trees[ti], id);
    if (p) return { ti, path: p };
  }
  return null;
}

export interface Placed<R, S> {
  node: Tree<R, S>;
  /** Its depth in its own tree (its place on that tree's branch, when the tree is focused). */
  depth: number;
  /** Its column on screen. */
  col: number;
  ti: number;
  parent?: Tree<R, S>;
}

/** Every pane, tree by tree, depth first, earlier forks first: the order panes stand in a column, top to bottom. */
export function all<R, S>(f: Forest<R, S>): Placed<R, S>[] {
  const out: Placed<R, S>[] = [];
  const go = (node: Tree<R, S>, depth: number, col: number, ti: number, parent?: Tree<R, S>) => {
    out.push({ node, depth, col, ti, parent });
    for (const k of node.kids) go(k, depth + 1, col + 1, ti, node);
  };
  f.trees.forEach((t, ti) => go(t, 0, colOf(t), ti));
  return out;
}

/**
 * The panes of each column, top to bottom: in the order the reader has put them in (by rank), then
 * those never placed by hand, in tree order (tree by tree, depth first, earlier forks first).
 */
export function columns<R, S>(f: Forest<R, S>): Map<number, Placed<R, S>[]> {
  const out = new Map<number, Placed<R, S>[]>();
  for (const x of all(f)) {
    const c = out.get(x.col);
    if (c) c.push(x);
    else out.set(x.col, [x]);
  }
  for (const c of out.values()) {
    const at = new Map(c.map((x, i) => [x, i]));
    c.sort((a, b) => (a.node.rank ?? Infinity) - (b.node.rank ?? Infinity) || at.get(a)! - at.get(b)!);
  }
  return out;
}

/** Move a pane within its column, to just above another pane there (or to the bottom): the column's order is then set by hand. */
export function reorder<R, S>(f: Forest<R, S>, id: number, before: number | null): Forest<R, S> {
  const me = all(f).find((x) => x.node.id === id);
  if (!me || id === before) return f;
  const col = columns(f).get(me.col)!.map((x) => x.node.id);
  const rest = col.filter((x) => x !== id);
  const at = before === null ? rest.length : rest.indexOf(before);
  if (at < 0) return f;
  rest.splice(at, 0, id);
  if (rest.every((x, i) => x === col[i]) && col.every((x) => (all(f).find((y) => y.node.id === x)!.node.rank ?? -1) >= 0)) return f;
  return rest.reduce((g, x, i) => updateIn(g, x, (n) => (n.rank === i ? n : { ...n, rank: i })), f);
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

/** Change the node with this id, in whichever tree it is. */
export function updateIn<R, S>(f: Forest<R, S>, id: number, fn: (n: Tree<R, S>) => Tree<R, S>): Forest<R, S> {
  const hit = find(f, id);
  if (!hit) return f;
  const t = update(f.trees[hit.ti], id, fn);
  return t === f.trees[hit.ti] ? f : { ...f, trees: f.trees.map((x, j) => (j === hit.ti ? t : x)) };
}

/** Make the node with this id lie on its tree's focused branch (its own picks below it kept). */
export function select<R, S>(t: Tree<R, S>, id: number): Tree<R, S> | null {
  if (t.id === id) return t;
  for (let k = 0; k < t.kids.length; k++) {
    const s = select(t.kids[k], id);
    if (s) return s === t.kids[k] && k === t.pick ? t : { ...t, kids: t.kids.map((c, j) => (j === k ? s : c)), pick: k };
  }
  return null;
}

/** Make the pane with this id lie on the focused branch: its tree focused, and picked down to it. */
export function focus<R, S>(f: Forest<R, S>, id: number): Forest<R, S> {
  const hit = find(f, id);
  if (!hit) return f;
  const t = select(f.trees[hit.ti], id)!;
  if (t === f.trees[hit.ti] && hit.ti === f.at) return f;
  return { ...f, trees: t === f.trees[hit.ti] ? f.trees : f.trees.map((x, j) => (j === hit.ti ? t : x)), at: hit.ti };
}

/**
 * What stays open when a pane closes: the pinned panes inside it (topmost first, each with what it
 * opened), as orphans in the columns they were in. `self`: whether the pane itself may stay.
 */
function survivors<R, S>(n: Tree<R, S>, col: number, self: boolean): Tree<R, S>[] {
  if (self && n.pinned) return [{ ...n, col }];
  return n.kids.flatMap((k) => survivors(k, col + 1, true));
}

/** Put a tree in place of tree ti (null removes it), with orphans right after it. The focused tree stays focused. */
function replace<R, S>(f: Forest<R, S>, ti: number, t: Tree<R, S> | null, orphans: Tree<R, S>[]): Forest<R, S> {
  if (t === f.trees[ti] && !orphans.length) return f;
  const trees = [...f.trees.slice(0, ti), ...(t ? [t] : []), ...orphans, ...f.trees.slice(ti + 1)];
  const was = f.trees[f.at];
  const at = trees.indexOf(was);
  return { ...f, trees, at: at >= 0 ? at : Math.min(ti, trees.length - 1) };
}

/** Remove a child of a node, picking the one that takes its place (the one below, else the one above). */
function dropKid<R, S>(n: Tree<R, S>, k: number): Tree<R, S> {
  const kids = n.kids.filter((_, j) => j !== k);
  const pick = k < n.pick ? n.pick - 1 : Math.max(0, Math.min(n.pick, kids.length - 1));
  return { ...n, kids, pick };
}

/**
 * Open something to the right of pane i of the focused branch. If it is already open there (as any
 * of the forks) that fork is picked and kept as it is. Otherwise a fork adds a child below the
 * others; a plain open replaces the picked child (and everything right of it), or adds the first.
 * A pinned child is never replaced: a plain open beside it is a fork. Pinned panes in what is
 * replaced stay, as orphans.
 */
export function open<R, S>(f: Forest<R, S>, i: number, ref: R, fork: boolean, same: Same<R>): Forest<R, S> {
  const t = focused(f);
  if (!t) return plain([ref]);
  const orphans: Tree<R, S>[] = [];
  const hues = palette(f);
  const next = at(t, i, (n) => {
    const k = n.kids.findIndex((c) => same(c.ref, ref));
    if (k >= 0) return k === n.pick ? n : { ...n, pick: k };
    // The first child goes on in its parent's colour; another starts the next one.
    if (!n.kids.length) return { ...n, kids: [tint(leaf<R, S>(ref), n.hue)], pick: 0 };
    if (fork || n.kids[n.pick].pinned) return { ...n, kids: [...n.kids, tint(leaf<R, S>(ref), hues.next(n.hue))], pick: n.kids.length };
    const was = n.kids[n.pick];
    orphans.push(...survivors(was, colOf(t) + i + 1, true));
    const kids = n.kids.slice();
    // In its place, in its column and its colour too.
    const put = tint(leaf<R, S>(ref), was.hue);
    kids[n.pick] = was.rank === undefined ? put : { ...put, rank: was.rank };
    return { ...n, kids };
  });
  return hues.done(replace(f, f.at, next, orphans));
}

/**
 * Close a pane and everything opened from it, except pinned panes, which stay where they are as
 * orphans (with what they opened). The first tree's root never closes. `active` is the pane the keys
 * act on; returned is the forest, with the active pane on its focused branch, and that pane: the
 * same one if it is still open, else the closed pane's parent, else (for an orphan's root) the
 * nearest pane of the tree before it.
 */
export function close<R, S>(f: Forest<R, S>, id: number, active: number): { forest: Forest<R, S>; active: number } {
  const hit = find(f, id);
  if (!hit || (hit.ti === 0 && hit.path.length === 1 && !f.trees[0].col)) return { forest: f, active };
  const t = f.trees[hit.ti];
  const node = hit.path[hit.path.length - 1];
  const col = colOf(t) + hit.path.length - 1;
  const orphans = survivors(node, col, false);
  let g: Forest<R, S>;
  let fallback: number;
  if (hit.path.length === 1) {
    g = replace(f, hit.ti, null, orphans);
    const before = g.trees[Math.max(0, hit.ti - 1)];
    const p = path(before);
    fallback = p[Math.max(0, Math.min(p.length - 1, col - 1 - colOf(before)))].id;
  } else {
    const parent = hit.path[hit.path.length - 2];
    g = replace(f, hit.ti, update(t, parent.id, (n) => dropKid(n, n.kids.indexOf(node))), orphans);
    fallback = parent.id;
  }
  const still = find(g, active) ? active : fallback;
  return { forest: focus(g, still), active: still };
}

/** Pin or unpin a pane. */
export const pin = <R, S>(f: Forest<R, S>, id: number, on: boolean): Forest<R, S> => updateIn(f, id, (n) => (!!n.pinned === on ? n : { ...n, pinned: on || undefined }));

/** The pane above (−1) or below (+1) this one in its column, or null at the top or bottom. */
export function besideInColumn<R, S>(f: Forest<R, S>, id: number, delta: number): number | null {
  for (const col of columns(f).values()) {
    const i = col.findIndex((x) => x.node.id === id);
    if (i >= 0) return col[i + delta]?.node.id ?? null;
  }
  return null;
}

/** Drop every pane whose ref fails `keep` (with everything right of it but pinned panes, which stay as orphans). Unchanged forests are returned as they are. */
export function prune<R, S>(f: Forest<R, S>, keep: (r: R) => boolean): Forest<R, S> {
  const go = (t: Tree<R, S>, col: number, out: Tree<R, S>[]): Tree<R, S> | null => {
    if (!keep(t.ref)) {
      for (const s of survivors(t, col, false)) {
        const p = go(s, s.col!, out);
        if (p) out.push(p);
      }
      return null;
    }
    let changed = false;
    // The picked child, or the one that takes its place: as many kept children before it.
    let pick = 0;
    const kids: Tree<R, S>[] = [];
    t.kids.forEach((k, j) => {
      const p = go(k, col + 1, out);
      if (p !== k) changed = true;
      if (p) kids.push(p);
      if (j === t.pick) pick = kids.length - (p ? 1 : 0);
    });
    if (!changed) return t;
    return { ...t, kids, pick: Math.max(0, Math.min(pick, kids.length - 1)) };
  };
  let g = f;
  for (let ti = f.trees.length - 1; ti >= 0; ti--) {
    const t = f.trees[ti];
    const out: Tree<R, S>[] = [];
    const p = go(t, colOf(t), out);
    if (p !== t || out.length) g = replace(g, g.trees.indexOf(t), p, out);
  }
  return g;
}

/** Whether the first tree is the one starting at this ref (not missing, not an orphan). */
export const rooted = <R, S>(f: Forest<R, S>, ref: R, same: Same<R>) => !!f.trees[0] && !f.trees[0].col && same(f.trees[0].ref, ref);

/**
 * Make the focused branch the first tree's path along this list of refs, keeping every pane that is
 * already on the way: where a ref is already a child it is picked; where it is not, the picked child
 * is replaced by the rest of the list (a pinned one is kept beside it). Panes right of the list's
 * end close, but pinned ones. A different root starts again. Orphans stay; pinned panes in what
 * closes become orphans.
 */
export function withBranch<R, S>(f: Forest<R, S>, refs: R[], same: Same<R>): Forest<R, S> {
  if (!refs.length) return f;
  const orphans: Tree<R, S>[] = [];
  if (!rooted(f, refs[0], same)) {
    const old = f.trees[0] && !f.trees[0].col ? f.trees[0] : null;
    if (old) orphans.push(...survivors(old, 0, false));
    const rest = old ? f.trees.slice(1) : f.trees;
    return { ...f, trees: [chain<R, S>(refs)!, ...orphans, ...rest], at: 0 };
  }
  const hues = palette(f);
  const go = (n: Tree<R, S>, i: number): Tree<R, S> => {
    if (i === refs.length) {
      const kept = n.kids.filter((k) => k.pinned);
      if (kept.length === n.kids.length) return n;
      for (const k of n.kids) if (!k.pinned) orphans.push(...survivors(k, i, true));
      return { ...n, kids: kept, pick: 0 };
    }
    const k = n.kids.findIndex((c) => same(c.ref, refs[i]));
    if (k < 0) {
      const rest = chain<R, S>(refs.slice(i))!;
      if (!n.kids.length) return { ...n, kids: [tint(rest, n.hue)], pick: 0 };
      if (n.kids[n.pick].pinned) return { ...n, kids: [...n.kids, tint(rest, hues.next(n.hue))], pick: n.kids.length };
      orphans.push(...survivors(n.kids[n.pick], i, true));
      return { ...n, kids: n.kids.map((c, j) => (j === n.pick ? tint(rest, c.hue) : c)) };
    }
    const sub = go(n.kids[k], i + 1);
    return sub === n.kids[k] && k === n.pick ? n : { ...n, kids: n.kids.map((c, j) => (j === k ? sub : c)), pick: k };
  };
  const t = go(f.trees[0], 1);
  const g = hues.done(replace(f, 0, t, orphans));
  return g.at === 0 ? g : { ...g, at: 0 };
}

/** As stored: refs (made storable by the caller), children, picks, pins, an orphan's column, places and colours; no ids, nothing remembered. */
export interface Saved<R> {
  ref: R;
  kids?: Saved<R>[];
  pick?: number;
  pin?: 1;
  col?: number;
  rank?: number;
  hue?: number;
}

export function save<R, S, O>(t: Tree<R, S>, ref: (r: R) => O): Saved<O> {
  const out: Saved<O> = { ref: ref(t.ref) };
  if (t.kids.length) out.kids = t.kids.map((k) => save(k, ref));
  if (t.pick) out.pick = t.pick;
  if (t.pinned) out.pin = 1;
  if (t.col) out.col = t.col;
  if (t.rank !== undefined) out.rank = t.rank;
  if (t.hue !== undefined) out.hue = t.hue;
  return out;
}

/** Read a stored tree back, dropping whatever does not pass `ok` (and is not shaped like a tree). */
export function load<R, S>(o: unknown, ok: (r: unknown) => r is R): Tree<R, S> | null {
  if (!o || typeof o !== "object" || !ok((o as Saved<unknown>).ref)) return null;
  const s = o as Saved<unknown>;
  const kids = (Array.isArray(s.kids) ? s.kids : []).map((k) => load<R, S>(k, ok)).filter((k): k is Tree<R, S> => !!k);
  const pick = Math.max(0, Math.min(typeof s.pick === "number" ? Math.floor(s.pick) : 0, kids.length - 1));
  const t: Tree<R, S> = { ref: s.ref as R, kids, pick, id: ++ids };
  if (s.pin) t.pinned = true;
  if (typeof s.col === "number" && s.col >= 1) t.col = Math.floor(s.col);
  if (typeof s.rank === "number" && Number.isFinite(s.rank)) t.rank = s.rank;
  if (typeof s.hue === "number" && Number.isInteger(s.hue) && s.hue >= 0 && s.hue < HUES) t.hue = s.hue;
  return t;
}

/**
 * What was stored: the forest; from before orphans, one tree; from before forks, the trail as a
 * tree with one branch. An orphan stored first (its tree's root gone) is dropped. Stored from
 * before colours (no count of them), the panes are coloured as if opened in tree order.
 */
export function restore<R, S>(saved: { forest?: unknown; at?: unknown; forks?: unknown; trail?: unknown[]; hues?: unknown }, ok: (r: unknown) => r is R): Forest<R, S> {
  let f: Forest<R, S>;
  if (Array.isArray(saved.forest)) {
    const trees = saved.forest.map((o) => load<R, S>(o, ok)).filter((t): t is Tree<R, S> => !!t);
    const first = trees.findIndex((t) => !t.col);
    const kept = first < 0 ? trees.filter((t) => t.col) : [trees[first], ...trees.filter((t, j) => j !== first && t.col)];
    const at = typeof saved.at === "number" ? Math.floor(saved.at) : 0;
    f = { trees: kept, at: at >= 0 && at < kept.length ? at : 0 };
  } else {
    const t = saved.forks ? load<R, S>(saved.forks, ok) : chain<R, S>((saved.trail ?? []).filter(ok));
    f = { trees: t ? [t] : [], at: 0 };
  }
  if (typeof saved.hues === "number" && Number.isInteger(saved.hues) && saved.hues >= 0) return { ...f, hues: saved.hues };
  const hues = palette(f);
  const paint = (t: Tree<R, S>, hue: number | undefined): Tree<R, S> => {
    const kids = t.kids.map((k, j) => paint(k, j === 0 ? hue : hues.next(hue)));
    return hue === undefined ? { ...t, kids } : { ...t, kids, hue };
  };
  return hues.done({ ...f, trees: f.trees.map((t) => paint(t, t.col ? hues.next() : undefined)) });
}

/** Whether a forest is well formed: picks in range, colours in the palette, no pane twice among siblings, ids unique, orphans in a column right of the first, the focused tree there. */
export function valid<R, S>(f: Forest<R, S>, same: Same<R>): boolean {
  const seen = new Set<number>();
  const ok = (n: Tree<R, S>): boolean => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    if (n.pick < 0 || n.pick >= Math.max(1, n.kids.length) || !Number.isInteger(n.pick)) return false;
    if (n.hue !== undefined && !(Number.isInteger(n.hue) && n.hue >= 0 && n.hue < HUES)) return false;
    for (let a = 0; a < n.kids.length; a++) for (let b = a + 1; b < n.kids.length; b++) if (same(n.kids[a].ref, n.kids[b].ref)) return false;
    return n.kids.every((k) => k.col === undefined && ok(k));
  };
  if (!f.trees.length) return f.at === 0;
  if (f.at < 0 || f.at >= f.trees.length) return false;
  return f.trees.every((t, ti) => (ti === 0 ? !t.col : (t.col ?? 0) >= 1) && ok(t));
}
