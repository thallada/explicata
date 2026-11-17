import { describe, expect, it } from "vitest";
import { close, open, plain, trace, type Forest } from "../src/ui/forks";
import { arrived, findKey, loadVisits, pageAt, paneKey, paneOfPage, visit, type Visits } from "../src/ui/pages";

const same = (a: string, b: string) => a === b;
const k = (r: string) => r;

describe("the pages layout", () => {
  it("rests on the nearest page, within the pages there are", () => {
    expect(pageAt(0, 390, 3)).toBe(0);
    expect(pageAt(194, 390, 3)).toBe(0);
    expect(pageAt(196, 390, 3)).toBe(1);
    expect(pageAt(780, 390, 3)).toBe(2);
    expect(pageAt(5000, 390, 3)).toBe(2);
    expect(pageAt(-40, 390, 3)).toBe(0);
    expect(pageAt(100, 0, 3)).toBe(0);
    expect(pageAt(100, 390, 0)).toBe(0);
  });

  it("a page swiped to brings forward its pane on the focused branch, else the one last there, else the first", () => {
    expect(paneOfPage([4, 5, 6], new Set([1, 5]), 6)).toBe(5);
    expect(paneOfPage([4, 5, 6], new Set([1]), 6)).toBe(6);
    expect(paneOfPage([4, 5, 6], new Set([1]), 9)).toBe(4);
    expect(paneOfPage([4, 5, 6], new Set([1]))).toBe(4);
    expect(paneOfPage([], new Set([1]))).toBeUndefined();
  });

  it("names a pane by what the panes on the way to it show, and finds it again, in any tree; a closed one is not found", () => {
    let f: Forest<string> = plain(["top", "a"]);
    f = open(f, 1, "b", false, same);
    f = open(f, 0, "c", true, same);
    const b = f.trees[0].kids[0].kids[0];
    const c = f.trees[0].kids[1];
    const kb = paneKey(trace(f.trees[0], b.id)!, k);
    const kc = paneKey(trace(f.trees[0], c.id)!, k);
    expect(kb).toBe(JSON.stringify(["top", "a", "b"]));
    expect(findKey(f, kb, k)).toBe(b.id);
    expect(findKey(f, kc, k)).toBe(c.id);
    expect(findKey(f, JSON.stringify(["top"]), k)).toBe(f.trees[0].id);
    expect(findKey(f, JSON.stringify(["top", "x"]), k)).toBeNull();
    expect(findKey(f, "not json", k)).toBeNull();
    expect(findKey(f, JSON.stringify([]), k)).toBeNull();
    expect(findKey(f, JSON.stringify([1, 2]), k)).toBeNull();
    // Closed: gone; and an orphan (pinned, its source closed) is found in its own tree.
    const g = close(f, f.trees[0].kids[0].id, b.id).forest;
    expect(findKey(g, kb, k)).toBeNull();
    let h = plain(["top", "a", "b"]);
    const pb = h.trees[0].kids[0].kids[0];
    h = { ...h, trees: [{ ...h.trees[0], kids: [{ ...h.trees[0].kids[0], kids: [{ ...pb, pinned: true }] }] }] };
    const o = close(h, h.trees[0].kids[0].id, pb.id).forest;
    expect(o.trees).toHaveLength(2);
    expect(findKey(o, JSON.stringify(["b"]), k)).toBe(o.trees[1].id);
  });

  it("steps the history: back to the entry before, forward to the one after, else a new entry that drops what was ahead", () => {
    let v: Visits = { keys: ["A"], i: 0 };
    let r = visit(v, "A");
    expect(r.step).toBe("same");
    expect(r.visits).toBe(v);
    r = visit(v, "B");
    expect(r).toEqual({ step: "push", visits: { keys: ["A", "B"], i: 1 } });
    v = visit(r.visits, "C").visits;
    expect(v).toEqual({ keys: ["A", "B", "C"], i: 2 });
    r = visit(v, "B");
    expect(r).toEqual({ step: "back", visits: { keys: ["A", "B", "C"], i: 1 } });
    r = visit(r.visits, "C");
    expect(r).toEqual({ step: "forward", visits: { keys: ["A", "B", "C"], i: 2 } });
    // Two back is not adjacent: a new entry.
    r = visit({ keys: ["A", "B", "C"], i: 2 }, "A");
    expect(r).toEqual({ step: "push", visits: { keys: ["A", "B", "C", "A"], i: 3 } });
    // From the middle, somewhere new: what was ahead goes.
    r = visit({ keys: ["A", "B", "C"], i: 1 }, "D");
    expect(r).toEqual({ step: "push", visits: { keys: ["A", "B", "D"], i: 2 } });
    // At the first entry, the pane before it is not Back (nothing is known before it).
    expect(visit({ keys: ["A"], i: 0 }, "Z").step).toBe("push");
  });

  it("follows the browser's own Back and Forward, starting again from an entry it does not know", () => {
    const v: Visits = { keys: ["A", "B", "C"], i: 2 };
    expect(arrived(v, "A", 0)).toEqual({ keys: ["A", "B", "C"], i: 0 });
    expect(arrived(v, "B", 1)).toEqual({ keys: ["A", "B", "C"], i: 1 });
    expect(arrived(v, "X", 1)).toEqual({ keys: ["X"], i: 0 });
    expect(arrived(v, "A", 7)).toEqual({ keys: ["A"], i: 0 });
    expect(arrived(v, "A", -1)).toEqual({ keys: ["A"], i: 0 });
  });

  it("reads back only well-formed visits, and keeps them short", () => {
    expect(loadVisits({ keys: ["A", "B"], i: 1 })).toEqual({ keys: ["A", "B"], i: 1 });
    expect(loadVisits(null)).toBeNull();
    expect(loadVisits({ keys: ["A"], i: 1 })).toBeNull();
    expect(loadVisits({ keys: [1], i: 0 })).toBeNull();
    expect(loadVisits({ keys: ["A"], i: 0.5 })).toBeNull();
    const many = Array.from({ length: 250 }, (_, j) => `k${j}`);
    const v = loadVisits({ keys: many, i: 240 })!;
    expect(v.keys).toHaveLength(200);
    expect(v.keys[v.i]).toBe("k240");
  });
});
