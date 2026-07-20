// lib/visionRental.js
// Screenshot(s) -> structured rental-listing fields via Anthropic vision.
// Mirrors vision.js's structure/API style, but extracts rental-specific
// fields instead of product fields.
//
// UPDATED 2026-07-19: accepts an array of 1-5 images of the SAME rental
// listing/conversation instead of a single image, same reasoning as
// vision.js's update.
//
// KNOWN LIMITATION: contactOfferedVideoOrInPerson and paymentRequestedBeforeTour
// are conversation-dependent signals — they typically emerge over multiple
// messages with a landlord, not from listing screenshots alone. This
// extractor only sets them when the screenshots' visible text explicitly
// states one (e.g. "schedule a video tour" or "send deposit to reserve").
// Otherwise they're left null, which analyzeRental() already treats as
// neutral/unknown rather than a red flag — this is an accepted degradation,
// not a bug. Live market-rent comparison is also not built (would require
// a separate rent-comp data source) — marketRentMedian is always null from
// this extractor, meaning pattern #3 (below-market rent) won't fire on a
// screenshot-only submission.

const API = "https://api.anthropic.com/v1/messages";
const MAX_IMAGES = 5;

const SYSTEM = `You are the extraction step of PurPort, a tool that assesses rental listings for fraud risk.
You are given one or more screenshots of the SAME rental listing or message thread with a landlord/property manager (e.g. someone scrolled through one listing or conversation and captured several screenshots). Treat all images together as one listing/conversation, not separate items.
Return ONLY a JSON object, no prose, with these keys:
- "monthly_rent": the numeric monthly rent in USD as a number, or null if not visible
- "listing_text": all readable listing description and/or message text relevant to the rental, combined across all images (string)
- "landlord_claim": how the poster describes themselves if stated (e.g. "owner", "property manager", "agent"), or "" if not stated
- "contact_offered_video_or_in_person": true ONLY if the text explicitly offers/mentions a video call or in-person tour, false ONLY if it explicitly refuses one, otherwise null
- "payment_requested_before_tour": true ONLY if the text explicitly asks for payment/deposit before any tour, false ONLY if it explicitly says payment is due only after a tour/lease signing, otherwise null
- "extraction_confidence": one of "high" | "medium" | "low"
Be conservative with the two boolean fields — only set true/false when the text is explicit, not inferred from tone. Default to null when unsure.`;

export async function analyzeRentalScreenshot(input) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

  const images = normalizeImages(input);
  if (!images.length) throw new Error("No images provided to analyzeRentalScreenshot");

  const content = images.slice(0, MAX_IMAGES).map(img => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.base64 }
  }));
  content.push({ type: "text", text: "Extract the rental listing fields as JSON, combining information across all images shown." });

  const body = {
    model,
    max_tokens: 800,
    system: SYSTEM,
    messages: [{ role: "user", content }]
  };

  const res = await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic vision error ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || []).map(c => c.text || "").join("").trim();
  const parsed = extractJson(text);
  if (!parsed) throw new Error("Vision step returned unparseable output");

  return {
    monthlyRent: numOrNull(parsed.monthly_rent),
    marketRentMedian: null, // no live rent-comp source — see file header
    listingText: (parsed.listing_text || "").trim(),
    landlordClaim: (parsed.landlord_claim || "").trim(),
    contactOfferedVideoOrInPerson: boolOrNull(parsed.contact_offered_video_or_in_person),
    paymentRequestedBeforeTour: boolOrNull(parsed.payment_requested_before_tour),
    scriptedRepeatQuestion: false, // not derivable from screenshots alone
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
function numOrNull(v) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return isFinite(n) ? n : null;
}
function boolOrNull(v) {
  if (v === true || v === false) return v;
  return null;
}