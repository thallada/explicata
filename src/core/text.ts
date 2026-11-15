/** Text utilities: hashing, sentence/word segmentation, and the size → display-form rule. */

export type Range = [start: number, end: number];
export type Form = "gloss" | "note" | "passage";

// ---- SHA-256 (synchronous; needed inside commits, where WebCrypto's async API can't be used) ----

const K = new Uint32Array(64);
{
  let n = 0;
  for (let c = 2; n < 64; c++) {
    let prime = true;
    for (let d = 2; d * d <= c; d++) if (c % d === 0) { prime = false; break; }
    if (prime) K[n++] = (Math.cbrt(c) * 2 ** 32) >>> 0;
  }
}
const encoder = new TextEncoder();

export function sha256(input: string): string {
  const data = encoder.encode(input);
  const bitLen = data.length * 8;
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

/** Short content hash used for staleness bookkeeping. */
export const digest = (s: string) => sha256(s).slice(0, 16);

// ---- Segmentation ----

/** Paragraph ranges: runs of text separated by one or more blank lines. */
export function paragraphs(body: string): Range[] {
  const out: Range[] = [];
  const re = /\n\s*\n/g;
  let start = 0;
  for (let m; (m = re.exec(body)); ) {
    if (m.index > start) out.push([start, m.index]);
    start = m.index + m[0].length;
  }
  if (start < body.length) out.push([start, body.length]);
  return out.filter(([s, e]) => body.slice(s, e).trim().length > 0);
}

/**
 * Sentence ranges. A sentence ends at . ! or ? (plus any closing quote or bracket) followed by
 * whitespace and something that looks like a sentence start, or at the end of its paragraph.
 */
export function sentences(body: string): Range[] {
  const out: Range[] = [];
  for (const [ps, pe] of paragraphs(body)) {
    const para = body.slice(ps, pe);
    const re = /[.!?]["”’)\]*`]*\s+(?=["“‘(\[*`]*[A-Z0-9])/g;
    let start = 0;
    const push = (s: number, e: number) => {
      while (s < e && /\s/.test(para[s])) s++;
      while (e > s && /\s/.test(para[e - 1])) e--;
      if (e > s) out.push([ps + s, ps + e]);
    };
    for (let m; (m = re.exec(para)); ) {
      const end = m.index + m[0].length;
      push(start, end);
      start = end;
    }
    push(start, para.length);
  }
  return out;
}

/** Word ranges (letters, digits, inner apostrophes and hyphens). */
export function words(body: string, within?: Range): Range[] {
  const [s, e] = within ?? [0, body.length];
  const out: Range[] = [];
  const re = /[\p{L}\p{N}]+(?:['’\-.][\p{L}\p{N}]+)*/gu;
  re.lastIndex = s;
  for (let m; (m = re.exec(body)) && m.index < e; ) {
    out.push([m.index, Math.min(e, m.index + m[0].length)]);
  }
  return out;
}

export const wordCount = (s: string) => words(s).length;

/**
 * The display form follows the size of what is being expanded, so it is known before the first
 * token arrives and nothing reflows while text streams in.
 */
export function formFor(selection: string): Form {
  const n = wordCount(selection);
  if (n <= 3) return "gloss";
  if (n <= 45 && sentences(selection).length <= 2) return "note";
  return "passage";
}

/** Index of the range containing offset, or the nearest one after it. */
export function rangeAt(ranges: Range[], offset: number): number {
  for (let i = 0; i < ranges.length; i++) if (offset < ranges[i][1]) return i;
  return ranges.length - 1;
}

export const overlaps = (a: Range, b: Range) => a[0] < b[1] && b[0] < a[1];

/** Strip the two inline markers so text can be shown or sent as plain prose. */
export const plain = (s: string) => s.replace(/[*`]/g, "");

export function clip(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

/** A file name or title as a document's slug: lowercase letters, digits and single hyphens. */
export function slugify(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "untitled"
  );
}
