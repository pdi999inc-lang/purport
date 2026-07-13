// Minimal correctness test for the pure verdict logic. Run: node test.mjs
import { analyze } from "./lib/analyze.js";
let fail = 0;
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); fail++; } else console.log("pass:", m); };

// Too-good-to-be-true + scam text => high risk
let r = analyze({ askingPrice: 45, sellerCondition: "Like New",
  listingText: "must sell today moving overseas, send deposit on Zelle and I'll ship",
  prices: { usedLow: 83, usedHigh: 191, usedMedian: 140, usedSample: 6, newPrice: 399 } });
ok(r.level === "high", "deep discount + Zelle + urgency => high risk (" + r.scamScore + "%)");
ok(r.dealBand === "Too good to be true", "deal band flagged too-good (" + r.dealBand + ")");

// Fair price, clean text => low risk
r = analyze({ askingPrice: 150, sellerCondition: "Good", listingText: "pickup only, cash on meetup",
  prices: { usedLow: 120, usedHigh: 200, usedMedian: 160, usedSample: 5, newPrice: 399 } });
ok(r.level === "low", "fair price + safe terms => low risk (" + r.scamScore + "%)");

// Good deal, no scam text => low/caution but flagged as genuine deal
r = analyze({ askingPrice: 95, sellerCondition: "Good", listingText: "meet at police station",
  prices: { usedLow: 120, usedHigh: 200, usedMedian: 160, usedSample: 5, newPrice: 399 } });
ok(r.dealBand === "Good deal", "below-median clean listing => good deal (" + r.dealBand + ")");

console.log(fail ? `\n${fail} test(s) failed` : "\nAll tests passed");
process.exit(fail ? 1 : 0);
