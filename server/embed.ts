/**
 * Local text embeddings and a small persistent index, for semantic search over the user's own
 * nodes and for checking that a Wikipedia candidate is the right sense of a phrase.
 *
 * Node text never leaves the machine: the model runs in a worker thread of this process
 * (transformers.js on onnxruntime-node, server/embedWorker.mjs). It is loaded on first use; its
 * files are downloaded once from the Hugging Face hub into <IE_DATA>/models/. If that fails
 * (offline, no native runtime), embed() returns null and callers fall back to text search.
 *
 *   embedder.embed(texts)           Float32Array[] (unit length) or null
 *   new VectorIndex(file).upsert()  re-embeds only entries whose text hash changed
 *   index.search / textSearch / hybrid    cosine top-k, BM25, and the two fused
 *
 * IE_EMBED_MODEL picks the model (default Xenova/bge-small-en-v1.5, MIT, 384 dimensions);
 * IE_EMBED=off turns embeddings off, IE_EMBED=fake uses hashed words (the tests).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { dataDir, writeAtomic } from "./util";

// ---- models ----

export interface ModelSpec {
  id: string;
  pooling: "cls" | "mean";
  /** Prepended to short queries searched against passages (asymmetric retrieval). */
  queryPrefix: string;
  dim: number;
}

const RETRIEVAL = "Represent this sentence for searching relevant passages: ";
const MODELS: Record<string, ModelSpec> = {
  "Xenova/bge-small-en-v1.5": { id: "Xenova/bge-small-en-v1.5", pooling: "cls", queryPrefix: RETRIEVAL, dim: 384 },
  "Xenova/all-MiniLM-L6-v2": { id: "Xenova/all-MiniLM-L6-v2", pooling: "mean", queryPrefix: "", dim: 384 },
  "Snowflake/snowflake-arctic-embed-xs": { id: "Snowflake/snowflake-arctic-embed-xs", pooling: "cls", queryPrefix: RETRIEVAL, dim: 384 },
  fake: { id: "fake", pooling: "mean", queryPrefix: "", dim: 384 },
};
const DEFAULT_MODEL = "Xenova/bge-small-en-v1.5";

/** The model's raw function: texts in, one unit vector per text out. */
export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;
export type Loader = (spec: ModelSpec, cacheDir: string) => Promise<EmbedFn>;

/**
 * The model with transformers.js, in a worker thread: loading it and every batch run off the main
 * thread, so the server keeps answering while a library is being embedded. A few threads are
 * nearly as fast as all of them and leave the machine usable (IE_EMBED_THREADS, default 4);
 * IE_EMBED_OFFLINE=1 reads only files downloaded before.
 */
const workerLoader: Loader = (spec, cacheDir) =>
  new Promise((resolveLoad, rejectLoad) => {
    // execArgv: [] keeps a TypeScript loader (tsx) out of the worker, which is plain JavaScript.
    const worker = new Worker(new URL("./embedWorker.mjs", import.meta.url), {
      execArgv: [],
      workerData: { id: spec.id, pooling: spec.pooling, cacheDir, offline: process.env.IE_EMBED_OFFLINE === "1", threads: Number(process.env.IE_EMBED_THREADS) || 4 },
    });
    // The worker must not keep a script alive that is otherwise done.
    worker.unref();
    const waiting = new Map<number, { ok: (v: Float32Array[]) => void; fail: (e: Error) => void }>();
    let seq = 0;
    let dead: Error | null = null;
    const die = (e: Error) => {
      dead = e;
      for (const w of waiting.values()) w.fail(e);
      waiting.clear();
    };
    worker.on("error", (e: Error) => (die(e), rejectLoad(e)));
    worker.on("exit", (code) => die(new Error(`embedding worker exited (${code})`)));
    worker.on("message", (m: { ready?: true; failed?: string; n?: number; dims?: number[]; buf?: Float32Array; error?: string }) => {
      if (m.ready) {
        return resolveLoad(async (texts) => {
          if (dead) throw dead;
          const n = ++seq;
          return new Promise<Float32Array[]>((ok, fail) => {
            waiting.set(n, { ok, fail });
            worker.postMessage({ n, texts });
          });
        });
      }
      if (m.failed) return rejectLoad(new Error(m.failed));
      const w = waiting.get(m.n!);
      if (!w) return;
      waiting.delete(m.n!);
      if (m.error) return w.fail(new Error(m.error));
      const [count, d] = m.dims!;
      w.ok(Array.from({ length: count }, (_, i) => m.buf!.slice(i * d, (i + 1) * d)));
    });
  });

/**
 * A stand-in model for tests and offline runs (IE_EMBED=fake): a bag of hashed words, normalised,
 * so texts sharing words are near each other. It needs no download and separates nothing subtle.
 */
export function fakeVector(text: string, dim = 384): Float32Array {
  const v = new Float32Array(dim);
  for (const w of tokenize(text)) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % dim] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
export const fakeLoader: Loader = async (spec) => async (texts) => texts.map((t) => fakeVector(t, spec.dim));

export type EmbedderState = "idle" | "loading" | "ready" | "failed" | "off";
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
const BATCH = 32;
const MAX_CHARS = 2000; // ~512 tokens; longer text is truncated by the tokenizer anyway

export class Embedder {
  readonly spec: ModelSpec;
  state: EmbedderState = "idle";
  error: string | null = null;
  private fn: EmbedFn | null = null;
  private loading: Promise<EmbedFn | null> | null = null;
  private failedAt = 0;
  private cacheDir: string;
  private loader: Loader;

  constructor(o: { model?: string; dataDir?: string; loader?: Loader; off?: boolean } = {}) {
    this.spec = MODELS[o.model ?? DEFAULT_MODEL] ?? { ...MODELS[DEFAULT_MODEL], id: o.model! };
    this.cacheDir = join(o.dataDir ?? dataDir(), "models");
    this.loader = o.loader ?? workerLoader;
    if (o.off) this.state = "off";
  }

  private async ready(): Promise<EmbedFn | null> {
    if (this.fn) return this.fn;
    if (this.state === "off") return null;
    if (this.state === "failed" && Date.now() - this.failedAt < RETRY_AFTER_FAILURE_MS) return null;
    this.loading ??= (async () => {
      this.state = "loading";
      try {
        mkdirSync(this.cacheDir, { recursive: true });
        this.fn = await this.loader(this.spec, this.cacheDir);
        this.state = "ready";
        this.error = null;
        return this.fn;
      } catch (e) {
        this.state = "failed";
        this.failedAt = Date.now();
        this.error = (e as Error)?.message ?? String(e);
        console.warn(`embeddings unavailable (${this.spec.id}): ${this.error}`);
        return null;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /**
   * Unit vectors for these texts, or null if the model cannot be used. kind "query" adds the
   * model's query prefix (for a short query searched against longer passages).
   */
  async embed(texts: string[], kind: "document" | "query" = "document"): Promise<Float32Array[] | null> {
    if (!texts.length) return [];
    const fn = await this.ready();
    if (!fn) return null;
    try {
      const prefix = kind === "query" ? this.spec.queryPrefix : "";
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH).map((t) => prefix + (t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t));
        out.push(...(await fn(batch)));
      }
      return out;
    } catch (e) {
      console.warn(`embedding failed: ${(e as Error)?.message ?? e}`);
      return null;
    }
  }
}

let shared: Embedder | null = null;
/** The server's embedder, configured from IE_DATA, IE_EMBED_MODEL and IE_EMBED. */
export function embedder(): Embedder {
  const mode = process.env.IE_EMBED;
  shared ??= new Embedder({ model: mode === "fake" ? "fake" : process.env.IE_EMBED_MODEL, off: mode === "off", loader: mode === "fake" ? fakeLoader : workerLoader });
  return shared;
}

// ---- vectors ----

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

const contentHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);

// ---- text search ----

const STOP = new Set(
  "a an and are as at be but by for from has have he her his i if in into is it its of on or our she so that the their them then there these they this to was we were what when which who will with you your".split(
    " ",
  ),
);

/** Lower-case word tokens with a light English plural strip. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    let w = m[0];
    if (STOP.has(w)) continue;
    if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
    else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) w = w.slice(0, -1);
    out.push(w);
  }
  return out;
}

// ---- the index ----

export interface Hit {
  id: string;
  score: number;
}
export interface HybridHit extends Hit {
  vector: number | null;
  text: number | null;
}
interface Entry {
  id: string;
  hash: string;
  text: string;
  vector: Float32Array | null;
}
export interface UpsertReport {
  embedded: number;
  skipped: number;
  /** Entries stored without a vector because the model was unavailable. */
  withoutVector: number;
  degraded: boolean;
}

/**
 * An in-memory map of id → (content hash, text, vector), saved as <file>.json plus <file>.f32.
 * Brute-force cosine is fine for tens of thousands of 384-dim vectors (~10 ms per query).
 */
export class VectorIndex {
  private entries = new Map<string, Entry>();
  private bm25: { df: Map<string, number>; tf: Map<string, Map<string, number>>; len: Map<string, number>; avg: number } | null = null;

  constructor(
    private file: string | null,
    private embedder: Embedder | null,
  ) {
    if (file) this.load();
  }

  get size() {
    return this.entries.size;
  }
  vectorOf(id: string) {
    return this.entries.get(id)?.vector ?? null;
  }
  ids() {
    return [...this.entries.keys()];
  }

  /** Add or update entries. Unchanged text (same hash, vector present) is not re-embedded. */
  async upsert(items: { id: string; text: string }[], save = true): Promise<UpsertReport> {
    const todo: Entry[] = [];
    let skipped = 0;
    for (const { id, text } of items) {
      const hash = contentHash(text);
      const old = this.entries.get(id);
      if (old && old.hash === hash && (old.vector || !this.embedder)) {
        skipped++;
        continue;
      }
      const e: Entry = { id, hash, text, vector: null };
      this.entries.set(id, e);
      todo.push(e);
    }
    if (todo.length) this.bm25 = null;
    const vectors = todo.length && this.embedder ? await this.embedder.embed(todo.map((e) => e.text)) : null;
    if (vectors) todo.forEach((e, i) => (e.vector = vectors[i]));
    if (save && todo.length) this.save();
    return {
      embedded: vectors ? todo.length : 0,
      skipped,
      withoutVector: vectors ? 0 : todo.length,
      degraded: Boolean(todo.length && !vectors),
    };
  }

  remove(ids: string[], save = true) {
    let n = 0;
    for (const id of ids) if (this.entries.delete(id)) n++;
    if (n) {
      this.bm25 = null;
      if (save) this.save();
    }
    return n;
  }

  /** Cosine top-k against a vector. */
  searchVector(q: Float32Array, k = 10, filter?: (id: string) => boolean): Hit[] {
    const top: Hit[] = [];
    for (const e of this.entries.values()) {
      if (!e.vector || (filter && !filter(e.id))) continue;
      const score = dot(q, e.vector);
      if (top.length < k) {
        top.push({ id: e.id, score });
        top.sort((a, b) => b.score - a.score);
      } else if (score > top[k - 1].score) {
        top[k - 1] = { id: e.id, score };
        top.sort((a, b) => b.score - a.score);
      }
    }
    return top;
  }

  /** A passage's vector (no query prefix), or null without a model. */
  async vector(text: string): Promise<Float32Array | null> {
    const v = await this.embedder?.embed([text]);
    return v?.[0] ?? null;
  }

  /** Semantic top-k for a query, or null if the model is unavailable. */
  async search(query: string, k = 10, filter?: (id: string) => boolean): Promise<Hit[] | null> {
    const v = await this.embedder?.embed([query], "query");
    return v ? this.searchVector(v[0], k, filter) : null;
  }

  /** BM25 over the stored texts (k1 1.2, b 0.75). Needs no model. */
  textSearch(query: string, k = 10, filter?: (id: string) => boolean): Hit[] {
    const ix = this.textIndex();
    const terms = [...new Set(tokenize(query))];
    const n = this.entries.size;
    const scores = new Map<string, number>();
    for (const t of terms) {
      const df = ix.df.get(t);
      if (!df) continue;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (const [id, tf] of ix.tf.get(t)!) {
        if (filter && !filter(id)) continue;
        const len = ix.len.get(id)!;
        const s = (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * len) / ix.avg));
        scores.set(id, (scores.get(id) ?? 0) + s);
      }
    }
    return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score).slice(0, k);
  }

  /**
   * Text and vector results fused by reciprocal rank (score = Σ 1/(60 + rank)), with each raw
   * score kept so callers can weigh them differently. Falls back to text alone without a model.
   */
  async hybrid(query: string, k = 10, filter?: (id: string) => boolean): Promise<HybridHit[]> {
    const depth = Math.max(k * 4, 40);
    const [vec, txt] = [await this.search(query, depth, filter), this.textSearch(query, depth, filter)];
    const out = new Map<string, HybridHit>();
    const add = (hits: Hit[] | null, key: "vector" | "text") =>
      hits?.forEach((h, rank) => {
        const cur = out.get(h.id) ?? { id: h.id, score: 0, vector: null, text: null };
        cur[key] = h.score;
        cur.score += 1 / (60 + rank + 1);
        out.set(h.id, cur);
      });
    add(vec, "vector");
    add(txt, "text");
    return [...out.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }

  private textIndex() {
    if (this.bm25) return this.bm25;
    const df = new Map<string, number>();
    const tf = new Map<string, Map<string, number>>();
    const len = new Map<string, number>();
    let total = 0;
    for (const e of this.entries.values()) {
      const toks = tokenize(e.text);
      len.set(e.id, toks.length || 1);
      total += toks.length || 1;
      const counts = new Map<string, number>();
      for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const [t, c] of counts) {
        df.set(t, (df.get(t) ?? 0) + 1);
        let m = tf.get(t);
        if (!m) tf.set(t, (m = new Map()));
        m.set(e.id, c);
      }
    }
    this.bm25 = { df, tf, len, avg: total / Math.max(1, this.entries.size) };
    return this.bm25;
  }

  // -- persistence --

  /** Write nothing more (its directory is being moved aside). */
  detach() {
    this.file = null;
  }

  save() {
    if (!this.file) return;
    const model = this.embedder?.spec.id ?? null;
    const list = [...this.entries.values()];
    const withV = list.filter((e) => e.vector);
    const dim = withV[0]?.vector?.length ?? 0;
    const buf = new Float32Array(withV.length * dim);
    let slot = 0;
    const meta = list.map((e) => {
      let v = -1;
      if (e.vector && e.vector.length === dim) {
        buf.set(e.vector, slot * dim);
        v = slot++;
      }
      return { id: e.id, hash: e.hash, text: e.text, v };
    });
    try {
      writeAtomic(`${this.file}.f32`, Buffer.from(buf.buffer, buf.byteOffset, slot * dim * 4));
      writeAtomic(`${this.file}.json`, JSON.stringify({ version: 1, model, dim, count: slot, entries: meta }));
    } catch (e) {
      console.warn(`vector index: could not save ${this.file}: ${(e as Error).message}`);
    }
  }

  private load() {
    const json = `${this.file}.json`;
    if (!existsSync(json)) return;
    try {
      const meta = JSON.parse(readFileSync(json, "utf8")) as {
        model: string | null;
        dim: number;
        count: number;
        entries: { id: string; hash: string; text: string; v: number }[];
      };
      let vecs: Buffer | null = existsSync(`${this.file}.f32`) ? readFileSync(`${this.file}.f32`) : null;
      // Vectors from another model, or a vector file that does not match, are dropped: re-embed.
      const sameModel = meta.model && meta.model === (this.embedder?.spec.id ?? meta.model);
      if (!sameModel || !vecs || vecs.length !== meta.count * meta.dim * 4) vecs = null;
      const all = vecs ? new Float32Array(vecs.buffer.slice(vecs.byteOffset, vecs.byteOffset + vecs.length)) : null;
      for (const e of meta.entries) {
        const vector = all && e.v >= 0 ? all.slice(e.v * meta.dim, (e.v + 1) * meta.dim) : null;
        this.entries.set(e.id, { id: e.id, hash: e.hash, text: e.text, vector });
      }
    } catch (e) {
      console.warn(`vector index: could not read ${json}: ${(e as Error).message}`);
    }
  }
}
