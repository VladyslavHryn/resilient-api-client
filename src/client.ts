/**
 * Reliable client for a flaky external API.
 *
 * Policy:
 *  - every attempt has its own timeout (covers headers AND body);
 *  - 5xx, timeouts and network errors: retry with exponential backoff + jitter;
 *  - 429 (and 503) with Retry-After: wait exactly as long as the server asks;
 *  - other 4xx: never retried, a descriptive ApiError is thrown at once;
 *  - at most `maxAttempts` attempts in total, so the loop always terminates.
 */

export type ApiErrorKind =
  /** 401/403: the token is expired or lacks rights; a human has to fix it, retrying cannot help. */
  | "auth_error"
  /** Other 4xx (except 429): our request is wrong, retrying cannot help. */
  | "client_error"
  /** Status we do not know how to handle (1xx/3xx that fetch did not follow). */
  | "unexpected_status"
  /** 2xx, but the body could not be parsed. */
  | "invalid_response"
  /** All attempts were used up on retryable failures. */
  | "retries_exhausted"
  /** Server asked us to wait longer than we are willing to. */
  | "retry_after_too_long"
  /** Caller cancelled via AbortSignal. */
  | "aborted";

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly details: {
      url: string;
      attempts: number;
      status?: number;
      /** First part of the response body, useful for 4xx diagnostics. */
      body?: string;
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: details.cause });
    this.name = "ApiError";
  }

  get status(): number | undefined {
    return this.details.status;
  }
  get attempts(): number {
    return this.details.attempts;
  }
}

export interface RetryInfo {
  /** Number of the attempt that just failed (1-based). */
  attempt: number;
  delayMs: number;
  reason: string;
}

export interface RequestOptions<T = unknown> {
  /** Standard fetch init (method, headers, body ...). `signal` is ignored, use the option below. */
  init?: Omit<RequestInit, "signal">;
  /** Per-attempt timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /** Total attempts including the first one. Default 5. */
  maxAttempts?: number;
  /** Backoff base: delay before retry n is about base * 2^(n-1). Default 500. */
  baseDelayMs?: number;
  /** Upper bound for the exponential backoff. Default 30_000. */
  maxDelayMs?: number;
  /** If Retry-After is larger than this, fail instead of sleeping. Default 120_000. */
  maxRetryAfterMs?: number;
  /** Cancels the request, the pending sleep and any further retries. */
  signal?: AbortSignal;
  /** Body parser. Default: JSON.parse. */
  parse?: (text: string) => T;
  /** Called before every sleep; handy for logging/metrics. */
  onRetry?: (info: RetryInfo) => void;

  // Seams for tests; production code does not need them.
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const DEFAULTS = {
  timeoutMs: 10_000,
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 120_000,
} as const;

const BODY_SNIPPET_LIMIT = 500;

/** Retry-After is either delta-seconds or an HTTP date. Returns ms, or undefined if absent/invalid. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const v = value.trim();
  if (v === "") return undefined;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  // HTTP-dates always contain day/month names; without this check Date.parse("-3") is a valid year.
  if (!/[A-Za-z]/.test(v)) return undefined;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/** Exponential backoff with "equal jitter": half fixed, half random, so clients do not retry in lockstep. */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number {
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + (exp / 2) * random());
}

/** Errors end up in logs, and API keys are often passed in the query string: keep only origin + path. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return "<invalid url>";
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type Attempt<T> =
  | { type: "success"; data: T }
  | { type: "fatal"; error: ApiError }
  | { type: "retry"; reason: string; status?: number; retryAfterMs?: number; cause?: unknown };

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

export async function requestJson<T = unknown>(
  url: string | URL,
  options: RequestOptions<T> = {},
): Promise<T> {
  const {
    init,
    timeoutMs = DEFAULTS.timeoutMs,
    maxAttempts = DEFAULTS.maxAttempts,
    baseDelayMs = DEFAULTS.baseDelayMs,
    maxDelayMs = DEFAULTS.maxDelayMs,
    maxRetryAfterMs = DEFAULTS.maxRetryAfterMs,
    signal,
    parse = (text: string) => JSON.parse(text) as T,
    onRetry,
    fetch: fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    random = Math.random,
    now = Date.now,
  } = options;

  assertPositiveInt("maxAttempts", maxAttempts);
  assertPositiveInt("timeoutMs", timeoutMs);

  const target = String(url);
  const shownUrl = redactUrl(target);
  const label = `${init?.method ?? "GET"} ${shownUrl}`;

  const aborted = (attempts: number): ApiError =>
    new ApiError("aborted", `${label} was aborted`, { url: shownUrl, attempts, cause: signal?.reason });

  const attemptOnce = async (attempt: number): Promise<Attempt<T>> => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onUserAbort = () => controller.abort();
    signal?.addEventListener("abort", onUserAbort, { once: true });

    try {
      const res = await fetchImpl(target, { ...init, signal: controller.signal });
      const { status } = res;

      if (status >= 200 && status < 300) {
        const text = await res.text(); // still under the timeout
        try {
          return { type: "success", data: parse(text) };
        } catch (cause) {
          return {
            type: "fatal",
            error: new ApiError(
              "invalid_response",
              `${label} returned HTTP ${status} with an unparsable body`,
              { url: shownUrl, attempts: attempt, status, body: text.slice(0, BODY_SNIPPET_LIMIT), cause },
            ),
          };
        }
      }

      if (status === 429 || status === 503) {
        const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), now());
        await res.body?.cancel().catch(() => {});
        return { type: "retry", reason: `HTTP ${status}`, status, retryAfterMs };
      }

      if (status >= 500) {
        await res.body?.cancel().catch(() => {});
        return { type: "retry", reason: `HTTP ${status}`, status };
      }

      const body = (await res.text().catch(() => "")).slice(0, BODY_SNIPPET_LIMIT);
      const isClientError = status >= 400;
      const kind: ApiErrorKind = !isClientError
        ? "unexpected_status"
        : status === 401 || status === 403
          ? "auth_error"
          : "client_error";
      return {
        type: "fatal",
        error: new ApiError(
          kind,
          `${label} failed with HTTP ${status}${res.statusText ? ` ${res.statusText}` : ""}` +
            (kind === "auth_error" ? " (not retried: check the API token and its permissions)" : "") +
            (kind === "client_error" ? " (not retried: the request itself is rejected)" : "") +
            (body ? `: ${body}` : ""),
          { url: shownUrl, attempts: attempt, status, body },
        ),
      };
    } catch (cause) {
      if (signal?.aborted) return { type: "fatal", error: aborted(attempt) };
      return {
        type: "retry",
        reason: timedOut ? `timeout after ${timeoutMs} ms` : `network error: ${(cause as Error)?.message ?? cause}`,
        cause,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onUserAbort);
    }
  };

  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw aborted(attempt - 1);

    const result = await attemptOnce(attempt);
    if (result.type === "success") return result.data;
    if (result.type === "fatal") throw result.error;

    if (attempt >= maxAttempts) {
      throw new ApiError(
        "retries_exhausted",
        `${label} failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${result.reason}`,
        { url: shownUrl, attempts: attempt, status: result.status, cause: result.cause },
      );
    }

    if (result.retryAfterMs !== undefined && result.retryAfterMs > maxRetryAfterMs) {
      throw new ApiError(
        "retry_after_too_long",
        `${label}: server asked to wait ${result.retryAfterMs} ms (limit ${maxRetryAfterMs} ms)`,
        { url: shownUrl, attempts: attempt, status: result.status, retryAfterMs: result.retryAfterMs },
      );
    }

    const delayMs =
      result.retryAfterMs ?? backoffDelay(attempt, baseDelayMs, maxDelayMs, random);
    onRetry?.({ attempt, delayMs, reason: result.reason });

    try {
      await sleep(delayMs, signal);
    } catch {
      throw aborted(attempt);
    }
  }
}
