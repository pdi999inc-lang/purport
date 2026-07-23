// lib/httpRetry.js
// Shared transient-failure retry for outbound API calls (Anthropic vision,
// Nimble pricing). One helper for every caller — no per-module retry logic
// (invariant #6: one path, no divergence).
//
// Built 2026-07-22 after a live Anthropic 529 (overloaded_error) killed an
// analysis outright and leaked raw API JSON into the PurPort UI.
// 429/5xx/529 are capacity or transport failures and are retryable.
// 400/401/403/404 are permanent and must fail closed immediately
// (invariants #1 and #4 — fail closed, never guess).
//
// No npm dependencies. Node 18+ (global fetch, AbortController).

"use strict";

// Retry ONLY these. Every other status — including every 4xx that is not a
// rate limit — is permanent and must not be retried.
//   408 request timeout        429 rate limited
//   500 internal (api_error)   502/503/504 gateway / unavailable
//   529 overloaded_error       (Anthropic capacity signal — the one we hit)
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

const DEFAULTS = {
  attempts: 3,        // total tries (2 retries)
  baseDelayMs: 500,   // first backoff ceiling
  maxDelayMs: 4000,   // ceiling on any single backoff wait
  timeoutMs: 30000,   // per-attempt hard timeout
  label: "upstream",  // used in error messages / logs
};

export function isTransientStatus(status) {
  return RETRYABLE_STATUS.has(Number(status));
}

export class UpstreamError extends Error {
  constructor(message, { status = null, transient = false, attempts = 1, body = "" } = {}) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;      // HTTP status, or null for network-level failure
    this.transient = transient; // true => safe to retry / rerun the row
    this.attempts = attempts;   // how many tries were made before giving up
    this.body = body;           // truncated upstream body — LOG THIS, never render it
  }
}

/**
 * Drop-in replacement for fetch() that retries transient failures.
 * Returns a Response only on 2xx. Throws UpstreamError otherwise.
 *
 *   const res = await fetchWithRetry(API, { method: "POST", ... },
 *                                    { label: "Anthropic vision" });
 *
 * Callers no longer need their own `if (!res.ok)` block — delete it.
 */
export async function fetchWithRetry(url, init = {}, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  let lastErr = null;

  for (let attempt = 1; attempt <= cfg.attempts; attempt++) {
    let res;

    try {
      res = await fetchOnce(url, init, cfg.timeoutMs);
    } catch (e) {
      // Network-level failure: DNS, reset, socket hang up, or our own abort
      // on timeout. All transient.
      lastErr = new UpstreamError(
        `${cfg.label} request failed: ${e && e.message ? e.message : e}`,
        { transient: true, attempts: attempt }
      );
      if (attempt === cfg.attempts) break;
      await sleep(backoffMs(attempt, cfg));
      continue;
    }

    if (res.ok) return res;

    const status = res.status;
    const body = await safeText(res);

    if (!isTransientStatus(status)) {
      // Permanent: auth, malformed request, not found. Fail closed now —
      // retrying a 401 just burns time and hides the real problem.
      throw new UpstreamError(`${cfg.label} error ${status}`, {
        status, transient: false, attempts: attempt, body,
      });
    }

    lastErr = new UpstreamError(`${cfg.label} error ${status}`, {
      status, transient: true, attempts: attempt, body,
    });
    if (attempt === cfg.attempts) break;

    // Honor Retry-After when the server sends one; otherwise back off.
    await sleep(retryAfterMs(res, cfg) ?? backoffMs(attempt, cfg));
  }

  throw lastErr;
}

/**
 * Map an error to a safe client response. Never leaks upstream body text.
 * Log err.body server-side before calling this.
 *
 *   catch (e) { console.error("[vision]", e.status, e.body);
 *               const c = toClientError(e);
 *               return res.status(c.http).json(c.body); }
 */
export function toClientError(err) {
  const transient = err && err.transient === true;
  return {
    http: transient ? 503 : 502,
    body: {
      error: transient ? DEGRADED_MESSAGE : PERMANENT_MESSAGE,
      transient,                                    // machine-readable — the harness reads this
      code: transient ? "upstream_unavailable" : "upstream_error",
    },
  };
}

export const DEGRADED_MESSAGE =
  "Couldn't read the screenshot right now \u2014 the analysis service is busy. " +
  "Try again in a moment, or type the details in below.";

export const PERMANENT_MESSAGE =
  "Analysis is unavailable right now. Nothing was scored \u2014 please try again later.";

// ---- internals ----

async function fetchOnce(url, init, timeoutMs) {
  if (!timeoutMs) return fetch(url, init);
  // NOTE: this replaces any caller-supplied AbortSignal. No current caller
  // passes one; if one ever does, compose the signals here instead.
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

// Equal jitter: half the ceiling fixed, half random. Keeps a minimum real
// pause (unlike full jitter, which can retry almost instantly into a 529)
// while still de-synchronizing concurrent harness requests.
function backoffMs(attempt, cfg) {
  const ceiling = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * Math.pow(2, attempt - 1));
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
}

function retryAfterMs(res, cfg) {
  const raw = res.headers && res.headers.get ? res.headers.get("retry-after") : null;
  if (!raw) return null;

  let ms;
  const secs = Number(raw);
  if (Number.isFinite(secs)) {
    ms = secs * 1000;
  } else {
    const when = Date.parse(raw); // HTTP-date form
    if (Number.isNaN(when)) return null;
    ms = when - Date.now();
  }
  if (!(ms > 0)) return null;
  return Math.min(ms, cfg.maxDelayMs); // never stall a live request on a long header value
}

async function safeText(res) {
  try {
    const t = await res.text();
    return t.slice(0, 300);
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}