/**
 * Importing a file into the library, and (until step 2 of the move to nodes only removes them) the
 * UI's document features: the root's children listed, created, renamed, copied, deleted and
 * addressed. Each is an ordinary op on that subtree, so the server and the browser share this file
 * and every one of them is a commit that syncs, versions and undoes like any other edit.
 *
 * TEMPORARY (step 2 deletes everything here but IMPORT_MAX and importDoc): `DocInfo`, `listDocs`,
 * `createDoc`, `renameDoc`, `duplicateDoc`, `deleteDoc`, `topName`, `findTop`, `address`, `resolve`.
 * Nothing is stored for them: a top's name in an address is made from its title.
 */
import { Doc, retitleOps, topOf, tops, type NodeId, type Snap } from "./model";
import { writeText, type BuildOptions } from "./seed";
import { clip, paragraphs, plain, slugify } from "./text";

/** Largest .md file an import accepts. */
export const IMPORT_MAX = 2 * 1024 * 1024;

/** A child of the root, as the documents menu lists it. */
export interface DocInfo {
  /** Its node. */
  node: NodeId;
  /** Its name in an address (`topName`), not stored. */
  slug: string;
  title: string;
  /** The first paragraph of its text, plain and clipped. */
  excerpt: string;
}

function excerpt(body: string): string {
  const first = paragraphs(body)[0];
  return first ? clip(plain(body.slice(first[0], first[1])), 160) : "";
}

/** A top's name in an address: made from its title, so it changes with it. */
export const topName = (title: string) => slugify(title) || "untitled";

/** The root's children, in library order. */
export function listDocs(snap: Snap): DocInfo[] {
  return tops(snap).map((id) => {
    const n = snap.nodes[id];
    return { node: id, slug: topName(n.title), title: n.title, excerpt: excerpt(n.body) };
  });
}

/** A child of the root by its node id, or else by its name (the first with that name). */
export function findTop(snap: Snap, name: string): NodeId | undefined {
  const all = tops(snap);
  return all.find((d) => d === name) ?? all.find((d) => topName(snap.nodes[d].title) === name);
}

/** A new, empty child of the root at its end (or at `index`). */
export function createDoc(doc: Doc, title: string, author: string, index?: number): NodeId {
  const snap = doc.snap();
  return doc.as(author, () => doc.apply([{ op: "create", parent: snap.root, index, title, body: "" }], `New “${clip(title, 60)}”`).created[0]);
}

export function renameDoc(doc: Doc, id: NodeId, title: string, author: string) {
  doc.as(author, () => doc.apply(retitleOps(doc.snap(), id, title), `Rename to “${clip(title, 60)}”`));
}

/** Save as: a copy of the whole subtree, placed after the original, under a new title. */
export function duplicateDoc(doc: Doc, id: NodeId, title: string, author: string): NodeId {
  const snap = doc.snap();
  const index = snap.nodes[snap.root].children.indexOf(id) + 1;
  return doc.as(author, () =>
    doc.apply([{ op: "copy", id, parent: snap.root, index, title }], `Duplicate “${clip(snap.nodes[id].title, 40)}” as “${clip(title, 40)}”`).created[0],
  );
}

/** An ordinary delete: `u` brings it back. */
export function deleteDoc(doc: Doc, id: NodeId, author: string) {
  const snap = doc.snap();
  doc.as(author, () => doc.apply([{ op: "delete", id }], `Delete “${clip(snap.nodes[id].title, 60)}”`));
}

/** A model-authored tree from the text format, at the end of the library. Throws FormatError, writing nothing. */
export function importDoc(doc: Doc, text: string, name: string, opts: BuildOptions = {}): NodeId {
  return writeText(doc, text, name, { verb: "Import", ...opts });
}

// ---- addresses ----

/**
 * Where a node lives, as a path: `/` is the library, `/doc/<name>` a child of the root, and
 * `/doc/<name>/<node id>` a node under it (or a child of the root whose name another one has
 * too). The node id is what counts; the name, made from the top's title, is there to be read.
 * `/n/<node id>` names a node with no top to put in front of it.
 */
export function address(snap: Snap, id: NodeId): string {
  if (!snap.nodes[id] || (snap.library && id === snap.root)) return "/";
  const d = snap.library ? topOf(snap, id) : null;
  if (!d) return `/n/${encodeURIComponent(id)}`;
  const name = topName(snap.nodes[d].title);
  return d === id && findTop(snap, name) === id ? `/doc/${name}` : `/doc/${name}/${encodeURIComponent(id)}`;
}

/** The node a path names, or why there is none. */
export function resolve(snap: Snap, path: string): { node: NodeId } | { missing: string } {
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return { node: snap.root };
  const [kind, a, b] = parts;
  const node = (x: string | undefined) => (x && snap.nodes[x as NodeId] ? (x as NodeId) : null);
  if (kind === "n") return node(a) ? { node: a as NodeId } : { missing: `no node ${a ?? ""}` };
  if (kind !== "doc") return { missing: `no page ${path}` };
  const d = a ? findTop(snap, a) : undefined;
  return node(b) ? { node: b as NodeId } : d ? { node: d } : { missing: `nothing called “${a ?? ""}”` };
}
