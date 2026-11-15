/**
 * Link marks: `[[phrase]]` asks for the phrase to be linked to whatever it names (a library node
 * or a Wikipedia article, verified before a link is made); `[[phrase|handle]]` names a library node
 * by its handle (its id, as given to a model in the "nearby" list). A writer, human or model, types
 * them; they are never stored. On save the brackets are taken out and each mark becomes a forced
 * candidate for the scanner (server/links). While a model streams, the reader sees the text
 * without them.
 */

export interface Mark {
  /** Offsets of the phrase in the text with the marks taken out. */
  start: number;
  end: number;
  phrase: string;
  handle?: string;
}

const MARK = /\[\[([^\[\]|\n]{1,200}?)(?:\|([^\[\]|\n]{1,100}))?\]\]/g;

/** The text without its marks, and where each marked phrase now sits. */
export function stripMarks(raw: string): { text: string; marks: Mark[] } {
  const marks: Mark[] = [];
  let text = "";
  let last = 0;
  MARK.lastIndex = 0;
  for (let m; (m = MARK.exec(raw)); ) {
    text += raw.slice(last, m.index);
    const phrase = m[1].trim();
    const lead = m[1].length - m[1].trimStart().length;
    const start = text.length + lead;
    text += m[1];
    if (phrase) marks.push({ start, end: start + phrase.length, phrase, ...(m[2]?.trim() ? { handle: m[2].trim() } : {}) });
    last = m.index + m[0].length;
  }
  text += raw.slice(last);
  return { text, marks };
}

/**
 * What a reader sees of text still arriving: complete marks taken out, and an unfinished one at
 * the end shown as its phrase so far (its brackets and handle hidden), so nothing flickers.
 */
export function streamView(raw: string): string {
  const { text } = stripMarks(raw);
  const open = text.lastIndexOf("[[");
  if (open < 0) return text.endsWith("[") ? text.slice(0, -1) : text;
  const tail = text.slice(open + 2);
  if (tail.includes("]]") || tail.includes("\n")) return text;
  const bar = tail.indexOf("|");
  return text.slice(0, open) + (bar < 0 ? tail.replace(/\]$/, "") : tail.slice(0, bar));
}
