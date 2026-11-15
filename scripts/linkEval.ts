/**
 * Evaluate the link scanner (server/links/scan.ts) on the starter library against hand labels.
 *
 *   IE_DATA=/tmp/x npx tsx scripts/linkEval.ts warm [docs…]    live: fill the Wikipedia cache for the
 *                                                             sampled sections, write their traces
 *   IE_DATA=/tmp/x npx tsx scripts/linkEval.ts eval [docs…]    offline (cache only): precision and
 *                                                             recall against the labels
 *   IE_DATA=/tmp/x npx tsx scripts/linkEval.ts trace [docs…]   offline: the traces, for labelling
 *
 * The sample is the first SAMPLE sections (in reading order, document text included) of each named
 * document that have at least 40 words. Labels: tests/fixtures/link-labels.json, one entry per
 * phrase (by its normalised key) per section, saying whether it is worth linking and to what.
 * `warm` goes to Wikipedia through the client (serial, spaced as it enforces) and stops at a budget
 * of requests (IE_EVAL_BUDGET, default 380); nothing but candidate phrases is sent. The embedding
 * model is the real one unless IE_EMBED says otherwise.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { importDoc } from "../src/core/library";
import { Doc, ancestorsInDoc, documents, sections, type NodeId, type Snap } from "../src/core/model";
import { embedder } from "../server/embed";
import { extract } from "../server/links/extract";
import { NodeIndex } from "../server/links/nodeIndex";
import { Linker, type TraceRow, type Tuning } from "../server/links/scan";
import { WikiClient } from "../server/wiki";

const [mode = "eval", ...rest] = process.argv.slice(2);
const DATA = resolve(process.env.IE_DATA ?? "");
if (!process.env.IE_DATA) throw new Error("set IE_DATA to a scratch directory");
const SAMPLE = Number(process.env.IE_EVAL_SAMPLE ?? 12);
const BUDGET = Number(process.env.IE_EVAL_BUDGET ?? 380);
const DOCS = rest.length ? rest : ["octopus-minds", "fixed-points", "origin-of-the-elements", "invention-of-writing"];
const LABELS = resolve("tests/fixtures/link-labels.json");

// The whole starter library, so that titles in other documents can be matched as they would be.
const doc = Doc.library("eval");
for (const f of readdirSync("library").filter((x) => x.endsWith(".md")).sort()) importDoc(doc, readFileSync(join("library", f), "utf8"), f, { creator: "eval", slug: f.replace(/\.md$/, "") });
const snap = doc.snap();

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
function sample(snap: Snap, slug: string): NodeId[] {
  const d = documents(snap).find((x) => snap.nodes[x].slug === slug);
  if (!d) throw new Error(`no document ${slug}`);
  const out: NodeId[] = [];
  const visit = (id: NodeId) => {
    if (out.length < SAMPLE && words(snap.nodes[id].body) >= 40) out.push(id);
    sections(snap, id).forEach(visit);
  };
  visit(d);
  return out;
}
const pathOf = (id: NodeId) => [...ancestorsInDoc(snap, id).reverse().slice(1), id].map((x) => snap.nodes[x].title).join(" › ") || snap.nodes[id].title;

// `sample`: the sampled sections' texts only, for labelling before the scanner has seen them.
if (mode === "sample") {
  const out = DOCS.flatMap((slug) => sample(snap, slug).map((id) => ({ doc: slug, node: pathOf(id), text: snap.nodes[id].body })));
  const file = join(DATA, `sample-${DOCS.join("+")}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1));
  console.error(`${out.length} sections → ${file}`);
  process.exit(0);
}

const live = mode === "warm";
const wiki = new WikiClient({
  dataDir: DATA,
  // Offline modes answer from the cache alone: anything uncached is "unavailable", never fetched.
  ...(live ? {} : { fetch: (async () => { throw new TypeError("offline (eval)"); }) as typeof fetch, offlineHoldMs: 0, spacingMs: 0 }),
});
const index = new NodeIndex(() => doc, { file: join(DATA, "vectors", "eval-nodes"), embedder: embedder(), delayMs: 0 });
const tuning: Partial<Tuning> = JSON.parse(process.env.IE_EVAL_TUNING ?? "{}");
const linker = new Linker({ doc: () => doc, wiki: () => wiki, embedder: embedder(), index, tuning });

const t0 = performance.now();
await index.refresh();
const indexMs = Math.round(performance.now() - t0);
console.error(`index: ${index.vectors.size} sections in ${indexMs} ms${index.degraded ? " (no model: degraded)" : ""}`);

const nodes = DOCS.flatMap((slug) => sample(snap, slug).map((id) => ({ slug, id })));

if (live) {
  // One deduplicated lookup of every candidate of every sampled section first: 50 phrases a request.
  const variants = [...new Set(nodes.flatMap(({ id }) => extract(snap.nodes[id].body, { skip: new Set() }).flatMap((c) => c.variants)))];
  console.error(`${nodes.length} sections, ${variants.length} distinct phrases to look up`);
  await wiki.lookup(variants, { priority: "bulk" });
  wiki.flush();
  console.error(`lookups done: ${wiki.requests} requests`);
}

type Row = TraceRow & { doc: string; node: string; sentence?: string };
const rows: Row[] = [];
const perNode: { node: string; ms: number; requests: number }[] = [];
for (const { slug, id } of nodes) {
  if (live && wiki.requests >= BUDGET) {
    console.error(`budget of ${BUDGET} requests reached; stopping before ${pathOf(id)}`);
    break;
  }
  const trace: TraceRow[] = [];
  const r = await linker.scan({ node: id, priority: live ? "bulk" : "interactive", trace });
  perNode.push({ node: pathOf(id), ms: r.stats.ms, requests: r.stats.requests });
  const body = snap.nodes[id].body;
  for (const t of trace) {
    const from = Math.max(body.lastIndexOf(". ", t.start) + 2, body.lastIndexOf("\n", t.start) + 1, 0);
    const to = body.indexOf(". ", t.start);
    rows.push({ ...t, doc: slug, node: pathOf(id), sentence: body.slice(from, to < 0 ? body.length : to + 1) });
  }
  if (live) wiki.flush();
  if (live) console.error(`${slug} › ${pathOf(id)}: ${r.stats.candidates} candidates, ${r.suggestions.length} chosen, ${r.stats.requests} requests (total ${wiki.requests})`);
}
wiki.flush();

if (mode === "warm" || mode === "trace") {
  const file = join(DATA, `trace-${DOCS.join("+")}.json`);
  writeFileSync(file, JSON.stringify(rows, null, 1));
  console.error(`${rows.length} traced phrases → ${file}; ${wiki.requests} requests`);
  const ms = perNode.map((p) => p.ms).sort((a, b) => a - b);
  console.error(`scan time per section: median ${ms[ms.length >> 1]} ms, max ${ms[ms.length - 1]} ms; requests per section: ${(perNode.reduce((a, p) => a + p.requests, 0) / Math.max(1, perNode.length)).toFixed(2)}`);
  process.exit(0);
}

// ---- heldout: closed-world scoring against a list of everything worth linking ----

if (mode === "heldout") {
  // tests/fixtures/link-labels-heldout.json lists, per section, every phrase worth a link and the
  // acceptable targets, written from the text before the scanner ran. A link not on it is wrong.
  const held: { doc: string; node: string; key: string; phrase: string; targets: string[] }[] = JSON.parse(readFileSync(resolve("tests/fixtures/link-labels-heldout.json"), "utf8")).labels.filter((l: { doc: string }) => DOCS.includes(l.doc));
  const label = (r: Row) => held.find((l) => l.doc === r.doc && l.node === r.node && l.key === r.key);
  const ok = (r: Row) => !!label(r)?.targets.includes(r.target);
  const chosen = rows.filter((r) => r.chosen);
  const line = (name: string, set: Row[]) => {
    const right = set.filter(ok).length;
    console.log(`${name.padEnd(16)} ${String(set.length).padStart(4)} chosen  ${String(right).padStart(4)} right  precision ${(set.length ? right / set.length : 1).toFixed(3)}  recall ${(right / held.length).toFixed(3)}`);
  };
  console.log(`documents: ${DOCS.join(", ")}; ${nodes.length} sections; ${held.length} phrases worth linking`);
  line("auto", chosen.filter((r) => r.tier === "auto"));
  line("auto + suggest", chosen);
  const fmt = (r: Row) => `  [${r.tier} fit ${r.fit ?? "-"}] ${r.doc} | ${r.node} | “${r.phrase}” → ${r.target}${label(r) ? `   (label: ${label(r)!.targets.join(" or ")})` : "   (not on the list)"}   — ${r.sentence?.trim().slice(0, 140)}`;
  console.log("\nauto errors:");
  for (const r of chosen.filter((r) => r.tier === "auto" && !ok(r))) console.log(fmt(r));
  console.log("\nauto right:");
  for (const r of chosen.filter((r) => r.tier === "auto" && ok(r))) console.log(fmt(r));
  if (process.env.IE_EVAL_SUGGEST) {
    console.log("\nsuggest errors:");
    for (const r of chosen.filter((r) => r.tier === "suggest" && !ok(r))) console.log(fmt(r));
  }
  process.exit(0);
}

// ---- eval ----

interface Label {
  doc: string;
  node: string;
  key: string;
  phrase: string;
  /** yes: worth linking, to `target`. no: not worth linking. */
  label: "yes" | "no";
  target?: string;
  note?: string;
}
const labels: Label[] = JSON.parse(readFileSync(LABELS, "utf8")).labels;
const mine = labels.filter((l) => DOCS.includes(l.doc));
const find = (r: Row) => mine.find((l) => l.doc === r.doc && l.node === r.node && l.key === r.key);
const chosen = rows.filter((r) => r.chosen);
const unlabelled = chosen.filter((r) => !find(r));
const correct = (r: Row) => {
  const l = find(r);
  return !!l && l.label === "yes" && l.target === r.target;
};
const yes = mine.filter((l) => l.label === "yes").length;
const report = (name: string, set: Row[]) => {
  const labelled = set.filter(find);
  const right = labelled.filter(correct).length;
  const p = labelled.length ? right / labelled.length : 1;
  const rcl = yes ? right / yes : 0;
  console.log(`${name.padEnd(16)} ${String(set.length).padStart(4)} chosen  ${String(right).padStart(4)} right  precision ${p.toFixed(3)}  recall ${rcl.toFixed(3)}`);
};
console.log(`documents: ${DOCS.join(", ")}; ${nodes.length} sections; ${mine.length} labelled phrases (${yes} worth linking)`);
report("auto", chosen.filter((r) => r.tier === "auto"));
report("auto + suggest", chosen);
if (unlabelled.length) console.log(`unlabelled chosen: ${unlabelled.length}\n${unlabelled.map((r) => `  ${r.doc} | ${r.node} | ${r.key} → ${r.target} [${r.tier}]`).join("\n")}`);
const show = (title: string, list: Row[]) => {
  if (!list.length) return;
  console.log(`\n${title}`);
  for (const r of list) {
    const l = find(r);
    console.log(`  [${r.tier ?? "drop"} ${r.score.toFixed(3)} fit ${r.fit ?? "-"}] “${r.phrase}” → ${r.target}${l ? `   label: ${l.label}${l.target && l.target !== r.target ? ` (${l.target})` : ""}` : ""}   (${r.why})`);
  }
};
const wrong = chosen.filter((r) => find(r) && !correct(r));
show("wrong (chosen, label disagrees):", wrong);
const missed = mine.filter((l) => l.label === "yes" && !chosen.some((r) => r.doc === l.doc && r.node === l.node && r.key === l.key && correct(r)));
if (missed.length && process.env.IE_EVAL_MISSES) {
  console.log("\nmissed (worth linking, not chosen or wrong target):");
  for (const l of missed) {
    const r = rows.find((x) => x.doc === l.doc && x.node === l.node && x.key === l.key);
    console.log(`  ${l.doc} | ${l.node} | “${l.phrase}” → ${l.target}${r ? `   scanner: ${r.target} [${r.tier ?? "drop"} ${r.score} fit ${r.fit}] ${r.why}` : "   (never resolved)"}`);
  }
}
if (process.env.IE_EVAL_RIGHT) show("right:", chosen.filter(correct));
// Every labelled row with what judge() saw, for tuning (IE_EVAL_DUMP=file).
if (process.env.IE_EVAL_DUMP) {
  const dump = rows.map((r) => ({ ...r, label: find(r)?.label ?? null, labelTarget: find(r)?.target ?? null, right: correct(r) }));
  writeFileSync(process.env.IE_EVAL_DUMP, JSON.stringify(dump, null, 1));
}
// The embedding worker is unref'd, but a script is done here whatever is still open.
process.exit(0);
