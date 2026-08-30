# Mix Rescue (AudioRescue production)

Stereo mix rescue intake: free in-browser CoProducer analysis, **$19.50** deposit → secure MP3/WAV upload → ops decline/rescue → **$19.50** balance → signed downloads.

## Where production lives

| Surface | URL / host |
|---------|------------|
| **Primary (production)** | Cloudflare Pages project `nodaw-audiorescue` (`*.pages.dev` or your custom domain) |
| Legacy static | https://myaiplug.github.io/nodaw-audiorescue/ — **retired as primary**; redirect or unpublish after cutover (see [DEPLOY.md](./DEPLOY.md)) |

GitHub Pages cannot run Pages Functions, R2, KV, or Stripe webhooks. All paid/ops traffic must use the Cloudflare origin.

Full cutover steps (R2/KV, Stripe webhook, secrets, deploy, domain): **[DEPLOY.md](./DEPLOY.md)**.

## Stack

- Cloudflare Pages + Functions (`functions/`)
- R2 (`AUDIO`) for source / deliverables
- KV (`CASES`) for case records + one-time tokens
- Stripe Checkout + webhook (`/api/webhooks/stripe`)

## Local development

Requirements: Node.js 18+, npm, Cloudflare Wrangler (devDependency).

```bash
npm install
cp .dev.vars.example .dev.vars
# Edit .dev.vars with test Stripe keys, ops password, etc. Never commit .dev.vars.
npm test
npx wrangler pages dev .
```

Default local origin: `http://localhost:8788`. Keep `PUBLIC_BASE_URL` in `.dev.vars` aligned with that (no trailing slash).

`.dev.vars.example` lists:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `OPS_PASSWORD`
- `DISCORD_WEBHOOK_URL`
- `PUBLIC_BASE_URL`

For Stripe webhooks against local Functions, use the [Stripe CLI](https://stripe.com/docs/stripe-cli) to forward `checkout.session.completed` to `http://localhost:8788/api/webhooks/stripe`.

### Useful paths

| Path | Role |
|------|------|
| `/` | Landing + intake |
| `/analyze.html` | Free CoProducer report |
| `/upload.html` | Post-deposit upload |
| `/ops/` | Operator UI (password-gated) |
| `/thanks.html` | Post-balance thank-you / downloads |
| `POST /api/checkout/deposit` | Start deposit Checkout |
| `POST /api/webhooks/stripe` | Stripe webhook |

## Deploy

See [DEPLOY.md](./DEPLOY.md). Short version:

```bash
npm test
npx wrangler pages deploy . --project-name nodaw-audiorescue
```

Secrets are set with `npx wrangler pages secret put <NAME> --project-name nodaw-audiorescue` (not committed).

## License / notes

Ops and customer audio stay off git. R2 buckets must remain private.
