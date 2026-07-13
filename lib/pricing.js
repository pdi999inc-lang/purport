// lib/pricing.js
// Live new/used price lookup via Nimble.
//
// NOTE: Nimble account tiers expose different endpoints. This module posts a
// SERP-style search to NIMBLE_API_URL and parses dollar figures out of the
// result titles/snippets. CONFIRM the endpoint + auth header against your
// Nimble dashboard; adjust `buildRequest` / `readResults` if your account's
// response shape differs. Everything downstream depends only on getPrices().

export async function getPrices(product) {
  const [used, brandNew] = await Promise.all([
    search(`${product} used for sale price`, ["ebay.com"]),
    search(`${product} new price`, null)
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

async function search(query, includeDomains) {
  const key = process.env.NIMBLE_API_KEY;
  const url = process.env.NIMBLE_API_URL || "https://api.webit.live/api/v1/realtime/serp";
  if (!key) throw new Error("NIMBLE_API_KEY is not set");

  const q = includeDomains ? `${query} ${includeDomains.map(d => `site:${d}`).join(" ")}` : query;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${key}`
    },
    body: JSON.stringify({
      query: q,
      parse: true,
      search_engine: "google_search",
      country: "US",
      locale: "en"
    })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Nimble price lookup error ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return readResults(data);
}

// Normalize whatever the account returns into [{title, description, url}]
function readResults(data) {
  const cands =
    data?.parsing?.organic_results ||
    data?.organic_results ||
    data?.results ||
    data?.data?.results ||
    [];
  return cands.map(r => ({
    title: r.title || r.name || "",
    description: r.description || r.snippet || r.content || "",
    url: r.url || r.link || ""
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
