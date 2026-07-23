// harness_outcome.js
// Outcome classification for the PA-05 accuracy harness.
//
// PROBLEM THIS SOLVES: a 20-screenshot run will hit Anthropic 529s
// (overloaded_error). Without this, an infrastructure blip is recorded as
// "the model got the product wrong" and the accuracy number is understated
// by an unknown margin — which makes the PA-05 gate unfalsifiable. A gate
// you can't trust is worse than no gate.
//
// RULE: only rows where the call actually completed are scoreable.
// Everything else is excluded from the denominator and reported separately.
//
// No npm dependencies. Node 18+. ESM.

"use strict";

export const OUTCOME = {
  PASS: "PASS",                     // call completed, answer correct
  FAIL: "FAIL",                     // call completed, answer wrong  <- real signal
  SKIP_TRANSIENT: "SKIP_TRANSIENT", // 529/429/5xx/network — rerun the row
  SKIP_SETUP: "SKIP_SETUP",         // 400/404/contract mismatch — fix the harness, not the model
  ABORT: "ABORT",                   // 401/403 — circuit breaker, stop the run
};

const TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504, 529]);

// Fallback only. Used when the server has NOT yet been patched to emit
// { transient: true } — it string-matches the error text the app currently
// surfaces (e.g. `Anthropic vision error 529: {"type":"overloaded_error"...}`).
// Delete this fallback once the server emits the flag.
const TRANSIENT_TEXT =
  /\b(529|overloaded|rate.?limit|too many requests|timed? ?out|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|service unavailable|temporarily)\b/i;

/**
 * Decide whether a single API call is scoreable.
 *
 *   const call = classifyCall({ status: res.status, body: data });
 *   const call = classifyCall({ networkError: err });   // fetch threw
 *
 * @returns {{ outcome: string, reason: string }}
 */
export function classifyCall({ status = null, body = null, networkError = null } = {}) {
  if (networkError) {
    const msg = networkError.message || String(networkError);
    return { outcome: OUTCOME.SKIP_TRANSIENT, reason: `network: ${msg}` };
  }

  // Auth failures stop the whole run — every subsequent row would fail the
  // same way and the results would be meaningless.
  if (status === 401 || status === 403) {
    return { outcome: OUTCOME.ABORT, reason: `auth failure (HTTP ${status}) — check ANTHROPIC_API_KEY in Railway` };
  }

  // Preferred path: the server tells us explicitly (see toClientError in httpRetry.js).
  if (body && body.transient === true) {
    return { outcome: OUTCOME.SKIP_TRANSIENT, reason: body.code || `upstream transient (HTTP ${status})` };
  }
  if (body && body.transient === false) {
    return { outcome: OUTCOME.SKIP_SETUP, reason: body.code || `upstream permanent error (HTTP ${status})` };
  }

  if (status != null && status >= 400) {
    const text = errorText(body);
    if (TRANSIENT_HTTP.has(status) || TRANSIENT_TEXT.test(text)) {
      return { outcome: OUTCOME.SKIP_TRANSIENT, reason: `HTTP ${status}: ${trim(text)}` };
    }
    return { outcome: OUTCOME.SKIP_SETUP, reason: `HTTP ${status}: ${trim(text)}` };
  }

  // 2xx but the body doesn't carry what parseAnalyzeResponse() needs:
  // a contract mismatch, not a model miss.
  if (body == null) {
    return { outcome: OUTCOME.SKIP_SETUP, reason: "empty response body" };
  }

  return { outcome: "OK", reason: "" };
}

/**
 * Build one result row. `id` and `price` are "PASS" | "FAIL" | null, and are
 * forced to null whenever the call itself wasn't scoreable.
 */
export function makeRow({ file, call, id = null, price = null, note = "" }) {
  const scoreable = call.outcome === "OK";
  return {
    file,
    call: scoreable ? "OK" : call.outcome,
    reason: call.reason || "",
    id: scoreable ? id : null,
    price: scoreable ? price : null,
    note,
  };
}

/**
 * Aggregate. Accuracy is computed ONLY over scoreable rows.
 *
 * @param {Array} rows rows from makeRow()
 * @param {number} maxTransientRate run is invalid above this (default 10%)
 */
export function summarize(rows, { maxTransientRate = 0.10 } = {}) {
  const total = rows.length;
  const counts = { ok: 0, transient: 0, setup: 0, abort: 0 };

  for (const r of rows) {
    if (r.call === "OK") counts.ok++;
    else if (r.call === OUTCOME.SKIP_TRANSIENT) counts.transient++;
    else if (r.call === OUTCOME.SKIP_SETUP) counts.setup++;
    else if (r.call === OUTCOME.ABORT) counts.abort++;
  }

  const dim = (key) => {
    const scored = rows.filter((r) => r.call === "OK" && (r[key] === "PASS" || r[key] === "FAIL"));
    const pass = scored.filter((r) => r[key] === "PASS").length;
    return {
      pass,
      fail: scored.length - pass,
      scored: scored.length,
      accuracy: scored.length ? pass / scored.length : null,
    };
  };

  const transientRate = total ? counts.transient / total : 0;

  // The run is only valid if infrastructure noise stayed low, nothing is
  // structurally broken, and we actually scored enough rows to mean anything.
  const invalidReasons = [];
  if (counts.abort > 0) invalidReasons.push("auth failure — run aborted");
  if (counts.setup > 0) invalidReasons.push(`${counts.setup} setup/contract error(s) — fix the harness or endpoint contract first`);
  if (transientRate > maxTransientRate) invalidReasons.push(`transient failure rate ${pct(transientRate)} exceeds ${pct(maxTransientRate)} — rerun`);
  if (counts.ok < Math.ceil(total * 0.8)) invalidReasons.push(`only ${counts.ok}/${total} rows scoreable`);

  return {
    total,
    counts,
    transientRate,
    id: dim("id"),
    price: dim("price"),
    valid: invalidReasons.length === 0,
    invalidReasons,
  };
}

export function formatReport(summary) {
  const L = [];
  L.push("=== PA-05 ACCURACY RUN ===");
  L.push(`rows:        ${summary.total}`);
  L.push(`scoreable:   ${summary.counts.ok}`);
  L.push(`transient:   ${summary.counts.transient}  (excluded — rerun these)`);
  L.push(`setup err:   ${summary.counts.setup}  (excluded — harness/contract bug)`);
  L.push(`aborted:     ${summary.counts.abort}`);
  L.push("");
  L.push(`product ID:  ${fmtDim(summary.id)}`);
  L.push(`pricing:     ${fmtDim(summary.price)}`);
  L.push("");
  if (summary.valid) {
    L.push("RUN VALID — these accuracy numbers are trustworthy.");
  } else {
    L.push("RUN INVALID — do not treat these numbers as PA-05 evidence:");
    for (const r of summary.invalidReasons) L.push(`  - ${r}`);
  }
  return L.join("\n");
}

// ---- internals ----

function fmtDim(d) {
  if (!d.scored) return "no scoreable rows";
  return `${d.pass}/${d.scored} = ${pct(d.accuracy)}  (fail: ${d.fail})`;
}
function pct(n) {
  return n == null ? "n/a" : `${(n * 100).toFixed(1)}%`;
}
function errorText(body) {
  if (body == null) return "";
  if (typeof body === "string") return body;
  return String(body.error || body.message || JSON.stringify(body));
}
function trim(s) {
  return String(s).replace(/\s+/g, " ").slice(0, 160);
}