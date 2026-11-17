/** The stacking shared by the panes view's strip and its crowded columns (src/ui/stack.ts). */
import { describe, expect, it } from "vitest";
import { coverage, crowds, fill, fit, folded, offsets, release, resize, reveal, starts, whole } from "../src/ui/stack";

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
  it("as pages, a pane's handle dragged moves its top edge: the pane above takes or gives the difference, a tab pushed along at the limit", () => {
    const T = 44;
    // Two panes: the second's edge follows the drag both ways.
    expect(resize([600, 44], 1, -200, T)).toEqual([400, 244]);
    expect(resize([400, 244], 1, 100, T)).toEqual([500, 144]);
    // Never past a tab either side: the column never overflows.
    expect(resize([600, 44], 1, -1000, T)).toEqual([44, 600]);
    expect(resize([300, 344], 1, 1000, T)).toEqual([600, 44]);
    // A folded tab at the top opens as the edge below it is dragged down.
    expect(resize([44, 556, 44], 1, 150, T)).toEqual([194, 406, 44]);
    // Three panes, the middle open: the last tab dragged up takes from the middle; once that is a tab, the tab is pushed up and the first gives.
    expect(resize([44, 556, 44], 2, -200, T)).toEqual([44, 356, 244]);
    expect(resize([44, 556, 44], 2, -600, T)).toEqual([44, 44, 556]);
    expect(resize([200, 400, 44], 2, -500, T)).toEqual([56, 44, 544]);
    // Dragged down, the dragged pane gives, then those below it.
    expect(resize([200, 300, 144], 1, 350, T)).toEqual([550, 44, 50]);
    expect(resize([200, 300, 144], 1, 1000, T)).toEqual([556, 44, 44]);
    // From the sizes the drag began with: back where it started, what was pushed is given back.
    expect(resize([200, 400, 44], 2, 0, T)).toEqual([200, 400, 44]);
    // The total is kept, and so is every tab, wherever the finger goes.
    for (const dy of [-700, -333.4, -50, 0, 17.6, 260, 700]) {
      const h = resize([120, 300, 44, 180], 2, dy, T);
      expect(h.reduce((a, b) => a + b, 0)).toBeCloseTo(644, 6);
      for (const x of h) expect(x).toBeGreaterThanOrEqual(T - 1e-9);
    }
    // The first pane has no edge above it to move.
    expect(resize([300, 344], 0, 100, T)).toEqual([300, 344]);
  });

  it("as pages, a hand-sized pane left barely taller than its tab folds when the finger lifts; sizes fit a column whose height changed", () => {
    const T = 44;
    // Left 20 px over a tab: it folds, the pane above takes the rest.
    expect(release([600, 44], 1, -20, T, 40)).toEqual([600, 44]);
    expect(release([300, 344], 1, 280, T, 40)).toEqual([600, 44]);
    // The pane above left nearly a tab: it folds instead.
    expect(release([300, 344], 1, -230, T, 40)).toEqual([44, 600]);
    // Well inside: where the finger left it, in whole pixels.
    expect(release([600, 44], 1, -200.4, T, 40)).toEqual([400, 244]);
    expect(release([600, 44], 1, -200.6, T, 40)).toEqual([399, 245]);
    // Both nearly tabs (a short column): the shorter folds.
    expect(release([100, 100], 1, 10, T, 80)).toEqual([156, 44]);
    expect(folded(44, T)).toBe(true);
    expect(folded(45, T)).toBe(true);
    expect(folded(46, T)).toBe(false);
    // Fit: what each has beyond its tab scales; a folded pane stays folded.
    expect(fit([44, 300, 300], 544, T)).toEqual([44, 250, 250]);
    expect(fit([44, 556, 44], 644, T)).toEqual([44, 556, 44]);
    expect(fit([44, 556, 44], 744, T)).toEqual([44, 656, 44]);
    // Measured sizes under a tab come up to one.
    expect(fit([20, 580, 44], 644, T)).toEqual([44, 556, 44]);
    // Whole pixels, filling the column exactly.
    const f = fit([100, 200, 300], 641, T)!;
    expect(f.reduce((a, b) => a + b, 0)).toBe(641);
    for (const x of f) expect(Number.isInteger(x)).toBe(true);
    // Too short for a tab each: none.
    expect(fit([44, 44, 44], 120, T)).toBeNull();
  });
});
