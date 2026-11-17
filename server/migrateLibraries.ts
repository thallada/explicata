/**
 * From the single-library layout to the libraries layout (libraries.ts), once, when asked:
 *
 *   npm run migrate                  migrate IE_DATA (or .data)
 *   npm run migrate -- --check       a dry run: build, verify and report, writing nothing
 *   npm run migrate -- [--check] DIR another data directory
 *
 * The library's text is what must come across, not its history: the tree is copied, in this
 * process, into a new library with a new id and a history of one commit ("Bring the library over"),
 * with `Doc.graft`, which carries everything that is content: titles, bodies, kinds, notes with
 * their anchors (a note on the root's own text too), who wrote each node, locks, forms and lenses,
 * targets, declined phrases, the Wikipedia container and its articles' notes, the order of
 * everything, and the hashes each node was last reconciled with (so nothing turns stale). Every
 * reference to a node is then rewritten through the map of old ids to new: node targets (links,
 * cards) get the new id and the titles down to it from the root, as the page would write them; a
 * target that already named nothing keeps its hint, put in today's form (an old target's document
 * slug becomes that top's title). Open conflicts come along with their ids rewritten. The link
 * reviewer's verdicts, people's decisions and pending suggestions (links/pending.json) are
 * re-keyed to the new ids; vectors are rebuilt when first needed.
 *
 * Before anything is written, the copy is checked against the original node by node: the same tree
 * (each node's parent and children, in order), the same number of nodes, the same title, body,
 * kind, author, lock, form, lens, flags, declined phrases, anchors (start, end, quoted and current
 * words) and staleness for each, every target that found its node before finding the same node
 * (by its new id) now, and the same number of open conflicts. It is checked again after being
 * written out and read back, and again from the file on disk. Any difference stops the migration
 * with a report, and the data directory is left as it was.
 *
 * Then: the libraries are written to libraries.tmp-<time>/ and renamed to libraries/ (the one step
 * that commits), and the old files (library/, library.json, links/, vectors/) are moved, unchanged,
 * into backup-<time>/. Nothing is deleted. wiki-cache/ and models/ stay where they are.
 *
 * Not carried: history (every commit before), branches other than main (they stay in the backup,
 * and the report names them), resolved conflicts, the empty spans of notes already orphaned (the
 * notes themselves come across), fields of a node no version of this program reads (named in the
 * report; `slug`, from before documents went, is dropped silently), and vectors.
 *
 * Run again, it does nothing (the libraries layout is there and no old files are left). If a
 * migration stopped after the commit step, a second run only moves the old files aside. It will
 * not run while a server has the data directory open (lock.ts).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { nodeRef, resolveNode, targetKey } from "../src/core/links";
import { Doc, NOLINK, ancestors, isStale, label, notesOf, sections, staleness, topOf, type Conflict, type NodeId, type NodeSnap, type Ref, type Snap } from "../src/core/model";
import { canonRef } from "../src/core/ref";
import { digest } from "../src/core/text";
import { LIBRARIES, OLD_FILES, indexText, layout, stamp, type LibraryEntry } from "./libraries";
import { busy } from "./lock";
import { dataDir } from "./util";

export interface MigrateOptions {
  /** Build, verify and report; write nothing. */
  check?: boolean;
  log?: (line: string) => void;
  /** For the tests: change the new library after it is built, before it is verified. */
  tamper?: (doc: Doc) => void;
}

export interface MigrateResult {
  status: "migrated" | "checked" | "nothing" | "finished" | "refused" | "failed";
  problems: string[];
  /** The new library's id, and where the old files went. */
  library?: string;
  backup?: string;
}

/** Fields a node may hold that the copy carries (or that mean nothing without the old history). */
const KNOWN = new Set(["kind", "title", "body", "by", "pinned", "form", "lens", "ref", "wanchor", "articles", "up", "down", "anchors", "library"]);
/** Fields from older versions that are dropped on purpose. */
const DROPPED = new Set(["slug"]);

type NodeRef = Ref & { kind: "node" };
type Pending = Record<string, { at: number; suggestions: { id: string; node: string; range: [number, number]; target: Ref; review?: unknown; decided?: unknown; applied?: unknown }[] }>;

const MESSAGE = "Bring the library over";

export function migrateLibraries(dataIn: string, o: MigrateOptions = {}): MigrateResult {
  const data = resolvePath(dataIn);
  const log = o.log ?? console.log;
  const l = layout(data);
  const what = o.check ? "dry run" : "migration";

  if (l.kind === "empty") {
    log(`${data}: nothing to migrate (no library here); the server starts it fresh.`);
    return { status: "nothing", problems: [] };
  }
  if (l.kind === "libraries") {
    log(`${data}: already in the libraries layout; nothing to do.`);
    return { status: "nothing", problems: [] };
  }
  if (l.kind === "older") {
    const msg = `${data} holds data from before the single library (${l.found.join(", ")}). Open it once with a version from before libraries (commit c4d6856), which brings it into one library, then migrate.`;
    log(msg);
    return { status: "refused", problems: [msg] };
  }
  const why = busy(data);
  if (why && !o.check) {
    const msg = `Refusing to migrate: ${why}. Stop it first.`;
    log(msg);
    return { status: "refused", problems: [msg] };
  }
  if (why) log(`note: ${why}; a dry run only reads, but stop it before the real run.`);
  const backupName = `backup-${stamp()}`;
  if (l.kind === "unfinished" || !existsSync(join(data, "library", "main.loro"))) {
    // The libraries were written but the old files were not moved; or old files without a library.
    log(`${data}: ${l.kind === "unfinished" ? "an earlier migration wrote libraries/ but did not move the old files aside" : "no library/main.loro, only old files"}: ${l.found.join(", ")}.`);
    if (o.check) {
      log(`${what}: they would be moved into ${join(data, backupName)}/. Nothing was written.`);
      return { status: "checked", problems: [] };
    }
    const backup = moveAside(data, backupName, l.found);
    log(`Moved them into ${backup}/, unchanged.`);
    return { status: "finished", problems: [], backup };
  }

  // ---- read ----
  const dir = join(data, "library");
  const old = Doc.load(readFileSync(join(dir, "main.loro")), "migration");
  const branches = readdirSync(dir).filter((f) => f.endsWith(".loro") && f !== "main.loro").map((f) => decodeURIComponent(f.slice(0, -5)));
  let pendingRaw: Pending = {};
  const pendingFile = join(data, "links", "pending.json");
  const warnings: string[] = [];
  if (existsSync(pendingFile)) {
    try {
      pendingRaw = JSON.parse(readFileSync(pendingFile, "utf8")) as Pending;
    } catch (err) {
      warnings.push(`links/pending.json could not be read (${(err as Error).message}); the reviewer's verdicts are not carried (it stays in the backup)`);
    }
  }

  // ---- build and verify, in memory ----
  const built = build(old, pendingRaw);
  warnings.push(...built.warnings);
  o.tamper?.(built.doc);
  let problems = verify(old, built.doc, built.ids);
  if (!problems.length) problems = verify(old, Doc.load(built.doc.snapshotBytes(), "migration"), built.ids).map((p) => `after writing out and reading back: ${p}`);

  const snap = old.snap();
  log(`${what}: ${data}`);
  log(`  library “${snap.nodes[snap.root].title}”: ${Object.keys(snap.nodes).length} nodes, ${snap.nodes[snap.root].children.length} under the root, ${built.stats.links} node targets (${built.stats.broken} already naming nothing, kept with their hints)`);
  log(`  pending links: ${built.stats.pendingKept} entries carried (${built.stats.decisions} with a verdict or a decision)${built.stats.pendingDropped ? `, ${built.stats.pendingDropped} dropped (their node or target is gone)` : ""}`);
  log(`  conflicts: ${built.stats.openConflicts} open carried${built.stats.resolvedConflicts ? `, ${built.stats.resolvedConflicts} resolved left behind` : ""}`);
  if (built.stats.orphanSpans) log(`  ${built.stats.orphanSpans} empty spans of already orphaned notes not carried (the notes are)`);
  if (branches.length) log(`  branches other than main, not carried (they stay in the backup): ${branches.join(", ")}`);
  for (const w of warnings) log(`  note: ${w}`);
  if (problems.length) {
    log(`FAILED: the copy differs from the library in ${problems.length} place${problems.length > 1 ? "s" : ""}; nothing was written.`);
    for (const p of problems.slice(0, 50)) log(`  - ${p}`);
    if (problems.length > 50) log(`  … and ${problems.length - 50} more`);
    return { status: "failed", problems };
  }
  const id = built.doc.libraryId!;
  log(`  verified: same tree, ${built.ids.size} nodes, identical titles, bodies, notes, flags and anchors, every target that resolved resolves to the same node`);
  if (o.check) {
    log(`${what}: it would become library ${id} (address /l/${id}); the old files would move into ${join(data, backupName)}/. Nothing was written.`);
    return { status: "checked", problems: [], library: id };
  }

  // ---- write, check what is on disk, commit, move the old files aside ----
  for (const f of readdirSync(data)) if (f.startsWith(`${LIBRARIES}.tmp-`)) rmSync(join(data, f), { recursive: true, force: true });
  const tmp = join(data, `${LIBRARIES}.tmp-${stamp()}`);
  const lib = join(tmp, id);
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, "main.loro"), built.doc.snapshotBytes());
  if (Object.keys(built.pending).length) {
    mkdirSync(join(lib, "links"));
    writeFileSync(join(lib, "links", "pending.json"), JSON.stringify(built.pending));
  }
  const entry: LibraryEntry = { id, title: built.doc.snap().nodes[built.doc.snap().root].title, created: new Date().toISOString() };
  writeFileSync(join(tmp, "index.json"), indexText([entry]));
  const onDisk = verify(old, Doc.load(readFileSync(join(lib, "main.loro")), "migration"), built.ids);
  if (onDisk.length) {
    rmSync(tmp, { recursive: true, force: true });
    log(`FAILED: the file written differs from the library; nothing was changed.`);
    for (const p of onDisk.slice(0, 50)) log(`  - ${p}`);
    return { status: "failed", problems: onDisk };
  }
  renameSync(tmp, join(data, LIBRARIES));
  const backup = moveAside(data, backupName, OLD_FILES.filter((f) => existsSync(join(data, f))));
  log(`Migrated: ${join(data, LIBRARIES, id)} (address /l/${id}).`);
  log(`The old files are in ${backup}/, unchanged. Pages open on the old library will say to reload.`);
  return { status: "migrated", problems: [], library: id, backup };
}

function moveAside(data: string, name: string, files: string[]): string {
  let backup = join(data, name);
  for (let i = 2; existsSync(backup); i++) backup = join(data, `${name}-${i}`);
  mkdirSync(backup, { recursive: true });
  for (const f of files) renameSync(join(data, f), join(backup, f));
  return backup;
}

// ---- building the copy ----

interface Built {
  doc: Doc;
  ids: Map<NodeId, NodeId>;
  pending: Pending;
  warnings: string[];
  stats: { links: number; broken: number; pendingKept: number; pendingDropped: number; decisions: number; openConflicts: number; resolvedConflicts: number; orphanSpans: number };
}

function build(old: Doc, pendingRaw: Pending): Built {
  const src = old.snap();
  const r = src.nodes[src.root];
  const doc = Doc.library("server", undefined, r.title);
  const root = doc.snap().root;
  const ids = new Map<NodeId, NodeId>([[src.root, root]]);
  const warnings: string[] = [];
  const stats = { links: 0, broken: 0, pendingKept: 0, pendingDropped: 0, decisions: 0, openConflicts: 0, resolvedConflicts: 0, orphanSpans: 0 };

  const roots = old.tree.roots().length;
  if (roots > 1) warnings.push(`the old database has ${roots} roots; only the first (the library, the one every version shows) is carried`);
  const unknown = new Map<string, number>();
  for (const id of Object.keys(src.nodes) as NodeId[]) {
    const n = old.tree.getNodeByID(id);
    for (const k of Object.keys((n?.data.toJSON() ?? {}) as Record<string, unknown>)) {
      if (KNOWN.has(k) || DROPPED.has(k) || k.startsWith(NOLINK)) continue;
      unknown.set(k, (unknown.get(k) ?? 0) + 1);
    }
    stats.orphanSpans += src.nodes[id].anchors.filter((a) => a.end <= a.start).length;
  }
  if (unknown.size) warnings.push(`fields no version of this program reads, not carried: ${[...unknown].map(([k, n]) => `${k} (${n})`).join(", ")}`);

  doc.begin(MESSAGE, "human", "migrate");
  const top = doc.tree.getNodeByID(root)!;
  top.data.set("title", r.title);
  (top.data.get("body") as { insert(i: number, s: string): void }).insert(0, r.body);
  top.data.set("by", r.by);
  top.data.set("pinned", r.pinned);
  top.data.set("up", r.seenUp);
  top.data.set("down", r.seenDown);
  if (r.form) top.data.set("form", r.form);
  if (r.lens) top.data.set("lens", r.lens);
  for (const p of r.nolink ?? []) top.data.set(NOLINK + p, 1);
  doc.mark(root);
  // The root's children in order, the Wikipedia container among them; a note on the root's own text
  // keeps its anchors, the new root's text being the same.
  for (const c of r.children) doc.graft(src, c, root, { keepAnchors: true, ids });
  doc.mark(root);

  // Node targets, rewritten through the map; written straight into each node's data, as graft
  // writes, so that no one becomes their author.
  const now = doc.snap();
  for (const [was, id] of ids) {
    const ref = src.nodes[was].ref;
    if (ref?.kind !== "node") continue;
    stats.links++;
    const to = resolveOld(old, src, ref, was);
    const next = to ? nodeRef(now, ids.get(to)!) : hint(old, src, ref);
    if (!to) stats.broken++;
    doc.tree.getNodeByID(id)!.data.set("ref", next as never);
    doc.mark(id);
  }

  // Open conflicts, their nodes renamed; a deleted node's id (an edit-delete) is kept, naming nothing in either.
  for (const c of old.conflicts()) {
    if (c.status !== "open") {
      stats.resolvedConflicts++;
      continue;
    }
    const map = (x: string | undefined) => (x ? (ids.get(x as NodeId) ?? x) : x);
    const next: Conflict = { ...c, node: map(c.node) as NodeId, ...(c.other ? { other: map(c.other) as NodeId } : {}), ...(c.parent ? { parent: map(c.parent) as NodeId } : {}) };
    doc.conflictMap.set(c.id, JSON.stringify(next));
    stats.openConflicts++;
  }
  doc.reread();
  doc.commit(MESSAGE, "human", "migrate");

  // The link reviewer's verdicts, people's decisions and what is pending, keyed by the new ids.
  const after = doc.snap();
  const pending: Pending = {};
  for (const [node, entry] of Object.entries(pendingRaw)) {
    const list = Array.isArray(entry?.suggestions) ? entry.suggestions : [];
    const nn = ids.get(node as NodeId);
    if (!nn) {
      stats.pendingDropped += list.length;
      continue;
    }
    const out: Pending[string]["suggestions"] = [];
    for (const s of list) {
      let target = s.target;
      if (target?.kind === "node") {
        const to = resolveOld(old, src, target, node as NodeId);
        if (!to) {
          stats.pendingDropped++;
          continue;
        }
        target = nodeRef(after, ids.get(to)!);
      }
      out.push({ ...s, node: nn, target, id: digest(`${nn}\u0000${s.range[0]}\u0000${s.range[1]}\u0000${targetKey(target)}`) });
      if (s.review || s.decided || s.applied) stats.decisions++;
    }
    stats.pendingKept += out.length;
    if (out.length) pending[nn] = { at: entry.at, suggestions: out };
  }
  return { doc, ids, pending, warnings, stats };
}

/** A node's `slug` as older versions stored it (documents were the root's children). */
const slugOf = (old: Doc, id: NodeId) => old.tree.getNodeByID(id)?.data.get("slug") as string | undefined;

/**
 * Walk section titles down from a node, as resolveNode does: exact title first, then ignoring case,
 * and among sections sharing a title the one `here` is in.
 */
function walk(snap: Snap, from: NodeId, path: string[], quote: string | undefined, here: NodeId): NodeId | null {
  const mine = new Set([here, ...ancestors(snap, here)]);
  let at = from;
  for (const title of path) {
    const kids = sections(snap, at);
    let same = kids.filter((c) => snap.nodes[c].title === title);
    if (!same.length) same = kids.filter((c) => snap.nodes[c].title.toLowerCase() === title.toLowerCase());
    if (!same.length) return null;
    at = same.find((c) => mine.has(c)) ?? same[0];
  }
  if (quote === undefined) return at;
  return notesOf(snap, at).find((c) => snap.nodes[c].anchors.some((a) => a.text === quote || a.quote === quote)) ?? null;
}

/**
 * The node an old target named, read as the version that wrote it would: by id while it exists;
 * else, with a document slug (before step 1), from the top with that slug; else from the root (as
 * today), then from the top of where it is written (as relative paths were read before).
 */
function resolveOld(old: Doc, snap: Snap, ref: NodeRef, here: NodeId): NodeId | null {
  if (ref.id && snap.nodes[ref.id]) return ref.id;
  const path = ref.path ?? [];
  const slug = (ref as { doc?: unknown }).doc;
  const top = topOf(snap, here);
  if (typeof slug === "string") {
    const doc = snap.nodes[snap.root].children.find((c) => slugOf(old, c) === slug);
    return doc ? walk(snap, doc, path, ref.quote, here) : null;
  }
  if (!ref.path) return null;
  if (ref.rel) return top ? walk(snap, top, path, ref.quote, here) : null;
  return walk(snap, snap.root, path, ref.quote, here) ?? (top ? walk(snap, top, path, ref.quote, here) : null);
}

/** A target that names nothing, in today's form: titles from the root (a slug made the top's title, if that top is still there), no id. */
function hint(old: Doc, snap: Snap, ref: NodeRef): NodeRef {
  const out: NodeRef = { kind: "node", path: [...(ref.path ?? [])] };
  const slug = (ref as { doc?: unknown }).doc;
  if (typeof slug === "string") {
    const doc = snap.nodes[snap.root].children.find((c) => slugOf(old, c) === slug);
    if (doc) out.path = [snap.nodes[doc].title, ...out.path!];
    else out.rel = true;
  } else if (ref.rel) out.rel = true;
  if (ref.quote !== undefined) out.quote = ref.quote;
  return out;
}

// ---- verifying the copy ----

/** Every difference between the library and its copy that matters, as lines naming the node. */
export function verify(old: Doc, neu: Doc, ids: Map<NodeId, NodeId>): string[] {
  const a = old.snap();
  const b = neu.snap();
  const out: string[] = [];
  const where = (id: NodeId) => {
    const names: string[] = [];
    for (let x: NodeId | null = id; x; x = a.nodes[x]?.parent ?? null) names.unshift(clipped(label(a, x)));
    return `“${names.join(" › ")}”`;
  };
  if (!b.library) out.push("the copy is not a library");
  if (!neu.libraryId || neu.libraryId === old.libraryId) out.push("the copy does not have a library id of its own");
  const na = Object.keys(a.nodes).length;
  const nb = Object.keys(b.nodes).length;
  if (na !== nb) out.push(`node count: ${na} in the library, ${nb} in the copy`);
  if (ids.get(a.root) !== b.root) out.push("the library's root did not become the copy's root");
  const seen = new Set<NodeId>();
  const visit = (id: NodeId) => {
    const x = a.nodes[id];
    const nid = ids.get(id);
    const y = nid ? b.nodes[nid] : undefined;
    if (!y) return void out.push(`${where(id)} is missing from the copy`);
    seen.add(nid!);
    const at = where(id);
    const want = (x.parent ? ids.get(x.parent) : null) ?? null;
    if (y.parent !== want) out.push(`${at}: under another parent`);
    if (y.children.join() !== x.children.map((c) => ids.get(c) ?? "?").join()) out.push(`${at}: children differ (${x.children.length} in the library, ${y.children.length} in the copy, or another order)`);
    const fields: (keyof NodeSnap)[] = ["kind", "title", "body", "by", "pinned", "form", "lens", "articles", "seenUp", "seenDown"];
    for (const f of fields) if ((x[f] ?? null) !== (y[f] ?? null)) out.push(`${at}: ${f} differs`);
    if (JSON.stringify(x.wanchor ?? null) !== JSON.stringify(y.wanchor ?? null)) out.push(`${at}: its place in the article differs`);
    if ((x.nolink ?? []).join("\u0000") !== (y.nolink ?? []).join("\u0000")) out.push(`${at}: declined phrases differ`);
    const anchors = (n: NodeSnap) => JSON.stringify(n.anchors.filter((q) => q.end > q.start).map((q) => [q.start, q.end, q.quote, q.text]));
    if (anchors(x) !== anchors(y)) out.push(`${at}: anchors differ`);
    const sa = staleness(a, id);
    const sb = staleness(b, nid!);
    const dropped = x.anchors.some((q) => q.end <= q.start);
    if (sa.orphan !== sb.orphan || sa.up !== sb.up || (!dropped && sa.down !== sb.down) || isStale(a, id) !== isStale(b, nid!)) out.push(`${at}: staleness differs`);
    if ((x.ref?.kind ?? null) !== (y.ref?.kind ?? null)) out.push(`${at}: target differs`);
    else if (x.ref && y.ref && x.ref.kind !== "node" && JSON.stringify(canonRef(x.ref)) !== JSON.stringify(canonRef(y.ref))) out.push(`${at}: target differs`);
    else if (x.ref?.kind === "node" && y.ref?.kind === "node") {
      const to = resolveOld(old, a, x.ref, id);
      const now = resolveNode(b, y.ref, nid!);
      if (to && (y.ref.id !== ids.get(to) || now !== ids.get(to))) out.push(`${at}: its link to ${where(to)} does not find that node in the copy`);
      if (!to && now) out.push(`${at}: a link that named nothing now names ${clipped(label(b, now))}`);
      if (!to && y.ref.id) out.push(`${at}: a link that named nothing kept an old id`);
    }
    x.children.forEach(visit);
  };
  visit(a.root);
  if (seen.size !== nb) out.push(`the copy has ${nb - seen.size} nodes the library does not`);
  const open = (d: Doc) => d.conflicts().filter((c) => c.status === "open").length;
  if (open(old) !== open(neu)) out.push(`open conflicts: ${open(old)} in the library, ${open(neu)} in the copy`);
  return out;
}

const clipped = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);

// ---- the command ----

if (process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const unknown = args.filter((a) => a.startsWith("-") && a !== "--check");
  const dirs = args.filter((a) => !a.startsWith("-"));
  if (unknown.length || dirs.length > 1) {
    console.error("usage: npm run migrate [-- [--check] [DATA_DIR]]   (DATA_DIR defaults to IE_DATA, else .data)");
    process.exit(2);
  }
  const r = migrateLibraries(dirs[0] ?? dataDir(), { check });
  process.exit(r.status === "failed" ? 1 : r.status === "refused" ? 2 : 0);
}
