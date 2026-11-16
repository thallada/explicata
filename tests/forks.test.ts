/** The panes view's forest of forks (src/ui/forks.ts): each operation, and any sequence of them leaving a well-formed forest with one focused branch and one active pane. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { all, besideInColumn, close, find, focus, focused, load, open, path, pin, plain, prune, restore, save, valid, withBranch, type Forest, type Tree } from "../src/ui/forks";

type F = Forest<string>;
type T = Tree<string>;
const same = (a: string, b: string) => a === b;
const branch = (f: F) => path(focused(f)).map((n) => n.ref);
/** A tree drawn as nested lists, the picked child starred, a pinned pane marked with a leading ^. */
const shape = (t: T | null): unknown => {
  if (!t) return null;
  const me = `${t.pinned ? "^" : ""}${t.ref}`;
  return t.kids.length ? [me, t.kids.map((k, j) => (j === t.pick ? ["*", shape(k)] : shape(k)))] : me;
};
const shapes = (f: F) => f.trees.map((t) => (t.col ? [t.col, shape(t)] : shape(t)));
const idOf = (f: F, ref: string) => all(f).find((x) => x.node.ref === ref)!.node.id;

describe("forks", () => {
  it("a plain trail is a chain, and a plain open replaces what is right of the pane", () => {
    let f: F = plain(["a", "b", "c"]);
    expect(branch(f)).toEqual(["a", "b", "c"]);
    f = open(f, 0, "x", false, same);
    expect(branch(f)).toEqual(["a", "x"]);
    expect(f.trees[0].kids).toHaveLength(1);
    // Already there: nothing changes, and what is right of it stays.
    const u: F = plain(["a", "b", "c"]);
    expect(open(u, 0, "b", false, same)).toBe(u);
  });

  it("a fork adds a child below the others and picks it; with no child it is a plain open", () => {
    let f: F = plain(["a", "b", "c"]);
    f = open(f, 0, "x", true, same);
    expect(shapes(f)).toEqual([["a", [["b", [["*", "c"]]], ["*", "x"]]]]);
    f = open(f, 1, "y", true, same); // x has no child: a plain open
    expect(branch(f)).toEqual(["a", "x", "y"]);
    f = open(f, 0, "z", true, same);
    expect(f.trees[0].kids.map((k) => k.ref)).toEqual(["b", "x", "z"]);
  });

  it("opening what is already a fork of the pane picks that fork, plain or not, instead of a duplicate", () => {
    let f: F = plain(["a", "b", "c"]);
    f = open(f, 0, "x", true, same);
    f = open(f, 0, "b", false, same);
    expect(branch(f)).toEqual(["a", "b", "c"]);
    expect(f.trees[0].kids.map((k) => k.ref)).toEqual(["b", "x"]);
    f = open(f, 0, "x", true, same);
    expect(branch(f)).toEqual(["a", "x"]);
  });

  it("a plain open beside a pinned pane forks instead of replacing it; pinned panes in what is replaced stay as orphans in their columns", () => {
    let f: F = plain(["a", "b", "c", "d"]);
    f = pin(f, idOf(f, "b"), true);
    f = open(f, 0, "x", false, same);
    expect(shapes(f)).toEqual([["a", [["^b", [["*", ["c", [["*", "d"]]]]]], ["*", "x"]]]]);
    let g: F = plain(["a", "b", "c", "d"]);
    g = pin(g, idOf(g, "c"), true);
    g = open(g, 0, "x", false, same);
    expect(shapes(g)).toEqual([["a", [["*", "x"]]], [2, ["^c", [["*", "d"]]]]]);
    expect(branch(g)).toEqual(["a", "x"]);
  });

  it("closes a pane and what was opened from it; the one below (else above) takes its pick; the first pane stays", () => {
    let f: F = plain(["a", "b", "c"]);
    f = open(f, 0, "x", true, same);
    f = open(f, 0, "y", true, same);
    const active = idOf(f, "y");
    let r = close(f, active, active);
    expect(r.forest.trees[0].kids.map((k) => k.ref)).toEqual(["b", "x"]);
    expect(r.active).toBe(idOf(f, "a"));
    expect(branch(r.forest)).toEqual(["a", "x"]);
    // Closing a pane off the focused branch leaves the active pane as it is.
    r = close(f, idOf(f, "b"), active);
    expect(r.active).toBe(active);
    expect(branch(r.forest)).toEqual(["a", "y"]);
    expect(shapes(r.forest)).toEqual([["a", ["x", ["*", "y"]]]]);
    // The first pane never closes.
    expect(close(f, idOf(f, "a"), active).forest).toBe(f);
    // Deep in a fork, only that pane (the owner's bug: q closed the whole fork).
    let g: F = plain(["a", "b"]);
    g = open(g, 0, "r", true, same);
    g = open(g, 1, "w1", false, same);
    g = open(g, 2, "w2", false, same);
    r = close(g, idOf(g, "w2"), idOf(g, "w2"));
    expect(branch(r.forest)).toEqual(["a", "r", "w1"]);
    expect(r.active).toBe(idOf(g, "w1"));
  });

  it("a pinned pane outlives the pane it was opened from: an orphan in its column, with what it opened; closing it closes it", () => {
    let f: F = plain(["a", "b", "c", "d", "e"]);
    f = pin(f, idOf(f, "d"), true);
    const e = idOf(f, "e");
    let r = close(f, idOf(f, "b"), e);
    expect(shapes(r.forest)).toEqual(["a", [3, ["^d", [["*", "e"]]]]]);
    // The active pane was inside the orphan: it stays active, its tree focused.
    expect(r.active).toBe(e);
    expect(r.forest.at).toBe(1);
    expect(branch(r.forest)).toEqual(["d", "e"]);
    expect(valid(r.forest, same)).toBe(true);
    // Closing the orphan's root closes it (its pin protects it from its parent, not from itself); the nearest pane of the tree before is active.
    const d = idOf(r.forest, "d");
    const s = close(r.forest, d, e);
    expect(shapes(s.forest)).toEqual(["a"]);
    expect(s.active).toBe(idOf(f, "a"));
    expect(s.forest.at).toBe(0);
  });

  it("[ and ]: the pane above and below in a column, across forks and trees", () => {
    let f: F = plain(["a", "b", "b1"]);
    f = open(f, 1, "b2", true, same);
    f = open(f, 0, "c", true, same);
    f = open(f, 1, "c1", false, same);
    // Column 2 holds b1, b2, c1, in that order.
    expect(besideInColumn(f, idOf(f, "c1"), -1)).toBe(idOf(f, "b2"));
    expect(besideInColumn(f, idOf(f, "b2"), -1)).toBe(idOf(f, "b1"));
    expect(besideInColumn(f, idOf(f, "b1"), -1)).toBeNull();
    expect(besideInColumn(f, idOf(f, "c1"), 1)).toBeNull();
    expect(besideInColumn(f, idOf(f, "a"), 1)).toBeNull();
    const g = focus(f, idOf(f, "b1"));
    expect(branch(g)).toEqual(["a", "b", "b1"]);
    expect(focus(g, idOf(f, "b1"))).toBe(g);
  });

  it("drops a deleted node's pane wherever it is, with what is right of it but pinned panes", () => {
    let f: F = plain(["a", "b", "c"]);
    f = open(f, 0, "x", true, same);
    f = open(f, 1, "gone", false, same);
    f = open(f, 2, "after", false, same);
    expect(branch(f)).toEqual(["a", "x", "gone", "after"]);
    expect(branch(prune(f, (r) => r !== "gone"))).toEqual(["a", "x"]);
    expect(prune(f, () => true)).toBe(f);
    const p = prune(pin(f, idOf(f, "after"), true), (r) => r !== "gone");
    expect(shapes(p)).toEqual([["a", [["b", [["*", "c"]]], ["*", "x"]]], [3, "^after"]]);
  });

  it("makes a path the branch, keeping the forks off it and the pinned panes", () => {
    let f: F = plain(["a", "b", "c"]);
    f = open(f, 0, "x", true, same);
    let u = withBranch(f, ["a", "b", "d"], same);
    expect(branch(u)).toEqual(["a", "b", "d"]);
    expect(u.trees[0].kids.map((k) => k.ref)).toEqual(["b", "x"]);
    u = withBranch(f, ["a", "x"], same);
    expect(u).toBe(f);
    expect(branch(withBranch(f, ["q", "r"], same))).toEqual(["q", "r"]);
    expect(branch(withBranch(f, ["a"], same))).toEqual(["a"]);
    // A pinned pane right of the list's end stays where it is.
    let h: F = plain(["a", "b", "c"]);
    h = pin(h, idOf(h, "c"), true);
    expect(shapes(withBranch(h, ["a"], same))).toEqual(["a", [2, "^c"]]);
    expect(shapes(withBranch(h, ["a", "b"], same))).toEqual([["a", [["*", ["b", [["*", "^c"]]]]]]]);
  });

  it("is stored without ids, pins and orphans kept; an old stored tree or trail loads", () => {
    let f: F = plain(["a", "b", "c"]);
    f = open(f, 0, "x", true, same);
    f = pin(f, idOf(f, "c"), true);
    f = close(f, idOf(f, "b"), idOf(f, "x")).forest;
    const isStr = (r: unknown): r is string => typeof r === "string";
    const stored = JSON.parse(JSON.stringify({ forest: f.trees.map((t) => save(t, (r) => r)), at: f.at }));
    const back = restore<string, unknown>(stored, isStr);
    expect(shapes(back)).toEqual(shapes(f));
    expect(valid(back, same)).toBe(true);
    expect(branch(restore<string, unknown>({ trail: ["a", "b"] }, isStr))).toEqual(["a", "b"]);
    expect(shapes(restore<string, unknown>({ forks: { ref: "a", kids: [{ ref: "b" }, { ref: "c" }], pick: 1 } }, isStr))).toEqual([["a", ["b", ["*", "c"]]]]);
    expect(restore({}, isStr).trees).toEqual([]);
    // Junk is dropped, not trusted.
    expect(load({ ref: "a", kids: [{ ref: 3 }, { ref: "b" }], pick: 9 }, isStr)!.kids.map((k) => k.ref)).toEqual(["b"]);
    expect(load("nonsense", isStr)).toBeNull();
    expect(restore<string, unknown>({ forest: [{ ref: "o", col: 2 }, { ref: "a" }], at: 7 }, isStr).trees.map((t) => t.ref)).toEqual(["a", "o"]);
  });

  it("any sequence of open, fork, close, pin, unpin and focus leaves a valid forest with exactly one active pane, and closing removes no pinned pane but the one closed", () => {
    const refs = ["a", "b", "c", "d", "e"];
    const op = fc.record({ kind: fc.integer({ min: 0, max: 8 }), i: fc.nat(40), r: fc.integer({ min: 0, max: refs.length - 1 }), d: fc.boolean() });
    fc.assert(
      fc.property(fc.array(op, { maxLength: 60 }), (ops) => {
        let f: F = plain(["root"]);
        // The active pane, by id: on the focused branch.
        let active = f.trees[0].id;
        for (const o of ops) {
          const p = path(focused(f));
          const i = Math.max(0, p.findIndex((n) => n.id === active));
          const panes = all(f);
          const any = panes[o.i % panes.length].node;
          switch (o.kind) {
            case 0:
            case 1:
              f = open(f, i, refs[o.r], o.kind === 1, same);
              active = path(focused(f))[Math.min(i + 1, path(focused(f)).length - 1)].id;
              break;
            case 2:
            case 3: {
              const pinned = new Set(all(f).filter((x) => x.node.pinned && x.node.id !== any.id).map((x) => x.node.id));
              const r = close(f, any.id, active);
              f = r.forest;
              active = r.active;
              const left = new Set(all(f).map((x) => x.node.id));
              for (const id of pinned) if (!left.has(id)) return false;
              break;
            }
            case 4:
            case 5:
              f = pin(f, any.id, o.kind === 4);
              break;
            case 6:
              f = focus(f, any.id);
              active = any.id;
              break;
            case 7: {
              const next = besideInColumn(f, active, o.d ? 1 : -1);
              if (next !== null) (f = focus(f, next)), (active = next);
              break;
            }
            case 8:
              f = withBranch(f, ["root", ...refs.slice(0, o.i % 4)], same);
              active = f.trees[0].id;
              break;
          }
          if (!valid(f, same)) return false;
          // One branch, from the focused tree's root to a pane with nothing right of it, each step a picked child.
          const b = path(focused(f));
          if (!b.length || b[b.length - 1].kids.length) return false;
          for (let k = 1; k < b.length; k++) if (b[k - 1].kids[b[k - 1].pick] !== b[k]) return false;
          // Exactly one active pane: it is open, once, and on the focused branch.
          if (all(f).filter((x) => x.node.id === active).length !== 1 || !b.some((n) => n.id === active)) return false;
          if (!find(f, active) || f.trees[0].ref !== "root") return false;
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });
});
