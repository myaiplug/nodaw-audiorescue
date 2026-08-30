# Production deploy & cutover checklist

Use this checklist to cut Mix Rescue over from GitHub Pages (static-only) to **Cloudflare Pages** with Functions, R2, KV, and Stripe.

Do **not** commit real secret values. Keep KV ids as placeholders until you create the namespaces and paste the real ids.

Project name in `wrangler.toml`: `nodaw-audiorescue`  
Pages output dir: `.` (repo root static assets + `functions/`)

---

## Prerequisites

- Cloudflare account with R2 enabled
- Stripe account (test keys first, then live)
- Discord incoming webhook URL (ops notify; optional but recommended)
- Wrangler authenticated:

```bash
npx wrangler login
```

---

## Step 1 — Create R2 bucket + KV namespace; paste ids into `wrangler.toml`

```bash
npx wrangler r2 bucket create nodaw-audiorescue
npx wrangler kv namespace create CASES
npx wrangler kv namespace create CASES --preview
```

Copy the printed namespace **id** (and preview id) into `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "AUDIO"
bucket_name = "nodaw-audiorescue"

[[kv_namespaces]]
binding = "CASES"
id = "REPLACE_AFTER_CREATE"          # paste production namespace id
preview_id = "REPLACE_AFTER_CREATE"  # paste preview namespace id
```

Leave `REPLACE_AFTER_CREATE` until the create commands succeed — do not invent ids.

Confirm the R2 bucket is **private** (no public access). Audio is served only through signed download routes.

If the Pages project does not exist yet:

```bash
npx wrangler pages project create nodaw-audiorescue
```

Bindings in `wrangler.toml` are applied on Pages deploy for this project. You can also verify **R2 → AUDIO** and **KV → CASES** under the Pages project **Settings → Bindings** in the Cloudflare dashboard.

---

## Step 2 — Stripe live products / prices + webhook

Checkout in this app builds line items with dynamic `price_data` at **$19.50** (1950¢) for both deposit and balance — Dashboard Price IDs are not required for Checkout to work. Still create two live Products (or one Product with two Prices) labeled for ops clarity:

- Mix Rescue deposit — **$19.50** USD
- Mix Rescue balance — **$19.50** USD

Total customer price when both complete: **$39.00**. Decline path (ops): keep **$5.00**, refund **$14.50** of the deposit (handled from ops via Stripe API, not by inventing prices here).

### Webhook endpoint

1. Stripe Dashboard → Developers → Webhooks → Add endpoint
2. URL: `https://<your-pages-host>/api/webhooks/stripe`  
   Example: `https://nodaw-audiorescue.pages.dev/api/webhooks/stripe` (or your custom domain)
3. Events to send:
   - `checkout.session.completed` — **required** (deposit + balance completion)
   - `charge.refunded` — subscribe for Stripe completeness; the Worker currently acknowledges non-`checkout.session.completed` events without mutating case state
4. Copy the signing secret (`whsec_...`) for Step 3 (`STRIPE_WEBHOOK_SECRET`)

Use **test** mode webhook + `sk_test_...` for dry-runs; switch to **live** keys/webhook before real money.

---

## Step 3 — Set Pages secrets

Secrets are **not** in `wrangler.toml`. Set them on the Pages project (prompts for values; do not paste secrets into git):

```bash
npx wrangler pages secret put STRIPE_SECRET_KEY --project-name nodaw-audiorescue
npx wrangler pages secret put STRIPE_WEBHOOK_SECRET --project-name nodaw-audiorescue
npx wrangler pages secret put OPS_PASSWORD --project-name nodaw-audiorescue
npx wrangler pages secret put DISCORD_WEBHOOK_URL --project-name nodaw-audiorescue
npx wrangler pages secret put PUBLIC_BASE_URL --project-name nodaw-audiorescue
```

| Secret | Purpose |
|--------|---------|
| `STRIPE_SECRET_KEY` | `sk_test_...` then `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Endpoint signing secret `whsec_...` |
| `OPS_PASSWORD` | Ops UI / API basic gate (`/ops/`) |
| `DISCORD_WEBHOOK_URL` | Ops notifications (deposit, upload, decline, rescue) |
| `PUBLIC_BASE_URL` | Canonical public origin, **no trailing slash** (e.g. `https://nodaw-audiorescue.pages.dev`) |

Same names are used locally via `.dev.vars` (see [README.md](./README.md)).

---

## Step 4 — Deploy Pages; test-mode then live dry-run

### Deploy

From the repo root (static files + `functions/`):

```bash
npm test
npx wrangler pages deploy . --project-name nodaw-audiorescue
```

Note the deployment URL. Set `PUBLIC_BASE_URL` to that origin (or your custom domain) if it is not already.

### Test-mode path

1. Secrets use Stripe **test** keys + test webhook secret pointing at the deployed URL (or Stripe CLI forward for local).
2. Submit intake → Stripe Checkout **$19.50** deposit → pay with test card `4242…`.
3. Confirm webhook marks case deposited, Discord notify fires, upload link works.
4. Upload MP3/WAV ≤5:00 / ≤50 MB → ops can decline or rescue.
5. Balance Checkout **$19.50** → `thanks.html` + download tokens.

### Live dry-run (real $19.50 + refund)

1. Switch secrets to **live** Stripe keys and live webhook signing secret.
2. Run one real **$19.50** deposit.
3. Verify webhook + upload mint.
4. **Refund** the PaymentIntent/charge in Stripe Dashboard (full refund for the dry-run).
5. Confirm no secrets or customer audio were committed to git; R2 remains private.

---

## Step 5 — Custom domain / retire GitHub Pages as primary

### Option A — Custom domain on Cloudflare Pages (preferred)

Cloudflare Dashboard → Pages → `nodaw-audiorescue` → Custom domains → add your domain and finish DNS.

Set `PUBLIC_BASE_URL` to `https://your.domain` (no trailing slash) and update the Stripe webhook URL to match.

### Option B — Redirect GitHub Pages → Cloudflare

Until DNS is ready, keep https://myaiplug.github.io/nodaw-audiorescue/ as a pointer only:

1. Replace the GitHub Pages `index.html` (on the Pages-publishing branch) with a short meta refresh + canonical/link to the Cloudflare URL, for example:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Mix Rescue moved</title>
  <link rel="canonical" href="https://REPLACE_WITH_PAGES_URL/" />
  <meta http-equiv="refresh" content="0; url=https://REPLACE_WITH_PAGES_URL/" />
  <script>location.replace("https://REPLACE_WITH_PAGES_URL/");</script>
</head>
<body>
  <p>Mix Rescue now lives at <a href="https://REPLACE_WITH_PAGES_URL/">https://REPLACE_WITH_PAGES_URL/</a>.</p>
</body>
</html>
```

2. Do **not** treat GitHub Pages as the app host — it cannot run Functions, R2, or Stripe webhooks.

### After cutover

- [ ] Stripe webhook URL matches production origin
- [ ] `PUBLIC_BASE_URL` matches production origin
- [ ] Marketing / social links point at Cloudflare (or custom domain)
- [ ] GitHub Pages is redirect-only or unpublished

---

## Quick reference

| Item | Value |
|------|--------|
| Pages project | `nodaw-audiorescue` |
| R2 binding | `AUDIO` → bucket `nodaw-audiorescue` |
| KV binding | `CASES` |
| Webhook path | `/api/webhooks/stripe` |
| Ops UI | `/ops/` |
| Deposit / balance | $19.50 each (code constants `DEPOSIT_AMOUNT_CENTS` / `BALANCE_AMOUNT_CENTS`) |

Local development and secret templates: [README.md](./README.md).
