// lib/vision.js
// Screenshot(s) -> structured listing fields via Anthropic vision.
// Extracts the product, condition, asking price, and any message/listing text
// from marketplace screenshot(s) (FB Marketplace, Craigslist, eBay, OfferUp).
//
// UPDATED 2026-07-19: accepts an array of 1-5 images of the SAME listing
// (e.g. someone scrolling through one FB Marketplace post) instead of a
// single image. All images are sent in one Anthropic call so the model can
// combine info across them (e.g. price on one screenshot, condition photos
// on another) into a single extraction.

import { fetchWithRetry } from "./httpRetry.js";

const API = "https://api.anthropic.com/v1/messages";
const MAX_IMAGES = 5;

const SYSTEM = `You are the extraction step of PurPort, a tool that assesses marketplace listings for fair pricing and scam risk.
You are given one or more screenshots of the SAME item for sale or message thread about one (e.g. someone scrolled through one listing and captured several screenshots). Treat all images together as one listing, not separate items.
Return ONLY a JSON object, no prose, with these keys:
- "product": the most specific make/model/variant you can read (string, or "" if unclear)
- "product_confidence": one of "high" | "medium" | "low"
- "seller_condition": the condition the listing states, e.g. "New", "Like New", "Good", "Fair", "For parts", or "" if not stated
- "photo_condition": your own read of condition from any product photo (wear/damage/completeness), or "" if no product photo
- "asking_price": the numeric asking price in USD as a number, or null if not visible
- "listing_text": all readable seller text / message body relevant to the sale, combined across all images (string)
Be conservative: if you cannot confidently read the exact model, set product_confidence to "low" and put your best guess in product.`;

export async function analyzeScreenshot(input) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

  // Backward-compatible: accept either a single {base64, mediaType} or an
  // {images: [{base64, mediaType}, ...]} array.
  const images = normalizeImages(input);
  if (!images.length) throw new Error("No images provided to analyzeScreenshot");

  const content = images.slice(0, MAX_IMAGES).map(img => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.base64 }
  }));
  content.push({ type: "text", text: "Extract the listing fields as JSON, combining information across all images shown." });

  const body = {
    model,
    max_tokens: 800,
    system: SYSTEM,
    messages: [{ role: "user", content }]
  };

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
    product: (parsed.product || "").trim(),
    productConfidence: parsed.product_confidence || "low",
    sellerCondition: (parsed.seller_condition || "").trim(),
    photoCondition: (parsed.photo_condition || "").trim(),
    askingPrice: numOrNull(parsed.asking_price),
    listingText: (parsed.listing_text || "").trim()
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