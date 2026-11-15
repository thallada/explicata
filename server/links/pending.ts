/**
 * Suggestions waiting for a writer. Derived data, so they live on the server under
 * <IE_DATA>/links/pending.json and never in the library: a scan replaces what was pending for its
 * node. They are checked against the library whenever they are read, because the text moves on:
 * a suggestion whose words are gone, already linked, or declined (a phrase in the node's `nolink`)
 * is not offered, and one whose words moved is offered where they now are.
 */
import { existsSync, readFileSync } from "node:fs";
import { notesOf, type NodeId, type Snap } from "../../src/core/model";
import { overlaps } from "../../src/core/text";
import { writeAtomic } from "../util";
import type { Suggestion } from "./scan";

interface Entry {
  at: number;
  suggestions: Suggestion[];
}

export class PendingStore {
  private byNode = new Map<string, Entry>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private file: string | null) {
    if (file && existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, Entry>;
        for (const [k, v] of Object.entries(data)) this.byNode.set(k, v);
      } catch (e) {
        console.warn(`pending links: could not read ${file}: ${(e as Error).message}`);
      }
    }
  }

  /** What a scan of this node found, replacing what was pending for it. */
  put(node: NodeId, suggestions: Suggestion[]) {
    if (suggestions.length) this.byNode.set(node, { at: Date.now(), suggestions });
    else this.byNode.delete(node);
    this.saveSoon();
  }

  /** Forget these suggestions (accepted or declined). */
  drop(ids: Iterable<string>) {
    const gone = new Set(ids);
    for (const [k, e] of this.byNode) {
      const left = e.suggestions.filter((s) => !gone.has(s.id));
      if (left.length === e.suggestions.length) continue;
      if (left.length) e.suggestions = left;
      else this.byNode.delete(k);
    }
    this.saveSoon();
  }

  /** Every suggestion still valid against the library, optionally for some nodes only. */
  list(snap: Snap, nodes?: Set<NodeId>): Suggestion[] {
    const out: Suggestion[] = [];
    for (const [k, e] of this.byNode) {
      if (nodes && !nodes.has(k as NodeId)) continue;
      for (const s of e.suggestions) {
        const live = check(snap, s);
        if (live) out.push(live);
      }
    }
    return out;
  }

  get(snap: Snap, id: string): Suggestion | undefined {
    for (const e of this.byNode.values()) {
      const s = e.suggestions.find((x) => x.id === id);
      if (s) return check(snap, s) ?? undefined;
    }
    return undefined;
  }

  get size() {
    let n = 0;
    for (const e of this.byNode.values()) n += e.suggestions.length;
    return n;
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

/** A suggestion as it applies to the library now, or null if it no longer does. */
function check(snap: Snap, s: Suggestion): Suggestion | null {
  const n = snap.nodes[s.node];
  if (!n) return null;
  if (n.nolink?.includes(s.key)) return null;
  let range = s.range;
  if (n.body.slice(range[0], range[1]) !== s.quote) {
    const at = n.body.indexOf(s.quote);
    if (at < 0) return null;
    range = [at, at + s.quote.length];
  }
  for (const c of notesOf(snap, s.node)) {
    const note = snap.nodes[c];
    if (!note.ref) continue;
    if (note.anchors.some((a) => overlaps([a.start, a.end], range))) return null;
  }
  return range === s.range ? s : { ...s, range };
}
