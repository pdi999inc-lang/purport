// lib/vision.js
// Screenshot -> structured listing fields via Anthropic vision.
// Extracts the product, condition, asking price, and any message/listing text
// from a marketplace screenshot (FB Marketplace, Craigslist, eBay, OfferUp).

const API = "https://api.anthropic.com/v1/messages";

const SYSTEM = `You are the extraction step of PurPort, a tool that assesses marketplace listings for fair pricing and scam risk.
You are given a screenshot of an item for sale or a message about one.
Return ONLY a JSON object, no prose, with these keys:
- "product": the most specific make/model/variant you can read (string, or "" if unclear)
- "product_confidence": one of "high" | "medium" | "low"
- "seller_condition": the condition the listing states, e.g. "New", "Like New", "Good", "Fair", "For parts", or "" if not stated
- "photo_condition": your own read of condition from any product photo (wear/damage/completeness), or "" if no product photo
- "asking_price": the numeric asking price in USD as a number, or null if not visible
- "listing_text": all readable seller text / message body relevant to the sale (string)
Be conservative: if you cannot confidently read the exact model, set product_confidence to "low" and put your best guess in product.`;

export async function analyzeScreenshot({ base64, mediaType }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

  const body = {
    model,
    max_tokens: 800,
    system: SYSTEM,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text", text: "Extract the listing fields as JSON." }
      ]
    }]
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
    product: (parsed.product || "").trim(),
    productConfidence: parsed.product_confidence || "low",
    sellerCondition: (parsed.seller_condition || "").trim(),
    photoCondition: (parsed.photo_condition || "").trim(),
    askingPrice: numOrNull(parsed.asking_price),
    listingText: (parsed.listing_text || "").trim()
  };
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
