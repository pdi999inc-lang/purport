// analyzeRental.js
// Rental fraud detection module for PurPort.
// Implements patterns #1-#15 from purport-rental-fraud-taxonomy-context-pack.md.
// Scored/validated against purport-rental-fraud-fixtures.json (13 cases).

"use strict";

const PATTERNS = {
  applicationFee: /\b(application|app|credit[\s-]?check)\s*fee\b/i,
  urgency: /(several|many|other)\s+(people|applicants|renters)\s+(are\s+)?(asking|interested|looking)|won'?t\s+last|act\s+fast|first\s+come|within\s+\d+\s+hours?/i,
  riskyPaymentMethod: /\b(zelle|venmo|cash\s?app|wire\s?transfer|western\s?union|moneygram|gift\s?card|crypto|bitcoin)\b/i,
  overseasOrUnavailable: /\b(overseas|out\s+of\s+(the\s+)?country|deployed|missionary|relocated|transferred|not\s+(currently\s+)?local)\b.{0,40}\b(can'?t|cannot|unable to)\s+(show|meet|do a tour)|\bcan'?t\s+meet\s+in\s+person\b/i,
  keysByMail: /\b(mail(ing|ed)?|overnight(ing|ed)?|ship(ping|ped)?)\s+(you\s+)?the\s+keys\b/i,
  cashOnlyNoExceptions: /\b(cash|cashier'?s?\s?check)\b.{0,60}\b(no\s+exceptions|only|must)\b|\b(no\s+exceptions|only)\b.{0,60}\b(cash|cashier'?s?\s?check)\b/i,
  fakeEscrowPlatform: /\b(through|via)\s+(tripadvisor|airbnb|booking\.com|expedia|paypal\s+goods)\b|\b(real estate professional department|better business bureau department)\b/i,
  formulaicPhrasing: /\bwill only be given to the (right|correct) person\b|\bmoney is not (the |my )?(primary|main) reason\b|\brecently (transferred|relocated)\b.{0,25}\b(work|job|employment)\b/i,
};

const WEIGHTS = {
  p1_paymentBeforeTour: 30,
  p2_refusesVerification: 22,
  p4_applicationFee: 14,
  p5_urgency: 14,
  p6_riskyPayment: 12,
  p7_overseas: 18,
  p8_keysByMail: 24,
  p10_weakPropertyManager: 6,
  p11_cashOnly: 45,
  p12_fakeEscrow: 22,
  p13_formulaic: 12,
  p14_scriptedRepeat: 26,
  p15_addressPriceMismatch: 35,
  compoundBonus: 18,
};

const PATTERN_META = {
  1: { label: "Payment requested before viewing", confidence: "high" },
  2: { label: "Refuses video call or in-person tour", confidence: "high" },
  3: { label: "Rent is notably below market", confidence: "high" },
  4: { label: "Application/credit-check fee before lease terms shown", confidence: "medium" },
  5: { label: "Manufactured urgency / \"other applicants\"", confidence: "medium" },
  6: { label: "Irreversible/individual payment method requested (Zelle, wire, gift card, crypto)", confidence: "medium" },
  7: { label: "Landlord claims overseas/unavailable and can't show unit", confidence: "medium" },
  8: { label: "Keys/access promised by mail, no lease signing", confidence: "medium" },
  10: { label: "Property-manager claim with no verifiable company name", confidence: "low" },
  11: { label: "Cash/cashier's-check-only payment, no exceptions", confidence: "medium" },
  12: { label: "Fake third-party \"escrow\" platform or invented department", confidence: "medium" },
  13: { label: "Formulaic scam-template phrasing", confidence: "low" },
  14: { label: "Scripted repeat question, ignores your reply", confidence: "medium" },
  15: { label: "Same address listed elsewhere at a different price", confidence: "high" },
};

const NEXT_STEPS = {
  1: "Never send money before you've toured the unit in person or via live video call.",
  2: "Insist on a live video call or in-person tour before proceeding. A real landlord can accommodate this.",
  3: "Below-market rent alone isn't proof of a scam, but verify the listing isn't posted elsewhere at a different price.",
  4: "Don't pay any application or credit-check fee until you've seen lease terms and verified the landlord's identity.",
  5: "Ignore urgency pressure — real vacancies don't disappear in hours. Take your time to verify.",
  6: "Only pay through a traceable, reversible method — never Zelle/Venmo/wire/gift cards/crypto to an individual.",
  7: "Ask for a live video walkthrough right now, showing the interior and exterior matching the listing photos.",
  8: "A lease should always be signed before any keys or access codes are exchanged — refuse a 'keys by mail' arrangement.",
  10: "Ask for the property management company's name and look it up independently (BBB, Google, state licensing).",
  11: "Insisting on untraceable bulk cash or cashier's checks with 'no exceptions' is unusual — ask why other methods aren't accepted.",
  12: "Verify independently whether the named platform actually offers rental deposit protection — most do not.",
  13: "This phrasing alone isn't proof, but combined with other flags above, treat it as reinforcing evidence.",
  14: "If they're not answering your direct questions, that's a real signal — push for a direct answer before proceeding.",
  15: "Search the address independently — if it's listed at a different price elsewhere, ask the contact to explain why.",
};

const GENERIC_ADVICE = "Regardless of your score: never wire money or pay via untraceable methods before seeing a property in person, verify the landlord owns or manages the property via public records when possible, and trust your instincts if something feels rushed or evasive.";

function priceScore(monthlyRent, marketRentMedian) {
  if (!monthlyRent || !marketRentMedian) return { score: 0, ratio: null };
  const ratio = monthlyRent / marketRentMedian;
  let score = 0;
  if (ratio < 0.5) score = 35;
  else if (ratio < 0.7) score = 18;
  else score = 0;
  return { score, ratio };
}

function scanText(listingText) {
  const text = listingText || "";
  const hits = {};
  for (const [name, re] of Object.entries(PATTERNS)) {
    hits[name] = re.test(text);
  }
  return hits;
}

function weakPropertyManagerClaim(landlordClaim) {
  if (!landlordClaim) return false;
  const claim = landlordClaim.toLowerCase();
  const claimsManager = /property manager|manages? (it|the property) for the owner/.test(claim);
  const hasCompanyName = /\b(llc|inc|realty|properties|management co|group)\b/.test(claim);
  return claimsManager && !hasCompanyName;
}

function analyzeRental(input) {
  const {
    monthlyRent,
    marketRentMedian,
    listingText,
    landlordClaim,
    contactOfferedVideoOrInPerson = null,
    paymentRequestedBeforeTour = null,
    scriptedRepeatQuestion = false,
    addressSeenAtDifferentPrice = null,
  } = input;

  const fired = new Set();
  const breakdown = [];
  let score = 0;

  const { score: pScore, ratio } = priceScore(monthlyRent, marketRentMedian);
  if (pScore > 0) {
    fired.add(3);
    score += pScore;
    breakdown.push({ pattern: 3, label: "below-market rent", weight: pScore, ratio, confidence: "high" });
  }

  const textHits = scanText(listingText);

  if (paymentRequestedBeforeTour === true) {
    fired.add(1);
    score += WEIGHTS.p1_paymentBeforeTour;
    breakdown.push({ pattern: 1, label: "payment requested before viewing", weight: WEIGHTS.p1_paymentBeforeTour, confidence: "high" });
  }

  const refusedVerification = contactOfferedVideoOrInPerson === false;
  if (refusedVerification) {
    fired.add(2);
    score += WEIGHTS.p2_refusesVerification;
    breakdown.push({ pattern: 2, label: "refuses video call or in-person tour", weight: WEIGHTS.p2_refusesVerification, confidence: "high" });
  }

  if (textHits.applicationFee) {
    fired.add(4);
    score += WEIGHTS.p4_applicationFee;
    breakdown.push({ pattern: 4, label: "application/credit-check fee before terms shown", weight: WEIGHTS.p4_applicationFee, confidence: "medium" });
  }

  if (textHits.urgency) {
    fired.add(5);
    score += WEIGHTS.p5_urgency;
    breakdown.push({ pattern: 5, label: "manufactured urgency / other applicants", weight: WEIGHTS.p5_urgency, confidence: "medium" });
  }

  if (textHits.riskyPaymentMethod) {
    fired.add(6);
    score += WEIGHTS.p6_riskyPayment;
    breakdown.push({ pattern: 6, label: "irreversible/individual payment method requested", weight: WEIGHTS.p6_riskyPayment, confidence: "medium" });
  }

  if (textHits.overseasOrUnavailable) {
    fired.add(7);
    score += WEIGHTS.p7_overseas;
    breakdown.push({ pattern: 7, label: "landlord claims overseas/unavailable to show unit", weight: WEIGHTS.p7_overseas, confidence: "medium" });
  }

  if (textHits.keysByMail) {
    fired.add(8);
    score += WEIGHTS.p8_keysByMail;
    breakdown.push({ pattern: 8, label: "keys/access promised by mail, no lease signing", weight: WEIGHTS.p8_keysByMail, confidence: "medium" });
  }

  if (weakPropertyManagerClaim(landlordClaim)) {
    fired.add(10);
    score += WEIGHTS.p10_weakPropertyManager;
    breakdown.push({ pattern: 10, label: "property-manager claim with no verifiable company name", weight: WEIGHTS.p10_weakPropertyManager, confidence: "low" });
  }

  if (textHits.cashOnlyNoExceptions) {
    fired.add(11);
    score += WEIGHTS.p11_cashOnly;
    breakdown.push({ pattern: 11, label: "cash/cashier's-check-only payment, no exceptions", weight: WEIGHTS.p11_cashOnly, confidence: "medium" });
  }

  if (textHits.fakeEscrowPlatform) {
    fired.add(12);
    score += WEIGHTS.p12_fakeEscrow;
    breakdown.push({ pattern: 12, label: "fake third-party 'escrow' platform or invented department", weight: WEIGHTS.p12_fakeEscrow, confidence: "medium" });
  }

  if (textHits.formulaicPhrasing) {
    fired.add(13);
    score += WEIGHTS.p13_formulaic;
    breakdown.push({ pattern: 13, label: "formulaic scam-template phrasing", weight: WEIGHTS.p13_formulaic, confidence: "low" });
  }

  if (scriptedRepeatQuestion === true) {
    fired.add(14);
    score += WEIGHTS.p14_scriptedRepeat;
    breakdown.push({ pattern: 14, label: "scripted repeat question, ignores renter's reply", weight: WEIGHTS.p14_scriptedRepeat, confidence: "medium" });
  }

  if (addressSeenAtDifferentPrice) {
    fired.add(15);
    score += WEIGHTS.p15_addressPriceMismatch;
    breakdown.push({
      pattern: 15,
      label: "same address listed elsewhere at $" + addressSeenAtDifferentPrice.otherRent + " on " + addressSeenAtDifferentPrice.otherPlatform,
      weight: WEIGHTS.p15_addressPriceMismatch,
      confidence: "high",
    });
  }

  if (paymentRequestedBeforeTour === true && refusedVerification) {
    score += WEIGHTS.compoundBonus;
    breakdown.push({ pattern: "compound", label: "payment-before-tour + refused verification (compounding)", weight: WEIGHTS.compoundBonus, confidence: "high" });
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

export { analyzeRental, PATTERN_META, NEXT_STEPS, GENERIC_ADVICE };
