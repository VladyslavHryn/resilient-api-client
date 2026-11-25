/**
 * Client for a flaky external API.
 *
 *  - every attempt has its own timeout (covers headers AND body);
 *  - 5xx, 408, timeouts, network errors: retry with a growing pause (exponential backoff + jitter);
 *  - 429 (and 503) with Retry-After: wait as long as the server asks;
 *  - other 4xx: never retried, a descriptive ApiError is thrown at once;
 *  - at most `maxAttempts` attempts and at most `deadlineMs` in total, so the loop always ends.
 */

export type ApiErrorKind =
  /** 401/403: the token is expired or lacks rights. A human has to fix it, retrying cannot help. */
  | "auth_error"
  /** Any other non-2xx status that is not worth repeating (4xx except 408/429). */
  | "client_error"
  /** 2xx, but the body is not valid JSON. */
  | "invalid_response"
  /** All attempts were used up on retryable failures. */
  | "retries_exhausted"
  /** The next pause (e.g. a huge Retry-After) would not fit into the total deadline. */
  | "deadline_exceeded"
  /** Non-idempotent request (e.g. POST) failed in a way that may have already been processed. */
  | "unsafe_to_retry";

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly details: {
      /** Origin + path only: query strings often carry API keys and must not reach logs. */
      url: string;
      attempts: number;
      status?: number;
      /** Start of the last response body, to see what the server said. */
      body?: string;
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

/** Things the tests replace; production code never passes these. */
export interface Deps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => number;
}

export interface RequestOptions {
  /** Standard fetch init (method, headers, body ...). */
  init?: Omit<RequestInit, "signal">;
  /** Timeout of one attempt. Default 10 s. */
  timeoutMs?: number;
  /** Attempts in total, the first one included. Default 5. */
  maxAttempts?: number;
  /** Pause before retry n is about baseDelayMs * 2^(n-1). Default 500 ms. */
  baseDelayMs?: number;
  /** Upper bound of that pause. Default 30 s. */
  maxDelayMs?: number;
  /** Total time for all attempts and pauses. Default 2 min. */
  deadlineMs?: number;
  deps?: Partial<Deps>;
}

const BODY_SNIPPET_LIMIT = 500;
/** Repeating these cannot do harm; POST and the like are only retried on 429 (the server did not process them). */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

/** Retry-After is delta-seconds or an HTTP date. Returns ms, or undefined if absent/invalid. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  // HTTP-dates contain day/month names; without this check Date.parse("-3") is a valid year.
  if (!/[A-Za-z]/.test(v)) return undefined;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
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

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return "<invalid url>";
  }
}

type Attempt =
  | { type: "success"; data: unknown }
  | { type: "fatal"; error: ApiError }
  | { type: "retry"; reason: string; status?: number; retryAfterMs?: number; body?: string; cause?: unknown };

export async function requestJson<T = unknown>(
  url: string | URL,
  options: RequestOptions = {},
): Promise<T> {
  const {
    init,
    timeoutMs = 10_000,
    maxAttempts = 5,
    baseDelayMs = 500,
    maxDelayMs = 30_000,
    deadlineMs = 120_000,
  } = options;
  const {
    fetch: fetchImpl = globalThis.fetch,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
    now = Date.now,
  } = options.deps ?? {};

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be a positive integer, got ${maxAttempts}`);
  }

  const target = String(url);
  const shownUrl = redactUrl(target);
  const method = (init?.method ?? "GET").toUpperCase();
  const label = `${method} ${shownUrl}`;
  const deadline = now() + deadlineMs;

  const attemptOnce = async (attempt: number, attemptTimeoutMs: number): Promise<Attempt> => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, attemptTimeoutMs);

    try {
      const res = await fetchImpl(target, { ...init, signal: controller.signal });
      const { status } = res;

      if (status >= 200 && status < 300) {
        const text = await res.text(); // still under the timeout
        try {
          return { type: "success", data: JSON.parse(text) };
        } catch (cause) {
          const body = text.slice(0, BODY_SNIPPET_LIMIT);
          return {
            type: "fatal",
            error: new ApiError("invalid_response", `${label} returned HTTP ${status} with a body that is not JSON`, {
              url: shownUrl,
              attempts: attempt,
              status,
              body,
              cause,
            }),
          };
        }
      }

      const body = (await res.text().catch(() => "")).slice(0, BODY_SNIPPET_LIMIT);

      if (status === 408 || status === 429 || status >= 500) {
        const retryAfterMs =
          status === 429 || status === 503 ? parseRetryAfter(res.headers.get("retry-after"), now()) : undefined;
        return { type: "retry", reason: `HTTP ${status}`, status, retryAfterMs, body };
      }

      const kind: ApiErrorKind = status === 401 || status === 403 ? "auth_error" : "client_error";
      const hint =
        kind === "auth_error"
          ? " (not retried: check the API token and its permissions)"
          : " (not retried: the request itself is rejected)";
      return {
        type: "fatal",
        error: new ApiError(
          kind,
          `${label} failed with HTTP ${status}${res.statusText ? ` ${res.statusText}` : ""}${hint}` +
            (body ? `: ${body}` : ""),
          { url: shownUrl, attempts: attempt, status, body },
        ),
      };
    } catch (cause) {
      return {
        type: "retry",
        reason: timedOut ? `timeout after ${attemptTimeoutMs} ms` : `network error: ${(cause as Error)?.message ?? cause}`,
        cause,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  for (let attempt = 1; ; attempt++) {
    const result = await attemptOnce(attempt, Math.min(timeoutMs, deadline - now()));
    if (result.type === "success") return result.data as T;
    if (result.type === "fatal") throw result.error;

    const failure = { url: shownUrl, attempts: attempt, status: result.status, body: result.body, cause: result.cause };
    const detail = result.body ? `: ${result.body}` : "";

    if (!IDEMPOTENT_METHODS.has(method) && result.status !== 429) {
      throw new ApiError(
        "unsafe_to_retry",
        `${label} failed (${result.reason}) and was not retried: ${method} may already have been processed${detail}`,
        failure,
      );
    }
    if (attempt >= maxAttempts) {
      throw new ApiError(
        "retries_exhausted",
        `${label} failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${result.reason}${detail}`,
        failure,
      );
    }

    const delayMs = result.retryAfterMs ?? backoffDelay(attempt, baseDelayMs, maxDelayMs, random);
    if (now() + delayMs >= deadline) {
      throw new ApiError(
        "deadline_exceeded",
        `${label}: the next attempt would start after the ${deadlineMs} ms deadline ` +
          `(wait of ${delayMs} ms, ${attempt} attempt${attempt === 1 ? "" : "s"} made, last: ${result.reason})${detail}`,
        failure,
      );
    }
    await sleep(delayMs);
  }
}
