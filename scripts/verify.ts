/**
 * Checks on the seed document that do not need a browser.
 *
 *   tsx scripts/verify.ts            coverage of the prompt + history verification
 *   tsx scripts/verify.ts entail F   write the parent/children pairs to F, for a fresh model to judge
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Doc, descendants, sections } from "../src/core/model";
import { verifyHistory } from "../src/core/repo";
import { writeSeed } from "../src/core/seed";
import { overlaps, plain, sentences } from "../src/core/text";
import { seed } from "../src/seed/tree";

const prompt = readFileSync(new URL("../src/seed/prompt.txt", import.meta.url), "utf8");
const doc = Doc.library("seed");
const first = writeSeed(doc, prompt, seed);
const snap = doc.snap();
const root = snap.nodes[first];

if (process.argv[2] === "entail") {
  // Each node that has sections, with those sections: the claim is that the first is a
  // summary supported by the rest. The document itself is excluded: it is the prompt, not a summary.
  const pairs = descendants(snap, first)
    .map((id) => snap.nodes[id])
    .filter((n) => n.kind === "section" && sections(snap, n.id).length)
    .map((n) => ({
      id: n.id,
      title: n.title,
      summary: plain(n.body),
      sections: sections(snap, n.id).map((c) => ({ title: snap.nodes[c].title, body: plain(snap.nodes[c].body) })),
    }));
  writeFileSync(process.argv[3], JSON.stringify(pairs, null, 2));
  console.log(`wrote ${pairs.length} parent/children pairs to ${process.argv[3]}`);
} else {
  const tops = sections(snap, first);
  const all = sentences(root.body);
  let uncovered = 0;
  for (const s of all) {
    const by = tops.filter((id) => snap.nodes[id].anchors.some((a) => overlaps(s, [a.start, a.end])));
    if (!by.length) {
      uncovered++;
      console.log(`UNCOVERED: ${root.body.slice(s[0], s[1])}`);
    }
  }
  const nodes = descendants(snap, first).map((id) => snap.nodes[id]);
  console.log(`prompt sentences: ${all.length}, traced to a section: ${all.length - uncovered}, untraced: ${uncovered}`);
  console.log(`tree: ${nodes.filter((n) => n.kind === "section").length} sections, ${nodes.filter((n) => n.kind === "note").length} notes`);
  const v = verifyHistory(doc);
  console.log(`history: ${v.checked} commits re-hashed after checkout, ${v.mismatches.length} mismatches, ${v.unhashed} without a hash`);
  process.exit(uncovered || v.mismatches.length ? 1 : 0);
}
