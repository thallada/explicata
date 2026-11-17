/**
 * The migration from the single-library layout (server/migrateLibraries.ts), on data directories
 * written by older commits (tests/fixtures/migrate, made by running those commits' servers): pre/
 * by 626dc19, before documents went, main/ by c4d6856, just before libraries, mixed/ by the first
 * then the second.
 * The text, the notes, the flags and every reference must come across exactly; a dry run writes
 * nothing; a second run does nothing; a copy that differs leaves the data untouched; the server
 * will not open the old layout.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Libraries, layout, readIndex } from "../server/libraries";
import { LOCK } from "../server/lock";
import { migrateLibraries, type MigrateResult } from "../server/migrateLibraries";
import { resolveNode, targetKey } from "../src/core/links";
import { Doc, descendants, isStale, type NodeId, type Snap } from "../src/core/model";
import { digest } from "../src/core/text";

const FIXTURES = new URL("./fixtures/migrate/", import.meta.url).pathname;
const temps: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "ie-migrate-"));
  temps.push(d);
  return d;
};
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) c.kill("SIGKILL");
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

interface Edits {
  first: { made: Record<string, NodeId> };
  later?: { later: NodeId; laterLink: NodeId };
}

/** A copy of a fixture's data directory, and what was made in it. */
function fixture(name: string): { data: string; edits: Edits } {
  const data = temp();
  for (const f of ["library", "library.json", "links"]) cpSync(join(FIXTURES, name, f), join(data, f), { recursive: true });
  return { data, edits: JSON.parse(readFileSync(join(FIXTURES, name, "edits.json"), "utf8")) };
}

/** Every file under a directory, with a hash of its bytes: to show that nothing was written. */
function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

const run = (data: string, o: Parameters<typeof migrateLibraries>[1] = {}) => {
  const lines: string[] = [];
  const r = migrateLibraries(data, { log: (l) => lines.push(l), ...o });
  return { ...r, lines } as MigrateResult & { lines: string[] };
};

/** Titles from the root down to a node, its own last: what identifies a node in both libraries. */
function pathOf(snap: Snap, id: NodeId): string {
  const out: string[] = [];
  for (let x: NodeId | null = id; x; x = snap.nodes[x].parent) out.unshift(`${snap.nodes[x].kind}:${snap.nodes[x].title}#${snap.nodes[x].parent ? snap.nodes[snap.nodes[x].parent!].children.indexOf(x) : 0}`);
  return out.join(" / ");
}

/** The new library, read from its file on disk. */
const opened = (data: string, id: string) => Doc.load(readFileSync(join(data, "libraries", id, "main.loro")), "test");

describe.each(["pre", "main", "mixed"])("migrating data written by %s", (name) => {
  const { data, edits } = fixture(name);
  const before = files(data);
  const old = Doc.load(readFileSync(join(data, "library", "main.loro")), "test");
  const a = old.snap();
  const made = edits.first.made;

  // What the fixture's reviewer did not produce: a suggestion to a node, one rejected and one undecided.
  const pending = JSON.parse(readFileSync(join(data, "links", "pending.json"), "utf8"));
  const sugg = (quote: string, start: number, extra: object) => ({
    id: `old-${quote}`,
    node: made.second,
    range: [start, start + quote.length],
    quote,
    key: quote.toLowerCase(),
    target: { kind: "node", id: made.deep, path: ["Migration notes", "Second part", "Deep part"] },
    score: 0.9,
    tier: "suggest",
    why: "test",
    source: "library",
    title: "Deep part",
    description: null,
    kind: "title",
    ...extra,
  });
  const body2 = a.nodes[made.second].body;
  pending[made.second] = {
    at: 1,
    suggestions: [
      ...(pending[made.second]?.suggestions ?? []),
      sugg("Haskell Curry", body2.indexOf("Haskell Curry"), { review: { link: false, reason: "test: no", at: 2 } }),
      sugg("stars", body2.indexOf("stars"), {}),
    ],
  };
  // A suggestion whose node is gone is dropped.
  pending[made.doomed] = { at: 1, suggestions: [sugg("Soon", 0, { node: made.doomed })] };
  writeFileSync(join(data, "links", "pending.json"), JSON.stringify(pending));
  const withPending = files(data);

  it("refuses to open in the server, and a dry run verifies and writes nothing", () => {
    expect(layout(data).kind).toBe("old");
    expect(() => new Libraries(data, () => {}).open(() => {})).toThrow(/npm run migrate/);
    const r = run(data, { check: true });
    expect(r.problems).toEqual([]);
    expect(r.status).toBe("checked");
    expect(r.lines.join("\n")).toMatch(/verified: same tree/);
    expect(r.lines.join("\n")).toMatch(/Nothing was written/);
    expect(files(data)).toEqual(withPending);
    expect(before).not.toEqual(withPending); // (the test's own pending entries, above)
  });

  it("migrates: the same tree, text, notes, flags and anchors under new ids, in a new library", () => {
    const r = run(data);
    expect(r.problems).toEqual([]);
    expect(r.status).toBe("migrated");
    expect(layout(data).kind).toBe("libraries");
    const index = readIndex(join(data, "libraries"));
    expect(index).toEqual([{ id: r.library, title: "Library", created: expect.any(String) }]);
    // The old files, moved aside unchanged.
    const backup = files(r.backup!);
    for (const [f, h] of Object.entries(withPending)) expect(backup[f], f).toBe(h);
    expect(existsSync(join(data, "library"))).toBe(false);

    const neu = opened(data, r.library!);
    const b = neu.snap();
    expect(neu.libraryId).toBe(r.library);
    expect(neu.libraryId).not.toBe(old.libraryId);
    expect(b.library).toBe(true);
    // Node for node, by place: the same titles, bodies, kinds, authors, locks, notes and anchors.
    const rows = (s: Snap) =>
      Object.keys(s.nodes)
        .map((id) => {
          const n = s.nodes[id as NodeId];
          return [pathOf(s, id as NodeId), n.kind, n.title, n.body, n.by, n.pinned, n.form ?? null, n.lens ?? null, n.articles ?? false, JSON.stringify(n.wanchor ?? null), (n.nolink ?? []).join("|"), n.anchors.filter((x) => x.end > x.start).map((x) => `${x.start}-${x.end}:${x.quote}:${x.text}`).join("|"), isStale(s, id as NodeId)].join("\u0000");
        })
        .sort();
    expect(rows(b)).toEqual(rows(a));
    // No old id is left anywhere in the new library's nodes.
    const oldIds = new Set(Object.keys(a.nodes));
    for (const n of Object.values(b.nodes)) {
      expect(oldIds.has(n.id)).toBe(false);
      if (n.ref?.kind === "node" && n.ref.id) expect(b.nodes[n.ref.id], `${n.title}'s target`).toBeTruthy();
    }
    // A history of its own: nothing from before.
    expect(neu.loro.getAllChanges().size).toBe(1);
  });

  it("carries what the tests made: the root's note, locks, the article and its note, the orphan, declines", () => {
    const r = migrateLibraries(data, { log: () => {} }); // a second run: nothing to do
    expect(r.status).toBe("nothing");
    const id = readIndex(join(data, "libraries"))[0].id;
    const b = opened(data, id).snap();
    const find = (title: string, kind = "section") => Object.values(b.nodes).find((n) => n.title === title && n.kind === kind)!;
    const root = b.nodes[b.root];
    expect(root.body).toBe("Everything I keep. Root words worth a note sit here.");
    const rootNote = root.children.map((c) => b.nodes[c]).find((n) => n.kind === "note")!;
    expect(rootNote.anchors.map((x) => x.text)).toEqual(["Root words"]);
    expect(rootNote.body).toBe("A note on the library root itself.");
    // The fixtures were written when the project was called Infinispand.
    expect(b.nodes[root.children[0]].title).toBe("Infinispand");
    expect(b.nodes[root.children[1]].title).toBe("Migration notes");
    // Locks: set on a model's node, taken off a person's.
    const seed = find("Infinispand");
    expect(b.nodes[seed.children.find((c) => b.nodes[c].kind === "section")!].pinned).toBe(true);
    expect(find("Migration notes").pinned).toBe(false);
    // The Wikipedia container, its article and the note on the article.
    const box = root.children.map((c) => b.nodes[c]).find((n) => n.articles)!;
    expect(box.title).toBe("Wikipedia");
    const art = b.nodes[box.children[0]];
    expect(art.ref).toEqual({ kind: "wiki", title: "Octopus", lang: "en", pageId: 1200106 });
    expect(b.nodes[art.children[0]].wanchor?.q).toBe("two thirds of their neurons");
    // The orphan keeps its text; the titled note its title; the section under a note its place.
    const top = find("Migration notes");
    const notes = top.children.map((c) => b.nodes[c]).filter((n) => n.kind === "note");
    expect(notes.map((n) => n.body)).toContain("Its words are about to go.");
    expect(find("Hearts, titled", "note").anchors[0].text).toBe("three hearts");
    expect(b.nodes[find("A section under a note").parent!].form).toBe("passage");
    expect(find("Second part").nolink).toContain("recursion");
  });

  it("rewrites every node target to the new ids, and keeps a broken one's hint", () => {
    const id = readIndex(join(data, "libraries"))[0].id;
    const b = opened(data, id).snap();
    const find = (title: string) => Object.values(b.nodes).find((n) => n.title === title)!;
    // The links the tests made, in the top they made.
    const mine = new Set(descendants(b, find("Migration notes").id));
    const linkOn = (quote: string) => Object.values(b.nodes).find((n) => mine.has(n.id) && n.kind === "note" && n.anchors.some((x) => x.text === quote) && n.ref)!;
    const target = (quote: string) => {
      const n = linkOn(quote);
      expect(n.ref?.kind).toBe("node");
      return resolveNode(b, n.ref as never, n.id);
    };
    expect(target("Fixed points")).toBe(Object.values(b.nodes).find((n) => n.parent === b.root && n.title === "Fixed points")!.id);
    expect(b.nodes[target("Haskell Curry")!].title).toBe("Hearts, titled");
    expect(linkOn("Haskell Curry").ref).toMatchObject({ quote: "three hearts", path: ["Migration notes"] });
    expect(linkOn("Fred Hoyle").ref).toEqual({ kind: "wiki", title: "Fred Hoyle", lang: "en" });
    expect(linkOn("plain words").ref).toEqual({ kind: "url", url: "https://example.org/page", title: "An example" });
    const card = find("A card");
    expect(b.nodes[resolveNode(b, card.ref as never, card.id)!].parent).toBe(Object.values(b.nodes).find((n) => n.parent === b.root && n.title.startsWith("Octopus minds"))!.id);
    // From a starter tree into the new top.
    const octo = Object.values(b.nodes).find((n) => n.parent === b.root && n.title.startsWith("Octopus minds"))!;
    const octoFirst = b.nodes[octo.children.find((c) => b.nodes[c].kind === "section")!];
    const fromOcto = octoFirst.children.map((c) => b.nodes[c]).find((n) => n.ref?.kind === "node")!;
    expect(b.nodes[resolveNode(b, fromOcto.ref as never, fromOcto.id)!].title).toBe("Deep part");
    // The link to the deleted section: still naming nothing, with its titles from the root and no id.
    const broken = linkOn("doomed section");
    expect(broken.ref).toEqual({ kind: "node", path: ["Migration notes", "Second part", "Doomed"] });
    expect(resolveNode(b, broken.ref as never, broken.id)).toBeNull();
    if (name === "mixed") {
      // The link the newer code made, to a top renamed since.
      expect(b.nodes[target("stars")!].title).toBe("Octopus minds, renamed");
    }
  });

  it("re-keys the reviewer's verdicts, people's decisions and pending suggestions to the new ids", () => {
    const id = readIndex(join(data, "libraries"))[0].id;
    const b = opened(data, id).snap();
    const carried = JSON.parse(readFileSync(join(data, "libraries", id, "links", "pending.json"), "utf8")) as Record<string, { suggestions: { id: string; node: NodeId; range: [number, number]; quote: string; target: { kind: string; id?: NodeId }; review?: { link: boolean }; decided?: { link: boolean } }[] }>;
    const all = Object.entries(carried).flatMap(([k, e]) => e.suggestions.map((s) => ({ k, ...s })));
    // Every entry under its new node, its words where they were, its id made from the new ids.
    for (const s of all) {
      expect(s.k).toBe(s.node);
      expect(b.nodes[s.node].body.slice(s.range[0], s.range[1])).toBe(s.quote);
      expect(s.id).toBe(digest(`${s.node}\u0000${s.range[0]}\u0000${s.range[1]}\u0000${targetKey(s.target as never)}`));
    }
    const by = (quote: string) => all.find((s) => s.quote === quote)!;
    expect(by("triple-alpha process").review?.link).toBe(true);
    expect(by("triple-alpha process").decided?.link).toBe(true);
    expect(by("octopus").decided?.link).toBe(false);
    expect(by("Haskell Curry").review?.link).toBe(false);
    expect(b.nodes[by("Haskell Curry").target.id!].title).toBe("Deep part");
    expect(b.nodes[by("stars").target.id!].title).toBe("Deep part");
    expect(by("stars").review).toBeUndefined();
    expect(all.some((s) => s.quote === "Soon")).toBe(false); // its node was deleted
    // And the server opens the result as it is.
    const libs = new Libraries(data, () => {}).open(() => {
      throw new Error("must not seed a migrated library");
    });
    expect(libs.first().id).toBe(id);
  });
});

describe("the migration's guards", () => {
  it("leaves the data untouched when the copy differs, and says where", () => {
    const { data } = fixture("pre");
    const before = files(data);
    const r = run(data, {
      tamper: (doc) => {
        const snap = doc.snap();
        const id = Object.values(snap.nodes).find((n) => n.title === "Deep part")!.id;
        doc.apply([{ op: "update", id, body: "Changed." }], "tamper");
      },
    });
    expect(r.status).toBe("failed");
    expect(r.problems.some((p) => /“Library › Migration notes › Second part › Deep part”: body differs/.test(p))).toBe(true);
    expect(r.lines.join("\n")).toMatch(/FAILED: .*nothing was written/);
    expect(files(data)).toEqual(before);
    expect(readdirSync(data).sort()).toEqual(["library", "library.json", "links"]);
  });

  it("finishes a migration that stopped before moving the old files, and cleans a leftover temporary directory", () => {
    const { data } = fixture("main");
    mkdirSync(join(data, "libraries.tmp-20200101-000000", "x"), { recursive: true });
    const first = run(data);
    expect(first.status).toBe("migrated");
    expect(readdirSync(data).some((f) => f.startsWith("libraries.tmp-"))).toBe(false);
    // As if the run had stopped after the commit step: the old files back in place.
    cpSync(join(first.backup!, "library"), join(data, "library"), { recursive: true });
    cpSync(join(first.backup!, "links"), join(data, "links"), { recursive: true });
    expect(layout(data).kind).toBe("unfinished");
    expect(() => new Libraries(data, () => {}).open(() => {})).toThrow(/did not finish/);
    const check = files(data);
    expect(run(data, { check: true }).status).toBe("checked");
    expect(files(data)).toEqual(check);
    const again = run(data);
    expect(again.status).toBe("finished");
    expect(layout(data).kind).toBe("libraries");
    expect(existsSync(join(again.backup!, "library", "main.loro"))).toBe(true);
    expect(run(data).status).toBe("nothing");
  });

  it("carries open conflicts with their nodes renamed, reports other branches and unknown fields, drops slugs", () => {
    const data = temp();
    const old = Doc.library("old");
    const [top, sec] = old.apply(
      [
        { op: "create", parent: old.snap().root, title: "Top", body: "Text." },
        { op: "create", parent: "$0" as NodeId, title: "Section", body: "More." },
      ],
      "make",
    ).created;
    old.begin("raw", "human");
    old.tree.getNodeByID(top)!.data.set("slug", "top");
    old.tree.getNodeByID(sec)!.data.set("color", "red");
    old.conflictMap.set("c1", JSON.stringify({ id: "c1", type: "edit-edit", node: sec, field: "body", title: "Section", base: "b", a: "x", b: "y", merged: "xy", status: "open" }));
    old.conflictMap.set("c2", JSON.stringify({ id: "c2", type: "edit-edit", node: sec, field: "title", title: "Section", base: "b", a: "x", b: "y", merged: "xy", status: "resolved" }));
    old.commit("raw", "human");
    mkdirSync(join(data, "library"));
    writeFileSync(join(data, "library", "main.loro"), old.snapshotBytes());
    writeFileSync(join(data, "library", "draft.loro"), old.snapshotBytes());
    const r = run(data);
    expect(r.problems).toEqual([]);
    const text = r.lines.join("\n");
    expect(text).toMatch(/branches other than main, not carried .*: draft/);
    expect(text).toMatch(/fields no version of this program reads, not carried: color \(1\)/);
    expect(text).not.toMatch(/slug/);
    expect(text).toMatch(/1 open carried, 1 resolved left behind/);
    const neu = opened(data, r.library!);
    const s = neu.snap();
    const newSec = Object.values(s.nodes).find((n) => n.title === "Section")!.id;
    expect(neu.conflicts()).toEqual([expect.objectContaining({ id: "c1", node: newSec, status: "open" })]);
    expect(existsSync(join(r.backup!, "library", "draft.loro"))).toBe(true);
  });

  it("does nothing on an empty directory, and refuses the layout from before the single library", () => {
    const empty = temp();
    expect(run(empty).status).toBe("nothing");
    expect(readdirSync(empty)).toEqual([]);
    const older = temp();
    mkdirSync(join(older, "docs", "tides"), { recursive: true });
    const r = run(older);
    expect(r.status).toBe("refused");
    expect(r.problems[0]).toMatch(/c4d6856/);
  });

  it("refuses to run while a server holds the data's lock; a dry run and a stale lock are no obstacle", async () => {
    const data = temp();
    cpSync(join(FIXTURES, "pre", "library"), join(data, "library"), { recursive: true });
    // A stand-in server: a process whose command line names server/index.ts.
    const server = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "server/index.ts"], { stdio: "ignore" });
    children.push(server);
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(join(data, LOCK), JSON.stringify({ pid: server.pid, port: 4999 }));
    const r = run(data);
    expect(r.status).toBe("refused");
    expect(r.problems[0]).toMatch(new RegExp(`pid ${server.pid}, port 4999`));
    expect(run(data, { check: true }).status).toBe("checked");
    server.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    expect(run(data).status).toBe("migrated");
  });
});
