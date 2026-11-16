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

/** Where each item begins when nothing is stuck: one after another. */
export const starts = (sizes: number[]) => sizes.map((_, i) => sizes.slice(0, i).reduce((a, b) => a + b, 0));

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
