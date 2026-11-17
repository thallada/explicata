/**
 * The link scanner: given a node's text and where it sits, what in it is worth linking, and to
 * what. Four sources, in order of preference for any one phrase:
 *
 *   forced     a [[mark]] the writer typed: verified, then linked (or reported as not found)
 *   library    a phrase that is another section's title (normalised), never the node itself or
 *              an ancestor, other tops' trees preferred
 *   meaning    a section under another top close in meaning to this node, when a phrase here
 *              names it; when nothing here names it, it is only listed as Related (never forced
 *              onto arbitrary words)
 *   wikipedia  a batched lookup of the candidates; disambiguation pages resolved by embedding fit
 *              against the text (a few per scan); a title search as a second try for multi-word
 *              misses; every hit scored by fit between the text and "Title: description"
 *
 * Each suggestion gets a tier: `auto` (safe to apply without asking) or `suggest`; anything weaker
 * is dropped. Then Wikipedia's own manners: first mention only, a few links a paragraph, the
 * strongest kept. See judge() for the rule. Only phrases and search queries go to Wikipedia;
 * embeddings are local.
 *
 * "The same text" here means the tree under one top (a child of the library root, `topOf`): the
 * rule was tuned with that as the unit, for centrality, first mention and "meaning from elsewhere".
 */
import { inArticles } from "../../src/core/article";
import { notesOf, sections, topOf, ancestors as ancestorsOf, descendants, type Doc, type NodeId, type Snap } from "../../src/core/model";
import { nodeRef, targetKey } from "../../src/core/links";
import type { Mark } from "../../src/core/marks";
import type { Nearby } from "../../src/llm/prompts";
import type { Ref } from "../../src/core/ref";
import { digest, overlaps, paragraphs, plain, type Range } from "../../src/core/text";
import { VectorIndex, dot, tokenize, type Embedder } from "../embed";
import type { CallOpts, LookupItem, WikiClient } from "../wiki";
import { COMMON_RANK, extract, phraseKey, type Candidate, type Kind } from "./extract";
import type { NodeIndex } from "./nodeIndex";
import { UNLISTED, rank } from "./words";

export type Tier = "auto" | "suggest";
export type Source = "forced" | "library" | "meaning" | "wikipedia";

export interface Suggestion {
  /** Stable for the same node, words and target. */
  id: string;
  node: NodeId;
  range: Range;
  quote: string;
  /** The normalised phrase: what a rejection records. */
  key: string;
  target: Ref;
  score: number;
  tier: Tier;
  why: string;
  source: Source;
  /** The target's title (an article's, or a section's), and an article's short description. */
  title: string;
  description: string | null;
  kind: Kind;
  /**
   * Determinations, kept with the suggestion in the pending store (server/links/pending.ts): the
   * model reviewer's verdict, a person's decision, and when an approved link was handed out to be
   * made. A scan never sets these; the store carries them from one scan of the node to the next.
   */
  review?: Verdict;
  decided?: Decision;
  applied?: number;
}

/** The model reviewer's verdict on a suggestion, with its one-line reason. */
export interface Verdict {
  link: boolean;
  reason: string;
  at: number;
}

/** A person's decision on a suggestion: linked or declined, by whom. */
export interface Decision {
  link: boolean;
  by: string;
  at: number;
}

export interface Related {
  node: NodeId;
  title: string;
  /** Where it is: the title of the top it is under. */
  top: string;
  score: number;
  why: string;
}

export interface ScanInput {
  node: NodeId;
  /** The node's text; by default the server's copy. A browser sends its own, which may be newer. */
  text?: string;
  title?: string;
  /** The top the node is under, and its title (a page sends them for a node the server may not have yet). */
  top?: NodeId | null;
  topTitle?: string;
  ancestors?: NodeId[];
  /** Spans already under a note: [start, end, linked]. */
  occupied?: [number, number, boolean][];
  /** Normalised phrases the writer declined in this node. */
  rejected?: string[];
  /** [[marks]], already taken out of `text`. */
  forced?: Mark[];
  /** Wikipedia queue lane: "scan" (the default: after an edit, behind anything a person waits on) or "bulk" (a job). */
  priority?: "interactive" | "bulk" | "scan";
  /** Only phrases inside these spans are looked at (the new text of an edit); default the whole text. */
  within?: Range[];
  /** For evaluation: every phrase that resolved to something, with its judgement, is pushed here. */
  trace?: TraceRow[];
}

export interface TraceRow {
  phrase: string;
  key: string;
  start: number;
  kind: Kind;
  source: Source;
  target: string;
  description: string | null;
  fit: number | null;
  score: number;
  tier: Tier | null;
  chosen: boolean;
  why: string;
  /** What judge() saw. */
  features: { words: number; rarity: number; exact: boolean; redirect: boolean; sense: boolean; margin: number | null; searched: boolean; central: boolean; firstInTop: boolean; sentenceStart: boolean };
}

export interface ScanResult {
  node: NodeId;
  suggestions: Suggestion[];
  related: Related[];
  /** Marked phrases that resolved to nothing. */
  unresolved: string[];
  /** What was not available, in words ("embeddings unavailable: matched by text only"). */
  degraded: string[];
  stats: { candidates: number; lookedUp: number; requests: number; ms: number };
}

/**
 * The numbers judge() and the scan use, tuned on the labelled sample (tests/fixtures/link-labels.json,
 * scripts/linkEval.ts). Fits are on bge-small's scale.
 */
export interface Tuning {
  /** Least fit for a link made without asking: a multi-word term, a name, a single word, a library title. */
  auto: { term: number; name: number; noun: number; library: number };
  /** Least fit for a suggestion. */
  suggest: { term: number; name: number; noun: number; library: number };
  /** A single word must be at least this rare (words.ts rank) to be suggested, and this rare to be applied. */
  nounRank: { suggest: number; auto: number };
  /** A multi-word term is applied without asking only when one of its words is this rare. */
  termRank: number;
  /** A disambiguation sense is offered only when it beats the runner-up by this much. */
  senseMargin: number;
  /** Cosine at or above which another section counts as close in meaning. */
  relatedAt: number;
  /** Disambiguation pages resolved per scan (each costs a request), and title searches. */
  maxSenses: number;
  maxSearches: number;
  /** Links per paragraph, counting those already there. */
  perParagraph: number;
  /**
   * Fit as judged = a + b × cosine, clipped to [0, 1]. Embedding models spread their cosines
   * differently; the thresholds above are for bge-small, so another model is mapped onto its scale.
   */
  fit: [number, number];
}

export const TUNING: Tuning = {
  auto: { term: 0.55, name: 0.55, noun: 0.7, library: 0.72 },
  suggest: { term: 0.6, name: 0.6, noun: 0.64, library: 0.64 },
  nounRank: { suggest: 8000, auto: 15_000 },
  termRank: 6000,
  senseMargin: 0.04,
  relatedAt: 0.78,
  maxSenses: 2,
  maxSearches: 1,
  perParagraph: 3,
  fit: [0, 1],
};

/**
 * Per-model adjustments. The test model (IE_EMBED=fake: hashed words) gives a 7-word description
 * and a paragraph a cosine of 0.1–0.3 when they share a word and 0 when they share none.
 */
const PROFILES: Record<string, Partial<Tuning>> = {
  fake: { fit: [0.5, 1.5], relatedAt: 0.15 },
};

/** Descriptions of articles that are almost never what prose means by an ordinary phrase. */
const OFF_TOPIC = /\b(album|song|single|film|movie|band|group|singer|rapper|musician|episode|television|tv series|sitcom|novel|video game|comic|manga|anime|company|brand|restaurant|chain|surname|given name|family name|name list|fictional|character|play by|racehorse|ship|football|basketball|baseball|cricketer|footballer|politician|disambiguation|topics referred to|list of|wikimedia)\b/i;

interface Hit {
  c: Candidate;
  target: Ref;
  source: Source;
  title: string;
  description: string | null;
  /** Fit between the text and the target, or null without a model. */
  fit: number | null;
  /** The title is the phrase itself (up to case and number), not a redirect from something else. */
  exact: boolean;
  redirect: boolean;
  /** Chosen among a disambiguation page's senses. */
  sense: boolean;
  /** Margin of the chosen sense over the next. */
  margin?: number;
  /** Found by title search, not by lookup. */
  searched: boolean;
  central: boolean;
  firstInTop: boolean;
  /** A library target under the same top as the node. */
  sameTop?: boolean;
}

/** A hit with the defaults most sources share: an exact title, no description or fit yet, nothing special about it. */
const hitOf = (c: Candidate, target: Ref, source: Source, title: string, more: Partial<Hit> = {}): Hit => ({
  c, target, source, title, description: null, fit: null, exact: true, redirect: false, sense: false, searched: false, central: false, firstInTop: true, ...more,
});

const keyWords = (key: string) => key.split(" ").filter(Boolean).length;

export interface Judgement {
  score: number;
  tier: Tier | null;
  why: string;
}

/** Descriptions of pages that are not the concept a phrase in prose means: lists, name pages, countries. */
const NOT_A_CONCEPT = /^(surname|given name|family name|index of|list of|topics referred to)|\b(surname list|name list|set index)\b|^country in\b|^sovereign state\b/i;

/**
 * The rule, as tuned. Fit separates right senses from wrong ones (docs/wikipedia.md §5: about 0.6
 * for bge-small) but does not say whether a phrase is worth linking, so each kind of phrase has its
 * own bar, and `auto` needs the phrase's form to vouch for it too:
 *
 *   term     (several words, not a name) auto when the title is the phrase itself (up to case and
 *            number), one word is uncommon, and fit ≥ 0.55; suggest otherwise from fit 0.6
 *   name     (capitalised) auto when the title is the name itself and it is not an ordinary word
 *            ("Old World", "Sun"), from fit 0.55; never a country, a surname page or a list
 *   noun     (one lower-case word) only if rare (rank ≥ 8,000); auto only when very rare (≥ 15,000),
 *            the exact title, and fit ≥ 0.70
 *   library  a section title: under the same top from fit 0.72 (auto) or 0.64 (suggest); under
 *            another top only a multi-word or uncommon title, and never auto below 0.72
 *
 * Never auto: a disambiguation sense chosen by fit (suggested only for names and terms, with a
 * clear margin), a title found by search, a redirect to a differently named page from one word, and
 * a concept central to the top's tree (linked once, at its first mention, and only suggested).
 */
export function judge(h: Hit, t: Tuning = TUNING): Judgement {
  const c = h.c;
  const fit = h.fit;
  const f = fit === null ? "" : `fits the text ${fit.toFixed(2)}`;
  if (h.source === "meaning") return { score: fit ?? 0, tier: "suggest", why: `close in meaning (${(fit ?? 0).toFixed(2)}) to “${h.title}”, and named here` };
  if (h.source === "forced" || c.kind === "forced") {
    const ok = fit === null ? !h.sense : fit >= t.suggest.term - 0.1;
    return { score: fit ?? 0.7, tier: ok ? "auto" : null, why: `marked by the writer; ${fit === null ? "found" : f}` };
  }
  if (h.central && !h.firstInTop) return { score: 0, tier: null, why: "central to the text: linked once, at its first mention" };
  const tierBy = (autoOk: boolean, autoAt: number, suggestAt: number): Tier | null => {
    // Text only (no embeddings): the strongest are suggested, nothing is applied unasked.
    if (fit === null) return autoOk ? "suggest" : null;
    // Unasked, a concept is linked once per top's tree, where it is first mentioned; later mentions are only suggested.
    if (autoOk && fit >= autoAt && !h.central && h.firstInTop) return "auto";
    return fit >= suggestAt ? "suggest" : null;
  };
  const done = (tier: Tier | null, why: string[]) => ({ score: Math.round((fit ?? 0.6) * 1000) / 1000, tier, why: why.filter(Boolean).join("; ") });

  if (h.source === "library") {
    const strong = c.words > 1 || c.rarity >= t.nounRank.auto;
    if (!h.sameTop && !strong) return done(null, ["a common word that titles a section elsewhere"]);
    // A one-word title ("The comma", "Pythagorean") is a heading more often than the concept itself: suggested at most.
    const tier = tierBy(keyWords(c.key) > 1, t.auto.library, h.sameTop ? t.suggest.library : t.auto.library - 0.06);
    return done(h.central && tier ? "suggest" : tier, [`the title of “${h.title}” in this library`, f]);
  }

  const desc = h.description ?? "";
  if (NOT_A_CONCEPT.test(desc)) return done(null, [`“${h.title}” is ${desc.toLowerCase()}`]);
  const why = [f];
  if (h.central) why.push("central to the text: first mention only");
  if (h.sense) {
    // A sense chosen by fit: offered for names and terms when it clearly beats the next one.
    why.push(`one of the senses of “${c.text}”`);
    const clear = (h.margin ?? 0) >= t.senseMargin && c.kind !== "noun";
    return done(clear ? tierBy(false, 1, t.suggest.name + 0.08) : null, why);
  }
  if (h.searched) why.push("found by title search");
  if (!h.exact) why.push(h.redirect ? `redirects to “${h.title}”` : `titled “${h.title}”`);
  if (OFF_TOPIC.test(desc)) {
    why.push("an article about something else");
    return done(null, why);
  }
  const plain = h.exact && !h.searched;
  if (c.kind === "term") {
    why.push(c.rarity >= t.termRank ? "a technical term" : "a multi-word phrase");
    return done(tierBy(plain && c.rarity >= t.termRank, t.auto.term, t.suggest.term + (h.exact ? 0 : 0.05)), why);
  }
  if (c.kind === "name") {
    why.push("a proper name");
    // A capitalised ordinary word ("Sun", "East", "Old World") is not a name worth a link.
    if (c.rarity < 1000) return done(null, [...why, "an ordinary word"]);
    const single = c.words === 1;
    return done(tierBy(plain && (!single || c.rarity >= UNLISTED), single ? t.auto.name + 0.05 : t.auto.name, t.suggest.name), why);
  }
  // A single lower-case word.
  if (c.rarity < t.nounRank.suggest) return done(null, [...why, "a fairly common word"]);
  why.push(c.rarity >= UNLISTED ? "an uncommon word" : "a fairly uncommon word");
  return done(tierBy(plain && c.rarity >= t.nounRank.auto, t.auto.noun, t.suggest.noun + (h.exact ? 0 : 0.03)), why);
}

// ---- the library's titles ----

/** A title worth matching: a short concept name, not a sentence or a lone common word. */
function titleKeyOf(title: string): string | null {
  const key = phraseKey(title);
  const words = key.split(" ").filter(Boolean);
  if (!words.length || words.length > 4) return null;
  if (words.length === 1 && rank(words[0]) <= COMMON_RANK) return null;
  return key;
}

const titleCache = new WeakMap<object, Map<string, NodeId[]>>();
/**
 * Sections by normalised title, built once per state of the library. Keyed by the root's entry,
 * which is replaced whenever anything beneath it changes (the snapshot's record of nodes is not:
 * it is patched in place).
 */
function titleIndex(snap: Snap): Map<string, NodeId[]> {
  const key = snap.nodes[snap.root];
  let ix = titleCache.get(key);
  if (ix) return ix;
  ix = new Map();
  for (const id in snap.nodes) {
    const n = snap.nodes[id as NodeId];
    if (n.kind !== "section" || !n.parent || inArticles(snap, n.id)) continue;
    const key = titleKeyOf(n.title);
    if (!key) continue;
    const list = ix.get(key) ?? [];
    list.push(n.id);
    ix.set(key, list);
  }
  titleCache.set(key, ix);
  return ix;
}

/** For each top: the sections of its tree in reading order, each with its normalised text. */
const topCache = new WeakMap<object, { id: NodeId; text: string }[]>();
function topTexts(snap: Snap, top: NodeId): { id: NodeId; text: string }[] {
  const d = snap.nodes[top];
  let out = topCache.get(d);
  if (out) return out;
  out = [];
  const visit = (id: NodeId) => {
    const n = snap.nodes[id];
    out!.push({ id, text: ` ${phraseKey(`${n.title} ${n.body}`)} ` });
    for (const c of sections(snap, id)) visit(c);
  };
  visit(top);
  topCache.set(d, out);
  return out;
}

const stripParen = (t: string) => t.replace(/\s*\([^)]*\)\s*$/, "");

export class Linker {
  readonly tuning: Tuning;
  /** Vectors of "Title: description" strings, remembered between scans. */
  private senseVectors: VectorIndex;

  constructor(
    private o: { doc: () => Doc; wiki: () => WikiClient | null; embedder: Embedder | null; index: NodeIndex; tuning?: Partial<Tuning> },
  ) {
    this.tuning = { ...TUNING, ...(o.embedder ? PROFILES[o.embedder.spec.id] : undefined), ...o.tuning };
    this.senseVectors = new VectorIndex(null, o.embedder);
  }

  async scan(input: ScanInput, signal?: AbortSignal): Promise<ScanResult> {
    const t0 = performance.now();
    const t = this.tuning;
    const snap = this.o.doc().snap();
    const n = snap.nodes[input.node];
    const text = input.text ?? n?.body ?? "";
    const title = input.title ?? n?.title ?? "";
    const topId = input.top !== undefined ? input.top : n ? topOf(snap, input.node) : null;
    const topTitle = input.topTitle ?? (topId && snap.nodes[topId] ? snap.nodes[topId].title : "");
    const ancestors = new Set(input.ancestors ?? (n ? ancestorsOf(snap, input.node) : []));
    const occupied = input.occupied ?? (n ? notesOf(snap, input.node).flatMap((c) => snap.nodes[c].anchors.map((a): [number, number, boolean] => [a.start, a.end, !!snap.nodes[c].ref])) : []);
    const rejected = new Set(input.rejected ?? n?.nolink ?? []);
    const degraded: string[] = [];
    const wiki = this.o.wiki();
    const requests0 = wiki?.requests ?? 0;
    const opts: CallOpts = { priority: input.priority ?? "scan", signal };

    // Linked spans are off limits; a plain note's exact span may take a target (it becomes a note that also links).
    const plainNotes = occupied.filter(([, , linked]) => !linked);
    const exclude = occupied.filter(([, , linked]) => linked).map(([s, e]): [number, number] => [s, e]);
    const skip = new Set([phraseKey(title), ...rejected].filter(Boolean));
    let cands = extract(text, { exclude, forced: input.forced, skip });
    cands = cands.filter((c) => !plainNotes.some(([s, e]) => overlaps([s, e], [c.start, c.end]) && !(s === c.start && e === c.end)));
    if (input.within?.length) cands = cands.filter((c) => c.kind === "forced" || input.within!.some((r) => overlaps(r, [c.start, c.end])));
    // Targets already linked in this node: first mention means they are not offered again.
    const linkedHere = new Set(n ? notesOf(snap, input.node).map((c) => snap.nodes[c].ref).filter((r): r is Ref => !!r).map(targetKey) : []);

    // Centrality: in the top's title, or in many of its tree's sections.
    const tree = topId && snap.nodes[topId] ? topTexts(snap, topId) : [];
    const topTitleKey = ` ${phraseKey(topTitle)} `;
    const owner = n?.kind === "note" ? [...ancestors].find((a) => snap.nodes[a]?.kind === "section") ?? input.node : input.node;
    const centrality = (key: string) => {
      const k = ` ${key} `;
      const holders = tree.filter((d) => d.text.includes(k));
      const central = topTitleKey.includes(k) || (tree.length >= 6 && holders.length >= Math.max(3, tree.length * 0.3));
      const firstInTop = !holders.length || holders[0].id === owner;
      return { central, firstInTop };
    };

    const exceptSelf = new Set<NodeId>([input.node, ...ancestors]);
    const hits: Hit[] = [];
    const resolved = new Set<Candidate>();
    const unresolved: string[] = [];

    // 1. Forced marks with a handle name a library node outright.
    for (const c of cands) {
      if (c.kind !== "forced" || !c.handle) continue;
      const id = c.handle as NodeId;
      if (snap.nodes[id] && !exceptSelf.has(id)) {
        hits.push(hitOf(c, nodeRef(snap, id), "forced", snap.nodes[id].title || "a note"));
        resolved.add(c);
      }
    }

    // 2. Library titles.
    const titles = titleIndex(snap);
    for (const c of cands) {
      if (resolved.has(c)) continue;
      const ids = (titles.get(c.key) ?? []).filter((id) => !exceptSelf.has(id) && snap.nodes[id]);
      if (!ids.length) continue;
      const pick = ids.find((id) => topOf(snap, id) !== topId) ?? ids[0];
      const { central, firstInTop } = centrality(c.key);
      const d = topOf(snap, pick);
      hits.push(hitOf(c, nodeRef(snap, pick), c.kind === "forced" ? "forced" : "library", `${snap.nodes[pick].title}${d && d !== pick && d !== topId ? ` (${snap.nodes[d].title})` : ""}`, { central, firstInTop, sameTop: d === topId }));
      resolved.add(c);
    }

    // The text a target must fit: the node under its top.
    const context = `${topTitle}. ${title}.\n${plain(text)}`.slice(0, 2000);
    const ctx = this.o.embedder ? await this.o.embedder.embed([context]) : null;
    const ctxVec = ctx?.[0] ?? null;
    if (!ctxVec) degraded.push("embeddings unavailable: matched by text only");
    // A library title must also fit: "nucleus" in a physics text is not the cell's nucleus.
    for (const h of hits) {
      if (h.target.kind !== "node" || !ctxVec) continue;
      const v = this.o.index.vectors.vectorOf(h.target.id!);
      if (v) h.fit = this.calibrate(dot(ctxVec, v));
    }

    // 3. Wikipedia.
    let lookedUp = 0;
    if (!wiki) degraded.push("Wikipedia is off");
    else {
      const todo = cands.filter((c) => !resolved.has(c) && !(c.kind === "forced" && c.handle));
      const variants = [...new Set(todo.flatMap((c) => c.variants))];
      lookedUp = variants.length;
      const found = new Map<string, LookupItem>();
      for (const item of await wiki.lookup(variants, opts)) found.set(item.input, item);
      if ([...found.values()].some((i) => i.status === "unavailable")) degraded.push("Wikipedia did not answer for some phrases");
      const disamb: { c: Candidate; title: string }[] = [];
      const misses: Candidate[] = [];
      for (const c of todo) {
        const item = c.variants.map((v) => found.get(v)).find((i) => i?.status === "found");
        if (item?.status !== "found") {
          if (c.words > 1 && (c.kind !== "noun") && c.variants.every((v) => found.get(v)?.status === "missing")) misses.push(c);
          continue;
        }
        if (item.disambiguation) {
          disamb.push({ c, title: item.title });
          continue;
        }
        const key = phraseKey(stripParen(item.title));
        const { central, firstInTop } = centrality(c.key);
        hits.push(hitOf(c, { kind: "wiki", title: item.title, lang: wiki.lang }, "wikipedia", item.title, { description: item.description, exact: key === c.key, redirect: item.redirect, central, firstInTop }));
      }
      // Disambiguation pages: the most promising few, by the phrase's own worth.
      const worth = (c: Candidate) => (c.kind === "forced" ? 3 : c.kind === "name" ? 2 : c.kind === "term" ? 1.5 : c.rarity > 15_000 ? 1 : 0);
      disamb.sort((a, b) => worth(b.c) - worth(a.c));
      let senseBudget = t.maxSenses;
      for (const { c, title: page } of disamb) {
        if (!ctxVec) break;
        if (c.kind !== "forced") {
          if (senseBudget <= 0 || worth(c) < 1) continue;
          senseBudget--;
        }
        const r = await wiki.senses(page, opts);
        if (!r.ok || !r.value.length) continue;
        const scored = await this.fit(ctxVec, r.value.map((s) => ({ title: s.title, description: s.description })));
        if (!scored?.length) continue;
        const [best, next] = scored;
        const { central, firstInTop } = centrality(c.key);
        hits.push(
          hitOf(c, { kind: "wiki", title: best.title, lang: wiki.lang }, "wikipedia", best.title, {
            description: best.description, fit: best.fit, exact: phraseKey(stripParen(best.title)) === c.key, sense: true, margin: best.fit - (next?.fit ?? 0), central, firstInTop,
          }),
        );
      }
      // A multi-word miss may be a case problem ("Church-Turing thesis"): one title search.
      let searchBudget = t.maxSearches;
      misses.sort((a, b) => worth(b) - worth(a));
      for (const c of misses) {
        if (c.kind !== "forced") {
          if (searchBudget <= 0) break;
          searchBudget--;
        }
        const r = await wiki.suggest(c.text, 5, opts);
        if (!r.ok) continue;
        const match = r.value.find((s) => phraseKey(stripParen(s.title)) === c.key);
        if (!match) continue;
        const { central, firstInTop } = centrality(c.key);
        hits.push(hitOf(c, { kind: "wiki", title: match.title, lang: wiki.lang }, "wikipedia", match.title, { description: match.description, searched: true, central, firstInTop }));
      }
      // Fit for every article hit that has none yet.
      if (ctxVec) {
        const need = hits.filter((h) => h.source !== "library" && h.target.kind === "wiki" && h.fit === null);
        const scored = await this.fit(ctxVec, need.map((h) => ({ title: h.title, description: h.description })), false);
        if (scored) need.forEach((h, i) => (h.fit = scored[i].fit));
      }
    }

    // 4. Meaning: sections under other tops close to this node.
    const related: Related[] = [];
    if (ctxVec) {
      const exclude = new Set<NodeId>([...exceptSelf, ...(n ? descendants(snap, input.node) : [])]);
      const near = (await this.o.index.near(context, { exclude, top: topId, snap, vector: ctxVec, k: 8 })) ?? [];
      for (const hit of near) {
        if (hit.score < t.relatedAt) continue;
        const m = snap.nodes[hit.id as NodeId];
        const mKey = phraseKey(m.title);
        const mRef = m.ref?.kind === "wiki" ? m.ref.title : null;
        // A phrase here names it: its title's head ("the triple-alpha process" ← "triple-alpha process"), or what it is about.
        const namer = cands.find((c) => !resolved.has(c) && ((c.words > 1 && (` ${mKey}`.endsWith(` ${c.key}`) || ` ${mKey} `.includes(` ${c.key} `))) || (mRef && phraseKey(stripParen(mRef)) === c.key)));
        const where = whereIs(snap, m.id);
        if (namer) {
          hits.push(hitOf(namer, nodeRef(snap, m.id), "meaning", `${m.title} (${where})`, { fit: hit.score }));
          resolved.add(namer);
        } else if (related.length < 5) {
          related.push({ node: m.id, title: m.title, top: where, score: Math.round(hit.score * 1000) / 1000, why: `close in meaning (${hit.score.toFixed(2)})${shared(context, `${m.title} ${m.body}`)}` });
        }
      }
    }

    // 5. One target per phrase (library before meaning before Wikipedia), judged.
    const order: Record<Source, number> = { forced: 0, library: 1, meaning: 2, wikipedia: 3 };
    const best = new Map<Candidate, Hit>();
    for (const h of hits) {
      const cur = best.get(h.c);
      if (!cur || order[h.source] < order[cur.source]) best.set(h.c, h);
    }
    const judged = [...best.values()]
      .map((h) => ({ h, j: judge(h, t) }))
      .filter(({ h, j }) => {
        if (j.tier) return true;
        if (h.c.kind === "forced") unresolved.push(h.c.text);
        return false;
      });
    for (const c of cands) if (c.kind === "forced" && !best.has(c) && !unresolved.includes(c.text)) unresolved.push(c.text);

    // 6. Density: first mention of each target and phrase, no overlaps, a few per paragraph.
    judged.sort((a, b) => a.h.c.start - b.h.c.start);
    const firstOf = new Map<string, number>();
    for (const x of judged) {
      for (const k of [targetKey(x.h.target), `p:${x.h.c.key}`]) if (!firstOf.has(k)) firstOf.set(k, x.h.c.start);
    }
    const firsts = judged.filter((x) => x.h.c.kind === "forced" || (firstOf.get(targetKey(x.h.target)) === x.h.c.start && firstOf.get(`p:${x.h.c.key}`) === x.h.c.start && !linkedHere.has(targetKey(x.h.target))));
    const rankOf = (x: (typeof firsts)[number]) => (x.h.c.kind === "forced" ? 2 : x.j.tier === "auto" ? 1 : 0);
    firsts.sort((a, b) => rankOf(b) - rankOf(a) || b.j.score - a.j.score || b.h.c.words - a.h.c.words);
    const paras = paragraphs(text);
    const paraOf = (at: number) => paras.findIndex(([s, e]) => at >= s && at < e);
    const perPara = new Map<number, number>();
    for (const [s, , linked] of occupied) if (linked) perPara.set(paraOf(s), (perPara.get(paraOf(s)) ?? 0) + 1);
    const chosen: typeof firsts = [];
    const used = new Set<string>();
    for (const x of firsts) {
      const r: Range = [x.h.c.start, x.h.c.end];
      if (chosen.some((y) => overlaps(r, [y.h.c.start, y.h.c.end]))) continue;
      const tk = targetKey(x.h.target);
      if (used.has(tk)) continue;
      const p = paraOf(r[0]);
      if (x.h.c.kind !== "forced" && (perPara.get(p) ?? 0) >= t.perParagraph) continue;
      perPara.set(p, (perPara.get(p) ?? 0) + 1);
      used.add(tk);
      chosen.push(x);
    }
    // A word already linked inside a longer phrase here ("beryllium" beside "beryllium-8") is not linked again on its own.
    for (let i = chosen.length - 1; i >= 0; i--) {
      const x = chosen[i];
      if (x.h.c.kind !== "forced" && chosen.some((y) => y !== x && keyWords(y.h.c.key) > keyWords(x.h.c.key) && ` ${y.h.c.key} `.includes(` ${x.h.c.key} `))) chosen.splice(i, 1);
    }

    if (input.trace) {
      const picked = new Set(chosen.map((x) => x.h));
      for (const h of best.values()) {
        const j = judge(h, t);
        input.trace.push({ phrase: h.c.text, key: h.c.key, start: h.c.start, kind: h.c.kind, source: h.source, target: h.target.kind === "wiki" ? `w:${h.target.title}` : `node:${h.title}`, description: h.description, fit: h.fit, score: j.score, tier: picked.has(h) ? j.tier : null, chosen: picked.has(h), why: j.why, features: { words: h.c.words, rarity: h.c.rarity, exact: h.exact, redirect: h.redirect, sense: h.sense, margin: h.margin ?? null, searched: h.searched, central: h.central, firstInTop: h.firstInTop, sentenceStart: h.c.sentenceStart } });
      }
    }
    const suggestions = chosen
      .sort((a, b) => a.h.c.start - b.h.c.start)
      .map(({ h, j }): Suggestion => ({
        id: digest(`${input.node}\u0000${h.c.start}\u0000${h.c.end}\u0000${targetKey(h.target)}`),
        node: input.node,
        range: [h.c.start, h.c.end],
        quote: h.c.text,
        key: h.c.key,
        target: h.target,
        score: j.score,
        tier: j.tier!,
        why: j.why,
        source: h.source,
        title: h.title,
        description: h.description,
        kind: h.c.kind,
      }));
    return {
      node: input.node,
      suggestions,
      related,
      unresolved,
      degraded,
      stats: { candidates: cands.length, lookedUp, requests: (wiki?.requests ?? 0) - requests0, ms: Math.round(performance.now() - t0) },
    };
  }

  /**
   * Sections under other tops close in meaning to a node, for its Related list: derived, never
   * stored. Ones the node already links to are left out.
   */
  async related(node: NodeId, k = 5, given: Pick<ScanInput, "text" | "title" | "top" | "topTitle" | "ancestors"> = {}): Promise<{ related: Related[]; degraded: string[] }> {
    const snap = this.o.doc().snap();
    const n = snap.nodes[node];
    // A node the server has not seen yet (its replica is a moment behind the browser's) is described by the request.
    if (!n && given.text === undefined) return { related: [], degraded: [] };
    const topId = given.top !== undefined ? given.top : topOf(snap, node);
    const topTitle = given.topTitle ?? (topId && snap.nodes[topId] ? snap.nodes[topId].title : "");
    const context = `${topTitle}. ${given.title ?? n?.title ?? ""}.\n${plain(given.text ?? n!.body)}`.slice(0, 2000);
    const vec = this.o.embedder ? (await this.o.embedder.embed([context]))?.[0] ?? null : null;
    if (!vec) return { related: [], degraded: ["embeddings unavailable: no Related list"] };
    const linked = new Set(n ? notesOf(snap, node).map((c) => snap.nodes[c].ref).flatMap((r) => (r?.kind === "node" && r.id ? [r.id] : [])) : []);
    const exclude = new Set<NodeId>([node, ...(given.ancestors ?? (n ? ancestorsOf(snap, node) : [])), ...(n ? descendants(snap, node) : [])]);
    const near = (await this.o.index.near(context, { exclude, top: topId, snap, vector: vec, k: k + linked.size + 3 })) ?? [];
    const related = near
      .filter((h) => h.score >= this.tuning.relatedAt && !linked.has(h.id as NodeId))
      .slice(0, k)
      .map((h): Related => {
        const m = snap.nodes[h.id as NodeId];
        return { node: m.id, title: m.title, top: whereIs(snap, m.id), score: Math.round(h.score * 1000) / 1000, why: `close in meaning (${h.score.toFixed(2)})${shared(context, `${m.title} ${m.body}`)}` };
      });
    return { related, degraded: [] };
  }

  /**
   * The few sections a model writing at this node might link: hybrid search (text and meaning,
   * text alone without a model) on the node's text, the node itself and its line excluded.
   */
  async nearby(node: NodeId, k = 5, given: Pick<ScanInput, "text" | "title" | "ancestors"> = {}): Promise<Nearby[]> {
    const snap = this.o.doc().snap();
    const n = snap.nodes[node];
    if (!n && given.text === undefined) return [];
    const exclude = new Set<NodeId>([node, ...(given.ancestors ?? (n ? ancestorsOf(snap, node) : [])), ...(n ? descendants(snap, node) : [])]);
    const query = `${given.title ?? n?.title ?? ""}\n${plain(given.text ?? n!.body)}`.slice(0, 1000);
    const hits = await this.o.index.hybrid(query, k, (id) => !exclude.has(id as NodeId) && !!snap.nodes[id as NodeId]);
    return hits.map((h) => {
      const m = snap.nodes[h.id as NodeId];
      const d = topOf(snap, m.id);
      return { handle: m.id, title: m.title, top: d ? snap.nodes[d].title : "" };
    });
  }

  private calibrate(cos: number): number {
    const [a, b] = this.tuning.fit;
    return Math.round(Math.max(0, Math.min(1, a + b * cos)) * 1000) / 1000;
  }

  /** Fit of each "Title: description" to the context, in the order given or (sorted) best first. */
  private async fit(ctx: Float32Array, items: { title: string; description: string | null }[], sorted = true) {
    if (!items.length) return [];
    const texts = items.map((i) => ({ id: `${i.title}\u0000${i.description ?? ""}`, text: `${i.title}: ${i.description ?? ""}` }));
    if (this.senseVectors.size > 20_000) this.senseVectors = new VectorIndex(null, this.o.embedder);
    const rep = await this.senseVectors.upsert(texts);
    if (rep.degraded) return null;
    const out = items.map((i, k) => ({ ...i, fit: this.calibrate(dot(ctx, this.senseVectors.vectorOf(texts[k].id)!)) }));
    return sorted ? out.sort((a, b) => b.fit - a.fit) : out;
  }
}

/** Where a related section is, in words: the title of the top it is under, or "the library" for a top itself. */
function whereIs(snap: Snap, id: NodeId): string {
  const d = topOf(snap, id);
  return d && d !== id ? snap.nodes[d].title : "the library";
}

/** The uncommon words two texts share, for saying why they are related. */
function shared(a: string, b: string): string {
  const mine = new Set(tokenize(a).filter((w) => w.length > 3 && rank(w) > 3000));
  const both = [...new Set(tokenize(b))].filter((w) => mine.has(w)).slice(0, 3);
  return both.length ? `; both mention ${both.join(", ")}` : "";
}
