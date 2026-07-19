// lib/analyze.js
// Pure logic: given extracted listing fields + price data, produce the verdict.
// No I/O here so it is unit-testable and cheap to reason about.

const SCAM_PATTERNS = [
  { re: /\b(zelle|venmo|cash ?app|wire|gift ?card|crypto|bitcoin)\b/i, w: 22, label: "Requests an irreversible payment method (Zelle/Venmo/gift card/crypto)" },
  { re: /\b(deposit|hold fee|reserve|down payment)\b/i, w: 20, label: "Asks for a deposit to 'hold' the item" },
  { re: /\b(can'?t meet|no meet|out of (state|town|country)|overseas|deployed)\b/i, w: 18, label: "Avoids meeting in person (out of state / shipping only)" },
  { re: /\b(whats ?app|text me|email me|telegram|google voice|verification code)\b/i, w: 20, label: "Pushes the conversation off-platform" },
  { re: /\b(must sell (today|now)|urgent|asap|first come|leaving (today|tonight)|quick sale)\b/i, w: 12, label: "Manufactured urgency / pressure" },
  { re: /\b(shipping (agent|company)|freight forwarder|my shipper)\b/i, w: 16, label: "Insists on a specific shipping service" },
  { re: /\b(overpay|extra|refund the difference|sent too much)\b/i, w: 20, label: "Overpayment / refund-the-difference angle" }
];

export function analyze({ askingPrice, sellerCondition, listingText, prices }) {
  const flags = [];
  const { usedLow, usedHigh, usedMedian, newPrice, usedSample } = prices;

  // ---- deal math ----
  let dealBand = "Unknown", priceScore = 0;
  if (usedMedian && askingPrice != null) {
    const ratio = askingPrice / usedMedian;
    if (ratio > 1.15) { dealBand = "Overpriced"; priceScore = 5; }
    else if (ratio >= 0.8) { dealBand = "Fair — in line with used market"; priceScore = 0; }
    else if (ratio >= 0.55) { dealBand = "Good deal"; priceScore = 6; }
    else if (ratio >= 0.35) { dealBand = "Suspiciously low"; priceScore = 32; }
    else { dealBand = "Too good to be true"; priceScore = 48; }
  }

  // ---- scam-pattern scan ----
  let scamScore = priceScore;
  if (listingText) {
    for (const sp of SCAM_PATTERNS) {
      if (sp.re.test(listingText)) { flags.push({ level: "red", text: sp.label }); scamScore += sp.w; }
    }
  }

  // condition vs price sanity
  if (/new/i.test(sellerCondition || "") && usedMedian && askingPrice != null && askingPrice < usedMedian * 0.5) {
    flags.push({ level: "red", text: "'New' claim but price is far below even the used market" });
    scamScore += 10;
  }
  if (askingPrice != null && usedMedian) {
    if (priceScore >= 32) flags.push({ level: "red", text: `Asking price is ${Math.round((1 - askingPrice / usedMedian) * 100)}% below the typical used price (${money(usedMedian)})` });
    else if (dealBand.startsWith("Good")) flags.push({ level: "green", text: "Priced below typical used — a genuine deal if condition checks out" });
    else if (dealBand.startsWith("Fair")) flags.push({ level: "green", text: "Asking price is consistent with the used market" });
  }
  if (!listingText) flags.push({ level: "amber", text: "No readable listing text — scam-pattern scan limited." });
  if (!usedSample) flags.push({ level: "amber", text: "Couldn't verify a used price for this exact product — identification may be off." });

  scamScore = Math.max(0, Math.min(99, Math.round(scamScore)));

  let level, headline, recommendation;
  if (scamScore >= 60) {
    level = "high"; headline = "High scam risk";
    recommendation = "Treat as a likely scam. Do not send deposits, gift cards, or move off-platform. Proceed only with an in-person meet and payment on pickup.";
  } else if (scamScore >= 30) {
    level = "caution"; headline = "Caution";
    recommendation = "Some red flags. Verify the item in person, confirm serial/model, and never pay before you inspect it.";
  } else {
    level = "low"; headline = "Low scam risk";
    recommendation = "No strong scam signals. Still meet in a safe public place and confirm the item before paying.";
  }

  return { scamScore, level, headline, recommendation, dealBand, flags };
}

function money(n) { return n == null ? "—" : "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
