/**
 * Builds the old-layout data directories that tests/migrateLibraries.test.ts migrates, by running
 * the server of an older commit on an empty data directory and editing it over HTTP, as a page or
 * an outside agent would. The result is committed beside this file, so the tests need no git and no
 * server; run this again only to rebuild them.
 *
 *   npx tsx tests/fixtures/migrate/make.ts <scratch dir>
 *
 * It makes, in <scratch dir>, a git worktree for each commit (node_modules linked to this
 * checkout's), runs each server with IE_LLM=mock IE_WIKI=mock IE_EMBED=fake on ports 4800-4802, and
 * writes into tests/fixtures/migrate/:
 *
 *   pre/     written by 626dc19 (before step 1: documents with slugs, node targets with `doc`)
 *   main/    written by c4d6856 (no documents; node targets by titles from the root)
 *   mixed/   pre/, then opened and edited by c4d6856 (old and new targets side by side)
 *
 * Each holds library/main.loro, library.json and links/pending.json; edits.json beside them names
 * what was made, for the tests to check by.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const here = resolve(new URL(".", import.meta.url).pathname);
const repo = resolve(here, "../../..");
const scratch = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("give a scratch directory");
mkdirSync(scratch, { recursive: true });

interface Node {
  id: string;
  parent: string | null;
  kind: string;
  title: string;
  body: string;
  slug?: string;
  children: string[];
  anchors: { text: string }[];
  ref?: unknown;
  articles?: boolean;
}
interface Tree {
  root: string;
  nodes: Record<string, Node>;
}

function worktree(commit: string): string {
  const dir = join(scratch, `ie-${commit}`);
  if (!existsSync(dir)) {
    execFileSync("git", ["-C", repo, "worktree", "add", "--detach", dir, commit], { stdio: "inherit" });
    symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"));
  }
  return dir;
}

async function serve(dir: string, data: string, port: number, library: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: dir,
    env: { ...process.env, IE_PROD: "1", IE_LLM: "mock", IE_MOCK_DELAY: "0", IE_WIKI: "mock", IE_EMBED: "fake", IE_DATA: data, IE_LIBRARY: library, PORT: String(port), IE_USER: "fixture" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/state`)).ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill("SIGTERM");
  throw new Error(`the server in ${dir} did not start`);
}

async function stop(child: ChildProcess) {
  const done = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await done;
}

function client(port: number) {
  const base = `http://127.0.0.1:${port}`;
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(base + path, init);
    const body = await res.json();
    if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
    return body;
  };
  const post = (path: string, body: unknown) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    tree: () => call("/api/tree") as Promise<Tree>,
    ops: async (ops: unknown[], actor: "human" | "llm" = "human") => (await post("/api/ops", { ops, actor, author: "fixture", message: "fixture" })).created as string[],
    post,
  };
}

const byTitle = (t: Tree, parent: string, title: string) => {
  const id = t.nodes[parent].children.find((c) => t.nodes[c].title === title);
  if (!id) throw new Error(`no “${title}” under ${t.nodes[parent].title}`);
  return id;
};
const top = (t: Tree, title: string) => byTitle(t, t.root, title);

/** A node target as each version's page made it: with the document's slug and the titles below it, or the titles from the root. */
function refTo(t: Tree, id: string, old: boolean, quote?: string) {
  const path: string[] = [];
  let sec = id;
  while (t.nodes[sec].kind === "note") sec = t.nodes[sec].parent!;
  for (let x = t.nodes[sec]; x.parent; x = t.nodes[x.parent]) path.unshift(x.title);
  const r: Record<string, unknown> = { kind: "node", id };
  if (old) {
    r.doc = t.nodes[top(t, path[0])].slug;
    r.path = path.slice(1);
  } else r.path = path;
  if (quote !== undefined) r.quote = quote;
  return r;
}

/** The edits both versions get: a tree of every kind of node, link, flag and decision. */
async function edits(port: number, old: boolean) {
  const c = client(port);
  let t = await c.tree();
  const seed = top(t, "Infinispand");
  const octo = top(t, "Octopus minds");
  const fixed = top(t, "Fixed points");
  const made: Record<string, string> = {};

  // The root's own text, and a note on it (anchored in the root's body).
  await c.ops([{ op: "update", id: t.root, body: "Everything I keep. Root words worth a note sit here." }]);
  [made.rootNote] = await c.ops([{ op: "create", parent: t.root, kind: "note", quote: "Root words", form: "note", lens: "why", body: "A note on the library root itself." }]);

  // A new top with sections, notes on notes, a section under a note, a titled note.
  [made.top, made.first, made.second, made.deep] = await c.ops(
    [
      { op: "create", parent: t.root, index: 1, title: "Migration notes", body: "Alpha beta gamma. The octopus has three hearts. Delta epsilon zeta." },
      { op: "create", parent: "$0", title: "First part", body: "Kepler read about Fixed points. Some plain words here. Freddie Mercury sang while a eukaryote swam past bacteria near the planet Mercury." },
      { op: "create", parent: "$0", title: "Second part", body: "Haskell Curry and Fred Hoyle wrote about recursion and stars. The Hoyle state powers the triple-alpha process in stars, and the eukaryote watches." },
      { op: "create", parent: "$2", title: "Deep part", body: "Deep text that points elsewhere and at the doomed section." },
    ],
    "llm",
  );
  [made.gloss, made.passage] = await c.ops(
    [
      { op: "create", parent: made.top, kind: "note", quote: "three hearts", form: "gloss", lens: "define", body: "Two pump blood through the gills." },
      { op: "create", parent: made.top, kind: "note", quote: "Alpha beta gamma.", form: "passage", body: "A passage about the first letters. It has inner words." },
    ],
    "llm",
  );
  [made.inner] = await c.ops([{ op: "create", parent: made.passage, kind: "note", quote: "inner words", form: "note", lens: "example", body: "A note on a note." }], "llm");
  [made.underNote] = await c.ops([{ op: "create", parent: made.passage, kind: "section", title: "A section under a note", body: "It hangs from the passage." }], "llm");
  await c.ops([{ op: "update", id: made.gloss, title: "Hearts, titled" }]);

  // An orphan: a note whose words are then deleted.
  [made.orphan] = await c.ops([{ op: "create", parent: made.top, kind: "note", quote: "Delta epsilon", form: "note", body: "Its words are about to go." }], "llm");
  await c.ops([{ op: "update", id: made.top, body: "Alpha beta gamma. The octopus has three hearts. Zeta." }]);

  t = await c.tree();
  const octoFirst = t.nodes[octo].children.find((x) => t.nodes[x].kind === "section")!;
  // Links of every kind: to another top, to Wikipedia, to the web, a note that also links, a card, to a note.
  [made.toFixed, made.toKepler, made.toWeb, made.toGloss] = await c.ops([
    { op: "create", parent: made.first, kind: "note", quote: "Fixed points", ref: refTo(t, fixed, old) },
    { op: "create", parent: made.first, kind: "note", quote: "Kepler", ref: { kind: "wiki", title: "Johannes Kepler", lang: "en" } },
    { op: "create", parent: made.first, kind: "note", quote: "plain words", ref: { kind: "url", url: "https://example.org/page", title: "An example" } },
    { op: "create", parent: made.second, kind: "note", quote: "Haskell Curry", ref: refTo(t, made.gloss, old, "three hearts") },
  ]);
  [made.noteLink] = await c.ops([{ op: "create", parent: made.second, kind: "note", quote: "Fred Hoyle", form: "note", body: "He named the Big Bang.", ref: { kind: "wiki", title: "Fred Hoyle", lang: "en" } }], "llm");
  [made.card] = await c.ops([{ op: "create", parent: made.second, title: "A card", body: "", ref: refTo(t, octoFirst, old) }]);
  [made.fromOcto] = await c.ops([{ op: "create", parent: octoFirst, kind: "note", quote: t.nodes[octoFirst].body.split(" ").slice(0, 2).join(" "), ref: refTo(t, made.deep, old) }]);

  // A broken link: its target deleted, so only its hint is left.
  [made.doomed] = await c.ops([{ op: "create", parent: made.second, title: "Doomed", body: "Soon gone." }]);
  t = await c.tree();
  [made.toDoomed] = await c.ops([{ op: "create", parent: made.deep, kind: "note", quote: "doomed section", ref: refTo(t, made.doomed, old) }]);
  await c.ops([{ op: "delete", id: made.doomed }]);

  // Locks: one set on a model's node, one taken off a person's.
  const seedFirst = t.nodes[seed].children.find((x) => t.nodes[x].kind === "section")!;
  made.locked = seedFirst;
  await c.ops([{ op: "update", id: seedFirst, pinned: true }]);
  await c.ops([{ op: "update", id: made.top, pinned: false }]);

  // A declined phrase, by op.
  await c.ops([{ op: "update", id: made.second, nolink: ["recursion"] }]);

  // A Wikipedia article's node with an annotation on it.
  [made.articles, made.article, made.annotation] = await c.ops([
    { op: "create", parent: t.root, kind: "section", title: "Wikipedia", body: "", articles: true },
    { op: "create", parent: "$0", kind: "section", title: "Octopus", body: "", ref: { kind: "wiki", title: "Octopus", lang: "en", pageId: 1200106 } },
    { op: "create", parent: "$1", kind: "note", body: "Two thirds of the neurons are in the arms.", form: "note", wanchor: { sec: ["Description", "Nervous system and senses"], q: "two thirds of their neurons", pre: "with roughly ", post: " in the arms", rev: 1 } },
  ]);

  // The reviewer's verdicts (the mock links names and rejects single words), approved links made,
  // a person's decline and decision, and plain pending suggestions.
  const scan = await c.post("/api/links/scan", { node: made.second, review: "all" });
  const approved = (scan.apply ?? []).map((s: { id: string }) => s.id);
  if (approved.length) await c.post("/api/links/accept", { ids: approved, author: "reviewer" });
  await c.post("/api/links/scan", { node: made.first });
  const pending = await c.post("/api/links/scan", { node: made.top, save: true });
  const listed = (await (await fetch(`http://127.0.0.1:${port}/api/links/pending?all=1`)).json()).suggestions as { id: string; quote: string; review?: unknown; decided?: unknown }[];
  const open = listed.filter((s) => !s.review && !s.decided);
  if (open[0]) await c.post("/api/links/reject", { ids: [open[0].id], author: "fixture" });
  if (open[1]) await c.post("/api/links/decide", { ids: [open[1].id], link: false, by: "fixture" });
  return { made, scanned: { first: scan.suggestions.length, approved: approved.length, top: pending.suggestions.length, listed: listed.length } };
}

/** What c4d6856 adds to a library pre/ wrote: a new link by root titles, a rename, a new node. */
async function laterEdits(port: number) {
  const c = client(port);
  const t = await c.tree();
  const mig = top(t, "Migration notes");
  const second = byTitle(t, mig, "Second part");
  const octo = top(t, "Octopus minds");
  await c.ops([{ op: "update", id: octo, title: "Octopus minds, renamed" }]);
  const t2 = await c.tree();
  const [later] = await c.ops([{ op: "create", parent: second, title: "Added later", body: "Written by the newer code, linking stars." }]);
  const [laterLink] = await c.ops([{ op: "create", parent: later, kind: "note", quote: "stars", ref: refTo(t2, octo, false) }]);
  return { later, laterLink };
}

async function build(name: string, commit: string, port: number, from?: string, then?: string) {
  const data = mkdtempSync(join(scratch, `data-${name}-`));
  if (from) cpSync(from, data, { recursive: true });
  const lib = mkdtempSync(join(scratch, "lib-"));
  const dir = worktree(commit);
  for (const f of ["octopus-minds.md", "fixed-points.md"]) cpSync(join(dir, "library", f), join(lib, f));
  const child = await serve(dir, data, port, lib);
  let info: unknown;
  try {
    info = from ? await laterEdits(port) : await edits(port, commit === "626dc19");
  } finally {
    await stop(child);
  }
  const out = join(here, name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const f of ["library", "library.json", "links"]) if (existsSync(join(data, f))) cpSync(join(data, f), join(out, f), { recursive: true });
  const prior = then ? JSON.parse(execFileSync("cat", [join(here, then, "edits.json")]).toString()) : {};
  writeFileSync(join(out, "edits.json"), JSON.stringify({ commit, ...prior, ...(from ? { later: info } : { first: info }) }, null, 2) + "\n");
  rmSync(lib, { recursive: true, force: true });
  return data;
}

const pre = await build("pre", "626dc19", 4800);
const main = await build("main", "c4d6856", 4801);
const mixed = await build("mixed", "c4d6856", 4802, pre, "pre");
for (const d of [pre, main, mixed]) rmSync(d, { recursive: true, force: true });
console.log("fixtures written to", here);
