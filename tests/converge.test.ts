/**
 * Convergence: replicas of a library that apply random concurrent ops through the op API (moving
 * and copying nodes between its top-level trees among them) and exchange updates in random order must
 * end in identical state, with a history that still verifies. Along the way every snapshot, which
 * is patched node by node after each change, must equal one read from scratch.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Doc, OpError, descendants, type NodeId } from "../src/core/model";
import { encodeVV, mergeUpdate, verifyHistory } from "../src/core/repo";

const WORDS = ["tree", "node", "anchor", "merge", "stale", "bless", "fork", "sentence", "gloss", "margin"];

interface Cmd {
  kind: number;
  r: number;
  r2: number;
  x: number;
  y: number;
  z: number;
}

const cmd = fc.record({
  kind: fc.integer({ min: 0, max: 12 }),
  r: fc.integer({ min: 0, max: 2 }),
  r2: fc.integer({ min: 0, max: 2 }),
  x: fc.nat(1000),
  y: fc.nat(1000),
  z: fc.nat(1000),
});

function base(): Doc {
  const doc = Doc.library("a");
  const lib = doc.snap().root;
  doc.apply(
    [
      { op: "create", parent: lib, title: "Doc A", body: "Alpha is first. Beta is second. Gamma is third." },
      { op: "create", parent: "$0" as NodeId, title: "One", body: "The first child has a body. It has two sentences." },
      { op: "create", parent: "$0" as NodeId, title: "Two", body: "The second child." },
      { op: "create", parent: "$1" as NodeId, title: "Deep", body: "A grandchild." },
      { op: "create", parent: "$0" as NodeId, kind: "note", quote: "Beta", form: "gloss", body: "second letter" },
      { op: "create", parent: lib, title: "Doc B", body: "Another tree entirely." },
      { op: "create", parent: "$5" as NodeId, title: "Three", body: "A section of the second tree." },
    ],
    "Base",
  );
  return doc;
}

/** The snapshot as patched so far must be the snapshot a fresh read gives. */
function checkSnap(doc: Doc) {
  const fresh = Doc.load(doc.snapshotBytes(), "check").snap();
  expect(doc.snap()).toEqual(fresh);
}

function sync(into: Doc, from: Doc) {
  const vv = from.loro.version().toJSON();
  mergeUpdate(into, from.loro.export({ mode: "update", from: into.loro.version() }), vv);
}

function run(doc: Doc, c: Cmd, replicas: Doc[]) {
  const snap = doc.snap();
  const ids = [snap.root, ...descendants(snap, snap.root)];
  const id = ids[c.x % ids.length];
  const other = ids[c.y % ids.length];
  const n = snap.nodes[id];
  const word = WORDS[c.z % WORDS.length];
  try {
    switch (c.kind) {
      case 0:
        doc.apply([{ op: "create", parent: id, title: word, body: `About ${word}. More on ${word}.`, index: c.y % 3 }], "create");
        break;
      case 1: {
        if (n.body.length < 2) break;
        const s = c.y % (n.body.length - 1);
        const e = Math.min(n.body.length, s + 1 + (c.z % 12));
        doc.apply([{ op: "create", parent: id, kind: "note", anchors: [[s, e]], form: "note", body: `Note on ${word}.` }], "note", { actor: "llm" });
        break;
      }
      case 2: {
        const at = c.y % (n.body.length + 1);
        doc.apply([{ op: "update", id, body: n.body.slice(0, at) + ` ${word} ` + n.body.slice(at) }], "insert");
        break;
      }
      case 3: {
        if (!n.body.length) break;
        const s = c.y % n.body.length;
        doc.apply([{ op: "update", id, body: n.body.slice(0, s) + n.body.slice(s + 1 + (c.z % 15)) }], "cut", { actor: "llm" });
        break;
      }
      case 4:
        doc.apply([{ op: "update", id, title: `${word} ${c.z}` }], "retitle");
        break;
      case 5:
        if (id !== snap.root) doc.apply([{ op: "delete", id }], "delete");
        break;
      case 6:
        if (id !== snap.root) doc.apply([{ op: "move", id, parent: other, index: c.z % 3 }], "move");
        break;
      case 7:
        doc.apply([{ op: "replace", id, title: n.title, body: `Replaced with ${word}.` }], "replace", { actor: "llm" });
        break;
      case 8:
        doc.apply([{ op: "bless", id, dir: (["up", "down", "both"] as const)[c.z % 3] }], "bless");
        break;
      case 9:
        if (c.r !== c.r2) sync(doc, replicas[c.r2]);
        break;
      case 10:
        if (id !== snap.root) doc.apply([{ op: "copy", id, parent: other, index: c.z % 3 }], "copy");
        break;
      case 11: {
        // A link: a note with a target and no body, to an article or to another node.
        if (n.body.length < 2) break;
        const s = c.y % (n.body.length - 1);
        const ref = c.z % 2 ? { kind: "wiki" as const, title: word, lang: "en" } : { kind: "node" as const, id: other };
        doc.apply([{ op: "create", parent: id, kind: "note", anchors: [[s, Math.min(n.body.length, s + 1 + (c.z % 9))]], ref }], "link");
        break;
      }
      case 12:
        doc.apply([{ op: "update", id, ref: c.z % 3 ? { kind: "wiki", title: `${word} ${c.z % 5}`, lang: "en" } : null }], "retarget");
        break;
    }
  } catch (err) {
    if (!(err instanceof OpError)) throw err; // an op refused for a stated reason is fine; anything else is a bug
  }
}

describe("convergence", () => {
  it("replicas converge under random concurrent ops and random sync order", () => {
    fc.assert(
      fc.property(fc.array(cmd, { minLength: 8, maxLength: 60 }), (cmds) => {
        const a = base();
        const replicas = [a, a.fork("b"), a.fork("c")];
        for (const c of cmds) {
          run(replicas[c.r], c, replicas);
          checkSnap(replicas[c.r]);
        }

        // Exchange until quiet. Detecting a conflict is itself a commit, so one round is not always enough.
        let rounds = 0;
        const versions = () => new Set(replicas.map((d) => encodeVV(new Map([...d.loro.version().toJSON()].sort()))));
        do {
          for (const x of replicas) for (const y of replicas) if (x !== y) sync(x, y);
          if (++rounds > 8) throw new Error("replicas did not quiesce");
        } while (versions().size > 1);

        const states = new Set(replicas.map((d) => d.canonical()));
        expect(states.size).toBe(1);
        expect(new Set(replicas.map((d) => JSON.stringify(d.conflicts()))).size).toBe(1);
        // Every commit carries a hash, and every hash reproduces.
        for (const d of replicas) expect(verifyHistory(d)).toMatchObject({ unhashed: 0, mismatches: [] });

        // Structural invariants of the merged tree.
        for (const d of replicas) checkSnap(d);
        const snap = a.snap();
        expect(snap.library).toBe(true);
        for (const n of Object.values(snap.nodes)) {
          if (n.parent) expect(snap.nodes[n.parent].children).toContain(n.id);
          for (const an of n.anchors) {
            expect(an.start).toBeGreaterThanOrEqual(0);
            expect(an.end).toBeGreaterThanOrEqual(an.start);
            expect(an.end).toBeLessThanOrEqual(snap.nodes[n.parent!].body.length);
          }
        }
      }),
      { numRuns: Number(process.env.IE_RUNS ?? 200) },
    );
  }, 300_000);
});
