/**
 * Lanes for the panes view's curves (Panes.tsx): where several curves run down one gutter, each gets
 * a lane of its own, side by side like a ribbon cable, in the order that crosses least.
 */

/** Lanes in a gutter: vertical runs this far apart, from just inside the column's edge to just short of its titles. */
export const LANE_PITCH = 4;
export const LANE_FIRST = 5;
export const LANE_LAST = 29;
export const LANES = Math.floor((LANE_LAST - LANE_FIRST) / LANE_PITCH) + 1;
/** Up to this many curves in a gutter, every order is tried (720 at most). */
const EVERY = 6;
/** Up to this many curves in a gutter, every lane is tried for each; past it, only the neighbouring lanes. */
const MOVES = 8;

/**
 * How many times curves in one gutter cross, for an order of lanes (rightmost first): a lead-out
 * comes in from the left at its source's height, crossing the lanes left of its own still running
 * there; an arrival goes right at its title's height, crossing the lanes right of its own.
 */
export function crossings(order: { sy: number; ey: number }[]): number {
  const runs = (c: { sy: number; ey: number }, y: number) => y > Math.min(c.sy, c.ey) && y < Math.max(c.sy, c.ey);
  let n = 0;
  for (let i = 0; i < order.length; i++)
    for (let j = i + 1; j < order.length; j++) {
      // order[i] is right of order[j].
      if (runs(order[j], order[i].sy)) n++;
      if (runs(order[i], order[j].ey)) n++;
    }
  return n;
}

/**
 * The order of a gutter's lanes, rightmost first, so that curves cross as little as they can: the
 * curve with the shortest way to go takes the lane nearest the panes, and the rest outwards. Starting from the order last used, with new curves put
 * where that rule puts them, a curve is moved to another lane only while that removes crossings, so a
 * scroll or an open elsewhere does not reshuffle the bundle.
 */
export function laneOrder<T extends { key: string; sy: number; ey: number }>(edges: T[], last: string[] = []): T[] {
  const rule = [...edges].sort((a, b) => Math.abs(a.ey - a.sy) - Math.abs(b.ey - b.sy));
  const byKey = new Map(edges.map((e) => [e.key, e]));
  const order = last.flatMap((k) => byKey.get(k) ?? []);
  for (const e of rule) {
    if (order.includes(e)) continue;
    const r = rule.indexOf(e);
    const at = order.findIndex((o) => rule.indexOf(o) > r);
    order.splice(at < 0 ? order.length : at, 0, e);
  }
  let best = crossings(order);
  // A few curves: the order that crosses least, of all of them. Moving one curve at a time can stop
  // short of it (two moves that each add a crossing may together remove two). Only a strictly better
  // order replaces the one there, so the bundle keeps its order while no order crosses less.
  if (order.length <= EVERY) {
    if (!best) return order;
    let pick = order.slice();
    const go = (left: T[], done: T[]) => {
      if (!best) return;
      if (!left.length) {
        const n = crossings(done);
        if (n < best) (best = n), (pick = done.slice());
        return;
      }
      for (let i = 0; i < left.length; i++) go([...left.slice(0, i), ...left.slice(i + 1)], [...done, left[i]]);
    };
    go(order, []);
    return pick;
  }
  // More: move one curve to another lane while that removes crossings, every place tried for up to
  // MOVES curves and only neighbours swapped past that, which stays cheap enough for every frame.
  const far = order.length <= MOVES;
  for (let pass = 0, better = best > 0; better && pass < order.length; pass++) {
    better = false;
    for (let i = 0; i < order.length && best; i++)
      for (let j = far ? 0 : i + 1; j < (far ? order.length : Math.min(order.length, i + 2)); j++) {
        if (j === i) continue;
        const moved = order.slice();
        moved.splice(j, 0, ...moved.splice(i, 1));
        const n = crossings(moved);
        if (n < best) {
          order.splice(0, order.length, ...moved);
          best = n;
          better = true;
        }
      }
  }
  return order;
}

