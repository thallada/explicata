/** server/embed.ts with a fake model: persistence, hash skip, top-k order, BM25, degraded mode. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Embedder, VectorIndex, fakeVector as hashed, type Loader } from "../server/embed";

// The hashed-words stand-in model, in fewer dimensions: similar words → similar vectors.
const fakeVector = (text: string) => hashed(text, 64);
function fakeLoader() {
  const seen: string[] = [];
  const loader: Loader = async () => async (texts) => {
    seen.push(...texts);
    return texts.map(fakeVector);
  };
  return { loader, seen };
}
const failingLoader: Loader = async () => {
  throw new Error("no network");
};

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "ie-embed-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NODES = [
  { id: "a", text: "Octopuses have a distributed nervous system; most neurons are in the arms." },
  { id: "b", text: "A fixed point of a function is a point mapped to itself." },
  { id: "c", text: "Brouwer's fixed point theorem: every continuous map of a disc to itself has a fixed point." },
  { id: "d", text: "Tides are caused by the gravitational pull of the moon and sun." },
];

describe("embedder", () => {
  it("loads lazily, once", async () => {
    let loads = 0;
    const em = new Embedder({
      dataDir: dir,
      loader: async () => {
        loads++;
        return async (t) => t.map(fakeVector);
      },
    });
    expect(loads).toBe(0);
    expect(em.state).toBe("idle");
    await Promise.all([em.embed(["x"]), em.embed(["y"])]);
    expect(loads).toBe(1);
    expect(em.state).toBe("ready");
  });

  it("returns null when the model cannot be loaded, without throwing", async () => {
    const em = new Embedder({ dataDir: dir, loader: failingLoader });
    expect(await em.embed(["anything"])).toBeNull();
    expect(em.state).toBe("failed");
    expect(em.error).toBe("no network");
  });

  it("adds the query prefix only for queries", async () => {
    const { loader, seen } = fakeLoader();
    const em = new Embedder({ dataDir: dir, loader });
    await em.embed(["doc"]);
    await em.embed(["q"], "query");
    expect(seen).toEqual(["doc", "Represent this sentence for searching relevant passages: q"]);
  });
});

describe("vector index", () => {
  it("persists vectors and texts, and skips unchanged entries by hash", async () => {
    const { loader, seen } = fakeLoader();
    const em = new Embedder({ dataDir: dir, loader });
    const file = join(dir, "vectors", "nodes");
    const ix = new VectorIndex(file, em);
    expect(await ix.upsert(NODES)).toMatchObject({ embedded: 4, skipped: 0, degraded: false });
    expect(seen.length).toBe(4);

    const reopened = new VectorIndex(file, em);
    expect(reopened.size).toBe(4);
    expect(Array.from(reopened.vectorOf("b")!)).toEqual(Array.from(fakeVector(NODES[1].text)));
    const changed = [...NODES.slice(0, 3), { id: "d", text: "Tides rise and fall twice a day." }];
    expect(await reopened.upsert(changed)).toMatchObject({ embedded: 1, skipped: 3 });
    expect(seen.length).toBe(5);
    expect(seen[4]).toBe("Tides rise and fall twice a day.");
  });

  it("drops stored vectors made by a different model", async () => {
    const { loader } = fakeLoader();
    const file = join(dir, "vectors", "nodes");
    await new VectorIndex(file, new Embedder({ dataDir: dir, loader })).upsert(NODES);
    const other = new VectorIndex(file, new Embedder({ dataDir: dir, loader, model: "Xenova/all-MiniLM-L6-v2" }));
    expect(other.size).toBe(4);
    expect(other.vectorOf("a")).toBeNull();
    expect(await other.upsert(NODES)).toMatchObject({ embedded: 4, skipped: 0 });
  });

  it("returns cosine top-k in order", async () => {
    const { loader } = fakeLoader();
    const ix = new VectorIndex(null, new Embedder({ dataDir: dir, loader }));
    await ix.upsert(NODES);
    const hits = (await ix.search("fixed point theorem continuous map", 3))!;
    expect(hits.map((h) => h.id)[0]).toBe("c");
    expect(hits).toHaveLength(3);
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    expect(ix.searchVector(fakeVector(NODES[3].text), 1)[0]).toMatchObject({ id: "d" });
  });

  it("text search works without a model, and hybrid falls back to it", async () => {
    const ix = new VectorIndex(join(dir, "vectors", "t"), new Embedder({ dataDir: dir, loader: failingLoader }));
    const r = await ix.upsert(NODES);
    expect(r).toMatchObject({ embedded: 0, withoutVector: 4, degraded: true });
    expect(await ix.search("octopus", 2)).toBeNull();
    expect(ix.textSearch("octopus arms", 2)[0].id).toBe("a");
    expect(ix.textSearch("fixed point", 4).map((h) => h.id).sort()).toEqual(["b", "c"]);
    const hy = await ix.hybrid("tides moon", 2);
    expect(hy[0]).toMatchObject({ id: "d", vector: null });
    expect(hy[0].text).toBeGreaterThan(0);
  });

  it("re-embeds entries stored without vectors once the model works", async () => {
    const file = join(dir, "vectors", "n");
    await new VectorIndex(file, new Embedder({ dataDir: dir, loader: failingLoader })).upsert(NODES);
    const { loader } = fakeLoader();
    const ix = new VectorIndex(file, new Embedder({ dataDir: dir, loader }));
    expect(await ix.upsert(NODES)).toMatchObject({ embedded: 4, skipped: 0 });
  });

  it("removes entries from both searches", async () => {
    const { loader } = fakeLoader();
    const ix = new VectorIndex(null, new Embedder({ dataDir: dir, loader }));
    await ix.upsert(NODES);
    ix.remove(["c"]);
    expect(ix.textSearch("brouwer", 5)).toEqual([]);
    expect((await ix.search("brouwer disc", 5))!.map((h) => h.id)).not.toContain("c");
  });
});

