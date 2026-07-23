// lib/visionService.js
// Screenshot(s) -> structured contractor/service-offer fields via Anthropic
// vision. New 2026-07-19 — the service/contractor check previously had no
// vision step at all, only a manual text form. Mirrors vision.js and
// visionRental.js's structure/API style.
//
// PATCHED 2026-07-22 (PA-05 unblock): the raw fetch + `if (!res.ok) throw`
// block was replaced with fetchWithRetry() from lib/httpRetry.js. This is
// the third and last caller of that pattern; all three vision paths now
// share one retry/classification path (invariant #6 — one path, no
// divergence). 429/5xx/529 retried with backoff; 400/401/403/404 still
// fail closed immediately.
//
// KNOWN LIMITATION: wasUnsolicited (did they approach the user first) is
// essentially never determinable from a screenshot alone — it depends on
// context the user has that isn't in the image. This extractor leaves it
// false by default (analyzeService.js's neutral default) unless the text
// itself says something like "noticed your driveway" / door-to-door framing,
// which the existing doorToDoorPressure regex in analyzeService.js already
// catches independently from descriptionText, so leaving the structural
// flag false here is not a meaningful loss of signal.

import { fetchWithRetry } from "./httpRetry.js";

const API = "https://api.anthropic.com/v1/messages";
const MAX_IMAGES = 5;

const SYSTEM = `You are the extraction step of PurPort, a tool that assesses contractor/home-service offers for fraud risk.
You are given one or more screenshots of the SAME conversation, message, or profile from a contractor, handyman, mover, or similar service provider (e.g. someone scrolled through one conversation and captured several screenshots). Treat all images together as one offer, not separate items.
Return ONLY a JSON object, no prose, with these keys:
- "description_text": all readable text of their pitch, message, or offer, combined across all images (string)
- "claimed_licensed": true ONLY if they explicitly claim/show a license or insurance, false ONLY if they explicitly say they don't have one or deflect when asked, otherwise null
- "provided_written_estimate": true ONLY if a written estimate/quote is visible, false ONLY if they explicitly say it's verbal-only, otherwise null
- "payment_requested_before_work_started": true ONLY if they explicitly ask for full payment before starting work, false ONLY if they explicitly describe milestone/completion-based payment, otherwise null
- "extraction_confidence": one of "high" | "medium" | "low"
Be conservative with the boolean fields — only set true/false when the text is explicit, not inferred from tone. Default to null when unsure.`;

export async function analyzeServiceScreenshot(input) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

  const images = normalizeImages(input);
  if (!images.length) throw new Error("No images provided to analyzeServiceScreenshot");

  const content = images.slice(0, MAX_IMAGES).map(img => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.base64 }
  }));
  content.push({ type: "text", text: "Extract the service-offer fields as JSON, combining information across all images shown." });

  const body = {
    model,
    max_tokens: 800,
    system: SYSTEM,
    messages: [{ role: "user", content }]
  };

  // fetchWithRetry returns a Response only on 2xx; it throws UpstreamError
  // otherwise, so no `if (!res.ok)` block is needed here.
  const res = await fetchWithRetry(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  }, { label: "Anthropic vision" });

  const data = await res.json();
  const text = (data.content || []).map(c => c.text || "").join("").trim();
  const parsed = extractJson(text);
  if (!parsed) throw new Error("Vision step returned unparseable output");

  return {
    descriptionText: (parsed.description_text || "").trim(),
    wasUnsolicited: false, // not reliably derivable from a screenshot alone — see file header
    claimedLicensed: boolOrNull(parsed.claimed_licensed),
    providedWrittenEstimate: boolOrNull(parsed.provided_written_estimate),
    paymentRequestedBeforeWorkStarted: boolOrNull(parsed.payment_requested_before_work_started),
    extractionConfidence: parsed.extraction_confidence || "low"
  };
}

function normalizeImages(input) {
  if (Array.isArray(input?.images)) return input.images;
  if (input?.base64) return [{ base64: input.base64, mediaType: input.mediaType }];
  return [];
}

function extractJson(s) {
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
function boolOrNull(v) {
  if (v === true || v === false) return v;
  return null;
}
