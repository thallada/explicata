/**
 * Candidate phrases for linking, from a node's text, without an NLP stack. The text is cut into
 * runs of content words (function words, punctuation, `code` and existing links break a run); every
 * short span of a run is a candidate, kept in the text's own casing, since Wikipedia titles are
 * case-sensitive after the first letter. Proper names (capitalised words not at the start of a
 * sentence) and multi-word spans are always candidates; a single lower-case word only when it is
 * uncommon (words.ts). Over-generating is cheap (a batched lookup checks 50 phrases a request), so
 * this ranks rather than filters: the most promising candidates come first, and a cap keeps the
 * lookups per node bounded.
 */
import type { Mark } from "../../src/core/marks";
import { phraseKey } from "../../src/core/links";
import { UNLISTED, listed, rank, singular } from "./words";

export { phraseKey };

export type Kind = "forced" | "name" | "term" | "noun";

export interface Candidate {
  start: number;
  end: number;
  /** The phrase as written. */
  text: string;
  /** Normalised: what first mention, rejections and title matching compare. */
  key: string;
  kind: Kind;
  /** Phrases to look up, best first: as written, then singular. */
  variants: string[];
  words: number;
  /** The rarest word's rank (higher is rarer; UNLISTED if not in the list). */
  rarity: number;
  /** The first word opens a sentence, so its capital says nothing. */
  sentenceStart: boolean;
  /** A [[phrase|handle]] mark: the library node it names. */
  handle?: string;
}

/** Words that never start, end or make up a link on their own. */
const STOP = new Set(
  `a about above across after afterwards again against all almost alone along already also although always am among amongst an and another any anyone anything anyway anywhere are around as at back be became because become becomes becoming been before beforehand behind being below beside besides between beyond both but by can cannot could did do does doing done down during each either else elsewhere enough even ever every everyone everything everywhere except few for former formerly from further had has have having he hence her here hereby herein hers herself him himself his how however i if in indeed into is it its itself just last latter least less let like likely made mainly make makes many may me meanwhile might mine more moreover most mostly much must my myself namely neither never nevertheless next no nobody none nor not nothing now nowhere of off often on once one only onto or other others otherwise our ours ourselves out over own per perhaps quite rather really same seem seemed seeming seems several she should since so some somehow someone something sometime sometimes somewhere still such than that the their theirs them themselves then thence there thereafter thereby therefore therein thereupon these they this those though through throughout thus to together too toward towards under until up upon us used uses using very via was we well were what whatever when whence whenever where whereas whereby wherever whether which while whither who whoever whole whom whose why will with within without would yet you your yours yourself yourselves
  two three four five six seven eight nine ten hundred thousand million billion first second third half twice
  get gets got give gives gave given go goes went gone come comes came take takes took taken see sees saw seen say says said know knows knew known think thinks thought find finds found keep keeps kept put puts call calls called tell tells told show shows showed shown turn turns turned need needs needed want wants wanted try tries tried mean means meant ask asks asked work works worked look looks looked leave leaves left run runs ran become becomes able unable new old good bad great little big small large long short high low right wrong true false real certain possible different similar simple whole full early late least kind sort way ways thing things lot lots part parts case cases fact point points time times year years day days place places`.split(/\s+/),
);

/** Common verb forms that end a run of content words more often than they end a name. */
const VERBS = new Set(
  `grew grow grows began begin begins became brought build builds built felt fell held lay led lost lose loses met paid rose sat sent spoke stood struck taught wrote written drew drawn ate fed fled flew fought hid hit hung knelt laid lent lit meant read rode rang sang sank shot shut slept slid sold sought spent spun stuck stung swam swept swore threw thrown tore torn wore won wound broke broken chose chosen froze frozen hidden risen spoken stolen woke woken forgot forgotten lies lie seem appear appears appeared remain remains remained contain contains include includes allow allows require requires produce produces depend depends exist exists happen happens explain explains suggest suggests describe describes form forms`.split(/\s+/),
);

/** Lower-case words that may sit inside a proper name: "Bank of England", "Ludwig van Beethoven". */
const CONNECT = new Set(["of", "de", "da", "del", "der", "di", "du", "la", "le", "van", "von", "y", "al", "bin", "ibn"]);

/** A single lower-case word ranked above this is too common to be worth a link. */
export const COMMON_RANK = 6000;
const MAX_WORDS = 4;

interface Tok {
  start: number;
  end: number;
  text: string;
  /** Opens a sentence. */
  open: boolean;
  /** Nothing but whitespace separates it from the next token. */
  joined: boolean;
  /** Written with a possessive: a phrase ends here. */
  possessive: boolean;
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+|[-–‑][\p{L}\p{N}]+)*/gu;

/** Spans of the text that hold no candidates: `code`, and whatever the caller excludes (existing links). */
function blocked(text: string, exclude: [number, number][]): (a: number, b: number) => boolean {
  const zones = [...exclude];
  for (const m of text.matchAll(/`[^`\n]+`/g)) zones.push([m.index!, m.index! + m[0].length]);
  return (a, b) => zones.some(([s, e]) => a < e && b > s);
}

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  let prevEnd = 0;
  for (const m of text.matchAll(WORD)) {
    let w = m[0];
    const start = m.index!;
    // A possessive belongs to the word but not to the phrase: "the octopus's arms" links "octopus".
    const possessive = /['’]s?$/i.test(w);
    if (/['’]s$/i.test(w)) w = w.slice(0, -2);
    else if (/['’]$/.test(w)) w = w.slice(0, -1);
    const gap = text.slice(prevEnd, start);
    const open = out.length === 0 || /[.!?]["'”’)*]*\s+["“(*]*$/.test(gap) || /\n\s*\n/.test(gap);
    if (out.length) out[out.length - 1].joined = /^[ \t]+$/.test(gap) || gap === "";
    out.push({ start, end: start + w.length, text: w, open, joined: false, possessive });
    prevEnd = start + m[0].length;
  }
  return out;
}

const isCap = (w: string) => /^\p{Lu}/u.test(w);
/** Lower-case form for the frequency list and the stop list. */
const low = (w: string) => w.toLowerCase();
/** An adverb in -ly ("roughly", "independently"), when the stem is a word. */
const adverb = (w: string) => /ly$/i.test(w) && w.length > 5 && listed(low(w)) && rank(low(w)) < UNLISTED && (listed(low(w).slice(0, -2)) || listed(low(w).slice(0, -3) + "e") || /ally$/i.test(w));


function variants(text: string): string[] {
  const out = [text];
  const parts = text.split(" ");
  const last = parts[parts.length - 1];
  const s = singular(last);
  if (s !== last) out.push([...parts.slice(0, -1), s].join(" "));
  // "-ses" is ambiguous ("octopuses" / "causes"): try dropping just the s as well.
  if (/[^s]es$/i.test(last) && last.slice(0, -1) !== s) out.push([...parts.slice(0, -1), last.slice(0, -1)].join(" "));
  return out;
}

interface ExtractOptions {
  /** Spans to skip: existing links and notes the scanner may not touch. */
  exclude?: [number, number][];
  /** Marked phrases ([[…]] already taken out): candidates whatever they look like. */
  forced?: Mark[];
  /** Normalised phrases never to offer (the node's own title, its document's, rejected ones). */
  skip?: Set<string>;
}

/** At most this many candidates per text, best first. */
const CAP = 120;

/** The candidates in a text, most promising first. */
export function extract(text: string, o: ExtractOptions = {}): Candidate[] {
  const isBlocked = blocked(text, o.exclude ?? []);
  const toks = tokens(text);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (c: Candidate) => {
    const id = `${c.start}:${c.end}`;
    if (seen.has(id) || (o.skip?.has(c.key) && c.kind !== "forced")) return;
    seen.add(id);
    out.push(c);
  };

  for (const m of o.forced ?? []) {
    const t = text.slice(m.start, m.end);
    if (!t.trim()) continue;
    const words = t.split(/\s+/).length;
    push({ start: m.start, end: m.end, text: t, key: phraseKey(t), kind: "forced", variants: variants(t), words, rarity: Math.max(...t.split(/\s+/).map(rank)), sentenceStart: false, ...(m.handle ? { handle: m.handle } : {}) });
  }

  // Content words: not on the stop list, not an -ly adverb, not a bare number.
  const content = (t: Tok) => {
    const w = low(t.text);
    if (/^\d+$/.test(w)) return false;
    if (STOP.has(w) && !(isCap(t.text) && !t.open)) return false;
    return !adverb(t.text);
  };
  // A capitalised word means a name only away from a sentence's start, or when the word is not an ordinary one.
  // A sentence's first word is a name only when the text says so: written with a capital elsewhere
  // too, followed by another capitalised word ("Fred Hoyle"), or with a capital inside ("DNA").
  const capsElsewhere = new Set(toks.filter((t) => !t.open && isCap(t.text)).map((t) => t.text));
  const proper = (t: Tok, next?: Tok) =>
    isCap(t.text) && (!t.open || capsElsewhere.has(t.text) || /\p{Lu}.*\p{Lu}/u.test(t.text) || (!!next && next.start - t.end <= 1 && isCap(next.text) && !STOP.has(low(next.text))));

  // Runs of content words, broken by punctuation, function words and blocked text.
  const runs: Tok[][] = [];
  let run: Tok[] = [];
  const flush = () => {
    if (run.length) runs.push(run);
    run = [];
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (isBlocked(t.start, t.end)) {
      flush();
      continue;
    }
    const connector = CONNECT.has(t.text) && run.length && proper(run[run.length - 1]) && toks[i + 1] && proper(toks[i + 1]) && t.joined && toks[i - 1]?.joined;
    if (t.open && run.length) flush();
    if (content(t) || connector) run.push(t);
    else flush();
    if (!t.joined || t.possessive) flush();
  }
  flush();

  for (const r of runs) {
    for (let a = 0; a < r.length; a++) {
      for (let b = a; b < Math.min(r.length, a + MAX_WORDS); b++) {
        const span = r.slice(a, b + 1);
        // A phrase neither starts nor ends on a connector ("of England", "Bank of").
        if (CONNECT.has(span[0].text) || CONNECT.has(span[span.length - 1].text)) continue;
        const start = span[0].start;
        const end = span[span.length - 1].end;
        if (isBlocked(start, end)) continue;
        const t = text.slice(start, end);
        const isProper = (x: Tok, i: number) => proper(x, span[i + 1]);
        const names = span.filter((x) => !CONNECT.has(x.text));
        const allProper = span.every((x, i) => CONNECT.has(x.text) || isProper(x, i));
        const rarity = Math.max(...names.map((x) => (isCap(x.text) && !listed(low(x.text)) ? UNLISTED : rank(x.text))));
        const words = span.length;
        // A phrase rarely ends on a verb: "Hoyle predicted", "branch grew".
        const tail = low(span[span.length - 1].text);
        if (words > 1 && ((/ed$/.test(tail) && rank(tail) < UNLISTED) || VERBS.has(tail))) continue;
        if (words === 1 && t.length < 2) continue;
        let kind: Kind;
        if (allProper) kind = "name";
        else if (words > 1) kind = "term";
        else if (rarity > COMMON_RANK) kind = "noun";
        else continue;
        // A lower-case single word must look like a noun: not a verb form in -ed/-ing that is common.
        if (kind === "noun" && /(ed|ing)$/.test(t) && rank(t) < 15_000) continue;
        // Sentence-initial ordinary words are read in lower case.
        const sentenceStart = span[0].open;
        const shown = sentenceStart && !isProper(span[0], 0) ? low(t[0]) + t.slice(1) : t;
        push({ start, end, text: t, key: phraseKey(t), kind, variants: variants(shown), words, rarity, sentenceStart });
      }
    }
  }

  const weight = (c: Candidate) =>
    (c.kind === "forced" ? 1000 : c.kind === "name" ? 300 : 0) + (c.words > 1 ? 100 + Math.min(c.rarity, 20_000) / 200 : Math.min(c.rarity, 20_000) / 100) - c.words * 5;
  return out.sort((x, y) => weight(y) - weight(x) || x.start - y.start).slice(0, CAP);
}
