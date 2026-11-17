/**
 * Stacking, after Andy Matuschak's notes, along either axis of the panes view (Panes.tsx). Items
 * stand side by side in a scrolling box, each stuck (position: sticky) a strip's width after the one
 * before, so that a later item slides over an earlier one and leaves it a strip: across the strip,
 * the columns, leaving spines; down a crowded column, its panes, leaving tabs. A pinned item leaves
 * its whole size instead, so nothing after it covers it. How far each item is covered sets its
 * state: overlapped (a shadow edge on the item over it), covered (only its strip is worth showing),
 * and the box scrolls as little as it can to show the item looked at whole.
 *
 * This module is that model and its computation, for both axes; Panes.tsx sizes the items (a
 * column is a pane's width; a pane in a crowded column, what its text needs up to the column's
 * height less a tab for each other pane) and applies what comes back.
 */

export interface Axis {
  /** The sticky inset, and the start and end of a box along the axis. */
  start: "left" | "top";
  end: "right" | "bottom";
  size: "offsetWidth" | "offsetHeight";
  client: "clientWidth" | "clientHeight";
  scroll: "scrollLeft" | "scrollTop";
  scrollSize: "scrollWidth" | "scrollHeight";
}
/** Across: the columns of the strip. */
export const ACROSS: Axis = { start: "left", end: "right", size: "offsetWidth", client: "clientWidth", scroll: "scrollLeft", scrollSize: "scrollWidth" };
/** Down: the panes of a crowded column. */
export const DOWN: Axis = { start: "top", end: "bottom", size: "offsetHeight", client: "clientHeight", scroll: "scrollTop", scrollSize: "scrollHeight" };

/** An item covered to less than this share of its size shows only its strip (spine or tab). */
export const COVERED = 0.4;

/**
 * Each item's sticky offset: every item before it leaves its strip, a pinned one its whole size;
 * never so far that the items after it could not all still be scrolled to.
 */
export function offsets(sizes: number[], pinned: boolean[], strip: number, view: number): number[] {
  const n = sizes.length;
  let at = 0;
  return sizes.map((s, i) => {
    const o = Math.round(Math.min(at, Math.max(i * strip, view - s - (n - 1 - i) * strip)));
    at += pinned[i] ? s : strip;
    return o;
  });
}

/**
 * Heights for the panes of one column of height h, from what each needs to show all it holds:
 * each gets that, or an equal share of what is left, whichever is less; what no pane needs goes to
 * the one that needs most. So short panes are no taller than their text, and long ones share the rest.
 */
export function fill(h: number, needs: number[]): number[] {
  const out = needs.map(() => 0);
  const order = needs.map((_, i) => i).sort((a, b) => needs[a] - needs[b]);
  let rest = h;
  order.forEach((i, k) => {
    const share = rest / (order.length - k);
    out[i] = Math.floor(k === order.length - 1 ? rest : Math.min(needs[i], share));
    rest -= out[i];
  });
  return out;
}

/**
 * Whether a column of height h stacks its panes (each folding to a tab but the one looked at)
 * rather than sharing its height among them: when they do not all fit at their least (`least`
 * each, or less where a pane needs less); and, given `here`, the pane looked at (as pages, on a
 * phone), also whenever sharing would leave that pane shorter than what it needs, so it gets the
 * column's height and the others fold.
 */
export function crowds(h: number, needs: number[], least: number, here?: number): boolean {
  if (needs.reduce((s, x) => s + Math.min(x, least), 0) > h) return true;
  return here !== undefined && needs.length > 1 && fill(h, needs)[here] < needs[here] - 1;
}

/** Where each item begins when nothing is stuck: one after another. */
export const starts = (sizes: number[]) => sizes.map((_, i) => sizes.slice(0, i).reduce((a, b) => a + b, 0));

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Sizes from edges (each item's start, then the end of the last), each edge rounded to a whole pixel: an item at least `min` before stays so after. */
const fromEdges = (e: number[]) => e.slice(1).map((x, k) => Math.round(x) - Math.round(e[k]));

/**
 * As pages, a column sized by hand: the heights of its panes, top to bottom, filling the column,
 * each at least `min` (a tab; a pane that height is folded). Dragging a pane's handle moves its top
 * edge, the edge it shares with the pane above, to where it was when the drag began plus dy, as far
 * as the panes can give: moved up, the pane above gives, and once that is a tab the one above it,
 * pushed up as a tab, and so on; moved down, the dragged pane gives, then the ones below it. The
 * pane on the other side of the edge takes what is given (a tab there opens). Always from the sizes
 * the drag began with, so moving back gives back what was pushed. The first pane's top is the
 * column's: it has no edge to move.
 */
export function resize(start: number[], i: number, dy: number, min: number): number[] {
  const n = start.length;
  if (i <= 0 || i >= n) return start.slice();
  const total = sum(start);
  const e = [...starts(start), total];
  e[i] = Math.max(i * min, Math.min(total - (n - i) * min, e[i] + dy));
  for (let k = i - 1; k >= 1; k--) e[k] = Math.min(e[k], e[k + 1] - min);
  for (let k = i + 1; k < n; k++) e[k] = Math.max(e[k], e[k - 1] + min);
  return e.slice(1).map((x, k) => x - e[k]);
}

/**
 * Where a drag of pane i's edge by dy comes to rest when the finger lifts: as `resize`, except that
 * a pane on either side of the edge left less than `snap` taller than a tab folds to its tab (the
 * pane across the edge taking the rest), the shorter of the two if both are; in whole pixels.
 */
export function release(start: number[], i: number, dy: number, min: number, snap: number): number[] {
  const h = resize(start, i, dy, min);
  if (i <= 0 || i >= h.length) return fromEdges([...starts(h), sum(h)]);
  const below = h[i] - min;
  const above = h[i - 1] - min;
  const foldBelow = below > 0.5 && below < snap;
  const foldAbove = above > 0.5 && above < snap;
  const d = foldBelow && (!foldAbove || below <= above) ? dy + below : foldAbove ? dy - above : dy;
  const out = resize(start, i, d, min);
  return fromEdges([...starts(out), sum(out)]);
}

/**
 * Sizes made to fill a column of height h, each at least `min`: what each has beyond a tab is
 * scaled to what the column has beyond a tab each (a folded pane stays folded); null if the column
 * cannot hold a tab for every pane. For sizes measured off the screen, and for a column whose
 * height changed (the window, an on-screen keyboard).
 */
export function fit(sizes: number[], h: number, min: number): number[] | null {
  const n = sizes.length;
  if (!n || n * min > h) return null;
  if (Math.abs(sum(sizes) - h) < 0.5 && sizes.every((s) => s >= min)) return sizes.slice();
  const extra = sizes.map((s) => Math.max(0, s - min));
  const ex = sum(extra);
  const room = h - n * min;
  const out = ex > 0 ? extra.map((x) => min + (x * room) / ex) : sizes.map((_, k) => min + (k === n - 1 ? room : 0));
  return fromEdges([...starts(out), h]);
}

/** Whether a pane of this height, sized by hand, is folded to its tab. */
export const folded = (size: number, min: number) => size <= min + 1;

/**
 * How covered each item is, from where each begins on screen now, its size and where the box ends:
 * an item shows up to where the next begins (or the box's end); overlapped when any of it is
 * hidden, covered when less than COVERED of it shows, buried when no more than its strip does (what
 * is under the strip need not be painted).
 */
export function coverage(at: number[], sizes: number[], end: number, strip = 0): { over: boolean[]; covered: boolean[]; buried: boolean[] } {
  const shown = at.map((a, i) => Math.max(0, Math.min(at[i + 1] ?? Infinity, end) - a));
  return { over: shown.map((s, i) => s < sizes[i] - 1), covered: shown.map((s, i) => s < sizes[i] * COVERED), buried: shown.map((s) => s <= strip + 2) };
}

/**
 * The scroll, as near the present one as it can be, that shows an item whole: its far edge inside
 * the box, and itself not yet stuck under the items before it.
 */
export function reveal(scroll: number, view: number, start: number, size: number, stuck: number, max: number): number {
  return Math.max(0, Math.min(max, Math.min(Math.max(scroll, start + size - view), start - stuck)));
}

/** Whether an item is shown whole at this scroll. */
export const whole = (scroll: number, view: number, start: number, size: number, stuck: number) => scroll >= start + size - view - 1 && scroll <= start - stuck + 1;

const setAttr = (el: Element | undefined, name: string, on: boolean) => {
  if (el && el.hasAttribute(name) !== on) on ? el.setAttribute(name, "") : el.removeAttribute(name);
};

/** Stick a box's items at their offsets. */
export function stick(items: HTMLElement[], offs: number[], axis: Axis) {
  items.forEach((el, i) => {
    const v = `${offs[i]}px`;
    if (el.style[axis.start] !== v) el.style[axis.start] = v;
  });
}

/** Clear the marks of items no longer stacked. */
export function unmark(items: Element[]) {
  for (const el of items) {
    setAttr(el, "data-covered", false);
    setAttr(el, "data-over", false);
    setAttr(el, "data-buried", false);
  }
}

/** Mark a box's items with how covered they are now (data-over, data-covered); `edge`: whether the box's far edge covers too (down a column it does; across, a column beyond the window is simply further on). */
export function mark(box: HTMLElement, items: HTMLElement[], axis: Axis, edge: boolean, strip: number) {
  if (!items.length) return;
  const at = items.map((el) => el.getBoundingClientRect()[axis.start]);
  const { over, covered, buried } = coverage(
    at,
    items.map((el) => el[axis.size]),
    edge ? box.getBoundingClientRect()[axis.start] + box[axis.client] : Infinity,
    strip,
  );
  items.forEach((el, i) => {
    setAttr(el, "data-covered", covered[i]);
    setAttr(el, "data-buried", buried[i]);
    // The shadow edge is drawn by the item over an overlapped one.
    setAttr(items[i + 1], "data-over", over[i] && i + 1 < items.length);
  });
}
