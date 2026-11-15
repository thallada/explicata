/**
 * From one Loro database per document to one library, once, on the first start that finds the
 * older layout and no library:
 *
 *   <data>/docs/<id>/<branch>.loro   the per-document layout
 *   <data>/<branch>.loro             the single-document layout before it (the first document)
 *
 * Every document's main branch is imported into one new Loro database, histories and all: each
 * document's ops keep their ids, so its notes stay anchored, its open conflicts stay open, and
 * every commit it ever made can still be checked out and verified (a checkout from before the
 * library shows that document alone, as it stood). One commit then makes the Library root and
 * moves each document's root under it, with its old id as its slug. A document that shares
 * history with one already imported (a duplicate, which began as a byte copy) cannot be imported
 * beside it without merging into it, so it is copied in as content instead.
 *
 * The library is written to a temporary directory and renamed into place; only then is the old
 * `docs` directory renamed to `docs.migrated-<time>` (and flat files moved into
 * `flat.migrated-<time>`). Nothing in them is changed or deleted.
 * Branches other than main are not carried over; the log and migrated.json list them.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { Doc, LIBRARY_TITLE, SLUG, initRoot, randomPeer, type NodeId } from "../src/core/model";
import { encodeVV } from "../src/core/repo";
import { SEED_SLUG } from "../src/core/seed";

interface Source {
  id: string;
  dir: string | null;
  main: Uint8Array;
  /** Every branch's version, for browsers checking what they hold against what was migrated. */
  versions: Record<string, string>;
  uid: string | null;
  changed: number;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");

function sources(data: string, log: (m: string) => void): Source[] {
  const out: Source[] = [];
  const read = (id: string, dir: string, files: string[]) => {
    const versions: Record<string, string> = {};
    let main: Uint8Array | null = null;
    for (const f of files) {
      const bytes = readFileSync(join(dir, f));
      const name = decodeURIComponent(f.slice(0, -5));
      if (name === "main") main = bytes;
      try {
        versions[name] = encodeVV(Doc.load(bytes, "migration").loro.version().toJSON());
      } catch (err) {
        log(`migration: ${join(dir, f)} could not be read (${err instanceof Error ? err.message : err}); left as it is`);
      }
    }
    if (!main) return log(`migration: ${dir} has no main.loro; left as it is`);
    let uid: string | null = null;
    try {
      uid = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).uid ?? null;
    } catch {
      /* the single-document layout had no meta.json */
    }
    out.push({ id, dir, main, versions, uid, changed: statSync(join(dir, "main.loro")).mtimeMs });
  };
  const docs = join(data, "docs");
  if (existsSync(docs)) {
    for (const id of readdirSync(docs).sort()) {
      const dir = join(docs, id);
      if (!SLUG.test(id) || !statSync(dir).isDirectory()) continue;
      read(id, dir, readdirSync(dir).filter((f) => f.endsWith(".loro")));
    }
  }
  const flat = readdirSync(data).filter((f) => f.endsWith(".loro"));
  if (flat.length) {
    if (out.some((s) => s.id === SEED_SLUG)) log(`migration: ${flat.join(", ")} in ${data} left aside: docs/${SEED_SLUG} is the newer copy`);
    else read(SEED_SLUG, data, flat);
  }
  // The first document first, then the order the documents menu showed: most recently changed first.
  return out.sort((a, b) => (a.id === SEED_SLUG ? -1 : b.id === SEED_SLUG ? 1 : b.changed - a.changed));
}

/** Build the library from the older layout. Returns false if there was nothing to migrate. */
export function migrate(data: string, log: (m: string) => void): boolean {
  if (!existsSync(data)) return false;
  const found = sources(data, log);
  if (!found.length) return false;

  const lib = new Doc(new LoroDoc(), "migration");
  lib.loro.setPeerId(randomPeer());
  const plan: { src: Source; snap: ReturnType<Doc["snap"]>; root: NodeId; kept: boolean; commits: number; conflicts: number }[] = [];
  for (const src of found) {
    const old = Doc.load(src.main, "migration");
    const snap = old.snap();
    const ours = lib.loro.version().toJSON();
    const shared = [...old.loro.version().toJSON().keys()].some((peer) => ours.has(peer));
    if (!shared) lib.loro.import(src.main);
    const commits = [...old.loro.getAllChanges().values()].reduce((n, cs) => n + cs.length, 0);
    plan.push({ src, snap, root: snap.root, kept: !shared, commits, conflicts: old.conflicts().filter((c) => c.status === "open").length });
  }

  const message = `Gather ${plan.length} document${plan.length > 1 ? "s" : ""} into the library`;
  lib.begin(message, "human", "migrate");
  const tree = lib.tree;
  const root = tree.createNode();
  initRoot(root, LIBRARY_TITLE, "", "human");
  root.data.set("library", true);
  lib.loro.getMap("meta").set("library", randomPeer().toString(36));
  for (const p of plan) {
    if (p.kept) {
      tree.move(p.root, root.id, root.children()?.length ?? 0);
      tree.getNodeByID(p.root)!.data.set("slug", p.src.id);
    } else {
      lib.graft(p.snap, p.snap.root, root.id, { slug: p.src.id });
    }
  }
  lib.reread();
  lib.commit(message, "human", "migrate");

  // Every document must have come across whole before anything is written. A copied one can
  // differ only by anchors that were already lost (an orphaned note's empty span is not copied).
  const snap = lib.snap();
  for (const p of plan) {
    const id = snap.nodes[root.id].children.find((c) => snap.nodes[c].slug === p.src.id);
    const same = !!id && lib.shape(snap, id) === lib.shape(p.snap, p.snap.root);
    if (!same && (p.kept || !id)) throw new Error(`migration: “${p.src.id}” did not come across intact; nothing was changed on disk`);
    if (!same) log(`migration: “${p.src.id}” was copied without the empty spans of its orphaned notes`);
  }

  const when = stamp();
  const moved = existsSync(join(data, "docs")) ? `docs.migrated-${when}` : null;
  const flatFiles = readdirSync(data).filter((f) => f.endsWith(".loro"));
  const flatMoved = flatFiles.length ? `flat.migrated-${when}` : null;
  const record = {
    at: new Date().toISOString(),
    from: [moved, flatMoved].filter(Boolean),
    docs: plan.map((p) => ({
      slug: p.src.id,
      uid: p.src.uid,
      title: p.snap.nodes[p.snap.root].title,
      nodes: Object.keys(p.snap.nodes).length,
      history: p.kept ? "kept" : "copied",
      commits: p.commits,
      openConflicts: p.kept ? p.conflicts : 0,
      versions: p.src.versions,
    })),
    branchesNotCarried: plan.flatMap((p) => Object.keys(p.src.versions).filter((b) => b !== "main").map((b) => ({ doc: p.src.id, branch: b }))),
  };

  const tmp = join(data, `library.tmp-${stamp()}`);
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, "main.loro"), lib.snapshotBytes());
  writeFileSync(join(tmp, "migrated.json"), JSON.stringify(record, null, 2) + "\n");
  renameSync(tmp, join(data, "library"));

  // Only now that the library is in place does the old layout move aside, renamed, untouched.
  if (moved) renameSync(join(data, "docs"), join(data, moved));
  if (flatMoved) {
    mkdirSync(join(data, flatMoved));
    for (const f of flatFiles) renameSync(join(data, f), join(data, flatMoved, f));
  }
  const kept = [moved, flatMoved].filter(Boolean).map((d) => join(data, d!)).join(" and ");

  log(`migration: built ${join(data, "library", "main.loro")} from ${plan.length} document${plan.length > 1 ? "s" : ""}:`);
  for (const d of record.docs) {
    log(
      `  /doc/${d.slug}  “${d.title}”  ${d.nodes} nodes, ${d.history === "kept" ? `history kept (${d.commits} changes)` : "copied as content (it shares history with another document, so its history is not carried)"}${d.openConflicts ? `, ${d.openConflicts} open conflict${d.openConflicts > 1 ? "s" : ""}` : ""}`,
    );
  }
  if (record.branchesNotCarried.length) {
    log(`migration: branches other than main were not carried over (they are still in ${kept}):`);
    for (const b of record.branchesNotCarried) log(`  ${b.doc}: ${b.branch}`);
  }
  log(`migration: the old files are in ${kept}, unchanged.`);
  return true;
}
