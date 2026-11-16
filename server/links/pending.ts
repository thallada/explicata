/**
 * Suggestions and what was decided about them. Derived data, so they live on the server under
 * <IE_DATA>/links/pending.json and never in the library.
 *
 * A scan replaces what was pending for its node, but what was decided is kept: the model
 * reviewer's verdict (link or not, and why), a person's decision, and when an approved link was
 * handed to a page to be made. A suggestion found again by a later scan (the same phrase and target
 * in the node, wherever its words now are) keeps its determination, so it is never reviewed twice;
 * one the scan no longer finds (it was linked, or rejected and so skipped) stays as a record.
 *
 * Entries are checked against the library whenever they are read, because the text moves on: one
 * whose words are gone is not listed, and one whose words moved is listed where they now are. The
 * file is the one earlier versions wrote; their entries carry no determinations and read as pending.
 */
import { existsSync, readFileSync } from "node:fs";
import { targetKey } from "../../src/core/links";
import { notesOf, type NodeId, type Snap } from "../../src/core/model";
import { overlaps } from "../../src/core/text";
import { writeAtomic } from "../util";
import type { Suggestion, Verdict } from "./scan";

interface Entry {
  at: number;
  suggestions: Suggestion[];
}

/** What a determination is about: a phrase in a node and where it would link. Offsets move; this does not. */
export const decisionKey = (s: Pick<Suggestion, "key" | "target">) => `${s.key}\u0000${targetKey(s.target)}`;

/** Records kept per node beyond what the last scan found, oldest dropped first. */
const KEEP = 200;

export class PendingStore {
  private byNode = new Map<string, Entry>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private file: string | null) {
    if (file && existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, Entry>;
        for (const [k, v] of Object.entries(data)) if (v && Array.isArray(v.suggestions)) this.byNode.set(k, v);
      } catch (e) {
        console.warn(`pending links: could not read ${file}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * What a scan of this node found. It replaces what was pending; determinations carry over to the
   * same phrase and target found again, and decided entries the scan did not find are kept.
   */
  put(node: NodeId, found: Suggestion[]) {
    const old = this.byNode.get(node)?.suggestions ?? [];
    const was = new Map(old.map((s) => [decisionKey(s), s]));
    const out: Suggestion[] = found.map((s) => {
      const o = was.get(decisionKey(s));
      return o ? { ...s, ...carried(o) } : s;
    });
    const seen = new Set(out.map(decisionKey));
    const kept = old.filter((o) => !seen.has(decisionKey(o)) && (o.review || o.decided));
    out.push(...kept.slice(Math.max(0, kept.length - KEEP)));
    if (out.length) this.byNode.set(node, { at: Date.now(), suggestions: out });
    else this.byNode.delete(node);
    this.saveSoon();
  }

  /** Everything stored for a node, as stored. */
  of(node: NodeId): Suggestion[] {
    return this.byNode.get(node)?.suggestions ?? [];
  }

  /**
   * Suggestions under some nodes (all, by default). Pending ones only: still valid against the
   * library (words there, not linked, not declined) and not rejected by the reviewer. With `all`,
   * every entry whose words are still in its node, whatever was decided: what a page needs to
   * list them.
   */
  list(snap: Snap, nodes?: Set<NodeId>, all = false): Suggestion[] {
    const out: Suggestion[] = [];
    for (const [k, e] of this.byNode) {
      if (nodes && !nodes.has(k as NodeId)) continue;
      for (const s of e.suggestions) {
        const live = all ? placed(snap, s) : open(s) ? check(snap, s) : null;
        if (live) out.push(live);
      }
    }
    return out;
  }

  get(snap: Snap, id: string): Suggestion | undefined {
    const s = this.find(id);
    return s ? (check(snap, s) ?? undefined) : undefined;
  }

  /** Still valid, and nobody has judged them: what the reviewer is to see. */
  undecided(snap: Snap, nodes: Iterable<NodeId>): Suggestion[] {
    const out: Suggestion[] = [];
    for (const id of nodes) {
      for (const s of this.of(id)) {
        const live = !s.review && !s.decided ? check(snap, s) : null;
        if (live) out.push(live);
      }
    }
    return out;
  }

  /** Record the reviewer's verdict on a suggestion. */
  review(id: string, verdict: Verdict) {
    const s = this.find(id);
    if (s) s.review = verdict;
    this.saveSoon();
  }

  /** Record a person's decision on these suggestions. Returns how many were found. */
  decide(ids: Iterable<string>, link: boolean, by: string): number {
    let n = 0;
    for (const id of ids) {
      const s = this.find(id);
      if (!s) continue;
      s.decided = { link, by, at: Date.now() };
      n++;
    }
    if (n) this.saveSoon();
    return n;
  }

  /**
   * The links the reviewer approved that no page has made yet, under some nodes, marked as handed
   * out: the page that asked makes them (its own commit, so `u` takes them back), and no other page
   * makes them again.
   */
  claim(snap: Snap, nodes?: Iterable<NodeId>): Suggestion[] {
    const live: Suggestion[] = [];
    for (const id of nodes ?? (this.byNode.keys() as Iterable<NodeId>)) for (const s of this.of(id)) if (check(snap, s)) live.push(s);
    return this.handOut(live);
  }

  /** Of these stored entries, the approved links no page has made yet, marked as handed out (as `claim`). */
  handOut(list: Suggestion[]): Suggestion[] {
    const out: Suggestion[] = [];
    for (const s of list) {
      if (!s.review?.link || s.decided || s.applied) continue;
      s.applied = Date.now();
      out.push({ ...s });
    }
    if (out.length) this.saveSoon();
    return out;
  }

  /** Phrases the reviewer rejected in a node (and no person has linked since): the scanner skips them. */
  rejectedKeys(node: NodeId): string[] {
    return [...new Set(this.of(node).filter((s) => s.review && !s.review.link && !s.decided?.link).map((s) => s.key))];
  }

  /** Pending suggestions, by the default list's reckoning, without checking them against the library. */
  get size() {
    let n = 0;
    for (const e of this.byNode.values()) n += e.suggestions.filter(open).length;
    return n;
  }

  private find(id: string): Suggestion | undefined {
    for (const e of this.byNode.values()) {
      const s = e.suggestions.find((x) => x.id === id);
      if (s) return s;
    }
    return undefined;
  }

  private saveSoon() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 500);
    this.timer.unref?.();
  }

  flush() {
    if (!this.file) return;
    try {
      writeAtomic(this.file, JSON.stringify(Object.fromEntries(this.byNode)));
    } catch (e) {
      console.warn(`pending links: could not save: ${(e as Error).message}`);
    }
  }
}

/** The determinations of a stored suggestion, to carry onto the same one found again. */
function carried(s: Suggestion): Partial<Suggestion> {
  return { ...(s.review ? { review: s.review } : {}), ...(s.decided ? { decided: s.decided } : {}), ...(s.applied ? { applied: s.applied } : {}) };
}

/** Not yet settled: no person has decided, and the reviewer has not rejected it. */
const open = (s: Suggestion) => !s.decided && s.review?.link !== false;

/** A suggestion with its words where they now are in its node, or null if they are gone. */
function placed(snap: Snap, s: Suggestion): Suggestion | null {
  const n = snap.nodes[s.node];
  if (!n) return null;
  if (n.body.slice(s.range[0], s.range[1]) === s.quote) return s;
  const at = n.body.indexOf(s.quote);
  return at < 0 ? null : { ...s, range: [at, at + s.quote.length] };
}

/** A suggestion as it applies to the library now (placed, not declined, not under a link), or null if it no longer does. */
function check(snap: Snap, s: Suggestion): Suggestion | null {
  const n = snap.nodes[s.node];
  if (!n || n.nolink?.includes(s.key)) return null;
  const p = placed(snap, s);
  if (!p) return null;
  for (const c of notesOf(snap, s.node)) {
    const note = snap.nodes[c];
    if (!note.ref) continue;
    if (note.anchors.some((a) => overlaps([a.start, a.end], p.range))) return null;
  }
  return p;
}
