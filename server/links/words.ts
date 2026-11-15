/**
 * How common an English word is, from a bundled frequency list (words.txt: 20,000 words, most
 * frequent first). A word's rank is its line; a word not in the list ranks after all of them.
 * Rarity is the cheapest link-worthiness signal there is: "octopus" (rank ~9,700) and "cephalopod"
 * (absent) are worth a link where "brain" (~900) is not.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let ranks: Map<string, number> | null = null;

function load(): Map<string, number> {
  if (ranks) return ranks;
  ranks = new Map();
  const file = fileURLToPath(new URL("./words.txt", import.meta.url));
  let i = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    ranks.set(line, ++i);
  }
  return ranks;
}

/** Ranks run 1 (most common) to 20,000; a word not in the list gets this. */
export const UNLISTED = 50_000;

/** The rank of a word (case-insensitive), with a plural or possessive read as its singular. */
export function rank(word: string): number {
  const w = word.toLowerCase().replace(/['’]s$/, "");
  const r = load();
  const direct = r.get(w);
  if (direct !== undefined) return direct;
  const s = singular(w);
  return s !== w ? (r.get(s) ?? UNLISTED) : UNLISTED;
}

/** Whether a lower-case word is in the list at all. */
export const listed = (word: string) => load().has(word.toLowerCase());

/** A light English singular: enough for "cephalopods", "octopuses", "theories", "boxes". */
export function singular(w: string): string {
  if (w.length <= 3) return w;
  if (/ies$/i.test(w) && w.length > 4) return w.slice(0, -3) + (w[w.length - 1] === "S" ? "Y" : "y");
  if (/(uses|sses|shes|ches|xes|zes)$/i.test(w)) return w.slice(0, -2);
  if (/s$/i.test(w) && !/(ss|us|is|ous)$/i.test(w) && !/ies$/i.test(w)) return w.slice(0, -1);
  return w;
}
