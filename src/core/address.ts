/**
 * Where a node is, as the page's address: `/` is the library root, `/n/<node id>` any other node.
 * The id is all there is to it, so an address survives renames and moves.
 */
import type { NodeId, Snap } from "./model";

export function address(snap: Snap, id: NodeId): string {
  if (!snap.nodes[id] || id === snap.root) return "/";
  return `/n/${encodeURIComponent(id)}`;
}

/** The node a path names, or why there is none. */
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
