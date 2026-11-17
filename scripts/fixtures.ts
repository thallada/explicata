/**
 * Seeded semantic-conflict fixtures: hand-made pairs of concurrent edits whose correct outcome
 * is known. The detection half is deterministic and is asserted here directly. The resolution
 * half needs a model, so it runs in two steps that work with any model, with or without an API key:
 *
 *   tsx scripts/fixtures.ts render DIR   write the exact prompts the app would send, as DIR/<name>.prompt.txt
 *   tsx scripts/fixtures.ts check DIR    read DIR/<name>.response.json, apply it through the app's
 *                                        own code path, and check the result against what is known
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Doc, setPeerSource, type NodeId } from "../src/core/model";
import { mergeBranch, verifyHistory, type MergeReport } from "../src/core/repo";
import { resolveConflicts, scanContradictions } from "../src/llm/tasks";
import type { JsonReq, LLM } from "../src/llm/types";

interface Fixture {
  name: string;
  about: string;
  build(): { doc: Doc; other: Doc; ids: Record<string, NodeId> };
  /** What the structural merge must report, before any model is involved. */
  detect(report: MergeReport, doc: Doc): string[];
  /** What must be true once the model's answer has been applied. Returns failures. */
  check(doc: Doc, ids: Record<string, NodeId>): string[];
}

function base() {
  const doc = Doc.create("alice", "Explicata", "A document that expands without limit.");
  const root = doc.snap().root;
  const { created } = doc.apply(
    [
      { op: "create", parent: root, title: "Latency budget", body: "Pre-generated expansions must paint within 50 ms of the keypress. Generated expansions must show a first token within one second." },
      { op: "create", parent: root, title: "Undo", body: "Every edit is a commit and can be undone." },
      { op: "create", parent: root, title: "Sidenotes", body: "A note of one to three sentences is shown in the margin beside the line it is about." },
      { op: "create", parent: root, title: "Speculation", body: "With speculation on, the expansion of the focused sentence starts before it is asked for." },
      { op: "create", parent: root, title: "Hoisting", body: "Any node can be hoisted to fill the page." },
      { op: "bless", id: root },
    ],
    "Base",
    { actor: "llm" },
  );
  const [latency, undo, sidenotes, speculation, hoisting] = created;
  return { doc, ids: { root, latency, undo, sidenotes, speculation, hoisting } };
}

const has = (text: string, ...needles: (string | RegExp)[]) => needles.every((n) => (typeof n === "string" ? text.toLowerCase().includes(n.toLowerCase()) : n.test(text)));

const fixtures: Fixture[] = [
  {
    name: "compatible-additions",
    about: "Both sides added a different, compatible clause to the same sentence. The right answer keeps both.",
    build() {
      const { doc, ids } = base();
      const other = doc.fork("bob");
      doc.apply([{ op: "update", id: ids.sidenotes, body: "A note of one to three sentences is shown in the margin beside the line it is about, and is pushed down if it would overlap the note above it." }], "A: overlap rule");
      other.apply([{ op: "update", id: ids.sidenotes, body: "A note of one to three sentences is shown in the margin beside the line it is about; on screens too narrow for a margin it is set into the column instead." }], "B: narrow screens");
      return { doc, other, ids };
    },
    detect: (r) => (r.conflicts.length === 1 && r.conflicts[0].type === "edit-edit" ? [] : [`expected one edit-edit conflict, got ${JSON.stringify(r.conflicts.map((c) => c.type))}`]),
    check(doc, ids) {
      const body = doc.snap().nodes[ids.sidenotes].body;
      const out: string[] = [];
      if (!has(body, "overlap")) out.push("lost side A's overlap rule");
      if (!has(body, "narrow")) out.push("lost side B's narrow-screen rule");
      if (!has(body, "margin")) out.push("lost the original claim");
      return out;
    },
  },
  {
    name: "incompatible-numbers",
    about: "The two sides give different numbers for the same budget. They cannot be blended; the rest of the document says 50 ms.",
    build() {
      const { doc, ids } = base();
      // Elsewhere in the document, the 50 ms figure is relied on. This is what should decide it.
      doc.apply([{ op: "create", parent: ids.root, title: "How we know it works", body: "A scripted keyboard run measures keypress to paint and fails if the 95th percentile exceeds the 50 ms budget." }], "Verification", { actor: "llm" });
      const other = doc.fork("bob");
      doc.apply([{ op: "update", id: ids.latency, body: "Pre-generated expansions must paint within 50 ms of the keypress, measured at the 95th percentile. Generated expansions must show a first token within one second." }], "A: percentile");
      other.apply([{ op: "update", id: ids.latency, body: "Pre-generated expansions must paint within 200 ms of the keypress. Generated expansions must show a first token within one second." }], "B: relax to 200");
      return { doc, other, ids };
    },
    detect: (r) => (r.conflicts.length === 1 && r.conflicts[0].type === "edit-edit" ? [] : ["expected one edit-edit conflict"]),
    check(doc, ids) {
      const body = doc.snap().nodes[ids.latency].body;
      const c = doc.conflicts()[0];
      const out: string[] = [];
      if (!has(body, "50 ms")) out.push("did not keep the 50 ms budget the rest of the document relies on");
      if (has(body, "200")) out.push("kept or blended in the contradicting 200 ms figure");
      if (/(\d+)\s*[-–]\s*(\d+)\s*ms|between 50 and 200/i.test(body)) out.push("blended the two numbers into a range neither side wrote");
      if (!c.rationale || c.rationale.length < 20) out.push("gave no usable rationale for a human to overrule");
      return out;
    },
  },
  {
    name: "edit-vs-delete",
    about: "One side deleted a section; the other had just rewritten it with substantial new content. The edit should come back.",
    build() {
      const { doc, ids } = base();
      const other = doc.fork("bob");
      doc.apply([{ op: "delete", id: ids.speculation }], "A: delete speculation");
      other.apply([{ op: "update", id: ids.speculation, body: "With speculation on, the expansion of the focused sentence starts 350 ms after focus settles, before it is asked for. If the reader then presses e, the stream already in flight is adopted, so the first words appear at once. It is off by default because it spends tokens on expansions that may never be read." }], "B: explain speculation");
      return { doc, other, ids };
    },
    detect: (r, doc) => {
      const out: string[] = [];
      if (r.conflicts.length !== 1 || r.conflicts[0].type !== "edit-delete") out.push("expected one edit-delete conflict");
      if (Object.values(doc.snap().nodes).some((n) => n.title === "Speculation")) out.push("the structural merge should let the deletion win");
      return out;
    },
    check(doc) {
      const restored = Object.values(doc.snap().nodes).find((n) => n.title === "Speculation");
      if (!restored) return ["let the deletion stand, discarding the other side's new work"];
      return has(restored.body, "350") ? [] : ["restored the section but lost the new content"];
    },
  },
  {
    name: "cross-node-contradiction",
    about: "The edits touch different nodes, so the merge is clean, but one side's new claim contradicts the other's. A second pair of edits is unrelated and must not be reported.",
    build() {
      const { doc, ids } = base();
      const other = doc.fork("bob");
      doc.apply([{ op: "update", id: ids.undo, body: "Every edit is a commit and can be undone. Undo history is unlimited: every step back to the creation of the document is kept." }], "A: unlimited undo");
      doc.apply([{ op: "update", id: ids.hoisting, body: "Any node can be hoisted to fill the page, and a breadcrumb leads back up." }], "A: breadcrumb");
      other.apply([{ op: "create", parent: ids.root, title: "Memory limits", body: "To bound memory, the editor keeps only the last 20 undo steps; older steps are discarded and cannot be undone." }], "B: undo cap");
      other.apply([{ op: "update", id: ids.sidenotes, body: "A note of one to three sentences is shown in the right margin beside the line it is about." }], "B: right margin");
      return { doc, other, ids };
    },
    detect: (r) => (r.kind === "merge" && r.conflicts.length === 0 ? [] : ["expected a clean structural merge with no conflicts"]),
    check(doc, ids) {
      const found = doc.conflicts().filter((c) => c.type === "contradiction");
      const out: string[] = [];
      if (found.length !== 1) return [`expected exactly one contradiction, got ${found.length}`];
      const snap = doc.snap();
      const titles = [found[0].node, found[0].other!].map((id) => snap.nodes[id]?.title).sort();
      if (titles.join("|") !== "Memory limits|Undo") out.push(`reported the wrong pair: ${titles.join(" / ")}`);
      const undo = snap.nodes[ids.undo].body;
      const limits = Object.values(snap.nodes).find((n) => n.title === "Memory limits")!.body;
      if (has(undo, "unlimited") && has(limits, "last 20")) out.push("the two nodes still contradict after the resolution");
      if (!has(snap.nodes[ids.hoisting].body, "breadcrumb") || !has(snap.nodes[ids.sidenotes].body, "right margin")) out.push("disturbed the unrelated edits");
      return out;
    },
  },
];

/** A provider that records the request, or answers from a file. */
function scripted(dir: string, name: string, mode: "render" | "check"): LLM {
  const refuse = () => Promise.reject(new Error("not used"));
  return {
    kind: "mock",
    stream: refuse,
    turn: refuse,
    async json<T>(req: JsonReq): Promise<T> {
      const file = join(dir, `${name}.response.json`);
      if (mode === "render") {
        const shape =
          req.schema === "resolve"
            ? '{"resolutions": [{"id": "<conflict id>", "text": "<the text the node should have>", "rationale": "<one or two sentences>"}]}'
            : '{"contradictions": [{"node": "<id of the first node>", "other": "<id of the second node>", "explanation": "<one sentence>", "text": "<revised body for the second node>"}]}';
        writeFileSync(
          join(dir, `${name}.prompt.txt`),
          `=== SYSTEM ===\n${req.system}\n\n=== USER (context) ===\n${req.context}\n\n=== USER (request) ===\n${req.prompt}\n\n=== REPLY FORMAT ===\nReply with a single JSON object of exactly this shape and nothing else:\n${shape}\n`,
        );
        throw new Rendered();
      }
      if (!existsSync(file)) throw new Error(`missing ${file}`);
      return JSON.parse(readFileSync(file, "utf8")) as T;
    },
  };
}
class Rendered extends Error {}

const [mode, dir] = process.argv.slice(2) as ["render" | "check", string];
if (!["render", "check"].includes(mode) || !dir) {
  console.error("usage: tsx scripts/fixtures.ts render|check DIR");
  process.exit(2);
}
mkdirSync(dir, { recursive: true });
let failed = 0;
for (const f of fixtures) {
  // Fixed peer ids, so node and conflict ids are the same when rendering and when checking.
  let peer = 1000n;
  setPeerSource(() => peer++);
  const { doc, other, ids } = f.build();
  const report = mergeBranch(doc, other, "bob");
  const detection = f.detect(report, doc);
  const llm = scripted(dir, f.name, mode);
  try {
    if (f.name === "cross-node-contradiction") await scanContradictions(llm, doc, report);
    else await resolveConflicts(llm, doc);
  } catch (err) {
    if (!(err instanceof Rendered)) throw err;
  }
  if (mode === "render") {
    console.log(`${detection.length ? "FAIL" : "ok  "} detect  ${f.name}${detection.length ? ": " + detection.join("; ") : ""}`);
    failed += detection.length ? 1 : 0;
    continue;
  }
  const problems = [...detection, ...f.check(doc, ids)];
  const history = verifyHistory(doc);
  if (history.mismatches.length || history.unhashed) problems.push("history no longer verifies");
  console.log(`${problems.length ? "FAIL" : "pass"}  ${f.name}: ${f.about}`);
  for (const p of problems) console.log(`      - ${p}`);
  failed += problems.length ? 1 : 0;
}
console.log(mode === "render" ? `\nprompts written to ${dir}` : `\n${fixtures.length - failed} of ${fixtures.length} fixtures pass`);
process.exit(failed ? 1 : 0);
