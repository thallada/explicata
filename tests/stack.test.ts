/** The stacking shared by the panes view's strip and its crowded columns (src/ui/stack.ts). */
import { describe, expect, it } from "vitest";
import { coverage, crowds, fill, offsets, reveal, starts, whole } from "../src/ui/stack";

describe("stack", () => {
  it("sticks each item a strip after the one before, a pinned one its whole size, never past where the rest can still be reached", () => {
    expect(offsets([700, 700, 700, 700], [false, false, false, false], 40, 1920)).toEqual([0, 40, 80, 120]);
    expect(offsets([700, 700, 700, 700], [false, true, false, false], 40, 1920)).toEqual([0, 40, 740, 780]);
    // Two pinned columns would push the last out of reach: it stays where the window ends.
    expect(offsets([700, 700, 700, 700], [true, true, false, false], 40, 1920).at(-1)).toBe(1920 - 700);
    // Down a column: tabs.
    expect(offsets([300, 500, 400], [false, false, false], 30, 900)).toEqual([0, 30, 60]);
  });

  it("an item is overlapped where the next begins before it ends, and covered when less than 40% of it shows", () => {
    const { over, covered } = coverage([0, 40, 480], [700, 700, 700], Infinity);
    expect(over).toEqual([true, true, false]);
    expect(covered).toEqual([true, false, false]);
    // Down a column the box's foot covers too.
    expect(coverage([0, 300], [300, 600], 600).covered).toEqual([false, false]);
    expect(coverage([0, 500], [300, 600], 600).over).toEqual([false, true]);
  });

  it("scrolls as little as it can to show an item whole", () => {
    const sizes = [700, 700, 700, 700];
    const at = starts(sizes);
    expect(at).toEqual([0, 700, 1400, 2100]);
    // The last column whole: its far edge in view.
    expect(reveal(0, 1920, at[3], 700, 120, 880)).toBe(880);
    // Already whole: no move.
    expect(reveal(500, 1920, at[2], 700, 80, 880)).toBe(500);
    // Column 1 uncovered: not yet stuck under column 0.
    expect(reveal(880, 1920, at[1], 700, 40, 880)).toBe(660);
    expect(whole(660, 1920, at[1], 700, 40)).toBe(true);
    expect(whole(880, 1920, at[1], 700, 40)).toBe(false);
  });

  it("a column's height is shared: short panes take what they need, long ones share the rest", () => {
    expect(fill(700, [200, 1000])).toEqual([200, 500]);
    expect(fill(700, [1000, 1000])).toEqual([350, 350]);
    expect(fill(700, [100, 150])).toEqual([100, 600]);
    expect(fill(700, [300, 2000, 300])).toEqual([233, 234, 233]);
  });

  it("a column stacks when its panes do not fit at their least; as pages, also whenever a share would cut the pane looked at short", () => {
    // Wide screen: shared while they fit at their least, whoever is looked at.
    expect(crowds(850, [1000, 1000], 260)).toBe(false);
    expect(crowds(850, [1000, 1000, 1000], 260)).toBe(false);
    expect(crowds(850, [1000, 1000, 1000, 1000], 260)).toBe(true);
    // As pages: the long pane looked at gets the height.
    expect(crowds(720, [1000, 1000], 260, 0)).toBe(true);
    expect(crowds(720, [1000, 1000], 260, 1)).toBe(true);
    // A short pane looked at, shown whole by the share, leaves the long one beside it.
    expect(crowds(720, [300, 1000], 260, 0)).toBe(false);
    expect(crowds(720, [300, 1000], 260, 1)).toBe(true);
    // Both whole: nothing folds.
    expect(crowds(720, [300, 350], 260, 1)).toBe(false);
    // One pane: nothing to fold.
    expect(crowds(720, [3000], 260, 0)).toBe(false);
  });
});
