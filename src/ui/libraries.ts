/**
 * The libraries panel's state, as pure functions (the store holds it, the panel in Menu.tsx draws
 * it, keys.ts and the mouse drive it). A row is chosen by its library's id, not its place, so a
 * list fetched again under the reader keeps the row they were on.
 */
import type { LibraryInfo } from "./api";

export interface LibPanel {
  /** The library whose row is selected. */
  sel: string;
  /** A name being typed: for a new library, or a library being renamed. */
  edit: { kind: "new" } | { kind: "rename"; id: string } | null;
  /** The library whose deletion waits for y. */
  confirm: string | null;
  /** The list is being fetched again (it shows the last one meanwhile). */
  loading: boolean;
  /** What the panel last did that the reader should be able to read whole (where a deleted library went). */
  note?: string;
}

/** A panel opened on this page's library (or the first, if the list does not have it). */
export function openPanel(list: LibraryInfo[], current: string): LibPanel {
  return { sel: list.some((l) => l.id === current) ? current : (list[0]?.id ?? current), edit: null, confirm: null, loading: true };
}

/** The row `d` steps from the selected one, held at the ends. */
export function step(list: LibraryInfo[], sel: string, d: number): string {
  if (!list.length) return sel;
  const i = list.findIndex((l) => l.id === sel);
  const at = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + d));
  return list[at].id;
}

/** After a fetch: the same library if it is still listed, else the row that stood where it was (or the last). */
export function keep(before: LibraryInfo[], after: LibraryInfo[], sel: string): string {
  if (after.some((l) => l.id === sel)) return sel;
  if (!after.length) return sel;
  const i = before.findIndex((l) => l.id === sel);
  return after[Math.max(0, Math.min(after.length - 1, i))].id;
}

/** Where a deleted library went, as the data folder names it (`libraries/.deleted/<id>-<time>`), from the server's full path. */
export function deletedPlace(movedTo: string): string {
  const m = /(libraries[\\/]\.deleted[\\/][^\\/]+)[\\/]?$/.exec(movedTo);
  return m ? m[1].replace(/\\/g, "/") : movedTo;
}

/** How a library's size reads in its row. */
export const nodeCount = (n: number) => `${n} node${n === 1 ? "" : "s"}`;
