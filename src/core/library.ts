/**
 * Documents in the library, and their addresses. A document is a section of the library root
 * with a slug; creating, renaming, copying, deleting, importing and exporting one are ordinary
 * ops on that subtree, so the server and the browser share this file and every one of them is a
 * commit that syncs, versions and undoes like any other edit.
 */
import { Doc, docOf, documents, findDoc, retitleOps, type NodeId, type Snap } from "./model";
import { writeText, type BuildOptions } from "./seed";
import { clip, paragraphs, plain } from "./text";

/** Largest .md file an import accepts. */
export const IMPORT_MAX = 2 * 1024 * 1024;

export interface DocInfo {
  /** The document's node. */
  node: NodeId;
  slug: string;
  title: string;
  /** The first paragraph of its text, plain and clipped. */
  excerpt: string;
}

function excerpt(body: string): string {
  const first = paragraphs(body)[0];
  return first ? clip(plain(body.slice(first[0], first[1])), 160) : "";
}

/** The documents, in library order. */
export function listDocs(snap: Snap): DocInfo[] {
  return documents(snap).map((id) => {
    const n = snap.nodes[id];
    return { node: id, slug: n.slug ?? "", title: n.title, excerpt: excerpt(n.body) };
  });
}

/** A new, empty document at the end of the library (or at `index`). */
export function createDoc(doc: Doc, title: string, author: string, index?: number): NodeId {
  const snap = doc.snap();
  return doc.as(author, () => doc.apply([{ op: "create", parent: snap.root, index, title, body: "" }], `New document “${clip(title, 60)}”`).created[0]);
}

/** The slug stays, so links keep working. */
export function renameDoc(doc: Doc, id: NodeId, title: string, author: string) {
  doc.as(author, () => doc.apply(retitleOps(doc.snap(), id, title), `Rename document to “${clip(title, 60)}”`));
}

/** Save as: a copy of the whole subtree, placed after the original, under a new title and slug. */
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
  doc.as(author, () => doc.apply([{ op: "delete", id }], `Delete document “${clip(snap.nodes[id].title, 60)}”`));
}

/** A model-authored document from the text format, at the end of the library. Throws FormatError, writing nothing. */
export function importDoc(doc: Doc, text: string, name: string, opts: BuildOptions = {}): NodeId {
  return writeText(doc, text, name, { verb: "Import", ...opts });
}

// ---- addresses ----

/**
 * Where a node lives, as a path: `/` is the library, `/doc/<slug>` a document, and
 * `/doc/<slug>/<node id>` a node in it. The node id is what counts; the slug is there to be read,
 * and a link whose node has since moved to another document still finds it. `/n/<node id>`
 * names a node with no document to put in front of it.
 */
export function address(snap: Snap, id: NodeId): string {
  if (!snap.nodes[id] || (snap.library && id === snap.root)) return "/";
  const d = docOf(snap, id);
  const slug = d && snap.library ? snap.nodes[d].slug : undefined;
  if (!slug) return `/n/${encodeURIComponent(id)}`;
  return d === id ? `/doc/${slug}` : `/doc/${slug}/${encodeURIComponent(id)}`;
}

/** The node a path names, or why there is none. */
export function resolve(snap: Snap, path: string): { node: NodeId } | { missing: string } {
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return { node: snap.root };
  const [kind, a, b] = parts;
  const node = (x: string | undefined) => (x && snap.nodes[x as NodeId] ? (x as NodeId) : null);
  if (kind === "n") return node(a) ? { node: a as NodeId } : { missing: `no node ${a ?? ""}` };
  if (kind !== "doc") return { missing: `no page ${path}` };
  const d = a ? findDoc(snap, a) : undefined;
  return node(b) ? { node: b as NodeId } : d ? { node: d } : { missing: `no document “${a ?? ""}”` };
}

