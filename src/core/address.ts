/**
 * Where a node is, as the page's address. Every address starts with its library: `/l/<library id>`
 * is the library's root, `/l/<library id>/n/<node id>` any other node of it, and
 * `/l/<library id>/w/<lang>/<title>` an article as a page of its own. The node id is all there is to
 * a node's part, so an address survives renames and moves. An address without a library (`/`, or
 * one from before libraries, `/n/…`) is read in the library last used.
 */
import type { NodeId, Snap } from "./model";

/** A library's id: what `Doc.library` makes (base 36), also a directory name on the server. */
export const LIBRARY_ID = /^[0-9a-z]{1,32}$/;

/** The part of an address within its library: `/` for the root, `/n/<node id>` for any other node. */
export function address(snap: Snap, id: NodeId): string {
  if (!snap.nodes[id] || id === snap.root) return "/";
  return `/n/${encodeURIComponent(id)}`;
}

/** A whole address: the library's prefix, then the part within it. */
export function inLibrary(library: string, part: string): string {
  const base = `/l/${encodeURIComponent(library)}`;
  return part === "/" || part === "" ? base : base + part;
}

/** An address split into its library and the part within it; no library if it names none. */
export function splitLibrary(path: string): { library: string | null; part: string } {
  const m = /^\/l\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) return { library: null, part: path || "/" };
  let id = m[1];
  try {
    id = decodeURIComponent(id);
  } catch {
    /* kept as it came; it will name no library */
  }
  return { library: id, part: m[2] || "/" };
}

/** The node a path within a library names, or why there is none. */
export function resolve(snap: Snap, path: string): { node: NodeId } | { missing: string } {
  let parts: string[];
  try {
    parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return { missing: `no page ${path}` };
  }
  if (!parts.length) return { node: snap.root };
  const [kind, id] = parts;
  if (kind === "n" && parts.length === 2) return snap.nodes[id as NodeId] ? { node: id as NodeId } : { missing: `no node ${id}` };
  return { missing: `no page ${path}` };
}
