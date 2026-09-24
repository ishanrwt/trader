import { sleep } from "../limiters/clock.js";
import type { Logger } from "../logger/index.js";

export class HttpRequestError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "HttpRequestError";
    this.status = status;
  }
}

export interface FetchJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Extra attempts after the first, only for 429/5xx or a thrown network error. */
  retries?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Used in log messages and error text; defaults to the URL. */
  label?: string;
}

function jitterDelay(attempt: number, baseDelayMs: number): number {
  const base = baseDelayMs * 2 ** attempt;
  return base + Math.random() * base * 0.5;
}

/**
 * Fetches JSON with a timeout and, on a 429/5xx or a network error, a bounded
 * number of retries with jittered backoff. Per SPEC.md section 1: "Every
 * external call has a timeout and error handling" and section 3: "On a 429 or
 * 5xx, back off with jitter."
 */
export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const {
    method = "GET",
    headers,
    body,
    timeoutMs = 8000,
    retries = 2,
    baseDelayMs = 300,
    logger,
    label = url,
  } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method,
        ...(headers ? { headers } : {}),
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.ok) {
        return (await res.json()) as T;
      }

      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        logger?.warn(`${label} returned ${res.status}, retrying`, { attempt, status: res.status });
        await sleep(jitterDelay(attempt, baseDelayMs));
        continue;
      }

      const text = await res.text().catch(() => "");
      throw new HttpRequestError(`${label} returned ${res.status}: ${text.slice(0, 200)}`, res.status);
    } catch (err) {
      if (err instanceof HttpRequestError) throw err;
      lastError = err;
      if (attempt < retries) {
        logger?.warn(`${label} request failed, retrying`, { attempt, error: String(err) });
        await sleep(jitterDelay(attempt, baseDelayMs));
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new HttpRequestError(`${label} request failed`);
}
