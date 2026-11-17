/**
 * Writes a hand-written tree into the library as a new child of the root: the first one (the
 * project describing itself, grown from the verbatim prompt), and every file read from the text
 * format (src/core/format.ts).
 */
import { healLinks } from "./links";
import { Doc, type Actor, type NodeId, type Op } from "./model";
import type { Ref } from "./ref";
import type { SeedNode, SeedNote } from "../seed/types";
import { parseDoc } from "./format";
import { clip } from "./text";

export const SEED_TITLE = "Infinispand";

export interface BuildOptions {
  /** Name on the commit that creates the tree's top ("seed" by default, as on the commits under it). */
  creator?: string;
  /** Who wrote the top's own text. A human one is pinned; a model one may be rewritten. */
  rootActor?: Actor;
  /** First word of each commit message: "Pre-generate “Section”". */
  verb?: string;
}

/**
 * Write a tree into a library as a new child of the root, at its end, through the op API: one
 * commit for the tree's top, one for its notes and one per section under it. Everything was
 * written together, so everything is blessed and nothing starts out stale; below the top it is
 * authored as the model, so a model may later rewrite it. Returns the top's node.
 */
export function writeTree(doc: Doc, top: SeedNode, opts: BuildOptions = {}): NodeId {
  const verb = opts.verb ?? "Pre-generate";
  // A path written relative to the file's top ("./Section") is stored from the library root.
  const place = (r: Ref | undefined): Ref | undefined => (r?.kind === "node" && r.rel ? { kind: "node", path: [top.title, ...(r.path ?? [])], ...(r.quote !== undefined ? { quote: r.quote } : {}) } : r);
  const [root] = doc.as(opts.creator ?? "seed", () =>
    doc.apply(
      [{ op: "create", parent: doc.snap().root, title: top.title, body: top.body, ref: place(top.target) }],
      `${verb} “${clip(top.title, 60)}”`,
      { actor: opts.rootActor ?? "llm", tag: "seed" },
    ).created,
  );
  return doc.as("seed", () => {
    const rootBody = doc.snap().nodes[root].body;

    const commit = (message: string, fill: (ops: Op[], next: () => NodeId) => void) => {
      const ops: Op[] = [];
      let n = 0;
      fill(ops, () => `$${n++}` as NodeId);
      for (let i = 0; i < n; i++) ops.push({ op: "bless", id: `$${i}` as NodeId });
      ops.push({ op: "bless", id: root });
      doc.apply(ops, message, { actor: "llm", tag: "seed" });
    };
    const addNotes = (ops: Op[], next: () => NodeId, parent: NodeId, notes: SeedNote[] | undefined) => {
      for (const note of notes ?? []) {
        const me = next();
        const form = note.form === "link" ? undefined : note.form;
        ops.push({ op: "create", parent, kind: "note", quote: note.quote, form, lens: form && note.lens, body: note.body, ref: place(note.target) });
        addNotes(ops, next, me, note.notes);
      }
    };

    if (top.notes?.length) commit(`${verb} notes on “${top.title}”`, (ops, next) => addNotes(ops, next, root, top.notes));

    for (const section of top.children ?? []) {
      commit(`${verb} “${section.title}”`, (ops, next) => {
        const add = (parent: NodeId, s: SeedNode, first: boolean) => {
          const me = next();
          const anchors = first
            ? (s.src ?? []).map((q): [number, number] => {
                const at = rootBody.indexOf(q);
                if (at < 0) throw new Error(`seed: "${s.title}" cites text that is not in the prompt: ${q}`);
                return [at, at + q.length];
              })
            : undefined;
          ops.push({ op: "create", parent, kind: "section", title: s.title, body: s.body, anchors: anchors?.length ? anchors : undefined, ref: place(s.target) });
          addNotes(ops, next, me, s.notes);
          for (const child of s.children ?? []) add(me, child, false);
        };
        add(root, section, true);
      });
    }
    // Node targets are found now that everything they could name exists (and links elsewhere in
    // the library that were waiting for this tree find it too). Where another top has the same
    // title, a link is found in its own tree first.
    healLinks(doc);
    return root;
  });
}

/** The first tree: the prompt, verbatim and written by a person, with the pre-generated tree under it. */
export function writeSeed(doc: Doc, prompt: string, tree: SeedNode[]): NodeId {
  return writeTree(doc, { title: SEED_TITLE, body: prompt.trim(), children: tree }, { creator: "tyler", rootActor: "human" });
}

/** A tree from the text format. Throws FormatError listing every problem in the file, writing nothing. */
export function writeText(doc: Doc, text: string, name: string, opts: BuildOptions = {}): NodeId {
  return writeTree(doc, parseDoc(text, name), opts);
}
