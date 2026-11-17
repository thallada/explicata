/**
 * The link reviewer: the configured model judges what the scanner proposed, as a careful
 * Wikipedia editor would, and its verdicts (link or not, with a one-line reason) are kept in the
 * pending store. It is given no tools: each call is one structured reply of verdicts.
 *
 * Cost. Proposals are reviewed many to a call (BATCH), grouped by top and section, each with
 * just what it takes to judge it: its sentence, the section's title and path, the target's title,
 * description and (when the cache has it) first sentence, and, for a library target, how it stands
 * to the section. Anything judged before is never sent again. Each caller gives a budget of calls;
 * when it is spent, or a call fails, or there is no model, what is left stays pending for a person,
 * and the report says why. Only phrases and titles ever go to Wikipedia; the text goes only to the
 * model, as it does when the model writes.
 */
import { ownerSection, targetTitle } from "../../src/core/links";
import { ancestors, descendants, label, notesOf, sections, topOf, tops, type NodeId, type Snap } from "../../src/core/model";
import { clip, plain, sentences } from "../../src/core/text";
import type { LinkVerdicts, LLM } from "../../src/llm/types";
import type { WikiClient } from "../wiki";
import type { PendingStore } from "./pending";
import type { Suggestion } from "./scan";

/** Proposals per call. */
export const BATCH = 60;

/** Calls a background job may make, unless EX_REVIEW_CALLS says otherwise. */
export const JOB_CALLS = 50;
/** Calls the scan after one edit may make. */
export const SCAN_CALLS = 2;

/** Calls made and calls allowed, shared by every review in one job. */
export interface Budget {
  calls: number;
  max: number;
}

export interface ReviewReport {
  approved: number;
  rejected: number;
  calls: number;
  /** Proposals left unreviewed. */
  left: number;
  /** Why some were left: no model, the budget spent, a failed call. */
  fallback?: string;
}

export const REVIEW_SYSTEM = `You review proposed links in a personal library of text, kept as one tree of sections. A scanner has proposed linking phrases in the text to Wikipedia articles or to other sections of the library. Decide, for each proposal, whether a reader of this text would be glad of the link, as a careful Wikipedia editor applying the Manual of Style on linking would. A link is worth making only when it helps; when unsure, do not link. Expect to reject most proposals.

Reject a proposal when:
- the phrase is an everyday word, or a thing so famous that every reader knows it (a country, a major city, a common animal or material, an ordinary idea such as energy, water or the brain, a household name mentioned in passing);
- the target is a different sense of the phrase than the text means, or a different person, place or thing with the same name;
- the phrase is a fragment of a longer name or term in the text (a surname out of a full name, one word of a technical term), or the target is about the fragment alone;
- the same thing is already linked in this section, or earlier in the same tree (listed as "Already linked"), or by another proposal before it in this list: link a thing once, at its first mention that matters;
- a library target is this section's own subsection, parent or sibling (its relation is given): the outline already joins them;
- a library target matches the phrase only by its title, and the text does not mean what that section is about;
- the phrase is inside a verbatim quotation of the request or prompt the text was written from (instructions addressed to an assistant): such text stays as it was written;
- the target is a list, a disambiguation page, a name page, or an article about a film, album, band, company or other namesake.

Approve a proposal when the phrase names a specific concept, result, work, person, organism, place or event that the text means and that a curious reader may well want to look up: a technical term, a named theorem or process, a figure the passage discusses, or a library section elsewhere that treats the phrase's own subject in more depth.

The scanner's tier ("sure" or "unsure") is a weak hint only. Give a verdict for every proposal, by its id, each with a reason of at most twelve words that a person can read in a list.`;

/**
 * What a reviewer needs about one suggestion, besides the suggestion: where it is and what is
 * around it. `given` is the node's text and title as a page sent them, which may be newer than the
 * server's copy (or the node may not have reached the server yet).
 */
export function describe(snap: Snap, s: Suggestion, given?: Given) {
  const n = snap.nodes[s.node];
  const body = given?.node === s.node && given.text !== undefined ? given.text : (n?.body ?? "");
  const d = n ? topOf(snap, s.node) : (given?.top ?? null);
  const sent = sentences(body).find(([a, b]) => s.range[0] >= a && s.range[0] < b) ?? [0, body.length];
  const path: string[] = [];
  for (let x: NodeId | null = s.node; x && x !== d && snap.nodes[x]; x = snap.nodes[x].parent) path.unshift(label(snap, x));
  if (!n) path.push(given?.title || "a new section");
  return {
    ...s,
    nodeTitle: n ? label(snap, s.node) : given?.title || "a new section",
    top: d ? snap.nodes[d].title : null,
    path: path.join(" › "),
    sentence: clip(plain(body.slice(sent[0], sent[1])).trim(), 400),
  };
}

/** A node as the page that asked for its scan sent it. */
export interface Given {
  node: NodeId;
  text?: string;
  title?: string;
  top?: NodeId | null;
}

/** How a library target stands to the section a phrase is in. */
function relation(snap: Snap, from: NodeId, target: NodeId): string {
  if (!snap.nodes[from]) return "elsewhere in the library";
  const sec = ownerSection(snap, from);
  const t = snap.nodes[target];
  if (!t) return "a section that is gone";
  if (t.parent === sec) return "a subsection of this section";
  if (snap.nodes[sec]?.parent === target) return "this section's parent";
  if (ancestors(snap, sec).includes(target)) return "an ancestor of this section";
  if (t.parent && t.parent === snap.nodes[sec]?.parent) return "a sibling of this section";
  const d = topOf(snap, target);
  if (d && d === topOf(snap, sec)) return "elsewhere in this tree";
  return d ? `in another tree, “${snap.nodes[d].title}”` : "elsewhere in the library";
}

const firstSentence = (text: string) => {
  const t = plain(text).trim();
  const [r] = sentences(t);
  return clip(r ? t.slice(r[0], r[1]).trim() : t, 220);
};

/** The titles a node's links go to. */
const linkedTitles = (snap: Snap, id: NodeId): string[] =>
  notesOf(snap, id).flatMap((c) => {
    const r = snap.nodes[c].ref;
    return r ? [targetTitle(snap, r)] : [];
  });

/** Everything already linked under a top, in reading order, each title once. */
function linkedInTop(snap: Snap, top: NodeId): string[] {
  const out = new Set<string>();
  const visit = (id: NodeId) => {
    for (const t of linkedTitles(snap, id)) out.add(t);
    for (const c of sections(snap, id)) visit(c);
  };
  visit(top);
  return [...out];
}

export class Reviewer {
  constructor(
    private o: {
      llm: () => LLM | null;
      wiki: () => WikiClient | null;
      pending: PendingStore;
      snap: () => Snap;
    },
  ) {}

  /** Whether there is a model to ask. */
  get available() {
    return !!this.o.llm();
  }

  /**
   * Review these suggestions (already known to be undecided), in batches, within the budget.
   * Verdicts go into the pending store as they come. Throws only if the signal aborts.
   */
  async review(list: Suggestion[], budget: Budget, signal?: AbortSignal, given?: Given): Promise<ReviewReport> {
    const report: ReviewReport = { approved: 0, rejected: 0, calls: 0, left: list.length };
    if (!list.length) return report;
    const llm = this.o.llm();
    if (!llm) return { ...report, fallback: "no model is configured" };
    // By top, then in reading order, so a call sees a tree's proposals together.
    const snap = this.o.snap();
    const order = new Map<NodeId, number>();
    let i = 0;
    for (const d of tops(snap)) for (const id of [d, ...descendants(snap, d)]) order.set(id, i++);
    const sorted = [...list].sort((a, b) => (order.get(a.node) ?? 1e9) - (order.get(b.node) ?? 1e9) || a.range[0] - b.range[0]);
    for (let at = 0; at < sorted.length; at += BATCH) {
      if (budget.calls >= budget.max) return { ...report, fallback: `the reviewer's limit of ${budget.max} model call${budget.max === 1 ? "" : "s"} was reached` };
      const batch = sorted.slice(at, at + BATCH);
      const req = await this.request(batch, given);
      budget.calls++;
      report.calls++;
      let reply: LinkVerdicts;
      try {
        reply = await llm.json<LinkVerdicts>(req.json, signal);
      } catch (e) {
        if (signal?.aborted) throw e;
        return { ...report, fallback: `the reviewer failed: ${clip((e as Error)?.message ?? String(e), 200)}` };
      }
      signal?.throwIfAborted();
      const now = Date.now();
      for (const v of Array.isArray(reply?.verdicts) ? reply.verdicts : []) {
        const s = req.ids.get(String(v.id));
        if (!s || typeof v.link !== "boolean") continue;
        req.ids.delete(String(v.id));
        this.o.pending.review(s.id, { link: v.link, reason: clip(String(v.reason ?? "").trim(), 160), at: now });
        if (v.link) report.approved++;
        else report.rejected++;
        report.left--;
      }
    }
    return report;
  }

  /** The call for one batch: the top and section headings, and a line per proposal. */
  private async request(batch: Suggestion[], given?: Given) {
    const snap = this.o.snap();
    const wiki = this.o.wiki();
    const ids = new Map<string, Suggestion>();
    const lines: string[] = [];
    const proposals: { id: string; tier: string; quote: string; sentence: string }[] = [];
    let top: NodeId | null | undefined;
    let node: NodeId | undefined;
    for (const [k, s] of batch.entries()) {
      const id = `p${k + 1}`;
      ids.set(id, s);
      const where = describe(snap, s, given);
      const d = snap.nodes[s.node] ? topOf(snap, s.node) : (given?.top ?? null);
      if (d !== top) {
        top = d;
        node = undefined;
        const already = d ? linkedInTop(snap, d) : [];
        lines.push("", `# Tree: ${d ? snap.nodes[d].title : "(none)"}`, `Already linked in this tree: ${already.length ? already.slice(0, 60).join("; ") : "nothing"}`);
      }
      if (s.node !== node) {
        node = s.node;
        const here = snap.nodes[s.node] ? linkedTitles(snap, s.node) : [];
        lines.push("", `## Section: ${where.path || where.nodeTitle}`, `Already linked in this section: ${here.length ? here.join("; ") : "nothing"}`);
      }
      let target: string;
      if (s.target.kind === "node" && s.target.id) {
        const t = snap.nodes[s.target.id];
        target = `library section “${t ? label(snap, s.target.id) : s.title}”, ${relation(snap, s.node, s.target.id)}${t?.body.trim() ? `. It begins: ${firstSentence(t.body)}` : ""}`;
      } else if (s.target.kind === "wiki") {
        const sum = wiki ? await wiki.summary(s.target.title, { cacheOnly: true }) : null;
        const first = sum?.ok ? firstSentence(sum.value.extract) : "";
        target = `Wikipedia article “${s.target.title}”${s.description ? ` (${s.description})` : ""}${first ? `. It begins: ${first}` : ""}`;
      } else target = `web page ${s.title}`;
      lines.push(`- ${id}: “${s.quote}” → ${target} [scanner: ${s.tier === "auto" ? "sure" : "unsure"}]`, `  in: “${where.sentence}”`);
      proposals.push({ id, tier: s.tier, quote: s.quote, sentence: where.sentence });
    }
    const prompt = `Proposals (${batch.length}):\n${lines.join("\n").trim()}\n\nGive a verdict for each of the ${batch.length} proposals.`;
    return {
      ids,
      json: { task: "review-links", schema: "review" as const, system: REVIEW_SYSTEM, context: "Proposed links, grouped by tree and section.", prompt, vars: { proposals: JSON.stringify(proposals) }, effort: "low" as const, maxTokens: 8000 },
    };
  }
}
