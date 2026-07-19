// analyzeService.js
// Contractor / home-service scam detection module for PurPort.
// Covers: contractors, handymen, movers, roofers, driveway sealers, and
// similar door-to-door or unsolicited home-service offers.
//
// Built 2026-07-19, mirroring the structure of analyzeRental.js (patterns/
// weights/scoring/breakdown) for consistency with the existing rental
// module — but with its own domain-specific pattern set. Contractor scams
// have distinct signals (licensing claims, permit fees, storm-chasing,
// door-to-door pressure) that don't overlap cleanly with rental-fraud or
// marketplace-goods patterns, so this is deliberately a separate module,
// not a shared/generalized one — same "context pack, not fork" reasoning
// as the original marketplace/rental split, applied a third time.
//
// STATUS: New, unvalidated against real cases. No fixtures written yet.
// Pattern weights below are first-pass estimates, not calibrated.

"use strict";

const PATTERNS = {
  fullPaymentUpfront: /\b(full|entire|100%|whole)\s+(payment|amount|cost)\s+(upfront|up front|before|in advance)\b|\bpay\s+(everything|it all)\s+(upfront|up front|before\s+we\s+start)\b/i,
  cashOnly: /\b(cash only|cash preferred|no checks|no cards|discount for cash)\b/i,
  noWrittenEstimate: /\b(no need for a contract|don'?t need (it |anything )?in writing|verbal agreement is fine|handshake deal)\b/i,
  doorToDoorPressure: /\b(noticed your (roof|driveway|siding|gutters)|we'?re already in your neighborhood|leftover materials? from (another|a) job|today only|price (is )?only good today|have to decide (today|right now))\b/i,
  stormChaser: /\b(storm damage|hail damage|after the (storm|hurricane|tornado))\b.{0,60}\b(free inspection|noticed damage|walk your roof)\b/i,
  insuranceAssignment: /\b(assignment of benefits|sign (this |the )?before (we|I) (start|talk to|deal with) (your )?insurance|let us handle your insurance claim)\b/i,
  noLicenseProof: /\b(don'?t need a license|licensed in another state|license (number )?(isn'?t|not) (needed|required|available)|trust me,? I'?m licensed)\b/i,
  riskyPaymentMethod: /\b(zelle|venmo|cash\s?app|wire\s?transfer|western\s?union|moneygram|gift\s?card|crypto|bitcoin)\b/i,
  unmarkedVehicle: /\b(unmarked (van|truck)|no company (logo|name) on (the |my )?(van|truck)|magnetic sign)\b/i,
  permitFeeUpfront: /\b(permit fee|inspection fee)\b.{0,40}\b(before|upfront|first|now)\b/i,
  urgency: /\b(only (have|got) time today|crew is (leaving|already) (the area|nearby)|price goes up tomorrow|last spot (this week|today))\b/i,
  noVerifiablePresence: /\b(no website|don'?t have (a website|reviews)|just call my cell|word of mouth only)\b/i,
};

const WEIGHTS = {
  s1_fullPaymentUpfront: 32,
  s2_cashOnly: 16,
  s3_noWrittenEstimate: 24,
  s4_doorToDoorPressure: 20,
  s5_stormChaser: 22,
  s6_insuranceAssignment: 26,
  s7_noLicenseProof: 28,
  s8_riskyPayment: 14,
  s9_unmarkedVehicle: 14,
  s10_permitFeeUpfront: 18,
  s11_urgency: 14,
  s12_noVerifiablePresence: 10,
  compoundBonus: 16,
};

const PATTERN_META = {
  1: { label: "Full payment requested upfront, before work starts", confidence: "high" },
  2: { label: "Cash-only payment insisted on", confidence: "medium" },
  3: { label: "No written estimate or contract offered", confidence: "high" },
  4: { label: "Door-to-door / \"leftover materials\" / today-only pressure", confidence: "medium" },
  5: { label: "Storm-chaser pattern (unsolicited damage inspection after a storm)", confidence: "medium" },
  6: { label: "Pushes you to sign an insurance assignment of benefits immediately", confidence: "high" },
  7: { label: "Deflects or avoids proving license/insurance", confidence: "high" },
  8: { label: "Irreversible/individual payment method requested (Zelle, wire, gift card, crypto)", confidence: "medium" },
  9: { label: "Unmarked vehicle, no company branding", confidence: "low" },
  10: { label: "Permit or inspection fee requested upfront", confidence: "medium" },
  11: { label: "Manufactured urgency to decide immediately", confidence: "medium" },
  12: { label: "No verifiable business presence (no website, no reviews)", confidence: "low" },
};

const NEXT_STEPS = {
  1: "Legitimate contractors typically use milestone payments (deposit, progress, completion) — never pay the full amount before work begins.",
  2: "Cash-only is a red flag mainly because it leaves no paper trail — ask why check, card, or a traceable method isn't accepted.",
  3: "Never proceed without a written estimate and contract, even for small jobs — verbal agreements are hard to enforce if something goes wrong.",
  4: "Don't decide same-day under pressure. Get the pitch in writing and independently verify the company before committing.",
  5: "After a storm, get your own inspection from a company you found yourself — don't rely solely on someone who showed up unsolicited.",
  6: "Never sign an insurance assignment of benefits on the spot. Contact your insurer directly before authorizing anyone to deal with your claim.",
  7: "Ask for their license number directly and verify it yourself via your state's licensing board — don't take their word for it.",
  8: "Only pay through a traceable, reversible method — checks or cards, not Zelle/Venmo/wire/gift cards/crypto to an individual.",
  9: "A legitimate, established contractor usually has a marked vehicle and a verifiable business address.",
  10: "Permits are typically pulled and paid for as part of the project cost, not as a separate upfront fee collected before any paperwork exists.",
  11: "Real availability and pricing don't usually hinge on deciding in the next hour. Take the time to check references.",
  12: "Search independently for reviews, a business license, and a physical address before hiring — no online footprint at all is a real red flag.",
};

const GENERIC_ADVICE = "Regardless of your score: get multiple quotes, verify licensing independently through your state's contractor licensing board, never pay in full upfront, get everything in writing, and be especially cautious with anyone who showed up unsolicited or is pressuring same-day decisions.";

function scanText(text) {
  const t = text || "";
  const hits = {};
  for (const [name, re] of Object.entries(PATTERNS)) {
    hits[name] = re.test(t);
  }
  return hits;
}

function analyzeService(input) {
  const {
    descriptionText,
    claimedLicensed = null,
    providedWrittenEstimate = null,
    paymentRequestedBeforeWorkStarted = null,
    wasUnsolicited = false,
  } = input;

  const fired = new Set();
  const breakdown = [];
  let score = 0;
  const textHits = scanText(descriptionText);

  const structuralFullPayment = paymentRequestedBeforeWorkStarted === true;
  if (structuralFullPayment || textHits.fullPaymentUpfront) {
    fired.add(1);
    score += WEIGHTS.s1_fullPaymentUpfront;
    breakdown.push({ pattern: 1, label: PATTERN_META[1].label, weight: WEIGHTS.s1_fullPaymentUpfront, confidence: "high" });
  }

  if (textHits.cashOnly) {
    fired.add(2);
    score += WEIGHTS.s2_cashOnly;
    breakdown.push({ pattern: 2, label: PATTERN_META[2].label, weight: WEIGHTS.s2_cashOnly, confidence: "medium" });
  }

  const structuralNoEstimate = providedWrittenEstimate === false;
  if (structuralNoEstimate || textHits.noWrittenEstimate) {
    fired.add(3);
    score += WEIGHTS.s3_noWrittenEstimate;
    breakdown.push({ pattern: 3, label: PATTERN_META[3].label, weight: WEIGHTS.s3_noWrittenEstimate, confidence: "high" });
  }

  if (wasUnsolicited || textHits.doorToDoorPressure) {
    fired.add(4);
    score += WEIGHTS.s4_doorToDoorPressure;
    breakdown.push({ pattern: 4, label: PATTERN_META[4].label, weight: WEIGHTS.s4_doorToDoorPressure, confidence: "medium" });
  }

  if (textHits.stormChaser) {
    fired.add(5);
    score += WEIGHTS.s5_stormChaser;
    breakdown.push({ pattern: 5, label: PATTERN_META[5].label, weight: WEIGHTS.s5_stormChaser, confidence: "medium" });
  }

  if (textHits.insuranceAssignment) {
    fired.add(6);
    score += WEIGHTS.s6_insuranceAssignment;
    breakdown.push({ pattern: 6, label: PATTERN_META[6].label, weight: WEIGHTS.s6_insuranceAssignment, confidence: "high" });
  }

  const structuralNoLicense = claimedLicensed === false;
  if (structuralNoLicense || textHits.noLicenseProof) {
    fired.add(7);
    score += WEIGHTS.s7_noLicenseProof;
    breakdown.push({ pattern: 7, label: PATTERN_META[7].label, weight: WEIGHTS.s7_noLicenseProof, confidence: "high" });
  }

  if (textHits.riskyPaymentMethod) {
    fired.add(8);
    score += WEIGHTS.s8_riskyPayment;
    breakdown.push({ pattern: 8, label: PATTERN_META[8].label, weight: WEIGHTS.s8_riskyPayment, confidence: "medium" });
  }

  if (textHits.unmarkedVehicle) {
    fired.add(9);
    score += WEIGHTS.s9_unmarkedVehicle;
    breakdown.push({ pattern: 9, label: PATTERN_META[9].label, weight: WEIGHTS.s9_unmarkedVehicle, confidence: "low" });
  }

  if (textHits.permitFeeUpfront) {
    fired.add(10);
    score += WEIGHTS.s10_permitFeeUpfront;
    breakdown.push({ pattern: 10, label: PATTERN_META[10].label, weight: WEIGHTS.s10_permitFeeUpfront, confidence: "medium" });
  }

  if (textHits.urgency) {
    fired.add(11);
    score += WEIGHTS.s11_urgency;
    breakdown.push({ pattern: 11, label: PATTERN_META[11].label, weight: WEIGHTS.s11_urgency, confidence: "medium" });
  }

  if (textHits.noVerifiablePresence) {
    fired.add(12);
    score += WEIGHTS.s12_noVerifiablePresence;
    breakdown.push({ pattern: 12, label: PATTERN_META[12].label, weight: WEIGHTS.s12_noVerifiablePresence, confidence: "low" });
  }

  // Compounding: full payment demanded upfront AND no license proof together
  // is a materially worse combination than either alone.
  if ((structuralFullPayment || textHits.fullPaymentUpfront) && (structuralNoLicense || textHits.noLicenseProof)) {
    score += WEIGHTS.compoundBonus;
    breakdown.push({ pattern: "compound", label: "full payment upfront + no license proof (compounding)", weight: WEIGHTS.compoundBonus, confidence: "high" });
  }

  score = Math.max(0, Math.min(99, score));

  let level;
  if (score >= 65) level = "high";
  else if (score >= 15) level = "caution";
  else level = "low";

  return {
    level,
    scamScore: score,
    firedPatterns: Array.from(fired).sort((a, b) => a - b),
    breakdown,
  };
}

export { analyzeService, PATTERN_META, NEXT_STEPS, GENERIC_ADVICE };
