/**
 * Everything the app asks a model to do, written against the LLM seam and the op API.
 * Nothing here knows about the UI or the network.
 */
import { Doc, OpError, ancestorsBelowRoot, isLibraryRoot, topOf, isLink, label, notesOf, sections, staleness, type Conflict, type NodeId, type Op, type Snap } from "../core/model";
import { describeTarget, formatTarget, parseTarget, type Ref } from "../core/ref";
import { nodeRef, resolveNode as resolveTargetPath } from "../core/links";
import { mergeBranch, resolveConflict, type MergeReport } from "../core/repo";
import { clip, digest, type Form } from "../core/text";
import { stripMarks, type Mark } from "../core/marks";
import { articleParent, type ArticleKey, type WikiAnchor } from "../core/article";
import {
  AGENT_SYSTEM, PAGE_NOTE_SYSTEM, SYSTEM, type ArticleContext, type Grounding, type Nearby, articleContext, articlePrompt, cascadePrompt, contradictionPrompt, deepenPrompt, expandPrompt, pathOf,
  regenDownPrompt, regenUpPrompt, renderContext, resolvePrompt, writePrompt,
} from "./prompts";
import type { Block, CascadeDecision, Contradictions, LLM, Resolutions, ToolUseBlock, TurnReq } from "./types";
import { DEFAULT_LIMITS, describeStep, normUrl, spent, webOf, type WebStep } from "./web";

type OnText = (delta: string) => void;
const noop = () => {};

/**
 * What the app hands to the tasks that write text: the library's nodes near the one being written
 * (for the prompt's "nearby" list), and where to send the link marks found in what was written
 * (taken out of the stored text; the scanner verifies them before any link is made).
 */
export interface WriteHooks {
  nearby?: (node: NodeId) => Promise<Nearby[]>;
  marks?: (node: NodeId, marks: Mark[]) => void;
}
const nearbyOf = async (hooks: WriteHooks | undefined, id: NodeId) => (hooks?.nearby ? await hooks.nearby(id).catch(() => []) : []);

// ---- expansion ----

export interface ExpansionRequest {
  node: NodeId;
  range: [number, number];
  quote: string;
  form: Form;
  lens: string;
  question?: string;
  /** The summary of the Wikipedia article the words are linked to, when one was at hand. */
  grounding?: Grounding;
  /** Library nodes near this one, which the model may link. */
  nearby?: Nearby[];
}

/** Stream a note for a selection. Does not touch the library, so it can run speculatively. */
export function streamExpansion(llm: LLM, snap: Snap, r: ExpansionRequest, onText: OnText = noop, signal?: AbortSignal): Promise<string> {
  return llm.stream(
    {
      task: "expand",
      system: SYSTEM,
      context: renderContext(snap, r.node),
      prompt: expandPrompt(snap, r.node, r.range, r.form, r.lens, r.question, r.grounding, r.nearby),
      vars: { quote: r.quote, form: r.form, lens: r.question ?? r.lens, nearby: nearbyVar(r.nearby) },
      effort: "low",
      maxTokens: r.form === "passage" ? 2000 : 800,
    },
    onText,
    signal,
  );
}

/** For the mock model: the first nearby node, as handle NUL title. */
const nearbyVar = (n?: Nearby[]) => (n?.length ? `${n[0].handle}\u0000${n[0].title}` : "");

/**
 * Turn generated text into a note anchored to the selection, wherever the selection is by now.
 * Link marks in it are taken out and handed to `onMarks` with the note's id.
 */
export function commitExpansion(doc: Doc, r: ExpansionRequest, text: string, onMarks?: (node: NodeId, marks: Mark[]) => void): NodeId {
  const body = doc.snap().nodes[r.node]?.body;
  if (body === undefined) throw new OpError("the node was deleted while its expansion was being written");
  let [start, end] = r.range;
  if (body.slice(start, end) !== r.quote) {
    start = body.indexOf(r.quote);
    if (start < 0) throw new OpError("the selected text was edited away while its expansion was being written");
    end = start + r.quote.length;
  }
  text = text.trim();
  if (r.form === "gloss") text = text.replace(/[.\s]+$/, "");
  const { text: stored, marks } = stripMarks(text);
  text = stored;
  const report = (id: NodeId) => (marks.length && onMarks?.(id, marks), id);
  // A plain link on the same words becomes the expansion: one node with a body and the link's
  // target, not a note stacked on a link.
  const snap = doc.snap();
  const link = notesOf(snap, r.node).find((c) => isLink(snap.nodes[c]) && snap.nodes[c].anchors.some((a) => a.start === start && a.end === end));
  if (link) {
    doc.apply([{ op: "update", id: link, body: text, form: r.form, lens: r.question ?? r.lens }], `Expand “${clip(r.quote, 40)}”`, { actor: "llm", tag: "expand" });
    return report(link);
  }
  const { created } = doc.apply(
    [{ op: "create", parent: r.node, kind: "note", anchors: [[start, end]], form: r.form, lens: r.question ?? r.lens, body: text }],
    `Expand “${clip(r.quote, 40)}”`,
    { actor: "llm", tag: "expand" },
  );
  return report(created[0]);
}

/** A note on words of a Wikipedia article or a web page: where it attaches, and what it is written from. */
export interface ArticleNoteRequest {
  article: ArticleKey;
  anchor: WikiAnchor;
  form: Form;
  lens: string;
  question?: string;
  context: ArticleContext;
}

/** Stream a note on words of an article or a page (whose text is fenced as untrusted). Does not touch the library. */
export function streamArticleNote(llm: LLM, r: ArticleNoteRequest, onText: OnText = noop, signal?: AbortSignal): Promise<string> {
  return llm.stream(
    {
      task: "expand",
      system: r.context.page ? PAGE_NOTE_SYSTEM : SYSTEM,
      context: articleContext(r.context),
      prompt: articlePrompt(r.context, r.form, r.lens, r.question),
      vars: { quote: r.anchor.q, form: r.form, lens: r.question ?? r.lens },
      effort: "low",
      maxTokens: r.form === "passage" ? 2000 : 800,
    },
    onText,
    signal,
  );
}

/** Keep a note on an article or a page: under its node, made (with the container) on the first one. Link marks are dropped: nothing in an article's notes is linked. */
export function commitArticleNote(doc: Doc, r: ArticleNoteRequest, text: string): NodeId {
  text = stripMarks(text.trim()).text;
  if (r.form === "gloss") text = text.replace(/[.\s]+$/, "");
  const { ops, parent } = articleParent(doc.snap(), r.article);
  const { created } = doc.apply(
    [...ops, { op: "create", parent, kind: "note", wanchor: r.anchor, form: r.form, lens: r.question ?? r.lens, body: text }],
    `Expand “${clip(r.anchor.q, 40)}” in “${clip(r.context.title, 40)}”`,
    { actor: "llm", tag: "expand" },
  );
  return created[created.length - 1];
}

export function parseSections(text: string): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = [];
  for (const chunk of text.split(/^##\s+/m).slice(1)) {
    const nl = chunk.indexOf("\n");
    const title = (nl < 0 ? chunk : chunk.slice(0, nl)).trim();
    const body = nl < 0 ? "" : chunk.slice(nl + 1).trim();
    if (title) out.push({ title, body });
  }
  return out;
}

/** Give a leaf subsections. If it has no body yet, write that first. */
export async function deepen(llm: LLM, doc: Doc, id: NodeId, onText: OnText = noop, signal?: AbortSignal, hooks?: WriteHooks): Promise<NodeId[]> {
  let snap = doc.snap();
  if (isLibraryRoot(snap, id)) throw new OpError("The model does not write the library itself. a adds a section to it.");
  const nearby = await nearbyOf(hooks, id);
  if (!snap.nodes[id].body.trim()) {
    const text = await llm.stream(
      { task: "write", system: SYSTEM, context: renderContext(snap, id), prompt: writePrompt(snap, id, nearby), vars: { title: snap.nodes[id].title, nearby: nearbyVar(nearby) }, effort: "low", maxTokens: 800 },
      onText,
      signal,
    );
    const body = stripMarks(text.trim());
    doc.apply([{ op: "update", id, body: body.text }], `Write “${clip(snap.nodes[id].title, 40)}”`, { actor: "llm", tag: "expand" });
    if (body.marks.length) hooks?.marks?.(id, body.marks);
    return [];
  }
  const text = await llm.stream(
    { task: "deepen", system: SYSTEM, context: renderContext(snap, id), prompt: deepenPrompt(snap, id, nearby), vars: { title: snap.nodes[id].title, nearby: nearbyVar(nearby) }, effort: "low", maxTokens: 4000 },
    onText,
    signal,
  );
  const parts = parseSections(text).map((p) => ({ title: stripMarks(p.title).text, ...stripMarks(p.body) }));
  if (!parts.length) throw new Error("the model did not return any subsections");
  snap = doc.snap();
  if (!snap.nodes[id]) throw new OpError("the node was deleted while its subsections were being written");
  const ops: Op[] = parts.map((p) => ({ op: "create", parent: id, kind: "section", title: p.title, body: p.text }));
  // The subsections were derived from the body, so the body is already their summary.
  ops.push({ op: "bless", id, dir: "up" });
  const created = doc.apply(ops, `Deepen “${clip(snap.nodes[id].title, 40)}”`, { actor: "llm", tag: "expand" }).created;
  created.forEach((c, i) => parts[i]?.marks.length && hooks?.marks?.(c, parts[i].marks));
  return created;
}

// ---- regeneration ----

/** Rewrite a node's body as the summary of its sections. Returns false if the node may not be rewritten. */
export async function regenUp(llm: LLM, doc: Doc, id: NodeId, onText: OnText = noop, signal?: AbortSignal, hooks?: WriteHooks): Promise<boolean> {
  const snap = doc.snap();
  const n = snap.nodes[id];
  // The library's text is not a summary of its children, so the model never rewrites it.
  if (!n || n.pinned || isLibraryRoot(snap, id) || !sections(snap, id).length) return false;
  const settled = sections(snap, id).filter((c) => !staleness(snap, c).down);
  const nearby = await nearbyOf(hooks, id);
  const text = await llm.stream(
    { task: "regen-up", system: SYSTEM, context: renderContext(snap, id), prompt: regenUpPrompt(snap, id, nearby), vars: { current: n.body, titles: sections(snap, id).map((c) => snap.nodes[c].title).join("; "), nearby: nearbyVar(nearby) }, effort: "low", maxTokens: 2000 },
    onText,
    signal,
  );
  if (!doc.snap().nodes[id]) return false;
  const body = stripMarks(text.trim());
  doc.apply(
    // Children that were consistent with the old body were just summarised into the new one,
    // so they stay consistent. This is what stops a cascade from bouncing back down.
    [{ op: "update", id, body: body.text }, ...settled.filter((c) => doc.snap().nodes[c]).map((c): Op => ({ op: "bless", id: c, dir: "down" }))],
    `Re-summarise “${clip(n.title, 40)}” from its sections`,
    { actor: "llm", tag: "regen" },
  );
  // Reported even with no marks: a rewritten node is scanned for links like any other writing.
  hooks?.marks?.(id, body.marks);
  return true;
}

/** Rewrite a node to follow the parent text (or anchored quote) it elaborates. */
async function regenDown(llm: LLM, doc: Doc, id: NodeId, onText: OnText = noop, signal?: AbortSignal, hooks?: WriteHooks): Promise<boolean> {
  const snap = doc.snap();
  const n = snap.nodes[id];
  if (!n || !n.parent || n.pinned || staleness(snap, id).orphan || (n.kind === "section" && isLibraryRoot(snap, n.parent))) return false;
  const parentSettled = n.kind === "section" && !staleness(snap, n.parent).up;
  const nearby = await nearbyOf(hooks, id);
  const text = await llm.stream(
    { task: "regen-down", system: SYSTEM, context: renderContext(snap, id), prompt: regenDownPrompt(snap, id, nearby), vars: { current: n.body, nearby: nearbyVar(nearby) }, effort: "low", maxTokens: 2000 },
    onText,
    signal,
  );
  if (!doc.snap().nodes[id]) return false;
  const body = stripMarks(text.trim());
  const ops: Op[] = [{ op: "update", id, body: body.text }];
  if (parentSettled) ops.push({ op: "bless", id: n.parent, dir: "up" });
  doc.apply(ops, `Revise “${clip(label(snap, id), 40)}” to follow its parent`, { actor: "llm", tag: "regen" });
  hooks?.marks?.(id, body.marks);
  return true;
}

/** Bring one stale node back in line, in whichever direction it is stale. */
export async function reconcile(llm: LLM, doc: Doc, id: NodeId, onText: OnText = noop, signal?: AbortSignal, hooks?: WriteHooks): Promise<boolean> {
  const s = staleness(doc.snap(), id);
  let did = false;
  if (s.down) did = (await regenDown(llm, doc, id, onText, signal, hooks)) || did;
  if (staleness(doc.snap(), id).up) did = (await regenUp(llm, doc, id, onText, signal, hooks)) || did;
  return did;
}

export interface CascadeEvent {
  kind: "decide" | "rewrite" | "keep" | "locked" | "revise";
  node: NodeId;
  text: string;
}

/**
 * After an edit: ask the resolver how many ancestors actually need rewriting, rewrite those
 * bottom-up, bless the first one that does not, then revise the edited node's open children.
 * The ancestors end at the node's top: the library above it is never reconciled with it.
 */
export async function cascade(
  llm: LLM,
  doc: Doc,
  edited: NodeId,
  what: string,
  opts: { rendered?: (id: NodeId) => boolean; onEvent?: (e: CascadeEvent) => void; signal?: AbortSignal; hooks?: WriteHooks } = {},
): Promise<CascadeEvent[]> {
  const events: CascadeEvent[] = [];
  const emit = (e: CascadeEvent) => (events.push(e), opts.onEvent?.(e));
  let snap = doc.snap();
  if (!snap.nodes[edited]) return events;

  // Upward.
  const first = staleness(snap, edited).up ? edited : snap.nodes[edited].parent;
  if (first && staleness(snap, first).up) {
    const chain = [first, ...ancestorsBelowRoot(snap, first)];
    const decision = await llm.json<CascadeDecision>(
      { task: "cascade", schema: "cascade", system: SYSTEM, context: renderContext(snap, edited), prompt: cascadePrompt(snap, edited, what, chain), vars: { chain: String(chain.length) }, effort: "low", maxTokens: 1000 },
      opts.signal,
    );
    const levels = Math.max(0, Math.min(chain.length, Math.round(decision.levels)));
    emit({ kind: "decide", node: first, text: `${levels} level${levels === 1 ? "" : "s"} up: ${decision.reason}` });
    let i = 0;
    for (; i < levels; i++) {
      if (doc.snap().nodes[chain[i]]?.pinned) {
        emit({ kind: "locked", node: chain[i], text: "locked: flagged, not rewritten" });
        break;
      }
      if (await regenUp(llm, doc, chain[i], noop, opts.signal, opts.hooks)) emit({ kind: "rewrite", node: chain[i], text: "re-summarised" });
    }
    // The first ancestor judged still accurate is accepted as it stands.
    if (i === levels && chain[i] && staleness(doc.snap(), chain[i]).up) {
      doc.apply([{ op: "bless", id: chain[i], dir: "up" }], `Keep “${clip(doc.snap().nodes[chain[i]].title, 40)}”: still accurate`, { actor: "llm", tag: "regen" });
      emit({ kind: "keep", node: chain[i], text: "still accurate" });
    }
  }

  // Downward: only what is on screen. The rest stays stale until someone opens it.
  const rendered = opts.rendered ?? (() => true);
  const down = async (id: NodeId) => {
    for (const c of doc.snap().nodes[id]?.children ?? []) {
      snap = doc.snap();
      if (!snap.nodes[c] || !staleness(snap, c).down || !rendered(c)) continue;
      if (snap.nodes[c].pinned) {
        emit({ kind: "locked", node: c, text: "locked: flagged, not rewritten" });
        continue;
      }
      if (await regenDown(llm, doc, c, noop, opts.signal, opts.hooks)) {
        emit({ kind: "revise", node: c, text: "revised to follow its parent" });
        await down(c);
      }
    }
  };
  await down(edited);
  return events;
}

// ---- semantic merge ----

/** The top a conflict is under: its node's, or for a deleted node, its old parent's. */
function conflictTop(snap: Snap, c: Conflict): NodeId {
  const at = [c.node, c.parent].find((x) => x && snap.nodes[x]);
  return (at && topOf(snap, at)) ?? snap.root;
}

/** Split items by the top they are under, so each call carries that top's outline only. */
function byTop<T>(items: T[], topOfItem: (x: T) => NodeId): Map<NodeId, T[]> {
  const out = new Map<NodeId, T[]>();
  for (const x of items) {
    const d = topOfItem(x);
    out.set(d, [...(out.get(d) ?? []), x]);
  }
  return out;
}

/**
 * Ask a model to settle the open conflicts, one call per top they are under. Each resolution
 * is an ordinary commit with its reasoning attached.
 */
export async function resolveConflicts(llm: LLM, doc: Doc, signal?: AbortSignal): Promise<number> {
  // Two different targets for one node is a choice for a person (1 or 2 in history), not a text to write.
  const open = doc.conflicts().filter((c) => c.status === "open" && c.type !== "contradiction" && c.field !== "ref");
  if (!open.length) return 0;
  const snap = doc.snap();
  const context = (c: Conflict) => {
    const p = snap.nodes[c.node]?.parent ?? c.parent;
    return p && snap.nodes[p] ? snap.nodes[p].body : "";
  };
  let n = 0;
  for (const [d, group] of byTop(open, (c) => conflictTop(snap, c))) {
    const result = await llm.json<Resolutions>(
      {
        task: "resolve",
        schema: "resolve",
        system: SYSTEM,
        context: renderContext(snap, d),
        prompt: resolvePrompt(group.map((c) => ({ ...c, context: context(c) }))),
        vars: { conflicts: JSON.stringify(group.map((c) => ({ id: c.id, a: c.a, b: c.b }))) },
        effort: "medium",
        maxTokens: 8000,
      },
      signal,
    );
    for (const r of result.resolutions) {
      if (!group.some((c) => c.id === r.id)) continue;
      resolveConflict(doc, r.id, r.text, { by: "resolver", rationale: r.rationale, actor: "llm" });
      n++;
    }
  }
  return n;
}

/**
 * Look for contradictions between nodes that only one side touched. A clean merge can still hide
 * these. Each top's tree is checked on its own, with its own outline: a contradiction between two
 * trees is not looked for.
 */
export async function scanContradictions(llm: LLM, doc: Doc, report: MergeReport, signal?: AbortSignal): Promise<number> {
  const { base, ours, theirs } = report;
  if (!base || !ours || !theirs) return 0;
  const now = doc.snap();
  const changed = (side: Snap, otherSide: Snap) =>
    Object.values(side.nodes)
      .filter((n) => {
        const b = base.nodes[n.id];
        const o = otherSide.nodes[n.id];
        const mine = !b || b.body !== n.body || b.title !== n.title;
        const theirsToo = o && b && (o.body !== b.body || o.title !== b.title);
        return mine && !theirsToo && n.body.trim() && now.nodes[n.id] && !isLibraryRoot(now, n.id);
      })
      .map((n) => ({ id: n.id as string, title: n.title || label(side, n.id), before: base.nodes[n.id]?.body ?? "(new node)", after: n.body }));
  const a = byTop(changed(ours, theirs), (x) => topOf(now, x.id as NodeId)!);
  const b = byTop(changed(theirs, ours), (x) => topOf(now, x.id as NodeId)!);
  let n = 0;
  for (const [d, sideA] of a) {
    const sideB = b.get(d);
    if (!sideB?.length) continue;
    const result = await llm.json<Contradictions>(
      { task: "contradictions", schema: "contradictions", system: SYSTEM, context: renderContext(doc.snap(), d), prompt: contradictionPrompt(sideA, sideB), effort: "medium", maxTokens: 8000 },
      signal,
    );
    for (const c of result.contradictions) {
      const snap = doc.snap();
      const node = snap.nodes[c.other as NodeId];
      const other = snap.nodes[c.node as NodeId];
      if (!node || !other || !c.text.trim()) continue;
      const record: Conflict = {
        id: digest(["contradiction", ...[node.id, other.id].sort(), node.body, other.body].join("\u0000")),
        type: "contradiction",
        node: node.id,
        other: other.id,
        field: "body",
        title: node.title || label(snap, node.id),
        base: base.nodes[node.id]?.body ?? "",
        a: other.body,
        b: node.body,
        merged: node.body,
        status: "open",
      };
      if (doc.conflicts().some((x) => x.id === record.id)) continue;
      doc.conflictMap.set(record.id, JSON.stringify(record));
      doc.touch();
      resolveConflict(doc, record.id, c.text.trim(), { by: "resolver", rationale: c.explanation, actor: "llm" });
      n++;
    }
  }
  return n;
}

// ---- the editor agent ----

export const TOOLS = [
  {
    name: "read_node",
    description: "Read one node in full: its title, body, the ids and titles of its sections, and the notes anchored in its body. Call this before rewriting a node so you edit what is actually there.",
    input_schema: { type: "object", properties: { id: { type: "string", description: "The node's id, as shown in brackets in the outline." } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "find",
    description: "Search node titles and bodies across the whole library for a phrase, case-insensitively. Returns up to 12 matching nodes with their ids, the top each is under, and where they sit. Use it to locate where something is discussed, including in notes, which the outline does not show, and elsewhere in the library.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "create_node",
    description: "Create a node under a parent. With no quote it is a section, listed in the parent's outline at the given index (default: last). With a quote, which must be text copied exactly from the parent's body, it is a note anchored to that text and shown beside it. Returns the new node's id.",
    input_schema: {
      type: "object",
      properties: {
        parent: { type: "string", description: "Id of the parent node." },
        title: { type: "string", description: "Two to five words, sentence case. Notes may leave this empty." },
        body: { type: "string" },
        quote: { type: "string", description: "For a note: the exact text in the parent's body that the note is about." },
        index: { type: "integer", description: "For a section: position among the parent's children, from 0." },
        target: { type: "string", description: "Optional: what the node is about, elsewhere: \"w:Exact article title\", a node's id or its path \"/Top title/Section/Child\", or an http(s) address. A note with a quote, a target and an empty body is a link." },
      },
      required: ["parent", "title", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "update_node",
    description: "Change a node's title, its body, its target, or several, leaving everything beneath it in place. Give only the fields that change. A new body replaces the old one in full, so include the parts you are keeping. An empty target removes it.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, title: { type: "string" }, body: { type: "string" }, target: { type: "string", description: "\"w:Exact article title\", a node's id or its path \"/Top title/Section/Child\", an http(s) address, or empty to remove the target." } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "replace_node",
    description: "Swap a node's title and body for new ones and delete everything beneath it: its sections and its notes. Use this only when the node's whole subtree should go. To revise text and keep the subtree, use update_node.",
    input_schema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["id", "title", "body"], additionalProperties: false },
  },
  {
    name: "delete_node",
    description: "Delete a node and everything beneath it. The root cannot be deleted.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "suggest_links",
    description: "List the links the app would make or suggest in a node's text: phrases that name another section of the library, or a Wikipedia article (each checked against the text), with the target, a score, a tier (auto: safe to apply; suggest: plausible) and the reason. Nothing is changed; apply the ones worth having with create_node (quote, empty body, target).",
    input_schema: { type: "object", properties: { id: { type: "string", description: "The node whose text to scan." } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "move_node",
    description: "Move a node, with everything beneath it, under a different parent or to a different position under the same parent. A node cannot be moved inside itself.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, parent: { type: "string", description: "Id of the new parent." }, index: { type: "integer", description: "Position among the new parent's children, from 0. Default: last." } },
      required: ["id", "parent"],
      additionalProperties: false,
    },
  },
] as const;

const str = (v: unknown, name: string, required = true): string | undefined => {
  if (v === undefined || v === null) {
    if (required) throw new OpError(`missing "${name}"`);
    return undefined;
  }
  if (typeof v !== "string") throw new OpError(`"${name}" must be a string`);
  return v;
};
const int = (v: unknown, name: string): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new OpError(`"${name}" must be an integer`);
  return v;
};

/**
 * A target the model wrote, as a Ref: a node's id, or a target in the text form. A node path is
 * checked against the library and pinned to the node's id, so a link made by the agent is a real
 * link, not a hope.
 */
function toolTarget(snap: Snap, text: string, from: NodeId): Ref {
  if (snap.nodes[text.trim() as NodeId]) return nodeRef(snap, text.trim() as NodeId);
  const r = parseTarget(text);
  if (typeof r === "string") throw new OpError(`not a target: ${r}`);
  if (r.kind !== "node") return r;
  const id = resolveTargetPath(snap, r, from);
  if (!id) throw new OpError(`no node at ${text}`);
  return nodeRef(snap, id);
}

/**
 * What a research run adds to the tools: the URLs it retrieved. In such a run a web address given
 * as a target must be one of them, so every source the agent cites is a page it actually found or
 * read; outside a research run, addresses are taken as they are.
 */
export interface ToolOpts {
  retrieved?: (url: string) => boolean;
}

/** A URL target in a research run must have been retrieved in that run. The error is written for the model to recover from. */
function checkRetrieved(ref: Ref | null | undefined, opts: ToolOpts) {
  if (ref?.kind !== "url" || !opts.retrieved || opts.retrieved(ref.url)) return;
  throw new OpError(
    "that address was not among the search results or pages read in this run. Cite only an address this run's web search returned or its web fetch read, exactly as it appeared; search or read again if you need another source.",
  );
}

/** Run one tool call against a library. Inputs are validated here, since the model's JSON is not trusted. */
export function execTool(doc: Doc, name: string, input: Record<string, unknown>, opts: ToolOpts = {}): string {
  const snap = doc.snap();
  const need = (id: string) => {
    if (!snap.nodes[id as NodeId]) throw new OpError(`no node with id ${id}`);
    return id as NodeId;
  };
  const brief = (id: NodeId) => ({ id, title: label(snap, id), kind: snap.nodes[id].kind });
  const writable = (id: NodeId) => {
    if (isLibraryRoot(snap, id)) throw new OpError("the library itself is not rewritten by the model");
    return id;
  };
  switch (name) {
    case "read_node": {
      const id = need(str(input.id, "id")!);
      const n = snap.nodes[id];
      const target = (r: Ref | undefined) => (r ? formatTarget(r.kind === "node" && r.id && snap.nodes[r.id] ? nodeRef(snap, r.id) : r) : undefined);
      return JSON.stringify({
        id, kind: n.kind, title: n.title, body: n.body, pinned: n.pinned, written_by: n.by,
        path: pathOf(snap, id),
        target: target(n.ref),
        sections: sections(snap, id).map(brief),
        notes: notesOf(snap, id).map((c) => ({ id: c, about: snap.nodes[c].anchors[0]?.text ?? "", body: snap.nodes[c].body, target: target(snap.nodes[c].ref) })),
      });
    }
    case "find": {
      const q = str(input.query, "query")!.toLowerCase();
      const hits = Object.values(snap.nodes)
        .filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q))
        .slice(0, 12)
        .map((n) => {
          const d = topOf(snap, n.id);
          return { ...brief(n.id), top: d ? snap.nodes[d].title : null, path: pathOf(snap, n.id), excerpt: clip(n.body, 160) };
        });
      return JSON.stringify({ matches: hits });
    }
    case "create_node": {
      const parent = need(str(input.parent, "parent")!);
      const quote = str(input.quote, "quote", false);
      const t = str(input.target, "target", false);
      const ref = t ? toolTarget(snap, t, parent) : undefined;
      checkRetrieved(ref, opts);
      const { created } = doc.apply(
        [{ op: "create", parent, title: str(input.title, "title")!, body: str(input.body, "body")!, quote: quote || undefined, index: int(input.index, "index"), ref }],
        `Agent: add “${clip(String(input.title || quote || "node"), 40)}”`,
        { actor: "llm", tag: "agent" },
      );
      return JSON.stringify({ created: created[0] });
    }
    case "update_node": {
      const id = writable(need(str(input.id, "id")!));
      const title = str(input.title, "title", false);
      const body = str(input.body, "body", false);
      const t = str(input.target, "target", false);
      if (title === undefined && body === undefined && t === undefined) throw new OpError("give a title, a body or a target");
      const ref = t === undefined ? undefined : t.trim() ? toolTarget(snap, t, id) : null;
      checkRetrieved(ref, opts);
      doc.apply([{ op: "update", id, title, body, ref }], `Agent: edit “${clip(label(snap, id), 40)}”`, { actor: "llm", tag: "agent" });
      return JSON.stringify({ updated: id });
    }
    case "replace_node": {
      const id = writable(need(str(input.id, "id")!));
      doc.apply([{ op: "replace", id, title: str(input.title, "title")!, body: str(input.body, "body")! }], `Agent: replace “${clip(label(snap, id), 40)}”`, { actor: "llm", tag: "agent" });
      return JSON.stringify({ replaced: id });
    }
    case "delete_node": {
      const id = need(str(input.id, "id")!);
      doc.apply([{ op: "delete", id }], `Agent: delete “${clip(label(snap, id), 40)}”`, { actor: "llm", tag: "agent" });
      return JSON.stringify({ deleted: id });
    }
    case "move_node": {
      const id = need(str(input.id, "id")!);
      const parent = need(str(input.parent, "parent")!);
      doc.apply([{ op: "move", id, parent, index: int(input.index, "index") }], `Agent: move “${clip(label(snap, id), 40)}”`, { actor: "llm", tag: "agent" });
      return JSON.stringify({ moved: id, under: parent });
    }
    default:
      throw new OpError(`unknown tool: ${name}`);
  }
}

/** What the agent's tools need from outside the library: the link scanner, through the server. */
export interface AgentHooks {
  /** The scanner's suggestions for a node of the agent's copy, or null if it could not be asked. */
  suggest?: (doc: Doc, id: NodeId) => Promise<{ quote: string; target: string; tier: string; score: number; why: string }[] | null>;
}

/** Run a tool call, including the ones that need the scanner. A write's result says how many links are on offer for what it wrote. */
async function execToolAsync(doc: Doc, name: string, input: Record<string, unknown>, hooks: AgentHooks = {}, opts: ToolOpts = {}): Promise<string> {
  if (name === "suggest_links") {
    const id = str(input.id, "id")! as NodeId;
    if (!doc.snap().nodes[id]) throw new OpError(`no node with id ${id}`);
    const list = hooks.suggest ? await hooks.suggest(doc, id) : null;
    if (!list) return JSON.stringify({ suggestions: [], note: "the link scanner is not available" });
    return JSON.stringify({ suggestions: list });
  }
  const out = execTool(doc, name, input, opts);
  if ((name === "create_node" || name === "update_node") && hooks.suggest) {
    const r = JSON.parse(out) as { created?: NodeId; updated?: NodeId };
    const id = r.created ?? r.updated;
    const list = id ? await hooks.suggest(doc, id) : null;
    if (list) return JSON.stringify({ ...r, links: `${list.length} link suggestion${list.length === 1 ? "" : "s"} available (suggest_links lists them)` });
  }
  return out;
}

export interface AgentEvent {
  /** search and fetch: a step of web research, as it happens (or as the turn that made it ends). */
  kind: "say" | "tool" | "error" | "search" | "fetch";
  text: string;
}

export interface AgentResult {
  summary: string;
  commits: number;
  report: MergeReport;
  /** The web pages the agent linked from what it wrote, in the order it first linked them. */
  sources: { url: string; title?: string }[];
  /** Searches and fetches the run used (zero without research). */
  web: { searches: number; fetches: number };
}

export interface AgentOpts {
  /** Give the agent web search and fetch for this run. */
  research?: boolean;
  /** Caps for the run (the server applies its own, which win). */
  limits?: { searches: number; fetches: number };
}

/** A tool call in words, for the progress display: what it does, to which node. */
function describeCall(snap: Snap, name: string, input: Record<string, unknown>): string {
  const node = (v: unknown) => (typeof v === "string" && snap.nodes[v as NodeId] ? `“${clip(label(snap, v as NodeId), 40)}”` : "a node");
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (name) {
    case "create_node": {
      const t = s(input.target) ? parseTarget(s(input.target)) : null;
      const to = t && typeof t !== "string" ? ` to ${clip(describeTarget(t), 50)}` : "";
      if (s(input.quote) && !s(input.body).trim() && to) return `linked “${clip(s(input.quote), 40)}”${to}`;
      if (s(input.quote)) return `added a note on “${clip(s(input.quote), 40)}”${to ? `, linked${to}` : ""}`;
      return `added “${clip(s(input.title) || "a section", 40)}” under ${node(input.parent)}`;
    }
    case "update_node":
      return `revised ${node(input.id)}`;
    case "replace_node":
      return `rewrote ${node(input.id)}`;
    case "delete_node":
      return `deleted ${node(input.id)}`;
    case "move_node":
      return `moved ${node(input.id)} under ${node(input.parent)}`;
    case "read_node":
      return `read ${node(input.id)}`;
    case "find":
      return `looked for “${clip(s(input.query), 40)}”`;
    case "suggest_links":
      return `asked for links in ${node(input.id)}`;
    default:
      return `${name} ${clip(JSON.stringify(input), 80)}`;
  }
}

/** Consecutive paused turns (the API's server-side loop ran long) resumed before the run gives up. */
const MAX_PAUSES = 5;

/**
 * The editor agent. It works on a fork under its own peer id, with the same ops a person has,
 * and its work comes back through the ordinary merge, so the person can keep editing meanwhile.
 */
export async function runAgent(
  llm: LLM,
  doc: Doc,
  instruction: string,
  focus: NodeId,
  onEvent: (e: AgentEvent) => void = noop,
  signal?: AbortSignal,
  hooks: AgentHooks = {},
  opts: AgentOpts = {},
): Promise<AgentResult> {
  const fork = doc.fork("agent");
  const snap = fork.snap();
  const research = Boolean(opts.research);
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const ask = research
    ? `${instruction}\n\nWeb research is on for this request: search for what it needs, read the most useful pages, then make the change with your tools, linking each claim you take from the web to the page it came from.`
    : instruction;
  const req: TurnReq = {
    system: AGENT_SYSTEM,
    context: renderContext(snap, focus, { ids: true }),
    messages: [{ role: "user", content: `The person is looking at: [${focus}] ${pathOf(snap, focus)}\n\nTheir request: ${ask}` }],
    vars: { focus, instruction, ...(research ? { research: "1" } : {}) },
  };
  // What the run has retrieved (search results and pages read), by normalised URL, with a title if known.
  const retrieved = new Map<string, string | undefined>();
  const cited = new Map<string, { url: string; title?: string }>();
  const used = { searches: 0, fetches: 0 };
  const toolOpts: ToolOpts = research ? { retrieved: (url) => retrieved.has(normUrl(url)) } : {};
  const report = (s: WebStep) => onEvent({ kind: s.kind, text: describeStep(s) });

  let summary = "";
  let commits = 0;
  let pauses = 0;
  for (let step = 0; step < 24; step++) {
    signal?.throwIfAborted();
    if (research) req.research = { ...limits, used: { ...used }, found: [...retrieved.keys()] };
    let live = 0;
    const earlier = req.messages.flatMap((m) => (m.role === "assistant" && Array.isArray(m.content) ? m.content : []));
    const turn = await llm.turn(req, signal, research ? (s) => (live++, report(s)) : undefined);
    req.messages.push({ role: "assistant", content: turn.content });
    if (research) {
      const web = turn.web ?? webOf(turn.content, earlier);
      for (const src of web.sources) {
        const key = normUrl(src.url);
        if (!retrieved.has(key) || (!retrieved.get(key) && src.title)) retrieved.set(key, src.title);
      }
      const n = spent(web.steps);
      used.searches += n.searches;
      used.fetches += n.fetches;
      // A provider that streams its steps has reported them already.
      if (!live) web.steps.forEach(report);
      // The providers enforce the caps (the API's max_uses, the subscription route's guard); this
      // is the backstop should one of them not: past a cap by more than one, the run stops.
      if (used.searches > limits.searches + 1 || used.fetches > limits.fetches + 1) {
        onEvent({ kind: "error", text: "the run went past its limit on searches or pages read, so it was stopped" });
        throw new Error("The editor went past its web limits and was stopped; nothing it did was kept.");
      }
    }
    const text = turn.content.filter((b): b is Extract<Block, { type: "text" }> => b.type === "text").map((b) => (b as { text: string }).text).join("").trim();
    if (text) {
      summary = text;
      onEvent({ kind: "say", text });
    }
    if (turn.stop_reason === "refusal") throw new Error("the model declined this request");
    // The API paused its own loop of searches and fetches: send the conversation back as it is and
    // it carries on where it stopped (no new user message, the same tools).
    if (turn.stop_reason === "pause_turn") {
      if (++pauses > MAX_PAUSES) break;
      continue;
    }
    pauses = 0;
    // Server tool blocks (server_tool_use and its results) are the API's to run, not ours: only
    // tool_use blocks are client calls.
    const calls = turn.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    // A turn cut off by the token limit may carry a truncated tool call; do not run it.
    if (turn.stop_reason !== "tool_use" || !calls.length) break;
    const results = [];
    for (const call of calls) {
      try {
        const what = describeCall(fork.snap(), call.name, call.input ?? {});
        const out = await execToolAsync(fork, call.name, call.input ?? {}, hooks, toolOpts);
        if (!["read_node", "find", "suggest_links"].includes(call.name)) commits++;
        onEvent({ kind: "tool", text: what });
        results.push({ type: "tool_result", tool_use_id: call.id, content: out });
        const t = typeof call.input?.target === "string" ? parseTarget(call.input.target) : null;
        if (t && typeof t !== "string" && t.kind === "url" && !cited.has(normUrl(t.url))) {
          cited.set(normUrl(t.url), { url: t.url, title: retrieved.get(normUrl(t.url)) ?? t.title });
        }
      } catch (err) {
        if (!(err instanceof OpError)) throw err;
        onEvent({ kind: "error", text: `${call.name}: ${err.message}` });
        results.push({ type: "tool_result", tool_use_id: call.id, content: err.message, is_error: true });
      }
    }
    req.messages.push({ role: "user", content: results });
  }
  signal?.throwIfAborted();
  const merged = commits ? mergeBranch(doc, fork, "agent") : ({ kind: "nothing", conflicts: [] } as MergeReport);
  return { summary, commits, report: merged, sources: [...cited.values()], web: used };
}
