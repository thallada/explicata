/**
 * Scanning a document or the whole library in the background: one job at a time, a node at a
 * time, at bulk priority (a person's own requests to Wikipedia go first), with progress announced
 * and a cancel. Lookups are gathered across the next few nodes and asked together, 50 phrases a
 * request, which is most of what keeps a bulk pass affordable. A job only fills the pending list;
 * applying is up to whoever reviews it (the browser applies the auto tier itself, so `u` can take
 * it back; a reviewing agent uses the accept route).
 */
import type { NodeId, Snap } from "../../src/core/model";
import type { WikiClient } from "../wiki";
import { extract } from "./extract";
import type { NodeIndex } from "./nodeIndex";
import type { PendingStore } from "./pending";
import type { Linker } from "./scan";

export interface JobState {
  id: string;
  scope: "doc" | "library";
  /** The document scanned, for a document job. */
  doc?: NodeId;
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
    },
  ) {}

  /** Start a job over these nodes (in reading order). A running job is cancelled first. */
  start(scope: "doc" | "library", nodes: NodeId[], title: string, doc?: NodeId): JobState {
    this.cancel();
    const wiki = this.o.wiki();
    const spacing = wiki?.spacingMs ?? 0;
    const state: JobState = {
      id: Math.random().toString(36).slice(2, 10),
      scope,
      ...(doc ? { doc } : {}),
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
    };
    // First estimate: the uncached phrases in batches of 50, plus about one sense or search for every other node.
    const snap = this.o.snap();
    const phrases = new Set(nodes.flatMap((id) => (snap.nodes[id] ? extract(snap.nodes[id].body).flatMap((c) => c.variants) : [])));
    const uncached = wiki ? wiki.uncached([...phrases]) : 0;
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
    try {
      await this.o.index.refresh();
      for (let i = 0; i < nodes.length; i += CHUNK) {
        if (signal.aborted) return;
        const chunk = nodes.slice(i, i + CHUNK);
        const snap = this.o.snap();
        if (wiki) {
          const phrases = [...new Set(chunk.flatMap((id) => (snap.nodes[id] ? extract(snap.nodes[id].body).flatMap((c) => c.variants) : [])))];
          await wiki.lookup(phrases, { priority: "bulk", signal });
        }
        for (const id of chunk) {
          if (signal.aborted) return;
          if (this.o.snap().nodes[id]) {
            const r = await this.o.linker().scan({ node: id, priority: "bulk" }, signal);
            if (signal.aborted) return;
            this.o.pending.put(id, r.suggestions);
            for (const s of r.suggestions) state[s.tier]++;
          }
          state.done++;
          state.requests = (wiki?.requests ?? 0) - r0;
          // What is left: the uncached phrases of the nodes not yet scanned, at the client's pace.
          const left = nodes.slice(state.done);
          const snapNow = this.o.snap();
          const phrases = new Set(left.slice(0, 200).flatMap((x) => (snapNow.nodes[x] ? extract(snapNow.nodes[x].body).flatMap((c) => c.variants) : [])));
          const scale = left.length > 200 ? left.length / 200 : 1;
          state.etaSec = Math.round((((wiki ? Math.ceil(wiki.uncached([...phrases]) / 50) * scale : 0) + left.length * 0.5) * spacing) / 1000);
          if (Date.now() - lastAnnounce > 500 || state.done === state.total) {
            lastAnnounce = Date.now();
            this.o.announce(state);
          }
        }
      }
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
