// lib/pricing.js
// Live new/used price lookup via Nimble's current Search API.
//
// FIXED 2026-07-16 (PA-03): this file was previously built against Nimble's
// LEGACY/DEPRECATED Web API (api.webit.live, Basic auth, `search_engine`/
// `parse` params) while sending a Bearer token — a mismatch that meant it
// could never have authenticated correctly. Rewritten against the current
// documented API: POST https://sdk.nimbleway.com/v1/search, Bearer auth,
// `focus`/`search_depth` params, `results[]` response shape.
// Source: https://docs.nimbleway.com/nimble-sdk/web-tools/search
// (`focus: "shopping"` is Nimble's purpose-built product/price-comparison
// mode — used here instead of the previous site:ebay.com query-string hack.)

const SEARCH_URL = "https://sdk.nimbleway.com/v1/search";

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
    search_depth: "lite",
    max_results: 10,
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