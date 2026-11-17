/**
 * Whether a server has a data directory open. A server writes <data>/server.lock (its pid) while
 * it runs and removes it on the way out; a lock whose process is gone is stale and ignored.
 *
 * Servers from before the lock wrote none. For them (the migration must not run under one), on a
 * system with /proc, every process running `server/index.ts` is looked at: its checkout is found
 * from its command line and working directory, and it counts if that checkout's default data
 * directory (`<checkout>/.data`) is this one. Only command lines and working directories are read,
 * never a process's environment, so a server started with IE_DATA pointing elsewhere is still
 * reported if it runs from the checkout whose `.data` this is.
 */
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
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

/** Servers without a lock: processes running server/index.ts from the checkout whose `.data` this is. */
export function unlockedServers(data: string): number[] {
  if (!existsSync("/proc")) return [];
  const want = real(data);
  const out: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    const args = cmdline(pid);
    const script = args?.find((a) => a.endsWith("server/index.ts"));
    if (!script) continue;
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      const checkout = dirname(dirname(resolve(cwd, script)));
      if (real(join(checkout, ".data")) === want) out.push(pid);
    } catch {
      /* gone, or not ours to look at */
    }
  }
  return out;
}

/** Why the data directory is not free, or null if no server has it open. */
export function busy(data: string): string | null {
  const lock = lockHolder(data);
  if (lock) return `a server (pid ${lock.pid}${lock.port ? `, port ${lock.port}` : ""}) has ${data} open`;
  const pids = unlockedServers(data);
  if (pids.length) return `a server (pid ${pids.join(", ")}) is running from the checkout whose data directory is ${data}`;
  return null;
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
