# NoDAW AudioRescue — Production Design

**Date:** 2026-08-29  
**Status:** Draft for user review  
**Live today:** https://myaiplug.github.io/nodaw-audiorescue/ (static; payment/intake not configured)  
**Target stack:** Cloudflare Pages + Workers + R2 + Stripe Checkout (free-forever hosting tier)

---

## 1. Problem

The landing page sells a same-night mix rescue but:

- Intake asks for Drive/Dropbox links (friction + off-brand).
- Payment is stubbed (`ORDER_DESTINATION` empty).
- No webhooks, no secure direct upload, no deposit filter.
- “Free preflight” is not a real CoProducer-grade analysis experience.

Serious artists need a clear, secure path: **free local analysis → deposit → upload → human rescue → balance → download**.

---

## 2. Goals

1. **Production-ready money:** Stripe Checkout + verified webhooks; no “trust the client paid.”
2. **Easiest upload:** native file picker on *this* site — no Dropbox/Drive/WeTransfer as the primary path.
3. **Secure uploads:** MP3/WAV only, ≤5:00, size/magic-byte/token gates; free analysis never stores files server-side.
4. **Deposit filter:** half of price to enter the queue; weeds out window shoppers.
5. **Clear value copy:** exhaustive “what you pay for / what you get / what you don’t.”
6. **Free CoProducer analysis:** instant browser report in AudioRescue theme, with two view modes.
7. **Free hosting that doesn’t expire:** Cloudflare free tier (not Railway/Render credits).

### Non-goals (v1)

- Full multitrack / stem mixing product.
- User accounts / dashboards beyond case magic links.
- Server-side full desktop CoProducer Python engine.
- Antivirus SaaS, M4A/FLAC/AIFF support, live chat.
- Paid PDF generation (browser print-to-PDF is enough).

---

## 3. Offer & pricing (locked)

| Item | Amount |
|------|--------|
| Mix Rescue total | **$39** |
| Deposit (enter queue) | **$19.50** |
| Balance (before delivery) | **$19.50** |
| Keep on decline (review fee) | **$5** |
| Refund on decline | **$14.50** |
| Free CoProducer analysis | **$0** (local file only) |

**GTM note:** Brand origin may stay Louisville; promote to spend markets (Atlanta, LA, NYC/Brooklyn, Houston/Dallas) via ads/communities — not as a local-only service.

---

## 4. What users pay for (required on-page copy)

### They are paying for

1. A **reserved rush slot** (same-night when deposit + valid file clear before cutoff).
2. A **human fit decision** — fit / not a fit / re-record — before burning their master.
3. A **focused stereo rescue pass** on the problem holding the song back (vocal focus, low-end relationship, release translation — as needed).
4. **Deliverables after balance:** clean WAV + listening MP3, before/after listen, plain-English release-readiness notes.
5. **Rights retained:** processing + guidance only; they own the song and source files.

### They are not paying for

- Guaranteed streams, sales, playlisting, or commercial success.
- Full multitrack mix, production, songwriting, or album mastering.
- Fixing missing performances, crushed clipped sources, or “any bad recording.”

### Deposit / refund language (must be visible pre-checkout)

- Deposit is **half of $39** to reserve a real slot and filter unserious submissions.
- If the case is **not a fit** after listen: **$5 non-refundable review fee**, **$14.50 refunded**.
- If fit: work proceeds; **$19.50 balance** unlocks delivery downloads.
- Free CoProducer analysis never requires a card; the file stays in the browser.

---

## 5. Architecture (Approach B)

```
Browser (Pages)
  ├─ Free path: File API → validate → Web Audio analyze → report UI (no upload)
  └─ Paid path: Checkout deposit → return → tokenized upload → R2

Cloudflare Worker
  ├─ Stripe Checkout create (deposit / balance)
  ├─ Stripe webhook (signature verify, idempotent)
  ├─ Upload gate (token, magic bytes, size, duration)
  ├─ Signed download URLs (paid_in_full only)
  └─ Ops actions (decline → partial refund; mark rescued)

Cloudflare R2 (private)
  └─ cases/{caseId}/source.(mp3|wav) + rescue assets

Stripe
  └─ Checkout Sessions + Refunds + webhook events

Notify (free)
  └─ Discord webhook primary; Resend email optional add-on
```

### Hosting decision

Move marketing + app from GitHub Pages to **Cloudflare Pages** (Workers on same project). Keeps one origin for cookies/CORS and avoids credit-burn hosts.

---

## 6. Secure upload

### Free analysis

- File never leaves the device.
- Client checks: extension, magic bytes, decode, duration ≤ 5:00, size ≤ 50 MB.
- Reject anything that is not real MP3/WAV.

### Paid upload (only after deposit)

1. Webhook marks case `deposited` → mint **single-use upload token** (TTL ~60 minutes, bound to `caseId`).
2. `POST /api/upload` with token; Worker validates before commit to R2.
3. **Server gates:** extension allowlist, magic bytes (MP3 sync/ID3; WAV `RIFF....WAVE`), max 50 MB, duration ≤ 5:00, sanitized key `cases/{caseId}/source.{ext}`.
4. Failures delete partials; duration fail → `invalid_file` + new token (deposit held).
5. Rate-limit checkout + upload per IP (Workers / KV counters).

### Explicitly rejected

Executables, polyglots failing magic checks, path traversal, unauthenticated uploads, free-tier server storage of unpaid audio.

---

## 7. Free CoProducer report UX

### Views (user toggles after analysis)

1. **Dossier** — verdict-first case file: big score, meter grid, plain-English holds, deposit CTA. Matches AudioRescue landing tone.
2. **Full studio** — mix of dossier + split console + editorial: hero line → waveform/hot zones → severity checklist → full meter appendix → CTA.

Default: **Dossier**. Toggle always available; same underlying measurements.

### Exhaustive metrics (both views)

- Overall health score + plain-English verdict (salvageable / borderline / re-record likely).
- Duration, format, sample rate, channels, estimated bit depth / bitrate.
- Integrated LUFS, short-term / momentary peaks (as browser analysis allows).
- True-peak / sample-peak estimate, clip hit estimate.
- Crest / dynamic range proxy, RMS.
- Stereo width + phase/correlation proxy.
- Band energy balance (sub / low / mid / high) with plain-English notes.
- Streaming translation notes (e.g. hot vs Spotify-style targets) — clearly labeled as guidance, not a guarantee.
- Top findings ranked by severity + recommended next move.
- CTA: Open Mix Rescue · $19.50 deposit.

Visual system: AudioRescue tokens (`--ink`, `--paper`, `--acid`, `--orange`, Space Grotesk + DM Mono, hard edges, noise overlay).

---

## 8. Case lifecycle & webhooks

### States

```
draft → deposited → uploaded → in_review →
  ├─ declined → closed          (refund $14.50, keep $5)
  └─ rescued → balance_due → paid_in_full → delivered → closed

invalid_file (after deposit): re-issue upload token
```

### Stripe webhook handling

| Event | Behavior |
|-------|----------|
| `checkout.session.completed` (deposit) | Persist case `deposited`; mint upload token; notify ops |
| `checkout.session.completed` (balance) | `paid_in_full`; mint signed download URLs |
| `checkout.session.expired` | No token; case remains unpaid |
| `charge.refunded` / `refund.updated` | Sync refund state |

- Verify `Stripe-Signature` on raw body every time.
- Idempotency via stored Stripe `event.id` (KV or D1).
- Checkout metadata always includes `{ type: "deposit"|"balance", caseId }`.

### Operator loop (v1)

Lightweight password-protected `/ops`:

1. List open cases.
2. Signed download of source from R2.
3. **Decline** → Stripe partial refund $14.50 → email artist.
4. Upload rescue assets → mark **Rescued** → email balance Checkout link.
5. After balance paid, artist downloads from success page (links TTL ~72h, regenerable).

### Artist notifications

1. Deposit received + upload instructions.  
2. Declined + refund explanation + free report reminder.  
3. Rescue ready — pay balance to unlock.  
4. Paid — download links.

---

## 9. Landing & intake UX

### Dual CTAs

- **Free CoProducer analysis**
- **Claim rush slot · $19.50 deposit**

### New sections

- **What you’re paying for** (Section 4 copy).
- Updated **How the case moves** (free → deposit → upload → decision → rescue → balance → download).
- FAQ updates: 5-minute cap, MP3/WAV only, deposit/refund math, rights, not full mix.

### Forms

- Free: file picker → analyze → report.
- Paid: name, email, case type (vocal cleanup / full-song rescue), notes → Stripe Checkout → upload dropzone on return URL.
- Remove the Drive/Dropbox link field entirely in v1 (direct upload only).

### Keep

Existing before/after demo, visual identity, scarcity framing (five slots), honest “can’t save any bad recording” FAQ spirit.

---

## 10. Error handling

| Situation | User-facing behavior |
|-----------|----------------------|
| Wrong file type | Clear reject before analyze/upload |
| >5:00 | Reject with length shown |
| >50 MB | Reject with size shown |
| Deposit Checkout cancel | Return to site; no case charge |
| Upload token expired | “Deposit still good — request new upload link” via email/ops |
| Webhook retry | Idempotent; no duplicate emails |
| Decline | Auto partial refund; status email |
| Download before balance | 402/blocked; prompt balance Checkout |
| Worker/R2 outage | Friendly error; ops alert; no silent data loss |

---

## 11. Testing plan

1. Stripe **test mode** end-to-end: deposit → upload → decline refund → separate path balance → download.
2. Upload attack suite: `.exe` renamed `.mp3`, polyglot, oversized, 5:01 file, missing token, reused token.
3. Free analysis: MP3 + WAV under 5:00; reject others; both report views render.
4. Webhook signature fail rejects; replay of same `event.id` is no-op.
5. Mobile + desktop layout for landing, report toggle, upload dropzone.
6. Cutover checklist: live Stripe keys, webhook endpoint URL, R2 bucket private, Discord/Resend secrets in Worker env.

---

## 12. Implementation sketch (post-approval)

1. Scaffold Cloudflare Pages project from current `index.html` + `demo/`.
2. Worker routes: checkout, webhook, upload, download, ops.
3. Wire Stripe products/prices ($19.50 × 2) + webhook secret.
4. Rebuild intake UI + “what you pay for” section.
5. Ship client CoProducer analyzer + Dossier / Full studio report.
6. Test mode validation → live keys → DNS/custom domain optional.
7. Retire GitHub Pages as primary (or redirect to Cloudflare).

---

## 13. Decisions log

| Decision | Choice |
|----------|--------|
| Stack | Cloudflare Pages + Workers + R2 + Stripe |
| Upload philosophy | Free = local only; paid = deposit then R2 |
| Price | $39 total; $19.50 / $19.50 |
| Decline | Keep $5; refund $14.50 |
| Free report | Instant browser CoProducer-style analysis |
| Report UI | Toggle: Dossier vs Full studio (A+B+C mix) |
| Primary markets | ATL / LA / NYC / Houston-type spenders (digital) |

---

## 14. Open items for implementer (not blockers)

- Exact cutoff hour copy (“before 9 PM” vs operator timezone) — keep current same-night language unless changed at implement time.
- Custom domain timing — launch on `*.pages.dev` first; point custom domain when ready.
- Resend artist emails — v1 can ship Discord-to-ops + Stripe receipt emails first; add Resend templates in a fast follow if Discord-only feels thin for artists.
