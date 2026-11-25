import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { requestJson } from "../src/client.js";

/**
 * Every response closes its connection: with keep-alive, Node's fetch (undici) reused sockets in a way that
 * sometimes delayed the next request past our 150 ms timeout (seen on Windows, ~1 run in 8).
 * That is a transport quirk, not client logic; the retry loop absorbs it, but it made this test flaky.
 */
const CLOSE = { connection: "close" };

/**
 * End-to-end check with the real fetch against a local misbehaving server
 * (no external network). Each request is handled by the next script entry.
 */
let server: Server | undefined;

async function start(script: Array<(res: import("node:http").ServerResponse) => void>) {
  let i = 0;
  const hits = { count: 0 };
  server = createServer((_req, res) => {
    hits.count++;
    const handler = script[i++];
    if (!handler) {
      res.statusCode = 599;
      return res.end("script exhausted");
    }
    handler(res);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/stats`, hits };
}

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((r) => server!.close(r));
  server = undefined;
});

describe("real fetch against a local flaky server", () => {
  it("survives silence, a stalled body, 500 and 429, then returns the data", async () => {
    const { url, hits } = await start([
      () => {}, // never answers -> timeout
      (res) => {
        // headers and half a body, then silence -> body must be covered by the timeout too
        res.writeHead(200, { ...CLOSE, "content-type": "application/json" });
        res.write('{"visits":');
      },
      (res) => res.writeHead(500, CLOSE).end(),
      (res) => res.writeHead(429, { ...CLOSE, "retry-after": "0" }).end(),
      (res) => res.writeHead(200, { ...CLOSE, "content-type": "application/json" }).end('{"visits":42}'),
    ]);

    const retries: string[] = [];
    const data = await requestJson<{ visits: number }>(url, {
      timeoutMs: 150,
      baseDelayMs: 5,
      maxAttempts: 6,
      onRetry: (r) => retries.push(r.reason),
    });

    expect(data).toEqual({ visits: 42 });
    expect(hits.count).toBe(5);
    expect(retries).toEqual(["timeout after 150 ms", "timeout after 150 ms", "HTTP 500", "HTTP 429"]);
  });

  it("does not retry a 404 and exposes the server's message", async () => {
    const { url, hits } = await start([(res) => res.writeHead(404, CLOSE).end('{"error":"no such report"}')]);
    await expect(requestJson(url, { baseDelayMs: 5 })).rejects.toMatchObject({
      kind: "client_error",
      status: 404,
      message: expect.stringContaining("no such report"),
    });
    expect(hits.count).toBe(1);
  });
});
