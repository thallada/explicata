/** Shape of the hand-written (pre-generated) seed tree. See src/seed/tree.ts. */
import type { Ref } from "../core/ref";
import type { Form } from "../core/text";

export interface SeedNote {
  /** Exact substring of the parent's body (first occurrence is anchored). */
  quote: string;
  /** gloss: a few words, shown inline. note: 1-3 sentences, shown in the margin. passage: paragraphs, shown inset. link: no text, only a target. */
  form: Form | "link";
  /** Which question this answers about the quote: elaborate | define | why | example | challenge. */
  lens?: string;
  body: string;
  /** What the note is about, elsewhere. A link has a target and an empty body. */
  target?: Ref;
  notes?: SeedNote[];
}

export interface SeedNode {
  title: string;
  /** Paragraphs separated by a blank line. Inline markup: *emphasis* and `code` only. */
  body: string;
  /** Top-level sections only: exact substrings of src/seed/prompt.txt that this section traces back to. */
  src?: string[];
  /** What the section is about, elsewhere. */
  target?: Ref;
  notes?: SeedNote[];
  children?: SeedNode[];
}
