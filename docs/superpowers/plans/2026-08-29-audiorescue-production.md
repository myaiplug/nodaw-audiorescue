# AudioRescue Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship production Mix Rescue on Cloudflare with Stripe deposit/balance webhooks, secure MP3/WAV upload (≤5 min), free in-browser CoProducer report (Dossier / Full studio), and clear money copy.

**Architecture:** Static AudioRescue UI on Cloudflare Pages; Pages Functions (Workers) for Stripe Checkout, signed webhooks, tokenized R2 uploads, ops actions, and signed downloads. Free CoProducer analysis runs entirely in the browser (file never uploaded). Paid path requires $19.50 deposit before R2 storage.

**Tech Stack:** Cloudflare Pages + Functions, R2, KV (idempotency + tokens), Stripe Checkout + webhooks, vanilla JS (match existing `index.html`), Vitest for shared validation/unit tests, Wrangler for local/dev.

**Spec:** `docs/superpowers/specs/2026-08-29-audiorescue-production-design.md`

## Global Constraints

- Price: total **$39**; deposit **$19.50** (1950¢); balance **$19.50** (1950¢); decline keep **$5** (500¢), refund **$14.50** (1450¢).
- Uploads: **MP3/WAV only**, **≤5:00**, **≤50 MB**; magic-byte checks server-side; free analysis never hits R2.
- Visual system: existing AudioRescue tokens (`--ink #0b0c0c`, `--paper #e7e2d8`, `--acid #d8ff35`, `--orange #ff5c1b`, Space Grotesk + DM Mono).
- No Drive/Dropbox link field in v1.
- Free forever hosting: Cloudflare free tier only (no Railway/Render credit hosts).
- Notify: Discord webhook primary for ops; Stripe emails cover receipts.
- Never trust client “I paid”; only webhook + signed tokens unlock upload/download.

## File map

| Path | Responsibility |
|------|----------------|
| `wrangler.toml` | Pages/Functions config, R2 + KV bindings, vars |
| `package.json` | Scripts, `stripe`, `vitest`, `@cloudflare/workers-types` |
| `.dev.vars.example` | Local secrets template (never commit real secrets) |
| `functions/_middleware.ts` | CORS/security headers for `/api/*` |
| `functions/api/checkout/deposit.ts` | Create deposit Checkout Session |
| `functions/api/checkout/balance.ts` | Create balance Checkout (ops/authenticated) |
| `functions/api/webhooks/stripe.ts` | Verify + handle Stripe events |
| `functions/api/upload.ts` | Tokenized MP3/WAV → R2 |
| `functions/api/download.ts` | Signed download after `paid_in_full` |
| `functions/api/ops/cases.ts` | List/update cases (decline, rescued) |
| `functions/lib/env.ts` | Typed env bindings |
| `functions/lib/cases.ts` | Case record CRUD in KV |
| `functions/lib/tokens.ts` | One-time upload/download tokens |
| `functions/lib/audioValidate.ts` | Magic bytes, size, duration helpers |
| `functions/lib/stripe.ts` | Stripe client helpers |
| `functions/lib/discord.ts` | Ops notify |
| `js/audioValidate.js` | Client twin of validation (UX) |
| `js/analyze.js` | Web Audio analysis → metrics object |
| `js/report.js` | Dossier + Full studio render + toggle |
| `js/intake.js` | Free + paid intake flows |
| `index.html` | Landing, money copy, CTAs, wire scripts |
| `analyze.html` | Free analysis dropzone + report host (or section in index) |
| `upload.html` | Post-deposit upload dropzone |
| `thanks.html` | Post-checkout states |
| `ops/index.html` | Minimal password-gated ops UI |
| `tests/audioValidate.test.ts` | Shared validation tests |
| `tests/tokens.test.ts` | Token mint/burn tests (logic) |

---

### Task 1: Scaffold Cloudflare project + validation library

**Files:**
- Create: `package.json`, `wrangler.toml`, `.dev.vars.example`, `functions/lib/env.ts`, `functions/lib/audioValidate.ts`, `js/audioValidate.js`, `tests/audioValidate.test.ts`
- Modify: `.gitignore` (already ignores `.wrangler`, `.dev.vars`, `.env*`)

**Interfaces:**
- Produces: `validateAudioHeaders(buf: ArrayBuffer, filename: string): { ok: true, format: 'mp3'|'wav', size: number } | { ok: false, error: string }`
- Produces: `MAX_BYTES = 50 * 1024 * 1024`, `MAX_SECONDS = 300`

- [ ] **Step 1: Write failing validation tests**

Create `tests/audioValidate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateAudioHeaders, MAX_BYTES } from '../functions/lib/audioValidate';

function wavHeader(dataBytes = 100): ArrayBuffer {
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const enc = new TextEncoder();
  enc.encodeInto('RIFF', new Uint8Array(buf, 0, 4));
  v.setUint32(4, 36 + dataBytes, true);
  enc.encodeInto('WAVE', new Uint8Array(buf, 8, 4));
  enc.encodeInto('fmt ', new Uint8Array(buf, 12, 4));
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, 44100, true);
  v.setUint32(28, 44100 * 2 * 2, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  enc.encodeInto('data', new Uint8Array(buf, 36, 4));
  v.setUint32(40, dataBytes, true);
  return buf;
}

describe('validateAudioHeaders', () => {
  it('accepts WAV magic', () => {
    const r = validateAudioHeaders(wavHeader(), 'mix.wav');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.format).toBe('wav');
  });

  it('rejects exe renamed as mp3', () => {
    const bytes = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]); // MZ
    const r = validateAudioHeaders(bytes.buffer, 'hack.mp3');
    expect(r.ok).toBe(false);
  });

  it('rejects oversized', () => {
    const big = new ArrayBuffer(MAX_BYTES + 1);
    const r = validateAudioHeaders(big, 'big.wav');
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — expect fail**

```bash
npm init -y
npm install -D vitest typescript @cloudflare/workers-types wrangler
npx vitest run tests/audioValidate.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement `functions/lib/audioValidate.ts` + mirror `js/audioValidate.js`**

```ts
export const MAX_BYTES = 50 * 1024 * 1024;
export const MAX_SECONDS = 300;

export function validateAudioHeaders(buf: ArrayBuffer, filename: string) {
  if (buf.byteLength > MAX_BYTES) return { ok: false as const, error: 'File exceeds 50 MB limit.' };
  const name = filename.toLowerCase();
  const u8 = new Uint8Array(buf);
  const isWav = name.endsWith('.wav') && u8[0]===0x52 && u8[1]===0x49 && u8[2]===0x46 && u8[3]===0x46
    && u8[8]===0x57 && u8[9]===0x41 && u8[10]===0x56 && u8[11]===0x45;
  const isMp3 = name.endsWith('.mp3') && (
    (u8[0]===0x49 && u8[1]===0x44 && u8[2]===0x33) || // ID3
    (u8[0]===0xff && (u8[1] & 0xe0) === 0xe0) // frame sync
  );
  if (isWav) return { ok: true as const, format: 'wav' as const, size: buf.byteLength };
  if (isMp3) return { ok: true as const, format: 'mp3' as const, size: buf.byteLength };
  return { ok: false as const, error: 'Only real MP3 or WAV files are allowed.' };
}
```

Export the same logic from `js/audioValidate.js` as ESM for the browser.

- [ ] **Step 4: Add `wrangler.toml` + `.dev.vars.example`**

```toml
name = "nodaw-audiorescue"
compatibility_date = "2026-08-01"
pages_build_output_dir = "."

[[r2_buckets]]
binding = "AUDIO"
bucket_name = "nodaw-audiorescue"

[[kv_namespaces]]
binding = "CASES"
id = "REPLACE_AFTER_CREATE"
preview_id = "REPLACE_AFTER_CREATE"
```

`.dev.vars.example`:

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
OPS_PASSWORD=change-me
DISCORD_WEBHOOK_URL=
PUBLIC_BASE_URL=http://localhost:8788
```

- [ ] **Step 5: Re-run tests — expect pass; commit**

```bash
npx vitest run tests/audioValidate.test.ts
git add package.json package-lock.json wrangler.toml .dev.vars.example functions/lib/audioValidate.ts js/audioValidate.js tests/audioValidate.test.ts
git commit -m "chore: scaffold CF project and audio header validation"
```

---

### Task 2: Case store + one-time tokens

**Files:**
- Create: `functions/lib/cases.ts`, `functions/lib/tokens.ts`, `functions/lib/env.ts`, `tests/tokens.test.ts`

**Interfaces:**
- Produces: `CaseRecord` type with fields: `id`, `email`, `name`, `notes`, `service`, `status`, `stripeDepositPi`, `stripeBalancePi`, `createdAt`, `r2Key?`
- Produces: `mintToken(kv, kind, caseId, ttlSec) → string`, `consumeToken(kv, kind, token) → caseId | null`
- Status union: `draft|deposited|uploaded|in_review|declined|rescued|balance_due|paid_in_full|delivered|invalid_file|closed`

- [ ] **Step 1: Write token tests**

```ts
import { describe, it, expect } from 'vitest';
import { mintTokenLogic, consumeTokenLogic } from '../functions/lib/tokens';

describe('tokens', () => {
  it('mints and consumes once', () => {
    const store = new Map<string, string>();
    const token = mintTokenLogic(store, 'upload', 'case_1', 3600);
    expect(consumeTokenLogic(store, 'upload', token)).toBe('case_1');
    expect(consumeTokenLogic(store, 'upload', token)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect fail; implement map-backed logic + KV wrappers; re-run; commit**

```bash
npx vitest run tests/tokens.test.ts
git add functions/lib/cases.ts functions/lib/tokens.ts functions/lib/env.ts tests/tokens.test.ts
git commit -m "feat: case records and one-time upload tokens"
```

Implementation notes:
- KV key `case:{id}` → JSON `CaseRecord`
- KV key `tok:upload:{token}` → `caseId` with expirationTtl
- `crypto.randomUUID()` for case ids; `crypto.getRandomValues` for tokens (32 bytes hex)

---

### Task 3: Stripe deposit Checkout + webhook

**Files:**
- Create: `functions/lib/stripe.ts`, `functions/lib/discord.ts`, `functions/api/checkout/deposit.ts`, `functions/api/webhooks/stripe.ts`
- Modify: `wrangler.toml` (ensure Functions work with Pages)

**Interfaces:**
- `POST /api/checkout/deposit` body: `{ name, email, notes, service }` → `{ url: string, caseId: string }`
- Webhook handles `checkout.session.completed` where `metadata.type === 'deposit'` → status `deposited`, mint upload token, Discord notify with upload URL
- Amounts: `unit_amount: 1950`, currency `usd`

- [ ] **Step 1: Implement Stripe helper**

```ts
// functions/lib/stripe.ts
export async function stripeForm(secret: string, path: string, body: Record<string, string>) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
```

- [ ] **Step 2: Implement deposit endpoint**

`functions/api/checkout/deposit.ts` — onRequestPost:
1. Parse JSON; validate email/name lengths.
2. Create `CaseRecord` status `draft` in KV.
3. `checkout/sessions` with `mode=payment`, line item $19.50, `success_url={PUBLIC_BASE_URL}/upload.html?case={id}&session_id={CHECKOUT_SESSION_ID}`, `cancel_url=.../`, metadata `type=deposit&caseId=...`, `customer_email`.
4. Return `{ url, caseId }`.

- [ ] **Step 3: Implement webhook with signature verify**

Use Stripe’s scheme: HMAC SHA256 of `timestamp.payload` with `STRIPE_WEBHOOK_SECRET`; reject if skew > 300s.

On deposit completed:
1. Idempotency: if `event:{event.id}` exists in KV, return 200.
2. Load case; set `deposited`, store PaymentIntent id.
3. Mint upload token; store on case or only in KV tok.
4. Discord: `New deposit {caseId} {email} — upload token minted`.
5. Put `event:{id}` = `1` with long TTL.

- [ ] **Step 4: Local smoke with Stripe CLI**

```bash
npx wrangler pages dev . --compatibility-date=2026-08-01
stripe listen --forward-to localhost:8788/api/webhooks/stripe
stripe trigger checkout.session.completed
```

Expected: webhook 200; case moves to deposited when metadata present (may need a real test Checkout for full path).

- [ ] **Step 5: Commit**

```bash
git add functions/
git commit -m "feat: Stripe deposit checkout and signed webhook"
```

---

### Task 4: Secure upload to R2 + duration gate

**Files:**
- Create: `functions/api/upload.ts`, `upload.html`, `js/upload.js`
- Modify: `functions/lib/audioValidate.ts` (add WAV duration estimate from header `byteRate` / data size; MP3 duration via optional client-sent `durationSec` double-check + server max size)

**Interfaces:**
- `POST /api/upload` headers: `Authorization: Bearer {uploadToken}` or form field `token`
- Body: multipart file
- On success: R2 `cases/{caseId}/source.{mp3|wav}`, status `uploaded`, burn token
- Client must also send `durationSec` from Web Audio decode; reject if `> 300`

- [ ] **Step 1: Write upload.html dropzone (AudioRescue styled)**

Single file input accept `.mp3,.wav,audio/mpeg,audio/wav`; show validation errors; on success show “Case in queue.”

- [ ] **Step 2: Implement `/api/upload`**

1. Resolve token → caseId; require status `deposited` or `invalid_file`.
2. Read file bytes; `validateAudioHeaders`.
3. If `durationSec > 300` → 400.
4. `env.AUDIO.put(key, bytes, { httpMetadata: { contentType } })`.
5. Update case `uploaded`, `r2Key`; consume token.
6. Discord notify “file uploaded”.

- [ ] **Step 3: Manual test with a short WAV fixture + fake deposited case in KV; commit**

```bash
git add functions/api/upload.ts upload.html js/upload.js
git commit -m "feat: tokenized MP3/WAV upload to R2"
```

---

### Task 5: Free CoProducer analyzer + dual report views

**Files:**
- Create: `js/analyze.js`, `js/report.js`, `analyze.html` (or `#analyze` section)
- Modify: `index.html` (CTA → analyze)

**Interfaces:**
- `analyzeFile(file: File) → Promise<AnalysisResult>`
- `AnalysisResult`: `{ score, verdict, duration, format, sampleRate, channels, lufsEst, peak, clipEstimate, crest, width, phase, bands:{sub,low,mid,high}, findings:[{severity,title,detail}], nextMove }`
- `renderReport(root, result, view: 'dossier'|'studio')`

- [ ] **Step 1: Implement client validation + decode in `analyze.js`**

Use `AudioContext.decodeAudioData`; reject duration > 300; compute:
- peak = max abs sample
- clipEstimate = count of |s| >= 0.99
- RMS / crest
- crude LUFS-like integrated estimate from mean square (label as estimate)
- band energies via filtered time-domain or Analyser FFT averages
- stereo mid/side width + correlation if 2ch
- score 0–100 heuristic from peak/clips/crest/balance
- verdict strings matching lab tone

- [ ] **Step 2: Implement `report.js` views**

- Dossier: score, verdict chip, meter grid, findings list, CTA button `data-open-deposit`
- Full studio: editorial headline, waveform canvas hot zones, severity checklist, meter appendix, same CTA
- Toggle control persists `localStorage.nodawReportView`

- [ ] **Step 3: Wire `analyze.html` + landing CTA; browser-verify with a ≤5 min MP3/WAV; commit**

```bash
git add js/analyze.js js/report.js analyze.html index.html
git commit -m "feat: free CoProducer browser analysis with Dossier/Studio views"
```

---

### Task 6: Landing money copy + paid intake

**Files:**
- Modify: `index.html`, create `js/intake.js`

- [ ] **Step 1: Replace modal form**

Remove Drive link field. Fields: name, email, service (`Rush vocal cleanup` / `Rush full-song rescue`), notes. Submit → `POST /api/checkout/deposit` → redirect to Stripe `url`.

- [ ] **Step 2: Add “What you’re paying for” section**

Exact content from spec §4: deposit/balance/decline table; deliverables; exclusions; free analysis note.

- [ ] **Step 3: Dual hero CTAs**

`Free CoProducer analysis` → `/analyze.html`  
`Claim rush slot · $19.50 deposit` → open paid modal

- [ ] **Step 4: Update FAQ** for 5-min limit, MP3/WAV only, $5 review fee / $14.50 refund, rights, not full mix.

- [ ] **Step 5: Visual QA desktop+mobile; commit**

```bash
git add index.html js/intake.js
git commit -m "feat: production intake and transparent pricing copy"
```

---

### Task 7: Ops decline / rescued + balance Checkout + download

**Files:**
- Create: `functions/api/ops/cases.ts`, `functions/api/checkout/balance.ts`, `functions/api/download.ts`, `ops/index.html`, `thanks.html`
- Modify: `functions/api/webhooks/stripe.ts` (handle balance completion)

**Interfaces:**
- Ops auth: `Authorization: Bearer {OPS_PASSWORD}` or cookie set by ops login form
- `POST /api/ops/cases` actions: `list` | `decline` | `mark_rescued` (with optional multipart rescue files)
- Decline: Stripe refund `amount=1450` on deposit PI; status `declined`; Discord + note
- `mark_rescued`: put rescue objects in R2; status `balance_due`; create balance Checkout link; Discord
- Balance webhook → `paid_in_full`; mint download tokens for source/rescue/notes
- `GET /api/download?token=` streams from R2 if token valid

- [ ] **Step 1: Implement decline refund via Stripe API**

```ts
await stripeForm(secret, `refunds`, {
  payment_intent: case.stripeDepositPi,
  amount: '1450',
  reason: 'requested_by_customer',
  'metadata[caseId]': case.id,
  'metadata[reason]': 'not_a_fit_review_fee_kept',
});
```

- [ ] **Step 2: Balance Checkout ($19.50)** metadata `type=balance`; success → `/thanks.html?case=`

- [ ] **Step 3: Download endpoint burns/respects TTL tokens; only `paid_in_full`/`delivered`

- [ ] **Step 4: Build minimal ops UI list + buttons; test mode full path; commit**

```bash
git add functions/api/ops functions/api/checkout/balance.ts functions/api/download.ts ops thanks.html functions/api/webhooks/stripe.ts
git commit -m "feat: ops decline/rescue, balance checkout, signed downloads"
```

---

### Task 8: Production cutover checklist

**Files:**
- Create: `DEPLOY.md`
- Modify: GitHub Pages README note / redirect instructions

- [ ] **Step 1: Create R2 bucket + KV namespace; paste ids into `wrangler.toml`**

```bash
npx wrangler r2 bucket create nodaw-audiorescue
npx wrangler kv namespace create CASES
```

- [ ] **Step 2: Stripe live products/prices $19.50×2; webhook endpoint `https://<pages>/api/webhooks/stripe` events: `checkout.session.completed`, `charge.refunded`**

- [ ] **Step 3: Set Worker secrets**

```bash
npx wrangler pages secret put STRIPE_SECRET_KEY
npx wrangler pages secret put STRIPE_WEBHOOK_SECRET
npx wrangler pages secret put OPS_PASSWORD
npx wrangler pages secret put DISCORD_WEBHOOK_URL
npx wrangler pages secret put PUBLIC_BASE_URL
```

- [ ] **Step 4: Deploy Pages; run test-mode then live $19.50 deposit dry-run with refund**

- [ ] **Step 5: Point custom domain or update GitHub Pages with meta refresh/canonical to Cloudflare URL; commit DEPLOY.md**

```bash
git add DEPLOY.md README.md
git commit -m "docs: production deploy and cutover checklist"
```

---

## Plan self-review

| Spec requirement | Task |
|------------------|------|
| Cloudflare Pages/Workers/R2 | 1, 8 |
| Stripe deposit + webhooks | 3 |
| Secure MP3/WAV ≤5 min upload | 1, 4 |
| Free in-browser CoProducer + dual views | 5 |
| Money copy / no Drive link | 6 |
| Decline $5 keep / $14.50 refund | 7 |
| Balance before delivery + downloads | 7 |
| Ops notify Discord | 3, 7 |
| Testing / cutover | 4, 7, 8 |

No TBD placeholders. Amounts and statuses consistent across tasks (`1950` / `1450` / `500` keep implied by partial refund).
