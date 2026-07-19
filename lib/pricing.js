// lib/pricing.js
// Live new/used price lookup via Nimble's current Search API.
//
// FIXED 2026-07-16 (PA-03): this file was previously built against Nimble's
// LEGACY/DEPRECATED Web API (api.webit.live, Basic auth, `search_engine`/
// `parse` params) while sending a Bearer token — a mismatch that meant it
// could never have authenticated correctly. Rewritten against the current
// documented API: POST https://sdk.nimbleway.com/v1/search, Bearer auth,
// `focus`/`search_depth` params, `results[]` response shape.
//
// UPDATED 2026-07-19: search_depth was "lite", which returns empty
// description/content fields (titles only) — confirmed via live Railway
// logs against a real query, not assumed. No price text exists anywhere in
// "lite" results, so parsePrices() had nothing to extract regardless of
// regex quality. Switched to "deep" (full real-time page extraction),
// which costs 1 + 1 credit per page instead of 1 credit flat. max_results
// dropped from 10 to 3 to control credit burn on a limited free-trial
// budget — this trades comp sample size for affordability. Tune
// NIMBLE_MAX_RESULTS via env var if you want to raise it once budget allows.
//
// STILL OPEN, NOT FIXED HERE: include_domains: ["ebay.com"] on the "used"
// query is not actually restricting results to eBay — live logs show
// Amazon/Lowe's results coming back even with that filter set on the used
// query. Spec (§9) wants eBay sold/completed comps specifically for used
// pricing. Needs separate investigation — may be that focus:"shopping"
// routes to a fixed set of retail subagents regardless of include_domains.
//
// Source: https://docs.nimbleway.com/nimble-sdk/web-tools/search

const SEARCH_URL = "https://sdk.nimbleway.com/v1/search";
const MAX_RESULTS = Number(process.env.NIMBLE_MAX_RESULTS) || 3;

export async function getPrices(product) {
  const [used, brandNew] = await Promise.all([
    search(`${product} used for sale price`, { includeDomains: ["ebay.com"] }),
    search(`${product} new price`, {})
  ]);

  const usedPrices = collectPrices(used).filter(n => n >= 10);
  const newPrices = collectPrices(brandNew);

  return {
    usedLow: usedPrices.length ? Math.min(...usedPrices) : null,
    usedHigh: usedPrices.length ? Math.max(...usedPrices) : null,
    usedMedian: median(usedPrices),
    usedSample: usedPrices.length,
    newPrice: newPrices.length ? Math.max(...newPrices) : null,
    comps: used.slice(0, 6).map(r => ({
      title: r.title || r.url,
      url: r.url,
      price: minPrice(r)
    })).filter(c => c.price != null)
  };
}

async function search(query, { includeDomains } = {}) {
  const key = process.env.NIMBLE_API_KEY;
  if (!key) throw new Error("NIMBLE_API_KEY is not set");

  const body = {
    query,
    focus: "shopping",
    search_depth: "deep",
    max_results: MAX_RESULTS,
    country: "US",
    locale: "en"
  };
  if (includeDomains) body.include_domains = includeDomains;

  const res = await fetch(SEARCH_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${key}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Nimble price lookup error ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  console.log(`[NIMBLE DEBUG] query="${query}" raw response:`, JSON.stringify(data).slice(0, 3000));
  return readResults(data);
}

// Current API response shape: { total_results, results: [{title, description, url, metadata}], request_id }
function readResults(data) {
  const rows = data?.results || [];
  return rows.map(r => ({
    title: r.title || "",
    description: r.description || r.content || "",
    url: r.url || ""
  }));
}

function collectPrices(rows) {
  let all = [];
  for (const r of rows) all = all.concat(parsePrices(`${r.description} ${r.title}`));
  return all;
}
function minPrice(r) {
  const ps = parsePrices(`${r.description} ${r.title}`);
  return ps.length ? Math.min(...ps) : null;
}
function parsePrices(text) {
  const out = [];
  const re = /\$\s?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]{2,5}(?:\.[0-9]{1,2})?)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (n >= 5 && n <= 50000) out.push(n);
  }
  return out;
}
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2);
}