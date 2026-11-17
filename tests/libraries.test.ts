/**
 * Several libraries: the registry on disk (server/libraries.ts), and the server's routes for them,
 * driven over HTTP as a page or an outside agent would (a real server, on a temporary data
 * directory). Nothing of one library may reach another: not an op, a sync, a link suggestion, a
 * nearby or Related list, a pending entry or a vector.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Libraries, readIndex } from "../server/libraries";
import { LOCK } from "../server/lock";
import { Doc } from "../src/core/model";

const ROOT = new URL("..", import.meta.url).pathname;
const temps: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "ie-libs-"));
  temps.push(d);
  return d;
};
const servers: ChildProcess[] = [];
afterAll(() => {
  for (const s of servers) s.kill("SIGKILL");
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe("the libraries on disk", () => {
  it("makes, lists, renames and deletes libraries, each in its own directory; the last one stays", () => {
    const data = temp();
    const libs = new Libraries(data, () => {}).open((doc) => doc.apply([{ op: "create", parent: doc.snap().root, title: "Seeded", body: "Text." }], "seed"));
    const first = libs.first();
    const work = libs.create("  Work   notes ");
    expect(work.title).toBe("Work notes");
    expect(work.titles()).toEqual([]);
    expect(work.id).not.toBe(first.id);
    expect(libs.list().map((l) => [l.title, l.nodes])).toEqual([
      ["Library", 1],
      ["Work notes", 0],
    ]);
    // An op on one never touches the other: separate databases, separate files.
    const hash = first.main.stateHash();
    work.main.apply([{ op: "create", parent: work.main.snap().root, title: "Only here", body: "" }], "add");
    work.save("main");
    expect(first.main.stateHash()).toBe(hash);
    expect(existsSync(join(data, "libraries", work.id, "main.loro"))).toBe(true);
    // Renamed: a commit on its root's title, which the list reads.
    libs.rename(work.id, "Work");
    expect(work.main.snap().nodes[work.main.snap().root].title).toBe("Work");
    expect(libs.list()[1].title).toBe("Work");
    // A rename made in a replica (the root's title edited) shows in the list and the index.
    first.main.apply([{ op: "update", id: first.main.snap().root, title: "Mine" }], "rename");
    first.save("main");
    expect(libs.list()[0].title).toBe("Mine");
    expect(readIndex(join(data, "libraries"))[0].title).toBe("Mine");
    // Deleted: moved aside whole, still listed in the index as deleted, gone from the list.
    const moved = libs.remove(work.id);
    expect(moved).toContain(join("libraries", ".deleted", `${work.id}-`));
    expect(existsSync(join(moved, "main.loro"))).toBe(true);
    expect(existsSync(join(data, "libraries", work.id))).toBe(false);
    expect(libs.list().map((l) => l.id)).toEqual([first.id]);
    expect(readIndex(join(data, "libraries"))[1]).toMatchObject({ id: work.id, deleted: expect.any(String), movedTo: expect.stringContaining(".deleted") });
    expect(() => libs.remove(first.id)).toThrow(/last library/);
    // Opened again: the same libraries, the deleted one left out, nothing seeded.
    first.flush();
    const again = new Libraries(data, () => {}).open(() => {
      throw new Error("must not seed again");
    });
    expect(again.list().map((l) => [l.id, l.title])).toEqual([[first.id, "Mine"]]);
  });

  it("refuses a title that is empty or too long", () => {
    const libs = new Libraries(temp(), () => {}).open(() => {});
    expect(() => libs.create("   ")).toThrow(/title/);
    expect(() => libs.create("x".repeat(201))).toThrow(/200/);
  });
});

// ---- the server ----

const PORT = 4804;
const base = `http://127.0.0.1:${PORT}`;

function serve(data: string, library: string, port = PORT): { child: ChildProcess; out: string[]; exited: Promise<number | null> } {
  const out: string[] = [];
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, EX_PROD: "1", EX_LLM: "mock", EX_MOCK_DELAY: "0", EX_WIKI: "mock", EX_EMBED: "fake", EX_DATA: data, EX_LIBRARY: library, PORT: String(port), EX_USER: "tester" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(child);
  child.stdout!.on("data", (d) => out.push(String(d)));
  child.stderr!.on("data", (d) => out.push(String(d)));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  return { child, out, exited };
}

async function up() {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${base}/api/libraries`)).ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the server did not start");
}

const get = async (path: string) => (await fetch(base + path)).json();
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const ops = async (lib: string, list: unknown[]) => {
  const res = await send("POST", `/api/l/${lib}/ops`, { ops: list, author: "test", actor: "human" });
  expect(res.status).toBe(200);
  return (await res.json()).created as string[];
};

describe("the server with several libraries", () => {
  it("will not open a data directory in the old layout: one line saying to run the migration, and nothing written", async () => {
    const data = temp();
    cpSync(new URL("./fixtures/migrate/main/library", import.meta.url).pathname, join(data, "library"), { recursive: true });
    const before = readdirSync(data).sort();
    const s = serve(data, temp());
    expect(await s.exited).toBe(1);
    const text = s.out.join("").trim();
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toMatch(/old single-library layout.*npm run migrate/);
    expect(readdirSync(data).sort()).toEqual(before);
  }, 30_000);

  it("keeps libraries apart: ops, syncs, link suggestions, nearby, Related, pending entries and vectors", async () => {
    const data = temp();
    const starters = temp();
    writeFileSync(join(starters, "tides.md"), "# Tides\n\nThe sea rises and falls twice a day, pulled by the Moon.\n\n## Tidal locking\n\nA body that always shows the same face to what it orbits.\n");
    const s = serve(data, starters);
    await up();
    // An empty data directory: one library, with the seed and the starter trees.
    const [a] = (await get("/api/libraries")).libraries;
    expect(a.title).toBe("Library");
    const treeA = await get(`/api/l/${a.id}/tree`);
    const topsA = treeA.nodes[treeA.root].children.map((c: string) => treeA.nodes[c].title);
    expect(topsA).toEqual(["Explicata", "Tides"]);
    // The unprefixed routes are the first library's.
    expect((await get("/api/tree")).library).toBe(a.id);
    expect((await get("/api/state")).library).toBe(a.id);
    expect(existsSync(join(data, LOCK))).toBe(true);

    // A new library: its root alone, under the given title.
    const made = await send("POST", "/api/libraries", { title: "Second" });
    expect(made.status).toBe(201);
    const b = (await made.json()).library;
    expect(b).toMatchObject({ title: "Second", nodes: 0 });
    const state = await get(`/api/l/${b.id}/state`);
    expect(state).toMatchObject({ library: b.id, title: "Second" });
    expect(state.libraries.map((l: { id: string }) => l.id)).toEqual([a.id, b.id]);
    // The same titles as the first library's, and text that names them.
    const rootB = (await get(`/api/l/${b.id}/tree`)).root;
    const [tidesB, lockingB, moon] = await ops(b.id, [
      { op: "create", parent: rootB, title: "Tides", body: "Water moving under the pull of the Moon and the Sun." },
      { op: "create", parent: "$0", title: "Tidal locking", body: "A body that always shows the same face to what it orbits, as the Moon does to Earth." },
      { op: "create", parent: rootB, title: "Moon", body: "The Moon shows one face to Earth because of tidal locking, which slowed its spin." },
    ]);
    const after = await get(`/api/l/${a.id}/tree`);
    expect(Object.keys(after.nodes).length).toBe(Object.keys(treeA.nodes).length);
    expect(after.history[0].message).toBe(treeA.history[0].message);
    const treeB = await get(`/api/l/${b.id}/tree`);
    expect(Object.keys(treeB.nodes)).toHaveLength(4);
    for (const id of Object.keys(treeB.nodes)) expect(after.nodes[id]).toBeUndefined();

    // A replica of one library cannot sync into the other.
    const bytes = Doc.library("x").snapshotBytes();
    const foreign = await fetch(`${base}/api/l/${b.id}/sync/main`, { method: "POST", headers: { "x-library": a.id, "x-vv": "[]" }, body: bytes as BodyInit });
    expect(foreign.status).toBe(409);
    // A node of one library is not found under the other's prefix.
    expect((await send("GET", `/api/l/${b.id}/nodes/${encodeURIComponent(treeA.root)}/tree`)).status).toBe(404);
    expect((await send("GET", "/api/l/nosuchlibrary/tree")).status).toBe(404);

    // Link discovery in the second library proposes its own nodes only.
    const scan = await (await send("POST", `/api/l/${b.id}/links/scan`, { node: moon })).json();
    const nodeTargets = scan.suggestions.filter((x: { target: { kind: string } }) => x.target.kind === "node");
    expect(nodeTargets.length).toBeGreaterThan(0);
    for (const x of nodeTargets) expect(treeB.nodes[x.target.id]).toBeTruthy();
    expect(nodeTargets.map((x: { target: { id: string } }) => x.target.id)).toEqual([lockingB]);
    expect(treeB.nodes[tidesB].title).toBe("Tides");
    const related = await get(`/api/l/${b.id}/links/related?node=${encodeURIComponent(moon)}`);
    for (const r of related.related) expect(treeB.nodes[r.node]).toBeTruthy();
    const nearby = await get(`/api/l/${b.id}/links/nearby?node=${encodeURIComponent(moon)}&k=10`);
    expect(nearby.nearby.length).toBeGreaterThan(0);
    for (const n of nearby.nearby) expect(treeB.nodes[n.handle]).toBeTruthy();
    // And the first library's lists never name the second's nodes.
    const tidesA = treeA.nodes[treeA.root].children.find((c: string) => treeA.nodes[c].title === "Tides");
    const nearA = await get(`/api/l/${a.id}/links/nearby?node=${encodeURIComponent(tidesA)}&k=10`);
    for (const n of nearA.nearby) expect(treeA.nodes[n.handle]).toBeTruthy();
    // Pending entries and vectors are kept in each library's own directory.
    await new Promise((r) => setTimeout(r, 900));
    const pendingB = JSON.parse(readFileSync(join(data, "libraries", b.id, "links", "pending.json"), "utf8"));
    expect(Object.keys(pendingB)).toEqual([moon]);
    expect(existsSync(join(data, "libraries", a.id, "links", "pending.json"))).toBe(false);
    const vecB = JSON.parse(readFileSync(join(data, "libraries", b.id, "vectors", "nodes.json"), "utf8"));
    const vecA = JSON.parse(readFileSync(join(data, "libraries", a.id, "vectors", "nodes.json"), "utf8"));
    const ids = (v: unknown) => JSON.stringify(v);
    for (const id of Object.keys(treeB.nodes)) expect(ids(vecA)).not.toContain(id);
    for (const id of Object.keys(treeA.nodes)) expect(ids(vecB)).not.toContain(id);
    expect(existsSync(join(data, "links"))).toBe(false);
    expect(existsSync(join(data, "vectors"))).toBe(false);

    // Renamed, then deleted: moved aside, its routes gone; the last library stays.
    expect((await send("PATCH", `/api/libraries/${b.id}`, { title: "Second, renamed" })).status).toBe(200);
    expect((await get(`/api/l/${b.id}/tree`)).nodes[rootB].title).toBe("Second, renamed");
    const del = await send("DELETE", `/api/libraries/${b.id}`);
    expect(del.status).toBe(200);
    const { movedTo } = await del.json();
    expect(existsSync(join(movedTo, "main.loro"))).toBe(true);
    expect(existsSync(join(movedTo, "links", "pending.json"))).toBe(true);
    expect((await send("GET", `/api/l/${b.id}/state`)).status).toBe(404);
    expect((await get("/api/libraries")).libraries.map((l: { id: string }) => l.id)).toEqual([a.id]);
    expect((await send("DELETE", `/api/libraries/${a.id}`)).status).toBe(409);

    // A second server on the same data is refused while the first runs.
    const second = serve(data, starters, PORT + 1);
    expect(await second.exited).toBe(1);
    expect(second.out.join("")).toMatch(/Another server \(pid \d+, port 4804\)/);
    // Stopped, the first lets go of its lock; started again, the same library, nothing seeded twice.
    s.child.kill("SIGTERM");
    await s.exited;
    expect(existsSync(join(data, LOCK))).toBe(false);
    const again = serve(data, starters);
    await up();
    const listed = (await get("/api/libraries")).libraries;
    expect(listed.map((l: { id: string; nodes: number }) => [l.id, l.nodes])).toEqual([[a.id, Object.keys(treeA.nodes).length - 1]]);
    again.child.kill("SIGTERM");
    await again.exited;
  }, 60_000);
});
