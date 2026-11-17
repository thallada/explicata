/**
 * The pages layout: the panes view on a phone, and on any window narrower than PANES_MIN_WIDTH
 * while the view is `auto`. The forest of forks is the same (forks.ts); what changes is how it is
 * shown and moved through. Each column of the panes view is one page, as wide as the screen, with
 * its panes stacked down it exactly as on a wide screen (tabs, the sticky tab, pins); the pages lie
 * side by side and are swiped like pages, and the page on screen is always the active pane's
 * column. A trail at the foot names the focused branch, pane by pane, in its colours; a map lists
 * every open pane.
 *
 * The pure parts are here: which pane a page brings forward when it is swiped to, how a pane is
 * named in the browser's history (so Back, the button or the edge swipe, goes back a pane), the
 * steps of that history, and the tree lines the map draws.
 */
import type { Forest, Placed, Tree } from "./forks";

/** Which page a scroll offset rests on: the nearest, among `count`. */
export function pageAt(scrollLeft: number, width: number, count: number): number {
  if (count <= 0 || width <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(scrollLeft / width)));
}

/**
 * The pane a page brings forward when it is swiped to: the one on the focused branch, else the one
 * last on it there (`last`), else the first; undefined for an empty page.
 */
export function paneOfPage(ids: number[], onBranch: Set<number>, last?: number): number | undefined {
  return ids.find((id) => onBranch.has(id)) ?? (last !== undefined && ids.includes(last) ? last : ids[0]);
}

/**
 * A pane's name in the browser's history: what each pane on the way to it from its tree's root
 * shows (siblings never show the same thing, so the path names one pane). Unlike the pane's id it
 * survives a reload.
 */
export function paneKey<R, S>(path: Tree<R, S>[], key: (r: R) => string): string {
  return JSON.stringify(path.map((n) => key(n.ref)));
}

/** The pane a history key names, in whichever tree it is, or null if it has closed. */
export function findKey<R, S>(f: Forest<R, S>, k: string, key: (r: R) => string): number | null {
  let want: unknown;
  try {
    want = JSON.parse(k);
  } catch {
    return null;
  }
  if (!Array.isArray(want) || !want.length || !want.every((x) => typeof x === "string")) return null;
  for (const t of f.trees) {
    let n: Tree<R, S> | undefined = key(t.ref) === want[0] ? t : undefined;
    for (let i = 1; n && i < want.length; i++) n = n.kids.find((c) => key(c.ref) === want[i]);
    if (n) return n.id;
  }
  return null;
}

/**
 * The entries of the browser's history this tab made in the pages layout, as far as the page
 * knows them: a key per entry, and which one the browser is on.
 */
export interface Visits {
  keys: string[];
  i: number;
}

/**
 * The step the history takes when the active pane becomes the one named `key`: none if it is the
 * entry the browser is on; back or forward if it is the entry just before or after (a swipe back
 * to the pane a link was followed from is Back, so the browser's Back and Forward stay true);
 * otherwise a new entry, which drops whatever was ahead.
 */
export function visit(v: Visits, key: string): { step: "same" | "back" | "forward" | "push"; visits: Visits } {
  if (v.keys[v.i] === key) return { step: "same", visits: v };
  if (v.i > 0 && v.keys[v.i - 1] === key) return { step: "back", visits: { keys: v.keys, i: v.i - 1 } };
  if (v.i + 1 < v.keys.length && v.keys[v.i + 1] === key) return { step: "forward", visits: { keys: v.keys, i: v.i + 1 } };
  return { step: "push", visits: { keys: [...v.keys.slice(0, v.i + 1), key], i: v.i + 1 } };
}

/**
 * Where the browser has gone by its own Back or Forward (a popstate), to an entry that says it is
 * entry `i` named `key`: the visits as they now stand. An entry the page does not know as such (from
 * before a reload that lost them, or made elsewhere) starts them again from it.
 */
export function arrived(v: Visits, key: string, i: number): Visits {
  if (Number.isInteger(i) && i >= 0 && v.keys[i] === key) return { keys: v.keys, i };
  return { keys: [key], i: 0 };
}

/** The visits read back from storage, if they are well formed. */
export function loadVisits(o: unknown): Visits | null {
  const v = o as Visits | null;
  if (!v || typeof v !== "object" || !Array.isArray(v.keys) || !v.keys.every((k) => typeof k === "string") || !Number.isInteger(v.i) || v.i < 0 || v.i >= v.keys.length) return null;
  // Kept short: what lies far back is reached by the browser's own history anyway.
  return v.keys.length > 200 ? { keys: v.keys.slice(-200), i: Math.max(0, v.i - (v.keys.length - 200)) } : v;
}

/**
 * One stroke of the map's tree lines, in a row of the map, at a level (a column of the panes view,
 * which is how far the row is indented): `dash`, a root's mark (no line into it: the first pane, or
 * an orphan, whose source closed); `elbow`, from the row's top down its parent's line and across
 * into its own mark; `on`, its parent's line going on from the elbow to the row's foot, toward a
 * later sibling; `pass`, an ancestor's line running through the whole row to a later child of that
 * ancestor; `down`, the row's own line leaving under its mark for its first child. Each is drawn in
 * the colour of the pane it leads to (`tid`): a line into a child is the child's branch colour.
 */
export interface Rail {
  kind: "dash" | "elbow" | "on" | "pass" | "down";
  level: number;
  tid: number;
}

/** The map's tree lines, row by row, for every pane in the map's order (forks.ts `all`: tree by tree, depth first). */
export function rails<R, S>(placed: Placed<R, S>[]): Rail[][] {
  const at = new Map(placed.map((x) => [x.node.id, x]));
  const next = (x: Placed<R, S>) => {
    const sibs = x.parent?.kids ?? [];
    const j = sibs.findIndex((k) => k.id === x.node.id);
    return j >= 0 ? sibs[j + 1] : undefined;
  };
  return placed.map((x) => {
    const out: Rail[] = [];
    const parent = x.parent && at.get(x.parent.id);
    if (parent) {
      out.push({ kind: "elbow", level: parent.col, tid: x.node.id });
      const s = next(x);
      if (s) out.push({ kind: "on", level: parent.col, tid: s.id });
    } else out.push({ kind: "dash", level: x.col, tid: x.node.id });
    if (x.node.kids.length) out.push({ kind: "down", level: x.col, tid: x.node.kids[0].id });
    for (let c = parent; c?.parent; c = at.get(c.parent.id)) {
      const s = next(c);
      const p = at.get(c.parent.id);
      if (s && p) out.push({ kind: "pass", level: p.col, tid: s.id });
    }
    return out;
  });
}

/** How far each level of the map is indented, in px: a finger's width at most, less in a deep forest so its deepest rows keep room for their titles. */
export const mapStep = (deepest: number) => Math.min(16, Math.max(8, Math.floor(140 / Math.max(1, deepest))));
