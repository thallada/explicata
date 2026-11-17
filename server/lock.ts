/**
 * Whether a server has a data directory open. A server writes <data>/server.lock (its pid) while
 * it runs and removes it on the way out; a lock whose process is gone is stale and ignored.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./util";

export const LOCK = "server.lock";

interface Lock {
  pid: number;
  port?: number;
  started?: string;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The process holding the lock on this data directory, if it is still running (and is not this one). */
export function lockHolder(data: string): Lock | null {
  const file = join(data, LOCK);
  if (!existsSync(file)) return null;
  try {
    const lock = JSON.parse(readFileSync(file, "utf8")) as Lock;
    if (!Number.isInteger(lock.pid) || lock.pid === process.pid || !alive(lock.pid)) return null;
    // A pid can be reused: where /proc says what runs under it, it must be a server.
    const cmd = cmdline(lock.pid);
    if (cmd && !cmd.some((a) => a.endsWith("server/index.ts"))) return null;
    return lock;
  } catch {
    return null;
  }
}

function cmdline(pid: number): string[] | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\u0000").filter(Boolean);
  } catch {
    return null;
  }
}

/** Take the lock for this process; it is let go on exit. */
export function takeLock(data: string, port: number) {
  const file = join(data, LOCK);
  writeAtomic(file, JSON.stringify({ pid: process.pid, port, started: new Date().toISOString() }) + "\n");
  process.on("exit", () => {
    try {
      const lock = JSON.parse(readFileSync(file, "utf8")) as Lock;
      if (lock.pid === process.pid) rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
  });
}
