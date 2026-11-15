/** Helpers the server's modules share: JSON replies, request bodies, aborts, atomic writes. */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The checkout's root directory. */
export const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Where the library and everything derived from it are kept: IE_DATA, or .data in the checkout. */
export const dataDir = () => resolve(process.env.IE_DATA ?? join(ROOT, ".data"));

/** A failure with the HTTP status it should be answered with. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(value));
}

/** The request body, refused with 413 past `limit` bytes. */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, `the request is larger than ${Math.round(limit / 1024)} KB`);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** The request body as JSON ({} when empty), refused with 400 if it is not JSON. */
export async function readJson<T>(req: IncomingMessage, limit = 16 * 1024 * 1024): Promise<T> {
  const text = (await readBody(req, limit)).toString("utf8");
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new HttpError(400, "the body is not JSON");
  }
}

/** Aborted when the client goes away before the response is finished. */
export function abortOnClose(res: ServerResponse): AbortSignal {
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) ac.abort();
  });
  return ac.signal;
}

/** Write a file whole or not at all: to a temporary file beside it, then renamed over it. */
export function writeAtomic(file: string, data: string | Uint8Array) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}
