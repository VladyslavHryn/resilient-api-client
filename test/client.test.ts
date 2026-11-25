import { describe, expect, it, vi } from "vitest";
import { ApiError, backoffDelay, parseRetryAfter, redactUrl, requestJson } from "../src/client.js";

type Step = Response | Error | ((signal: AbortSignal) => Promise<Response>);

/** fetch mock that plays back a script, one step per call. Running past the script is a test failure. */
function scriptedFetch(...steps: Step[]) {
  const queue = [...steps];
  const calls: { url: string; signal: AbortSignal }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), signal: init!.signal! });
    const step = queue.shift();
    if (!step) throw new Error("fetch called more times than scripted");
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(init!.signal!);
    return step;
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  return { impl, calls };
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers });

/** Never answers; rejects like real fetch when its signal fires. */
const hang = (signal: AbortSignal) =>
  new Promise<Response>((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

/** Options that make tests instant and deterministic. */
function fast() {
  const sleeps: number[] = [];
  return {
    sleeps,
    opts: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      random: () => 0, // backoff = exactly half of the exponential value
      baseDelayMs: 500,
    },
  };
}

async function catchApiError(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected the promise to reject");
}

describe("success path", () => {
  it("returns parsed JSON on the first attempt without sleeping", async () => {
    const { impl } = scriptedFetch(json({ visits: 42 }));
    const { opts, sleeps } = fast();
    await expect(requestJson("https://api.test/stats", { ...opts, fetch: impl })).resolves.toEqual({
      visits: 42,
    });
    expect(impl).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("passes init (method, headers) through to fetch", async () => {
    const { impl } = scriptedFetch(json({}));
    await requestJson("https://api.test/x", {
      ...fast().opts,
      fetch: impl,
      init: { method: "POST", headers: { authorization: "Bearer t" } },
    });
    const init = (impl as any).mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ authorization: "Bearer t" });
  });
});

describe("5xx and network errors: exponential backoff", () => {
  it("retries 5xx with growing pauses and then succeeds", async () => {
    const { impl } = scriptedFetch(
      new Response("boom", { status: 500 }),
      new Response("boom", { status: 502 }),
      new Response("boom", { status: 504 }),
      json({ ok: true }),
    );
    const { opts, sleeps } = fast();
    await expect(requestJson("https://api.test/s", { ...opts, fetch: impl })).resolves.toEqual({ ok: true });
    expect(impl).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([250, 500, 1000]); // 500*2^n / 2 with random=0
  });

  it("caps the pause at maxDelayMs", async () => {
    const { impl } = scriptedFetch(...Array.from({ length: 4 }, () => new Response("x", { status: 500 })), json({}));
    const { opts, sleeps } = fast();
    await requestJson("https://api.test/s", { ...opts, fetch: impl, maxAttempts: 5, maxDelayMs: 800 });
    expect(sleeps).toEqual([250, 400, 400, 400]);
  });

  it("retries network errors (connection reset, DNS ...)", async () => {
    const { impl } = scriptedFetch(new TypeError("fetch failed"), json({ ok: 1 }));
    const { opts, sleeps } = fast();
    await expect(requestJson("https://api.test/s", { ...opts, fetch: impl })).resolves.toEqual({ ok: 1 });
    expect(sleeps).toHaveLength(1);
  });

  it("reports each retry through onRetry", async () => {
    const { impl } = scriptedFetch(new Response("", { status: 500 }), json({}));
    const onRetry = vi.fn();
    await requestJson("https://api.test/s", { ...fast().opts, fetch: impl, onRetry });
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, delayMs: 250, reason: "HTTP 500" });
  });
});

describe("timeouts", () => {
  it("aborts a hanging attempt after timeoutMs and retries", async () => {
    const { impl, calls } = scriptedFetch(hang, hang, json({ ok: true }));
    const { opts, sleeps } = fast();
    await expect(
      requestJson("https://api.test/s", { ...opts, fetch: impl, timeoutMs: 20 }),
    ).resolves.toEqual({ ok: true });
    expect(impl).toHaveBeenCalledTimes(3);
    expect(calls[0]!.signal.aborted).toBe(true); // the stuck request was actually cancelled
    expect(sleeps).toEqual([250, 500]);
  });

  it("gives up with retries_exhausted when every attempt times out", async () => {
    const { impl } = scriptedFetch(hang, hang, hang);
    const err = await catchApiError(
      requestJson("https://api.test/s", { ...fast().opts, fetch: impl, timeoutMs: 10, maxAttempts: 3 }),
    );
    expect(err.kind).toBe("retries_exhausted");
    expect(err.attempts).toBe(3);
    expect(err.message).toMatch(/timeout after 10 ms/);
  });
});

describe("429 and Retry-After", () => {
  it("waits exactly Retry-After seconds instead of the backoff", async () => {
    const { impl } = scriptedFetch(json({}, 429, { "retry-after": "7" }), json({ ok: true }));
    const { opts, sleeps } = fast();
    await requestJson("https://api.test/s", { ...opts, fetch: impl });
    expect(sleeps).toEqual([7000]);
  });

  it("understands the HTTP-date form of Retry-After", async () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const { impl } = scriptedFetch(
      json({}, 429, { "retry-after": "Thu, 01 Jan 2026 00:00:05 GMT" }),
      json({ ok: true }),
    );
    const { opts, sleeps } = fast();
    await requestJson("https://api.test/s", { ...opts, fetch: impl, now: () => now });
    expect(sleeps).toEqual([5000]);
  });

  it.each([[""], ["soon"], ["-3"]])("falls back to backoff when Retry-After is %j", async (value) => {
    const headers: Record<string, string> = value === "" ? {} : { "retry-after": value };
    const { impl } = scriptedFetch(json({}, 429, headers), json({ ok: true }));
    const { opts, sleeps } = fast();
    await requestJson("https://api.test/s", { ...opts, fetch: impl });
    expect(sleeps).toEqual([250]);
  });

  it("honours Retry-After on 503 too", async () => {
    const { impl } = scriptedFetch(json({}, 503, { "retry-after": "2" }), json({ ok: true }));
    const { opts, sleeps } = fast();
    await requestJson("https://api.test/s", { ...opts, fetch: impl });
    expect(sleeps).toEqual([2000]);
  });

  it("does not sleep for hours: Retry-After above the limit fails fast", async () => {
    const { impl } = scriptedFetch(json({}, 429, { "retry-after": "86400" }));
    const { opts, sleeps } = fast();
    const err = await catchApiError(
      requestJson("https://api.test/s", { ...opts, fetch: impl, maxRetryAfterMs: 60_000 }),
    );
    expect(err.kind).toBe("retry_after_too_long");
    expect(err.details.retryAfterMs).toBe(86_400_000);
    expect(sleeps).toEqual([]);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("a permanent 429 stops at maxAttempts", async () => {
    const { impl } = scriptedFetch(...Array.from({ length: 3 }, () => json({}, 429, { "retry-after": "1" })));
    const { opts, sleeps } = fast();
    const err = await catchApiError(requestJson("https://api.test/s", { ...opts, fetch: impl, maxAttempts: 3 }));
    expect(err.kind).toBe("retries_exhausted");
    expect(err.status).toBe(429);
    expect(impl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 1000]); // no sleep after the last attempt
  });
});

describe("4xx are not retried", () => {
  it.each([400, 404, 422])("HTTP %i fails immediately with a clear error", async (status) => {
    const { impl } = scriptedFetch(new Response('{"error":"bad day"}', { status, statusText: "Nope" }));
    const { opts, sleeps } = fast();
    const err = await catchApiError(requestJson("https://api.test/stats?day=1", { ...opts, fetch: impl }));
    expect(err.kind).toBe("client_error");
    expect(err.status).toBe(status);
    expect(err.attempts).toBe(1);
    expect(err.message).toContain(`HTTP ${status}`);
    expect(err.message).toContain("https://api.test/stats");
    expect(err.message).toContain("bad day"); // server's explanation is surfaced
    expect(impl).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it.each([401, 403])("HTTP %i is an auth_error, so the job can alert a human about the token", async (status) => {
    const { impl } = scriptedFetch(new Response('{"error":"token expired"}', { status }));
    const { opts, sleeps } = fast();
    const err = await catchApiError(requestJson("https://api.test/stats", { ...opts, fetch: impl }));
    expect(err.kind).toBe("auth_error");
    expect(err.message).toMatch(/token/i);
    expect(impl).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("never puts the query string (API keys) into errors", async () => {
    const url = "https://api.test/stats?api_key=SECRET123&day=1";
    const { impl } = scriptedFetch(new Response("", { status: 404 }));
    const e1 = await catchApiError(requestJson(url, { ...fast().opts, fetch: impl }));
    const { impl: impl2 } = scriptedFetch(new Response("", { status: 500 }));
    const e2 = await catchApiError(requestJson(url, { ...fast().opts, fetch: impl2, maxAttempts: 1 }));
    for (const e of [e1, e2]) {
      expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain("SECRET123");
    }
    // ...but the real request still carries it
    expect((impl as any).mock.calls[0][0]).toBe(url);
  });
});

describe("attempt limit", () => {
  it("persistent 500 gives retries_exhausted after exactly maxAttempts calls", async () => {
    const { impl } = scriptedFetch(...Array.from({ length: 4 }, () => new Response("", { status: 500 })));
    const { opts, sleeps } = fast();
    const err = await catchApiError(requestJson("https://api.test/s", { ...opts, fetch: impl, maxAttempts: 4 }));
    expect(err.kind).toBe("retries_exhausted");
    expect(err.status).toBe(500);
    expect(err.attempts).toBe(4);
    expect(err.message).toMatch(/after 4 attempts/);
    expect(impl).toHaveBeenCalledTimes(4);
    expect(sleeps).toHaveLength(3);
  });

  it("keeps the last network error as cause", async () => {
    const boom = new TypeError("fetch failed");
    const { impl } = scriptedFetch(boom, boom);
    const err = await catchApiError(requestJson("https://api.test/s", { ...fast().opts, fetch: impl, maxAttempts: 2 }));
    expect(err.cause).toBe(boom);
  });

  it("maxAttempts: 1 means no retries", async () => {
    const { impl } = scriptedFetch(new Response("", { status: 500 }));
    const { opts, sleeps } = fast();
    await catchApiError(requestJson("https://api.test/s", { ...opts, fetch: impl, maxAttempts: 1 }));
    expect(impl).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it.each([0, -1, 1.5, NaN])("rejects invalid maxAttempts=%s", async (maxAttempts) => {
    const { impl } = scriptedFetch();
    await expect(requestJson("https://api.test/s", { fetch: impl, maxAttempts })).rejects.toBeInstanceOf(RangeError);
    expect(impl).not.toHaveBeenCalled();
  });
});

describe("other responses", () => {
  it("2xx with a broken body is invalid_response and is not retried", async () => {
    const { impl } = scriptedFetch(new Response("<html>oops</html>", { status: 200 }));
    const err = await catchApiError(requestJson("https://api.test/s", { ...fast().opts, fetch: impl }));
    expect(err.kind).toBe("invalid_response");
    expect(err.details.body).toContain("oops");
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("supports a custom parser", async () => {
    const { impl } = scriptedFetch(new Response("a,b", { status: 200 }));
    await expect(
      requestJson("https://api.test/s", { ...fast().opts, fetch: impl, parse: (t) => t.split(",") }),
    ).resolves.toEqual(["a", "b"]);
  });
});

describe("cancellation", () => {
  it("an already aborted signal makes no request", async () => {
    const { impl } = scriptedFetch();
    const err = await catchApiError(
      requestJson("https://api.test/s", { fetch: impl, signal: AbortSignal.abort() }),
    );
    expect(err.kind).toBe("aborted");
    expect(impl).not.toHaveBeenCalled();
  });

  it("abort during a request stops without retrying", async () => {
    const controller = new AbortController();
    const { impl } = scriptedFetch(hang);
    const p = requestJson("https://api.test/s", { ...fast().opts, fetch: impl, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    expect((await catchApiError(p)).kind).toBe("aborted");
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("abort during the backoff sleep interrupts the wait immediately", async () => {
    const controller = new AbortController();
    const { impl } = scriptedFetch(new Response("", { status: 500 }));
    const started = Date.now();
    const p = requestJson("https://api.test/s", {
      fetch: impl,
      signal: controller.signal,
      random: () => 1,
      baseDelayMs: 60_000, // would sleep a minute if abort were ignored
      onRetry: () => setTimeout(() => controller.abort(), 10), // fires while we are sleeping
    });
    const err = await catchApiError(p);
    expect(err.kind).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(impl).toHaveBeenCalledTimes(1);
  });
});

describe("hygiene", () => {
  it("leaves no timers behind after success, failure or timeout", async () => {
    vi.useFakeTimers();
    try {
      const ok = scriptedFetch(json({}));
      await requestJson("https://api.test/s", { ...fast().opts, fetch: ok.impl });
      const bad = scriptedFetch(new Response("", { status: 404 }));
      await requestJson("https://api.test/s", { ...fast().opts, fetch: bad.impl }).catch(() => {});
      const net = scriptedFetch(new TypeError("x"), new TypeError("x"));
      await requestJson("https://api.test/s", { ...fast().opts, fetch: net.impl, maxAttempts: 2 }).catch(() => {});
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("redactUrl keeps only origin and path", () => {
    expect(redactUrl("https://u:p@api.test:8443/a/b?k=1#x")).toBe("https://api.test:8443/a/b");
    expect(redactUrl("not a url")).toBe("<invalid url>");
  });
});

describe("helpers", () => {
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
