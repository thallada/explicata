/** The panes view's forest of forks (src/ui/forks.ts): each operation, and any sequence of them leaving a well-formed forest with one focused branch and one active pane. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HUES, all, besideInColumn, close, columns, find, focus, focused, load, open, path, pin, plain, prune, reorder, restore, save, setSources, valid, withBranch, type Forest, type Tree } from "../src/ui/forks";

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

  it("a column's panes can be put in an order by hand, across forks; new panes come after; a replaced pane keeps its place; the order is stored", () => {
    let f: F = plain(["a", "b", "b1"]);
    f = open(f, 1, "b2", true, same);
    f = open(f, 0, "c", true, same);
    f = open(f, 1, "c1", false, same);
    const col2 = (g: F) => columns(g).get(2)!.map((x) => x.node.ref);
    expect(col2(f)).toEqual(["b1", "b2", "c1"]);
    f = reorder(f, idOf(f, "c1"), idOf(f, "b1"));
    expect(col2(f)).toEqual(["c1", "b1", "b2"]);
    expect(besideInColumn(f, idOf(f, "b1"), -1)).toBe(idOf(f, "c1"));
    f = reorder(f, idOf(f, "c1"), null);
    expect(col2(f)).toEqual(["b1", "b2", "c1"]);
    f = reorder(f, idOf(f, "b2"), idOf(f, "b1"));
    expect(col2(f)).toEqual(["b2", "b1", "c1"]);
    // A new pane in that column goes to the bottom; a pane opened in place of another takes its place.
    f = open(focus(f, idOf(f, "c")), 1, "c2", true, same);
    expect(col2(f)).toEqual(["b2", "b1", "c1", "c2"]);
    f = open(focus(f, idOf(f, "b1")), 1, "bx", false, same);
    expect(col2(f)).toEqual(["b2", "bx", "c1", "c2"]);
    const isStr = (r: unknown): r is string => typeof r === "string";
    const back = restore<string, unknown>(JSON.parse(JSON.stringify({ forest: f.trees.map((t) => save(t, (r) => r)), at: f.at })), isStr);
    expect(col2(back)).toEqual(["b2", "bx", "c1", "c2"]);
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

  it("any sequence of open, fork, close, pin, unpin, focus and reorder leaves a valid forest with exactly one active pane, and closing removes no pinned pane but the one closed", () => {
    const refs = ["a", "b", "c", "d", "e"];
    const op = fc.record({ kind: fc.integer({ min: 0, max: 9 }), i: fc.nat(40), r: fc.integer({ min: 0, max: refs.length - 1 }), d: fc.boolean() });
    fc.assert(
      fc.property(fc.array(op, { maxLength: 60 }), (ops) => {
        let f: F = plain(["root"]);
        // The active pane, by id: on the focused branch.
        let active = f.trees[0].id;
        // Each pane's colour, as first seen: it never changes while the pane is open.
        const hueOf = new Map<number, number | undefined>();
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
            case 9: {
              const col = [...columns(f).values()].find((c) => c.some((x) => x.node.id === any.id))!;
              const before = col[o.r % col.length].node.id;
              const was = all(f).length;
              f = reorder(f, any.id, o.d ? before : null);
              if (all(f).length !== was) return false;
              break;
            }
          }
          if (!valid(f, same)) return false;
          // One branch, from the focused tree's root to a pane with nothing right of it, each step a picked child.
          const b = path(focused(f));
          if (!b.length || b[b.length - 1].kids.length) return false;
          for (let k = 1; k < b.length; k++) if (b[k - 1].kids[b[k - 1].pick] !== b[k]) return false;
          // Exactly one active pane: it is open, once, and on the focused branch.
          if (all(f).filter((x) => x.node.id === active).length !== 1 || !b.some((n) => n.id === active)) return false;
          if (!find(f, active) || f.trees[0].ref !== "root") return false;
          if (f.trees[0].hue !== undefined) return false;
          for (const x of all(f)) {
            if (hueOf.has(x.node.id) && hueOf.get(x.node.id) !== x.node.hue) return false;
            hueOf.set(x.node.id, x.node.hue);
          }
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });
});

describe("branch colours", () => {
  const isStr = (r: unknown): r is string => typeof r === "string";
  /** Each pane's colour by its ref, "-" for none. */
  const hues = (f: F) => Object.fromEntries(all(f).map((x) => [x.node.ref, x.node.hue ?? "-"]));
  const roundTrip = (f: F) => restore<string, unknown>(JSON.parse(JSON.stringify({ forest: f.trees.map((t) => save(t, (r) => r)), at: f.at, hues: f.hues ?? 0 })), isStr);

  it("the top node has none; every pane opened from it starts a colour, a plain trail below keeps it, each further child of a pane starts the next", () => {
    let f: F = plain(["a", "b", "c"]);
    expect(hues(f)).toEqual({ a: "-", b: 0, c: 0 });
    f = open(f, 0, "x", true, same); // a second child of the top: a new colour
    f = open(f, 1, "x1", true, same); // x's first child: x's colour
    f = open(f, 2, "x2", false, same);
    f = open(f, 1, "y", true, same); // a second child of x
    f = open(f, 0, "z", true, same); // a third child of the top
    expect(hues(f)).toEqual({ a: "-", b: 0, c: 0, x: 1, x1: 1, x2: 1, y: 2, z: 3 });
    expect(f.hues).toBe(4);
    // The first pane opened from the top, by an open, starts a colour too.
    let g: F = plain(["a"]);
    g = open(g, 0, "p", false, same);
    g = open(g, 1, "q", false, same);
    expect(hues(g)).toEqual({ a: "-", p: 0, q: 0 });
  });

  it("the palette goes round, never giving a fork its parent's colour", () => {
    let f: F = plain(["a"]);
    for (let i = 0; i < HUES + 2; i++) f = open(focus(f, f.trees[0].id), 0, `k${i}`, true, same);
    // k0, k1, … take 0, 1, … round the palette.
    expect(all(f).slice(1).map((x) => x.node.hue ?? "-")).toEqual(Array.from({ length: HUES + 2 }, (_, i) => i % HUES));
    // Forks of a coloured pane skip its colour when the palette comes round to it.
    let g: F = plain(["a"]);
    g = open(g, 0, "c", true, same); // 0
    for (let i = 0; i < HUES - 1; i++) g = open(focus(g, g.trees[0].id), 0, `p${i}`, true, same); // 1 … HUES − 1
    g = open(focus(g, idOf(g, "c")), 1, "c1", true, same); // c's first: 0
    g = open(focus(g, idOf(g, "c")), 1, "c2", true, same); // next would be 0, c's own
    expect(all(g).find((x) => x.node.ref === "c2")!.node.hue).toBe(1);
  });

  it("a pane opened in place of another takes its colour; one beside a pinned pane starts a new one; so does withBranch", () => {
    let f: F = plain(["a", "b"]);
    f = open(f, 0, "x", true, same);
    f = open(f, 0, "y", true, same);
    f = open(focus(f, idOf(f, "x")), 0, "x'", false, same); // in x's place
    expect(hues(f)).toEqual({ a: "-", b: 0, "x'": 1, y: 2 });
    f = pin(f, idOf(f, "x'"), true);
    f = open(f, 0, "w", false, same); // beside a pinned pane: a fork
    expect(hues(f).w).toBe(3);
    let g: F = plain(["a", "b"]);
    g = open(g, 0, "x", true, same);
    g = withBranch(g, ["a", "x", "x1", "x2"], same);
    expect(hues(g)).toMatchObject({ x: 1, x1: 1, x2: 1 });
    g = withBranch(g, ["a", "x", "q"], same); // in x1's place
    expect(hues(g).q).toBe(1);
    // A different top: its trail starts a colour; the top has none.
    expect(hues(withBranch(g, ["r", "s", "t"], same))).toMatchObject({ r: "-", s: 2, t: 2 });
  });

  it("colours stay through a reorder, a close, a pin and a prune; an orphan keeps its own", () => {
    let f: F = plain(["a", "b", "b1"]);
    f = open(f, 1, "c", true, same);
    f = open(f, 2, "c1", true, same);
    f = open(f, 0, "d", true, same);
    f = open(f, 1, "d1", true, same);
    const was = hues(f);
    f = reorder(f, idOf(f, "d1"), idOf(f, "b1"));
    expect(hues(f)).toEqual(was);
    f = pin(f, idOf(f, "c1"), true);
    f = close(f, idOf(f, "c"), idOf(f, "d1")).forest;
    expect(f.trees[1].ref).toBe("c1");
    const { c: _c, ...rest } = was;
    expect(hues(f)).toEqual(rest);
    const { d1: _d1, ...left } = rest;
    expect(hues(prune(f, (r) => r !== "d1"))).toEqual(left);
    // A new fork after all that still takes the next colour, not one used already.
    expect(hues(open(focus(f, idOf(f, "a")), 0, "e", true, same)).e).toBe(f.hues);
  });

  it("colours are stored with the view; a view stored before colours is coloured as if opened in tree order", () => {
    let f: F = plain(["a", "b", "c"]);
    f = open(f, 0, "x", true, same);
    f = open(f, 1, "x1", true, same);
    f = open(f, 0, "y", true, same);
    f = pin(f, idOf(f, "x1"), true);
    f = close(f, idOf(f, "x"), idOf(f, "y")).forest;
    expect(hues(f)).toEqual({ a: "-", b: 0, c: 0, y: 2, x1: 1 });
    const back = roundTrip(f);
    expect(hues(back)).toEqual(hues(f));
    expect(back.hues).toBe(f.hues);
    // From before colours: the top plain, each of its children, each further child and each orphan a new colour.
    const old = restore<string, unknown>({ forest: [{ ref: "a", kids: [{ ref: "b", kids: [{ ref: "c" }, { ref: "c2" }] }, { ref: "x", kids: [{ ref: "x1" }] }] }, { ref: "o", col: 2, kids: [{ ref: "o1" }] }], at: 0 }, isStr);
    expect(hues(old)).toEqual({ a: "-", b: 0, c: 0, c2: 1, x: 2, x1: 2, o: 3, o1: 3 });
    expect(old.hues).toBe(4);
    expect(valid(old, same)).toBe(true);
    // Stored with a count but the top's first trail uncoloured (as the first colours had it): coloured on, from the count.
    const mid = restore<string, unknown>({ forest: [{ ref: "a", kids: [{ ref: "b", kids: [{ ref: "c" }] }, { ref: "x", hue: 0 }] }], at: 0, hues: 1 }, isStr);
    expect(hues(mid)).toEqual({ a: "-", b: 1, c: 1, x: 0 });
    expect(mid.hues).toBe(2);
    // Older still: one tree, or a trail.
    expect(hues(restore<string, unknown>({ forks: { ref: "a", kids: [{ ref: "b" }, { ref: "c" }], pick: 1 } }, isStr))).toEqual({ a: "-", b: 0, c: 1 });
    expect(hues(restore<string, unknown>({ trail: ["a", "b"] }, isStr))).toEqual({ a: "-", b: 0 });
    // A colour out of the palette is not trusted.
    expect(load({ ref: "a", hue: HUES }, isStr)!.hue).toBeUndefined();
    expect(load({ ref: "a", hue: 1.5 }, isStr)!.hue).toBeUndefined();
  });
});

describe("column order", () => {
  const col = (f: F, c: number) => columns(f).get(c)!.map((x) => x.node.ref);
  it("a column's panes stand by their parents' places, then by where in the parent each was opened from", () => {
    let f: F = plain(["lib"]);
    f = open(f, 0, "octopus", true, same);
    f = open(focus(f, f.trees[0].id), 0, "expand", true, same);
    expect(col(f, 1)).toEqual(["octopus", "expand"]); // not measured yet: in tree order
    f = setSources(f, new Map([[idOf(f, "octopus"), 40], [idOf(f, "expand"), 10]]));
    expect(col(f, 1)).toEqual(["expand", "octopus"]);
    // Their children follow their parents' order, then their own sources.
    f = open(focus(f, idOf(f, "octopus")), 1, "o1", true, same);
    f = open(focus(f, idOf(f, "expand")), 1, "e2", true, same);
    f = open(focus(f, idOf(f, "expand")), 1, "e1", true, same);
    f = setSources(f, new Map([[idOf(f, "o1"), 5], [idOf(f, "e2"), 90], [idOf(f, "e1"), 20]]));
    expect(col(f, 2)).toEqual(["e1", "e2", "o1"]);
    // Stored with the view.
    const isStr = (r: unknown): r is string => typeof r === "string";
    const back = restore<string, unknown>(JSON.parse(JSON.stringify({ forest: f.trees.map((t) => save(t, (r) => r)), at: f.at, hues: f.hues })), isStr);
    expect(col(back, 2)).toEqual(["e1", "e2", "o1"]);
  });

  it("an order set by hand stays; a pane never placed by hand goes just after the one before it in its own order", () => {
    let f: F = plain(["lib"]);
    for (const [r, y] of [["a", 10], ["b", 20], ["c", 30]] as const) {
      f = open(focus(f, f.trees[0].id), 0, r, true, same);
      f = setSources(f, new Map([[idOf(f, r), y]]));
    }
    expect(col(f, 1)).toEqual(["a", "b", "c"]);
    f = reorder(f, idOf(f, "c"), idOf(f, "a"));
    expect(col(f, 1)).toEqual(["c", "a", "b"]);
    // A new one opened from between a and b: just after a, where the reader put a.
    f = open(focus(f, f.trees[0].id), 0, "ab", true, same);
    f = setSources(f, new Map([[idOf(f, "ab"), 15]]));
    expect(col(f, 1)).toEqual(["c", "a", "ab", "b"]);
    // One from above all: first.
    f = open(focus(f, f.trees[0].id), 0, "top", true, same);
    f = setSources(f, new Map([[idOf(f, "top"), 1]]));
    expect(col(f, 1)).toEqual(["top", "c", "a", "ab", "b"]);
  });
});
