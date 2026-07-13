# PurPort — Marketplace Deal Intelligence

Upload a screenshot of a marketplace listing (Facebook Marketplace, Craigslist, eBay, OfferUp). PurPort:

1. **Identifies** the product + condition + asking price from the screenshot (Anthropic vision).
2. **Prices** it live — new (retail) and used range with comparable listings (Nimble).
3. **Judges** the deal (fair / good / too-good-to-be-true) and scans the listing text for scam patterns.
4. Returns a **scam-probability decision card**.

Built on the VibeLenz risk-analysis engine; PurPort is its marketplace-facing surface.

---

## Architecture

```
public/index.html   → upload UI + decision card
server.js           → Express: POST /api/analyze (screenshot -> verdict)
lib/vision.js       → Anthropic vision: screenshot -> {product, condition, asking, text}
lib/pricing.js      → Nimble: product -> {new, used range, comps}   [CONFIRM endpoint]
lib/analyze.js      → pure logic: deal math + scam scan -> verdict   [unit-tested]
```

The two external calls are isolated in `lib/`. `lib/analyze.js` has no I/O and is covered by `test.mjs`.

---

## Required environment variables

| Var | Purpose | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Screenshot product-ID (vision) | https://console.anthropic.com → API Keys |
| `ANTHROPIC_MODEL` | Vision model (default `claude-sonnet-5`) | Set to a model your account can access |
| `NIMBLE_API_KEY` | Live price lookup | Nimble dashboard → API credentials |
| `NIMBLE_API_URL` | Nimble search endpoint | **Confirm** in your Nimble docs (default is a SERP endpoint) |
| `PORT` | Set automatically by Railway | — |

> ⚠️ **One thing to verify before it prices correctly:** `lib/pricing.js` posts to `NIMBLE_API_URL` with a `Bearer` token and a SERP-style body, then reads results from common response shapes. Nimble account tiers differ. Make one test call from your Nimble dashboard, confirm the endpoint + auth header + response field names, and adjust `search()` / `readResults()` in `lib/pricing.js` if needed. Everything else keys off `getPrices()` and won't change.

---

## Run locally

```bash
cp .env.example .env      # fill in your keys
npm install
npm start                 # http://localhost:3000
npm test                  # runs verdict-logic tests (node test.mjs)
```

---

## Deploy to Railway

### Option A — CLI (fastest)

```bash
npm i -g @railway/cli
railway login
cd purport-app
railway init            # create a new project (name it "purport")
railway up              # builds with Nixpacks, deploys

# set your secrets
railway variables set ANTHROPIC_API_KEY=sk-ant-...
railway variables set ANTHROPIC_MODEL=claude-sonnet-5
railway variables set NIMBLE_API_KEY=...
railway variables set NIMBLE_API_URL=https://<your-nimble-endpoint>

railway up              # redeploy with variables
railway domain          # generates a temporary *.up.railway.app URL to test
```

### Option B — Dashboard

1. Push this folder to a GitHub repo.
2. railway.app → **New Project → Deploy from GitHub repo** → pick the repo.
3. Railway auto-detects Node (Nixpacks) and runs `npm start`. `railway.json` sets the health check to `/healthz`.
4. **Variables** tab → add the four env vars above.
5. Deploy. Open the generated URL and test with a screenshot.

---

## Tie your PurPort domain

You bought the domain (e.g. `purport.app` or `getpurport.com`). In Railway:

1. Project → your service → **Settings → Networking → Custom Domain → Add Domain**.
2. Enter your domain. Railway shows a target value.
   - **Subdomain** (recommended, e.g. `app.purport.app` or `www.purport.app`): Railway gives a **CNAME** target like `xxxx.up.railway.app`.
   - **Root/apex** (`purport.app`): use your registrar's ALIAS/ANAME/flattened-CNAME if supported, or add a CNAME on `www` and redirect the apex to it.
3. At your domain registrar (GoDaddy / Namecheap / Cloudflare / etc.), open DNS and add the record Railway gave you:

   | Type | Name | Value |
   |---|---|---|
   | CNAME | `app` (or `www`) | `xxxx.up.railway.app` |

4. Save. DNS propagates in minutes to a few hours. Railway auto-provisions HTTPS (Let's Encrypt) once it verifies the record — the domain flips to "Active."
5. If using Cloudflare, set the record to **DNS only (grey cloud)** first to let Railway issue the cert, then you can enable proxying.

Test: `https://app.your-purport-domain` → upload a screenshot → verdict.

---

## Cost control (built in)

- **One price lookup per analysis** (used + new = 2 Nimble calls), no broad sweeps.
- Low-confidence product IDs **ask the user to confirm** before spending a pricing call or showing a verdict — this both saves cost and prevents wrong financial signals.
- Consider adding a cache (Railway Redis plugin) keyed by `product` if volume grows — the `getPrices()` boundary is where you'd wrap it.

---

## Known limitations (be honest with users)

- Standard Nimble tier returns a mix of **asking and sold** prices, not pure sold comps — the used range is an approximation. Enterprise tier adds cleaner shopping/sold data.
- Product identification is the weakest link; a wrong model = wrong price. The confirm-on-low-confidence flow mitigates but doesn't eliminate this.
- Not financial advice. The UI tells users to inspect in person and pay on pickup.
