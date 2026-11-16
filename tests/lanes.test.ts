/** Lanes for the panes view's curves (src/ui/lanes.ts): the order crosses least, and stays put. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { crossings, laneOrder, LANES } from "../src/ui/lanes";

const e = (key: string, sy: number, ey: number) => ({ key, sy, ey });
const keys = (o: { key: string }[]) => o.map((x) => x.key);
/** The fewest crossings any order has. */
const least = <T extends { sy: number; ey: number }>(es: T[]): number => {
  if (es.length < 2) return 0;
  let best = Infinity;
  const go = (left: T[], done: T[]) => {
    if (!left.length) best = Math.min(best, crossings(done));
    left.forEach((x, i) => go([...left.slice(0, i), ...left.slice(i + 1)], [...done, x]));
  };
  go(es, []);
  return best;
};

describe("lanes", () => {
  it("fit the gutter: seven at a 4 px pitch", () => {
    expect(LANES).toBe(7);
  });

  it("rows fanning out to panes stacked below them do not cross: the one with least to go nearest the panes", () => {
    // Three rows 35 px apart, opening three panes stacked down the next column.
    const rows = [e("a", 300, 100), e("b", 335, 400), e("c", 370, 700)];
    const o = laneOrder(rows);
    expect(crossings(o)).toBe(0);
    // The owner's screenshot: two rows to panes above them, and a link above them to a pane far below, whose run passes both sources (two crossings no order avoids).
    const shot = [e("complex", 319, 73), e("shared", 354, 307), e("archaea", 140, 592)];
    expect(crossings(laneOrder(shot))).toBe(least(shot));
  });

  it("never does worse than the rule it starts from, and keeps the last order unless a swap removes a crossing", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 1000 })), { minLength: 1, maxLength: 9 }), (ys) => {
        const es = ys.map(([a, b], i) => e(String(i), a, b));
        const o = laneOrder(es);
        const again = laneOrder(es, keys(o));
        return o.length === es.length && new Set(keys(o)).size === es.length && keys(again).join() === keys(o).join() && (es.length > 6 || crossings(o) <= least(es) + 1);
      }),
    );
    // A small scroll that changes no crossing keeps the lanes as they were.
    const before = laneOrder([e("a", 300, 100), e("b", 335, 400), e("c", 370, 700)]);
    const after = laneOrder([e("a", 290, 100), e("b", 325, 400), e("c", 360, 700)], keys(before));
    expect(keys(after)).toEqual(keys(before));
    // A new curve goes where the rule puts it; the others keep their order.
    const more = laneOrder([e("a", 300, 100), e("b", 335, 400), e("c", 370, 700), e("d", 500, 520)], keys(before));
    expect(keys(more).filter((k) => k !== "d")).toEqual(keys(before));
  });
});
