/**
 * The text format for documents (.md), used for the starter library and for export and import.
 * No DOM or node dependencies: the server and the browser share it.
 *
 *   # Document title
 *
 *   Root body: paragraphs separated by blank lines.
 *
 *   ## Section title            heading depth is tree depth, to any depth
 *
 *   Body paragraphs.
 *
 *   ^ "exact quote" form [lens]: body
 *     continuation paragraphs, indented two spaces past the ^
 *     ^ "quote from this note" note: a note nested in the note it is indented under
 *   ^ "other words" link -> w:Fixed-point combinator          a link: a target and no text
 *   ^ "more words" note why -> w:Hoyle state: body            a note that also has a target
 *   ## Section title -> /doc-slug/Section/Child               a section about something elsewhere
 *
 * Targets are written as in src/core/ref.ts: w:Title, /document/Section/…, ./Section (in this
 * document), https://… An arrow is only read as a target when what follows looks like one, so
 * older files with "->" in a lens or a title still read as they did; a title whose "->" would be
 * misread is written with "-\>".
 *
 * Inside a paragraph, a line break is a space unless the line ends in `\` (a hard line break).
 * A body line that starts with `#`, `^` or `\` is written with a `\` in front. In quotes and
 * quoted lenses, `\"` is a quote, `\\` a backslash and `\n` a line break.
 *
 * A quote must be an exact substring of its parent's body; the first occurrence is anchored.
 */
import type { SeedNode, SeedNote } from "../seed/types";
import { nodeRef } from "./links";
import { anchorLost, descendants, docOf, notesOf, sections, type NodeId, type Snap } from "./model";
import { formatTarget, looksLikeTarget, quoteStr, readQuoted, readTarget, type Ref } from "./ref";
import type { Form } from "./text";

const FORMS: Form[] = ["gloss", "note", "passage"];

/** Every problem found in one file. The message lists them all, one per line. */
export class FormatError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
  }
}

// ---- parsing ----

interface Para {
  paras: string[][];
  line: number;
}
interface PSection extends Para {
  title: string;
  target?: Ref;
  notes: PNote[];
  children: PSection[];
}
interface PNote extends Para {
  quote: string;
  form: Form | "link";
  lens: string;
  target?: Ref;
  notes: PNote[];
}

/** Where an arrow that introduces a target starts in `s`, or -1: "->" at the start or after a space, followed by a target. */
function arrowAt(s: string, from = 0): number {
  for (let i = s.indexOf("->", from); i >= 0; i = s.indexOf("->", i + 2)) {
    if ((i === 0 || s[i - 1] === " ") && s[i - 1] !== "\\" && looksLikeTarget(s.slice(i + 2).trimStart())) return i;
  }
  return -1;
}

/** The target after an arrow at s[0..]: it, and the rest of the line after it. */
function readArrow(s: string): { target: Ref; rest: string } | string {
  const i = 2 + (s.slice(2).length - s.slice(2).trimStart().length);
  const t = readTarget(s, i);
  if (typeof t === "string") return t;
  return { target: t.ref, rest: s.slice(t.end).trimStart() };
}

/** A heading's title and the target it may end with. */
function splitHeading(text: string): { title: string; target?: Ref } {
  for (let i = arrowAt(text); i >= 0; i = arrowAt(text, i + 2)) {
    const r = readArrow(text.slice(i));
    if (typeof r !== "string" && !r.rest) return { title: unescapeArrows(text.slice(0, i).trim()), target: r.target };
  }
  return { title: unescapeArrows(text) };
}
const unescapeArrows = (s: string) => s.replace(/-\\>/g, "->");
/** Write "->" as "-\>" wherever it would be read as the start of a target. */
const escapeArrows = (s: string) => s.replace(/->(?=\s*(\S))/g, (m, _c, at: number) => (looksLikeTarget(s.slice(at + 2).trimStart()) ? "-\\>" : m));

function parseMarker(s: string): { quote: string; form: Form | "link"; lens: string; first: string; target?: Ref } | string {
  let i = 1;
  while (s[i] === " ") i++;
  if (s[i] !== '"') return `expected a "quoted" text after ^`;
  const q = readQuoted(s, i);
  if (!q) return "the quote is not closed";
  const [quote, after] = q;
  if (!quote) return "the quote is empty";
  const rest = s.slice(after);
  const m = /^\s+([A-Za-z]+)/.exec(rest);
  if (!m) return "expected a form (gloss, note, passage or link) after the quote";
  const form = m[1].toLowerCase() as Form | "link";
  if (form !== "link" && !FORMS.includes(form)) return `unknown form "${m[1]}" (expected gloss, note, passage or link)`;
  let tail = rest.slice(m[0].length).trimStart();
  if (form === "link") {
    if (!tail.startsWith("->")) return "a link needs a target: -> w:Title, -> /document/Section or -> https://…";
    const r = readArrow(tail);
    if (typeof r === "string") return r;
    if (r.rest) return "a link has no text of its own; write a note (^ \"…\" note -> target: text) to say something about it";
    return { quote, form, lens: "", first: "", target: r.target };
  }
  let lens = "";
  if (tail.startsWith('"')) {
    const l = readQuoted(tail, 0);
    if (!l) return "the lens is not closed";
    lens = l[0];
    tail = tail.slice(l[1]).trimStart();
    if (!tail.startsWith(":") && !tail.startsWith("->")) return "expected ':' after the lens";
  } else {
    const colon = tail.indexOf(":");
    const arrow = arrowAt(tail);
    if (arrow >= 0 && (colon < 0 || arrow < colon)) {
      lens = tail.slice(0, arrow).trim();
      tail = tail.slice(arrow);
    } else {
      if (colon < 0) return "expected ':' before the note's text";
      lens = tail.slice(0, colon).trim();
      tail = tail.slice(colon);
    }
  }
  let target: Ref | undefined;
  if (tail.startsWith("->")) {
    const r = readArrow(tail);
    if (typeof r === "string") return r;
    target = r.target;
    tail = r.rest;
    if (!tail.startsWith(":")) return "expected ':' before the note's text, after its target";
  }
  return { quote, form, lens: lens || "elaborate", first: tail.slice(1).trim(), ...(target ? { target } : {}) };
}

const unescapeLine = (s: string) => (s[0] === "\\" && "#^\\".includes(s[1] ?? "") ? s.slice(1) : s);

/** A paragraph's lines: soft-wrapped lines join with a space; a line ending in `\` keeps its break. */
function joinLines(lines: string[]): string {
  let out = "";
  lines.forEach((l, i) => {
    if (i === lines.length - 1) out += l;
    else if (l.endsWith("\\")) out += l.slice(0, -1) + "\n";
    else out += l + " ";
  });
  return out;
}
const bodyOf = (p: Para) => p.paras.map(joinLines).join("\n\n");

/**
 * Parse a document. Throws FormatError naming every problem: syntax, with its line, and every
 * quote that is not in its parent's text, with the section it is in.
 */
export function parseDoc(text: string, name = "document"): SeedNode {
  const problems: string[] = [];
  const at = (line: number, msg: string) => problems.push(`${name}:${line}: ${msg}`);
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");

  let root: PSection | null = null;
  let stack: PSection[] = []; // stack[d] is the open section at depth d
  let notes: PNote[] = []; // notes[k] is the open note at indent 2k
  let target: Para | null = null; // what received the last text line
  let blank = false;

  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const raw = lines[i].replace(/^\t+/, (t) => "  ".repeat(t.length)).trimEnd();
    if (!raw) {
      blank = true;
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    const content = raw.slice(indent);
    const heading = indent === 0 ? /^(#+)(?:\s+(.*))?$/.exec(content) : null;
    if (heading) {
      const depth = heading[1].length - 1;
      const head = splitHeading((heading[2] ?? "").trim());
      const sec: PSection = { title: head.title, paras: [], notes: [], children: [], line: n, ...(head.target ? { target: head.target } : {}) };
      if (!root) {
        if (depth !== 0) at(n, `the first heading must be "# Title", not "${heading[1]}"`);
        root = sec;
        stack = [sec];
      } else if (depth === 0) {
        at(n, `a document has one "# " heading; this is a second one`);
        continue;
      } else if (depth > stack.length) {
        at(n, `this heading is ${depth + 1} deep but the section above it is only ${stack.length}: a level is skipped`);
        continue;
      } else {
        stack[depth - 1].children.push(sec);
        stack.length = depth;
        stack.push(sec);
      }
      notes = [];
      target = null;
      blank = false;
      continue;
    }
    if (!root) {
      at(n, `text before the "# Title" heading`);
      root = { title: "", paras: [], notes: [], children: [], line: n };
      stack = [root];
    }
    const section = stack[stack.length - 1];

    if (content.startsWith("^")) {
      if (indent % 2) {
        at(n, "a ^ note must be indented by a multiple of two spaces");
        continue;
      }
      const level = indent / 2;
      if (level > notes.length) {
        at(n, notes.length ? "this note is indented deeper than the note above it" : "this note is indented, but there is no note above it to nest in");
        continue;
      }
      if (level && notes[level - 1].form === "link") {
        at(n, "a link has no text, so nothing can be anchored in it");
        continue;
      }
      const m = parseMarker(content);
      if (typeof m === "string") {
        at(n, m);
        continue;
      }
      notes.length = level;
      const note: PNote = { quote: m.quote, form: m.form, lens: m.lens, paras: m.first ? [[m.first]] : [], notes: [], line: n, ...(m.target ? { target: m.target } : {}) };
      (level ? notes[level - 1].notes : section.notes).push(note);
      notes.push(note);
      target = note;
      blank = false;
      continue;
    }

    // Text belongs to the innermost open note it is indented under, else to the section.
    let k = notes.length;
    while (k > 0 && indent < 2 * k) k--;
    notes.length = k;
    const into: Para = k ? notes[k - 1] : section;
    if (k && notes[k - 1].form === "link") {
      at(n, "a link has no text of its own; write a note (^ \"…\" note -> target: text) to say something about it");
      continue;
    }
    const line = unescapeLine(content);
    if (into === target && !blank && into.paras.length) into.paras[into.paras.length - 1].push(line);
    else into.paras.push([line]);
    target = into;
    blank = false;
  }

  if (!root) throw new FormatError([`${name}: no "# Title" heading`]);

  // Quotes are checked against the whole parent text, wherever in it they fall.
  const toNote = (p: PNote, parentBody: string, where: string): SeedNote => {
    const body = bodyOf(p);
    if (!parentBody.includes(p.quote)) at(p.line, `${where}: quote not found: "${p.quote}"`);
    const out: SeedNote = p.form === "link" ? { quote: p.quote, form: "link", body: "" } : { quote: p.quote, form: p.form, lens: p.lens, body };
    if (p.target) out.target = p.target;
    const kids = p.notes.map((c) => toNote(c, body, `${where}, in the note on "${p.quote}"`));
    if (kids.length) out.notes = kids;
    return out;
  };
  const toNode = (s: PSection): SeedNode => {
    const body = bodyOf(s);
    const out: SeedNode = { title: s.title, body };
    if (s.target) out.target = s.target;
    const where = `in “${s.title || "(untitled)"}”`;
    const ns = s.notes.map((c) => toNote(c, body, where));
    if (ns.length) out.notes = ns;
    const kids = s.children.map(toNode);
    if (kids.length) out.children = kids;
    return out;
  };
  const doc = toNode(root);
  if (problems.length) throw new FormatError(problems);
  return doc;
}

// ---- serialising ----

/** Paragraphs separated by one blank line, lines trimmed: the form a parsed body always has. */
export function canonBody(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((p) => p.split("\n").map((l) => l.trim()).filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n\n");
}

const escapeLine = (l: string) => ("#^\\".includes(l[0]) ? "\\" + l : l);

/** A canonical body as file lines: paragraphs with a blank line between, hard breaks as a trailing `\`. */
function bodyLines(body: string): string[][] {
  return body ? body.split("\n\n").map((p) => p.split("\n").map((l, i, all) => escapeLine(l) + (i < all.length - 1 ? "\\" : ""))) : [];
}

export interface Skipped {
  /** Notes whose anchored text is gone. */
  orphans: number;
  /** Sections hanging under a note, which the format has no place for. */
  inNotes: number;
}

/**
 * Write a document (a subtree, by default the whole tree) in the text format. Each note is written with the current text of its anchor.
 * Orphaned notes, and sections under notes, are left out and counted.
 */
export function serializeDoc(snap: Snap, from = snap.root): { text: string; skipped: Skipped } {
  const out: string[] = [];
  const skipped: Skipped = { orphans: 0, inNotes: 0 };
  const push = (...ls: string[]) => out.push(...ls);
  const here = snap.nodes[from].slug;
  // A node target is written from where its node is now, relative when it is in this document.
  const target = (r: Ref) => {
    if (r.kind !== "node") return formatTarget(r);
    const live = r.id && snap.nodes[r.id] ? nodeRef(snap, r.id) : r;
    const inside = r.id && snap.nodes[r.id] ? docOf(snap, r.id) === (snap.library ? from : snap.root) : !!here && r.doc === here;
    return formatTarget(inside ? { ...live, doc: undefined } : live, here);
  };

  const note = (id: NodeId, level: number, parentBody: string) => {
    const n = snap.nodes[id];
    const a = n.anchors.find((x) => x.end > x.start && !anchorLost(x));
    let quote = a?.text ?? "";
    if (quote && !parentBody.includes(quote)) quote = canonBody(quote);
    if (!quote || !parentBody.includes(quote)) {
      skipped.orphans++;
      return;
    }
    skipped.inNotes += sections(snap, id).length;
    const pad = "  ".repeat(level);
    const body = canonBody(n.body);
    if (n.ref && !body) {
      // A link: a target and no text, so nothing can hang from it.
      push(`${pad}^ ${quoteStr(quote)} link -> ${target(n.ref)}`);
      skipped.orphans += descendants(snap, id).filter((c) => snap.nodes[c].kind === "note").length;
      return;
    }
    const lens = n.lens && n.lens !== "elaborate" ? " " + (/^[^":\s](?:[^":\n]*[^":\s])?$/.test(n.lens) && !n.lens.includes("->") ? n.lens : quoteStr(n.lens)) : "";
    const paras = bodyLines(body);
    // The first line goes on the ^ line itself, where it needs no escaping.
    const first = paras.length ? paras[0][0].replace(/^\\(?=[#^\\])/, "") : "";
    push(`${pad}^ ${quoteStr(quote)} ${n.form ?? "note"}${lens}${n.ref ? ` -> ${target(n.ref)}` : ""}:${first ? " " + first : ""}`);
    paras.forEach((p, i) => {
      if (i > 0) push("");
      (i === 0 ? p.slice(1) : p).forEach((l) => push(`${pad}  ${l}`));
    });
    for (const c of notesOf(snap, id)) note(c, level + 1, body);
  };

  const section = (id: NodeId, depth: number) => {
    const n = snap.nodes[id];
    const title = escapeArrows(n.title.replace(/\s+/g, " ").trim());
    push(`${"#".repeat(depth + 1)}${title ? " " + title : ""}${n.ref ? ` -> ${target(n.ref)}` : ""}`, "");
    const body = canonBody(n.body);
    const paras = bodyLines(body);
    paras.forEach((p) => push(...p, ""));
    const ns = notesOf(snap, id);
    if (ns.length) {
      const before = out.length;
      for (const c of ns) note(c, 0, body);
      if (out.length > before) push("");
    }
    for (const c of sections(snap, id)) section(c, depth + 1);
  };

  section(from, 0);
  while (out.length && !out[out.length - 1]) out.pop();
  return { text: out.join("\n") + "\n", skipped };
}
