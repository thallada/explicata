/**
 * Scanning a node and everything under it, or the whole library, in the background: one job at a time, a node at a
 * time, at bulk priority (a person's own requests to Wikipedia go first), with progress announced
 * and a cancel. Lookups are gathered across the next few nodes and asked together, 50 phrases a
 * request, which is most of what keeps a bulk pass affordable. A job started with `review` also has
 * the model reviewer judge what it finds as it goes (review.ts: many proposals a call, within a
 * budget of calls for the job). A job only fills the pending list and records verdicts; making the
 * links is up to a page (the browser makes the approved ones itself, as one commit by "reviewer",
 * so `u` can take them back; a reviewing agent uses the accept route).
 */
import type { NodeId, Snap } from "../../src/core/model";
import type { WikiClient } from "../wiki";
import { extract } from "./extract";
import type { NodeIndex } from "./nodeIndex";
import type { PendingStore } from "./pending";
import { BATCH, JOB_CALLS, type Reviewer } from "./review";
import type { Linker, Suggestion } from "./scan";

export interface JobState {
  id: string;
  scope: "node" | "library";
  /** The node scanned (with everything under it), for a node job. */
  node?: NodeId;
  title: string;
  state: "running" | "done" | "cancelled" | "failed";
  done: number;
  total: number;
  auto: number;
  suggest: number;
  requests: number;
  startedAt: number;
  finishedAt?: number;
  /** Seconds left, estimated from the requests still to make and the client's spacing. */
  etaSec: number | null;
  /** The client is spacing requests for want of a contact (IE_WIKI_CONTACT). */
  slow: boolean;
  message?: string;
  /** The reviewer's part, for a job started with review: verdicts so far, calls made of those allowed, and why it stopped early if it did. */
  review?: { approved: number; rejected: number; left: number; calls: number; max: number; fallback?: string };
}

/** Nodes whose lookups are asked together. */
const CHUNK = 15;

export class Jobs {
  current: JobState | null = null;
  private stop: AbortController | null = null;

  constructor(
    private o: {
      snap: () => Snap;
      linker: () => Linker;
      wiki: () => WikiClient | null;
      index: NodeIndex;
      pending: PendingStore;
      announce: (state: JobState) => void;
      reviewer?: Reviewer;
      /** Calls a job's review may make (IE_REVIEW_CALLS). */
      reviewCalls?: number;
    },
  ) {}

  /** Start a job over these nodes (in reading order). A running job is cancelled first. */
  start(scope: "node" | "library", nodes: NodeId[], title: string, node?: NodeId, review = false): JobState {
    this.cancel();
    const wiki = this.o.wiki();
    const spacing = wiki?.spacingMs ?? 0;
    const state: JobState = {
      id: Math.random().toString(36).slice(2, 10),
      scope,
      ...(node ? { node } : {}),
      title,
      state: "running",
      done: 0,
      total: nodes.length,
      auto: 0,
      suggest: 0,
      requests: 0,
      startedAt: Date.now(),
      etaSec: null,
      slow: spacing > 2000,
      ...(review && this.o.reviewer ? { review: { approved: 0, rejected: 0, left: 0, calls: 0, max: this.o.reviewCalls ?? JOB_CALLS } } : {}),
    };
    // First estimate: the uncached phrases in batches of 50, plus about one sense or search for every other node.
    const snap = this.o.snap();
    const uncached = wiki ? wiki.uncached(phrasesOf(snap, nodes)) : 0;
    state.etaSec = Math.round(((Math.ceil(uncached / 50) + nodes.length * 0.5) * spacing) / 1000);
    this.current = state;
    const ac = (this.stop = new AbortController());
    void this.run(state, nodes, ac.signal);
    this.o.announce(state);
    return state;
  }

  cancel(): boolean {
    if (!this.stop || this.current?.state !== "running") return false;
    this.stop.abort();
    this.current.state = "cancelled";
    this.current.finishedAt = Date.now();
    this.o.announce(this.current);
    return true;
  }

  private async run(state: JobState, nodes: NodeId[], signal: AbortSignal) {
    const wiki = this.o.wiki();
    const spacing = wiki?.spacingMs ?? 0;
    const r0 = wiki?.requests ?? 0;
    let lastAnnounce = 0;
    // What waits for the reviewer: gathered across chunks, sent when a call's worth is ready.
    let queue: Suggestion[] = [];
    const review = async (all: boolean) => {
      const r = state.review;
      if (!r || !this.o.reviewer) return;
      if (r.fallback) {
        r.left += queue.length;
        queue = [];
        return;
      }
      while (queue.length >= BATCH || (all && queue.length)) {
        const batch = queue.splice(0, BATCH);
        const budget = { calls: r.calls, max: r.max };
        const rep = await this.o.reviewer.review(batch, budget, signal);
        r.calls = budget.calls;
        r.approved += rep.approved;
        r.rejected += rep.rejected;
        r.left += rep.left;
        if (rep.fallback) {
          r.fallback = rep.fallback;
          r.left += queue.length;
          queue = [];
        }
        this.o.announce(state);
      }
    };
    try {
      await this.o.index.refresh();
      for (let i = 0; i < nodes.length; i += CHUNK) {
        if (signal.aborted) return;
        const chunk = nodes.slice(i, i + CHUNK);
        const snap = this.o.snap();
        if (wiki) {
          await wiki.lookup(phrasesOf(snap, chunk), { priority: "bulk", signal });
        }
        for (const id of chunk) {
          if (signal.aborted) return;
          const n = this.o.snap().nodes[id];
          if (n) {
            // Declined phrases and those the reviewer rejected are not looked for again.
            const rejected = [...(n.nolink ?? []), ...this.o.pending.rejectedKeys(id)];
            const r = await this.o.linker().scan({ node: id, priority: "bulk", rejected }, signal);
            if (signal.aborted) return;
            this.o.pending.put(id, r.suggestions);
            for (const s of r.suggestions) state[s.tier]++;
            if (state.review) queue.push(...this.o.pending.undecided(this.o.snap(), [id]));
          }
          state.done++;
          state.requests = (wiki?.requests ?? 0) - r0;
          // What is left: the uncached phrases of the nodes not yet scanned, at the client's pace.
          const left = nodes.slice(state.done);
          const scale = left.length > 200 ? left.length / 200 : 1;
          state.etaSec = Math.round((((wiki ? Math.ceil(wiki.uncached(phrasesOf(this.o.snap(), left.slice(0, 200))) / 50) * scale : 0) + left.length * 0.5) * spacing) / 1000);
          if (Date.now() - lastAnnounce > 500 || state.done === state.total) {
            lastAnnounce = Date.now();
            this.o.announce(state);
          }
        }
        await review(false);
      }
      await review(true);
      if (signal.aborted) return;
      state.state = "done";
      state.etaSec = 0;
    } catch (e) {
      if (signal.aborted) return;
      state.state = "failed";
      state.message = (e as Error).message ?? String(e);
    } finally {
      if (!signal.aborted) {
        state.finishedAt = Date.now();
        this.o.announce(state);
      }
    }
  }
}

/** The phrases a scan of these nodes would look up, each once. */
const phrasesOf = (snap: Snap, ids: NodeId[]) => [...new Set(ids.flatMap((id) => (snap.nodes[id] ? extract(snap.nodes[id].body).flatMap((c) => c.variants) : [])))];
