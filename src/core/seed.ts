/**
 * Writes a hand-written tree into the library as a new document: the first document (the project
 * describing itself, grown from the verbatim prompt), and every document read from the text
 * format (src/core/format.ts).
 */
import { healLinks } from "./links";
import { Doc, type Actor, type NodeId, type Op } from "./model";
import type { Ref } from "./ref";
import type { SeedNode, SeedNote } from "../seed/types";
import { parseDoc } from "./format";
import { clip } from "./text";

const ROOT_TITLE = "Infinispand";
/** The first document's slug, which the single-document version's links and routes still mean. */
export const SEED_SLUG = "infinite-expand";

export interface BuildOptions {
  /** Name on the commit that creates the document ("seed" by default, as on the commits under it). */
  creator?: string;
  /** Who wrote the document's own text. A human one is pinned; a model one may be rewritten. */
  rootActor?: Actor;
  /** First word of each commit message: "Pre-generate “Section”". */
  verb?: string;
  /** The document's slug; by default one is made from its title. */
  slug?: string;
}

/**
 * Write a tree into a library as a new document at its end, through the op API: one commit for
 * the document itself, one for its notes and one per top-level section. Everything was written
 * together, so everything is blessed and nothing starts out stale; below the document it is
 * authored as the model, so a model may later rewrite it. Returns the document's node.
 */
export function writeTree(doc: Doc, top: SeedNode, opts: BuildOptions = {}): NodeId {
  const verb = opts.verb ?? "Pre-generate";
  const [root] = doc.as(opts.creator ?? "seed", () =>
    doc.apply(
      [{ op: "create", parent: doc.snap().root, title: top.title, body: top.body, slug: opts.slug, ref: top.target }],
      `${verb} document “${clip(top.title, 60)}”`,
      { actor: opts.rootActor ?? "llm", tag: "seed" },
    ).created,
  );
  return doc.as("seed", () => {
    const rootBody = doc.snap().nodes[root].body;
    // A path written relative to the document ("./Section") names this document, now that it has a slug.
    const slug = doc.snap().nodes[root].slug;
    const place = (r: Ref | undefined): Ref | undefined => (r?.kind === "node" && !r.doc && slug ? { ...r, doc: slug } : r);

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
    // the library that were waiting for this document find it too).
    healLinks(doc);
    return root;
  });
}

/** The first document: the prompt, verbatim and written by a person, with the pre-generated tree under it. */
export function writeSeed(doc: Doc, prompt: string, tree: SeedNode[]): NodeId {
  return writeTree(doc, { title: ROOT_TITLE, body: prompt.trim(), children: tree }, { creator: "tyler", rootActor: "human", slug: SEED_SLUG });
}

/** A document from the text format. Throws FormatError listing every problem in the file, writing nothing. */
export function writeText(doc: Doc, text: string, name: string, opts: BuildOptions = {}): NodeId {
  return writeTree(doc, parseDoc(text, name), opts);
}
