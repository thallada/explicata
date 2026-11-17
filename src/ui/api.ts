/**
 * Where the page's requests about its library go. The page holds one library, named by its
 * address (`/l/<id>`); everything that reads or writes a library's content asks under
 * `/api/l/<id>/`, and what holds no library's content (the model, Wikipedia, usage) under `/api/`.
 * Switching library is a page load (`/l/<other id>`), so the prefix is set once, at boot.
 */
let library: string | null = null;

/** Set the library this page holds. */
export function setLibrary(id: string) {
  library = id;
}

/** The library this page holds, once boot has chosen it. */
export const currentLibrary = () => library;

/**
 * A path under this library's API: libApi("/links/jobs") → /api/l/<id>/links/jobs. Before a library
 * is chosen (only in the tests: the page chooses one before anything asks) the unprefixed route,
 * which the server answers for its first library.
 */
export function libApi(path: string): string {
  return library ? `/api/l/${encodeURIComponent(library)}${path}` : `/api${path}`;
}

/** A library as /api/libraries lists it. */
export interface LibraryInfo {
  id: string;
  title: string;
  created: string;
  /** Nodes under its top-level nodes (the root and the Wikipedia container not counted). */
  nodes: number;
  branches: string[];
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  let body: Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new Error(String(body.error ?? `${res.status} ${res.statusText}`));
  return body as T;
}
const send = (method: string, body?: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

/** The libraries, in order. */
export const listLibraries = () => call<{ libraries: LibraryInfo[] }>("/api/libraries").then((r) => r.libraries);
/** A new library (its root alone), at the end of the list. */
export const createLibrary = (title: string) => call<{ library: LibraryInfo }>("/api/libraries", send("POST", { title })).then((r) => r.library);
/** Rename a library (a commit on its root's title). */
export const renameLibrary = (id: string, title: string) => call<{ library: LibraryInfo }>(`/api/libraries/${encodeURIComponent(id)}`, send("PATCH", { title })).then((r) => r.library);
/** Delete a library: the server moves it aside whole. Refused for the last one. */
export const deleteLibrary = (id: string) => call<{ deleted: string; movedTo: string }>(`/api/libraries/${encodeURIComponent(id)}`, send("DELETE"));
