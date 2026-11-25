import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  backoffDelay,
  parseRetryAfter,
  redactUrl,
  requestJson,
  type Deps,
} from "../src/client.js";

type Step = Response | Error | ((signal: AbortSignal) => Promise<Response>);

/**
 * Test setup: fetch plays back a script (one step per call; calling it more often fails the test),
 * sleep records the pause instead of waiting, random=0 makes backoff exactly half of the exponential value.
 */
function harness(steps: Step[], overrides: Partial<Deps> = {}) {
  const queue = [...steps];
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init! });
    const step = queue.shift();
    if (!step) throw new Error("fetch called more times than scripted");
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(init!.signal!);
    return step;
  });
  const sleeps: number[] = [];
  const deps: Partial<Deps> = {
    fetch: fetchMock as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    ...overrides,
  };
  return { deps, sleeps, calls, fetchMock };
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers });
const status = (code: number, body = "", headers: Record<string, string> = {}) =>
  new Response(body, { status: code, headers });

/** Never answers; rejects like real fetch when its signal fires. */
const hang = (signal: AbortSignal) =>
  new Promise<Response>((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

async function catchApiError(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected the promise to reject");
}

const URL_ = "https://api.test/stats";

describe("success path", () => {
  it("returns parsed JSON on the first attempt without sleeping", async () => {
    const h = harness([json({ visits: 42 })]);
    await expect(requestJson(URL_, { deps: h.deps })).resolves.toEqual({ visits: 42 });
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
  });

  it("passes init (method, headers) through to fetch", async () => {
    const h = harness([json({})]);
    await requestJson(URL_, { deps: h.deps, init: { method: "PUT", headers: { authorization: "Bearer t" } } });
    expect(h.calls[0]!.init.method).toBe("PUT");
    expect(h.calls[0]!.init.headers).toEqual({ authorization: "Bearer t" });
  });
});

describe("5xx, 408 and network errors: exponential backoff", () => {
  it("retries 5xx with growing pauses and then succeeds", async () => {
    const h = harness([status(500), status(502), status(504), json({ ok: true })]);
    await expect(requestJson(URL_, { deps: h.deps })).resolves.toEqual({ ok: true });
    expect(h.fetchMock).toHaveBeenCalledTimes(4);
    expect(h.sleeps).toEqual([250, 500, 1000]); // 500 * 2^n / 2 with random=0
  });

  it("caps the pause at maxDelayMs", async () => {
    const h = harness([status(500), status(500), status(500), status(500), json({})]);
    await requestJson(URL_, { deps: h.deps, maxAttempts: 5, maxDelayMs: 800 });
    expect(h.sleeps).toEqual([250, 400, 400, 400]);
  });

  it("retries network errors (connection reset, DNS ...)", async () => {
    const h = harness([new TypeError("fetch failed"), json({ ok: 1 })]);
    await expect(requestJson(URL_, { deps: h.deps })).resolves.toEqual({ ok: 1 });
    expect(h.sleeps).toHaveLength(1);
  });

  it("retries 408 Request Timeout", async () => {
    const h = harness([status(408), json({ ok: true })]);
    await expect(requestJson(URL_, { deps: h.deps })).resolves.toEqual({ ok: true });
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("timeouts", () => {
  it("aborts a hanging attempt after timeoutMs and retries", async () => {
    const h = harness([hang, hang, json({ ok: true })]);
    await expect(requestJson(URL_, { deps: h.deps, timeoutMs: 20 })).resolves.toEqual({ ok: true });
    expect(h.fetchMock).toHaveBeenCalledTimes(3);
    expect(h.calls[0]!.init.signal!.aborted).toBe(true); // the stuck request was actually cancelled
    expect(h.sleeps).toEqual([250, 500]);
  });

  it("gives up with retries_exhausted when every attempt times out", async () => {
    const h = harness([hang, hang, hang]);
    const err = await catchApiError(requestJson(URL_, { deps: h.deps, timeoutMs: 10, maxAttempts: 3 }));
    expect(err.kind).toBe("retries_exhausted");
    expect(err.attempts).toBe(3);
    expect(err.message).toMatch(/timeout after 10 ms/);
  });
});

describe("429 and Retry-After", () => {
  it("waits exactly Retry-After seconds instead of the backoff", async () => {
    const h = harness([status(429, "", { "retry-after": "7" }), json({ ok: true })]);
    await requestJson(URL_, { deps: h.deps });
    expect(h.sleeps).toEqual([7000]);
  });

  it("understands the HTTP-date form of Retry-After", async () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const h = harness(
      [status(429, "", { "retry-after": "Thu, 01 Jan 2026 00:00:05 GMT" }), json({ ok: true })],
      { now: () => now },
    );
    await requestJson(URL_, { deps: h.deps });
    expect(h.sleeps).toEqual([5000]);
  });

  it.each([[""], ["soon"], ["-3"]])("falls back to backoff when Retry-After is %j", async (value) => {
    const h = harness([status(429, "", value === "" ? {} : { "retry-after": value }), json({ ok: true })]);
    await requestJson(URL_, { deps: h.deps });
    expect(h.sleeps).toEqual([250]);
  });

  it("honours Retry-After on 503 too", async () => {
    const h = harness([status(503, "", { "retry-after": "2" }), json({ ok: true })]);
    await requestJson(URL_, { deps: h.deps });
    expect(h.sleeps).toEqual([2000]);
  });

  it("a permanent 429 stops at maxAttempts", async () => {
    const h = harness([1, 2, 3].map(() => status(429, "", { "retry-after": "1" })));
    const err = await catchApiError(requestJson(URL_, { deps: h.deps, maxAttempts: 3 }));
    expect(err.kind).toBe("retries_exhausted");
    expect(err.status).toBe(429);
    expect(h.fetchMock).toHaveBeenCalledTimes(3);
    expect(h.sleeps).toEqual([1000, 1000]); // no sleep after the last attempt
  });
});

describe("4xx are not retried", () => {
  it.each([400, 404, 422])("HTTP %i fails immediately with a clear error", async (code) => {
    const h = harness([status(code, '{"error":"bad day"}')]);
    const err = await catchApiError(requestJson(`${URL_}?day=1`, { deps: h.deps }));
    expect(err.kind).toBe("client_error");
    expect(err.status).toBe(code);
    expect(err.attempts).toBe(1);
    expect(err.message).toContain(`HTTP ${code}`);
    expect(err.message).toContain(URL_);
    expect(err.message).toContain("bad day"); // the server's explanation is surfaced
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
  });

  it.each([401, 403])("HTTP %i is an auth_error, so the job can alert a human about the token", async (code) => {
    const h = harness([status(code, '{"error":"token expired"}')]);
    const err = await catchApiError(requestJson(URL_, { deps: h.deps }));
    expect(err.kind).toBe("auth_error");
    expect(err.message).toMatch(/token/i);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never puts the query string (API keys) into errors", async () => {
    const url = `${URL_}?api_key=SECRET123&day=1`;
    const a = harness([status(404)]);
    const e1 = await catchApiError(requestJson(url, { deps: a.deps }));
    const b = harness([status(500)]);
    const e2 = await catchApiError(requestJson(url, { deps: b.deps, maxAttempts: 1 }));
    for (const e of [e1, e2]) {
      expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain("SECRET123");
    }
    expect(a.calls[0]!.url).toBe(url); // ...but the real request still carries it
  });
});

describe("attempt limit", () => {
  it("persistent 500 gives retries_exhausted after exactly maxAttempts calls, with the server's text", async () => {
    const h = harness([1, 2, 3, 4].map(() => status(500, "db is down")));
    const err = await catchApiError(requestJson(URL_, { deps: h.deps, maxAttempts: 4 }));
    expect(err.kind).toBe("retries_exhausted");
    expect(err.status).toBe(500);
    expect(err.attempts).toBe(4);
    expect(err.message).toMatch(/after 4 attempts/);
    expect(err.message).toContain("db is down");
    expect(h.fetchMock).toHaveBeenCalledTimes(4);
    expect(h.sleeps).toHaveLength(3);
  });

  it("keeps the last network error as cause", async () => {
    const boom = new TypeError("fetch failed");
    const h = harness([boom, boom]);
    const err = await catchApiError(requestJson(URL_, { deps: h.deps, maxAttempts: 2 }));
    expect(err.cause).toBe(boom);
  });

  it("maxAttempts: 1 means no retries", async () => {
    const h = harness([status(500)]);
    await catchApiError(requestJson(URL_, { deps: h.deps, maxAttempts: 1 }));
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
  });

  it.each([0, -1, 1.5, NaN])("rejects invalid maxAttempts=%s", async (maxAttempts) => {
    const h = harness([]);
    await expect(requestJson(URL_, { deps: h.deps, maxAttempts })).rejects.toBeInstanceOf(RangeError);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe("total deadline", () => {
  it("a huge Retry-After fails fast instead of sleeping for a day", async () => {
    const h = harness([status(429, "", { "retry-after": "86400" })]);
    const err = await catchApiError(requestJson(URL_, { deps: h.deps, deadlineMs: 60_000 }));
    expect(err.kind).toBe("deadline_exceeded");
    expect(err.status).toBe(429);
    expect(h.sleeps).toEqual([]);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops when the pauses would not fit, even if attempts remain", async () => {
    let clock = 0; // sleeping advances the clock
    const h = harness([1, 2, 3, 4, 5].map(() => status(500)), {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    const err = await catchApiError(requestJson(URL_, { deps: h.deps, maxAttempts: 5, deadlineMs: 1000 }));
    // pauses 250 (t=250), 500 (t=750); the third pause (1000) would end at 1750 > 1000
    expect(err.kind).toBe("deadline_exceeded");
    expect(err.attempts).toBe(3);
    expect(h.fetchMock).toHaveBeenCalledTimes(3);
    expect(clock).toBe(750);
  });

  it("an attempt never runs longer than the time left", async () => {
    const h = harness([hang]);
    const started = Date.now();
    // real clock and real sleep on purpose: only fetch is replaced
    const err = await catchApiError(
      requestJson(URL_, { deps: { fetch: h.deps.fetch }, timeoutMs: 10_000, deadlineMs: 40 }),
    );
    expect(err.kind).toBe("deadline_exceeded");
    expect(Date.now() - started).toBeLessThan(2000); // would be 10 s without the cap
  });
});

describe("only safe requests are repeated", () => {
  it.each(["POST", "post", "PATCH"])("%s is not retried after a 500", async (method) => {
    const h = harness([status(500, "oops")]);
    const err = await catchApiError(requestJson(URL_, { deps: h.deps, init: { method } }));
    expect(err.kind).toBe("unsafe_to_retry");
    expect(err.message).toContain("oops");
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
  });

  it("POST is not retried after a timeout either (the server may have processed it)", async () => {
    const h = harness([hang]);
    const err = await catchApiError(requestJson(URL_, { deps: h.deps, init: { method: "POST" }, timeoutMs: 10 }));
    expect(err.kind).toBe("unsafe_to_retry");
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("POST is retried on 429: the server did not process it", async () => {
    const h = harness([status(429, "", { "retry-after": "1" }), json({ ok: true })]);
    await expect(requestJson(URL_, { deps: h.deps, init: { method: "POST" } })).resolves.toEqual({ ok: true });
    expect(h.sleeps).toEqual([1000]);
  });

  it.each(["GET", "get", "HEAD", "PUT", "DELETE"])("%s is retried after a 500", async (method) => {
    const h = harness([status(500), json({ ok: true })]);
    await requestJson(URL_, { deps: h.deps, init: { method } });
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("other responses", () => {
  it("2xx with a body that is not JSON is invalid_response and is not retried", async () => {
    const h = harness([status(200, "<html>oops</html>")]);
    const err = await catchApiError(requestJson(URL_, { deps: h.deps }));
    expect(err.kind).toBe("invalid_response");
    expect(err.details.body).toContain("oops");
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("hygiene", () => {
  it("leaves no timers behind after success, failure or timeout", async () => {
    vi.useFakeTimers();
    try {
      await requestJson(URL_, { deps: harness([json({})]).deps });
      await requestJson(URL_, { deps: harness([status(404)]).deps }).catch(() => {});
      const net = harness([new TypeError("x"), new TypeError("x")]);
      await requestJson(URL_, { deps: net.deps, maxAttempts: 2 }).catch(() => {});
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("redactUrl keeps only origin and path", () => {
    expect(redactUrl("https://u:p@api.test:8443/a/b?k=1#x")).toBe("https://api.test:8443/a/b");
    expect(redactUrl("not a url")).toBe("<invalid url>");
  });

  it("parseRetryAfter", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter(" 12 ", now)).toBe(12_000);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("Wed, 31 Dec 2025 23:00:00 GMT", now)).toBe(0); // date in the past
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("later", now)).toBeUndefined();
  });

  it("backoffDelay stays within [exp/2, exp] and never exceeds the cap", () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      const lo = backoffDelay(attempt, 500, 30_000, () => 0);
      const hi = backoffDelay(attempt, 500, 30_000, () => 1);
      expect(hi).toBeLessThanOrEqual(30_000);
      expect(lo).toBeLessThanOrEqual(hi);
      expect(lo).toBeGreaterThanOrEqual(250);
    }
    expect(backoffDelay(1, 500, 30_000, () => 1)).toBe(500);
    expect(backoffDelay(3, 500, 30_000, () => 1)).toBe(2000);
  });
});
