/** The panes view's tree of forks (src/ui/forks.ts): each operation, and any sequence of them leaving one well-formed tree with one focused branch. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { all, chain, closeAt, closeChild, closeRight, leaves, load, open, path, prune, restore, save, select, sibling, valid, withBranch, type Tree } from "../src/ui/forks";

type T = Tree<string>;
const same = (a: string, b: string) => a === b;
const branch = (t: T | null) => path(t).map((n) => n.ref);
/** The tree drawn as nested lists, the picked child starred. */
const shape = (t: T | null): unknown => (t ? (t.kids.length ? [t.ref, t.kids.map((k, j) => (j === t.pick ? ["*", shape(k)] : shape(k)))] : t.ref) : null);

describe("forks", () => {
  it("a plain trail is a chain, and a plain open replaces what is right of the pane", () => {
    let t = chain<string, unknown>(["a", "b", "c"])!;
    expect(branch(t)).toEqual(["a", "b", "c"]);
    t = open(t, 0, "x", false, same);
    expect(branch(t)).toEqual(["a", "x"]);
    expect(t.kids).toHaveLength(1);
    // Already there: nothing changes, and what is right of it stays.
    const u = chain<string, unknown>(["a", "b", "c"])!;
    expect(open(u, 0, "b", false, same)).toBe(u);
  });

  it("a fork adds a child below the others and picks it; with no child it is a plain open", () => {
    let t = chain<string, unknown>(["a", "b", "c"])!;
    t = open(t, 0, "x", true, same);
    expect(shape(t)).toEqual(["a", [["b", [["*", "c"]]], ["*", "x"]]]);
    expect(branch(t)).toEqual(["a", "x"]);
    t = open(t, 1, "y", true, same); // x has no child: a plain open
    expect(branch(t)).toEqual(["a", "x", "y"]);
    expect(t.kids[1].kids).toHaveLength(1);
    t = open(t, 0, "z", true, same);
    expect(t.kids.map((k) => k.ref)).toEqual(["b", "x", "z"]);
    expect(leaves(t)).toBe(3);
  });

  it("opening what is already a fork of the pane picks that fork, plain or not, instead of a duplicate", () => {
    let t = chain<string, unknown>(["a", "b", "c"])!;
    t = open(t, 0, "x", true, same);
    t = open(t, 0, "b", false, same);
    expect(branch(t)).toEqual(["a", "b", "c"]);
    expect(t.kids.map((k) => k.ref)).toEqual(["b", "x"]);
    t = open(t, 0, "x", true, same);
    expect(branch(t)).toEqual(["a", "x"]);
    expect(t.kids).toHaveLength(2);
  });

  it("a plain open in a fork replaces only that fork", () => {
    let t = chain<string, unknown>(["a", "b"])!;
    t = open(t, 0, "x", true, same);
    t = open(t, 0, "y", false, same);
    expect(t.kids.map((k) => k.ref)).toEqual(["b", "y"]);
    expect(branch(t)).toEqual(["a", "y"]);
  });

  it("moves to the fork above and below in the order rows are drawn, from the deepest pane with one", () => {
    // a ─ b ─ b1          rows: b/b1, b/b2, c
    //       └ b2
    //   └ c
    let t = chain<string, unknown>(["a", "b", "b1"])!;
    t = open(t, 1, "b2", true, same);
    t = open(t, 0, "c", true, same);
    expect(branch(t)).toEqual(["a", "c"]);
    let s = sibling(t, -1)!;
    expect(s.depth).toBe(1);
    expect(branch(s.tree)).toEqual(["a", "b", "b2"]); // b remembers b2 was picked
    s = sibling(s.tree, -1)!;
    expect(s.depth).toBe(2);
    expect(branch(s.tree)).toEqual(["a", "b", "b1"]);
    expect(sibling(s.tree, -1)).toBeNull();
    s = sibling(s.tree, 1)!;
    expect(branch(s.tree)).toEqual(["a", "b", "b2"]);
    s = sibling(s.tree, 1)!;
    expect(branch(s.tree)).toEqual(["a", "c"]);
    expect(sibling(s.tree, 1)).toBeNull();
    expect(sibling(chain<string, unknown>(["a", "b"])!, 1)).toBeNull();
  });

  it("closes a branch: right of a pane (every fork), a pane and what follows it, or one child", () => {
    let t = chain<string, unknown>(["a", "b", "c"])!;
    t = open(t, 0, "x", true, same);
    t = open(t, 0, "y", true, same);
    expect(branch(closeRight(t, 0))).toEqual(["a"]);
    // Close the focused fork (y, the last): the one above takes its place.
    let u = closeAt(t, 1);
    expect(u.kids.map((k) => k.ref)).toEqual(["b", "x"]);
    expect(branch(u)).toEqual(["a", "x"]);
    // The middle one: the one below takes its place.
    u = closeAt(select(t, t.kids[1].id)!, 1);
    expect(branch(u)).toEqual(["a", "y"]);
    // Closing the last-but-one fork leaves a plain trail.
    u = closeAt(closeAt(t, 1), 1);
    expect(shape(u)).toEqual(["a", [["*", ["b", [["*", "c"]]]]]]);
    // One child by what it shows, whichever fork it is; picks stay on the same pane.
    u = closeChild(t, 0, "b", same);
    expect(u.kids.map((k) => k.ref)).toEqual(["x", "y"]);
    expect(branch(u)).toEqual(["a", "y"]);
    expect(closeChild(t, 0, "nope", same)).toBe(t);
    expect(closeAt(t, 0)).toBe(t);
  });

  it("drops a deleted node's pane wherever it is, with what is right of it", () => {
    let t = chain<string, unknown>(["a", "b", "c"])!;
    t = open(t, 0, "x", true, same);
    t = open(t, 1, "gone", false, same);
    t = open(t, 2, "after", false, same);
    expect(branch(t)).toEqual(["a", "x", "gone", "after"]);
    const p = prune(t, (r) => r !== "gone")!;
    expect(branch(p)).toEqual(["a", "x"]);
    expect(branch(select(p, p.kids[0].id))).toEqual(["a", "b", "c"]);
    // A deleted fork that is not focused goes without moving the branch.
    const q = prune(select(t, t.kids[0].id)!, (r) => r !== "x")!;
    expect(branch(q)).toEqual(["a", "b", "c"]);
    expect(q.kids).toHaveLength(1);
    // Nothing deleted: the same tree.
    expect(prune(t, () => true)).toBe(t);
    expect(prune(t, (r) => r !== "a")).toBeNull();
  });

  it("makes a path the branch, keeping the forks off it", () => {
    let t = chain<string, unknown>(["a", "b", "c"])!;
    t = open(t, 0, "x", true, same);
    let u = withBranch(t, ["a", "b", "d"], same)!;
    expect(branch(u)).toEqual(["a", "b", "d"]);
    expect(u.kids.map((k) => k.ref)).toEqual(["b", "x"]);
    u = withBranch(t, ["a", "x"], same)!;
    expect(u).toBe(t);
    expect(branch(withBranch(t, ["q", "r"], same))).toEqual(["q", "r"]);
    expect(branch(withBranch(t, ["a"], same))).toEqual(["a"]);
  });

  it("is stored without ids, and an old stored trail loads as a tree with one branch", () => {
    let t = chain<string, unknown>(["a", "b", "c"])!;
    t = open(t, 0, "x", true, same);
    t = open(t, 1, "y", true, same);
    const isStr = (r: unknown): r is string => typeof r === "string";
    const back = load<string, unknown>(JSON.parse(JSON.stringify(save(t, (r) => r))), isStr);
    expect(shape(back)).toEqual(shape(t));
    expect(restore<string, unknown>(undefined, ["a", "b"], isStr)!.kids[0].ref).toBe("b");
    expect(branch(restore<string, unknown>(undefined, ["a", "b"], isStr))).toEqual(["a", "b"]);
    expect(restore(undefined, [], isStr)).toBeNull();
    // Junk is dropped, not trusted.
    expect(load({ ref: "a", kids: [{ ref: 3 }, { ref: "b" }], pick: 9 }, isStr)!.kids.map((k) => k.ref)).toEqual(["b"]);
    expect(load({ ref: "a", kids: [{ ref: 3 }, { ref: "b" }], pick: 9 }, isStr)!.pick).toBe(0);
    expect(load("nonsense", isStr)).toBeNull();
  });

  it("any sequence of operations leaves a well-formed tree with exactly one focused branch", () => {
    const refs = ["a", "b", "c", "d", "e"];
    const op = fc.record({ kind: fc.integer({ min: 0, max: 8 }), i: fc.nat(6), r: fc.integer({ min: 0, max: refs.length - 1 }), d: fc.boolean() });
    fc.assert(
      fc.property(fc.array(op, { maxLength: 60 }), (ops) => {
        let t: T | null = chain<string, unknown>(["root"]);
        for (const o of ops) {
          if (!t) t = chain<string, unknown>(["root"])!;
          const depth = path(t).length;
          const i = o.i % depth;
          const r = refs[o.r];
          switch (o.kind) {
            case 0: t = open(t, i, r, false, same); break;
            case 1: t = open(t, i, r, true, same); break;
            case 2: t = sibling(t, o.d ? 1 : -1)?.tree ?? t; break;
            case 3: t = closeRight(t, i); break;
            case 4: t = closeAt(t, i); break;
            case 5: t = closeChild(t, i, r, same); break;
            case 6: t = prune(t, (x) => x !== r); break;
            case 7: {
              const nodes = all(t);
              t = select(t, nodes[o.i % nodes.length].node.id) ?? t;
              break;
            }
            case 8: t = withBranch(t, ["root", ...refs.slice(0, i)], same); break;
          }
          if (!valid(t, same)) return false;
          // One branch, from the root to a pane with nothing right of it, each step a picked child.
          const p = path(t);
          if (t && (p[0] !== t || p[p.length - 1].kids.length !== 0)) return false;
          for (let k = 1; k < p.length; k++) if (p[k - 1].kids[p[k - 1].pick] !== p[k]) return false;
        }
        return true;
      }),
      { numRuns: 400 },
    );
  });
});
