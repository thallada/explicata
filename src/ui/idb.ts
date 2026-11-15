/** A key-value store on IndexedDB: where the local replica lives between sessions. */

let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((resolve, reject) => {
    // The project's former name: kept, so replicas already stored in a browser are found.
    const req = indexedDB.open("infinite-expand", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const req = d.transaction("kv").objectStore("kv").get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined; // private windows and blocked storage: run from the server copy instead
  }
}

/** Every stored key. */
export async function idbKeys(): Promise<string[]> {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const req = d.transaction("kv").objectStore("kv").getAllKeys();
      req.onsuccess = () => resolve(req.result.map(String));
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* see idbGet */
  }
}
