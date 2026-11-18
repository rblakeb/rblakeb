# Video Chat

Random 1-on-1 video chat where people pick **why** they're here (Just Chat, Music & DJ,
Gaming, Language Exchange, Adult 18+) and only get matched with people who picked the same thing.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # matchmaking + access rules
npm run typecheck
```

Open two browser windows (one in private/incognito) to match with yourself.

### Database

Postgres. Set `DATABASE_URL` (e.g. Supabase's connection string) and the server applies
`server/migrations/*.sql` on startup. Without it, dev runs an embedded Postgres (PGlite)
that keeps its data in `.data/`; delete that folder to start fresh. Tests use a fresh
in-memory database per file. `DATABASE_URL` is required when `NODE_ENV=production`.

Tables: `users` (session tokens stored hashed), `credit_lots` (one row per purchase; the
payment reference is the primary key, so a retried webhook can't double-credit),
`refunds` (every attempt; `succeeded` is null while in flight, so nulls left after a crash
need checking by hand), `reports`, and `settings` (holds `sales_closed`).

Users with an open WebSocket are cached in memory for signaling. That assumes a single
server process; running several needs a shared channel (e.g. Postgres LISTEN/NOTIFY or Redis).

The production database is the Supabase project `video-chat` (ref `ovvsbsuwvvtfyynbhfgn`,
us-east-1), with migrations 001 and 002 already applied. Use its **session pooler**
connection string (Project Settings → Database → Connect) as `DATABASE_URL`. Migration 002
turns on row level security with no policies, which blocks Supabase's public REST API from
these tables; the server connects as the database owner and isn't affected. Keep it that way
for any new table.

### Calls and the media server

With `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` set, every match gets its own
LiveKit room (`server/src/media.ts`) and both browsers send their audio and video through it
instead of directly to each other. That's what makes calls monitorable and lets the server
cut them: `POST /admin/end-call` with `{"userId": "...", "ban": true|false}` and header
`x-admin-token` closes the room for both sides at once. Rooms close themselves when a call
ends. These settings are required in production; without them (dev only) calls are
peer-to-peer. For local testing:

```bash
docker run --rm --network host livekit/livekit-server --dev --bind 0.0.0.0
LIVEKIT_URL=ws://localhost:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret npm run dev
```

In production use LiveKit Cloud or a self-hosted LiveKit with TLS (`wss://`); it includes
TURN, so calls connect on mobile networks without a separate TURN server.

In dev mode, age verification and payments go to mock pages (`public/dev/`) where you
choose the outcome. Those routes are disabled when `NODE_ENV=production`.

## AI companions (prototype)

`/companion.html` is a video call with an AI character instead of a person. The user's speech
is turned into text by the browser (Web Speech API, Chrome/Edge), a still from their camera
goes with each turn, and the character's reply streams back and is spoken by the browser's
voice while an animated face (`public/avatar.js`) lip-syncs.

- Characters: **Lucía**, a language tutor (Spanish, French, German, Italian, Portuguese,
  Japanese) and **Jay**, a music buddy. Personas and shared rules are in
  `server/src/companion.ts`.
- The brain is Claude (`claude-opus-5-5`, low effort for fast replies, streaming, with
  server-side refusal fallback enabled). Set `ANTHROPIC_API_KEY`; without it, characters
  answer in test mode with canned replies so the call loop can still be tried.
- Every character says it's an AI if asked, the page shows a permanent "You're talking to an
  AI" badge, and the shared rules route self-harm talk to 988, for AI companion laws.
- Only the newest camera frame is sent each turn; frames are never stored. Conversations
  live in memory and expire after 30 minutes idle.
- The flirty/adult companion is not served here: Claude's usage policies don't allow sexual
  content, so it needs its own model stack.
- Prototype limits: browser voices and speech recognition vary by browser (Safari/Firefox
  users can type), the face is a drawing rather than a realistic avatar, Jay can't hear
  instruments (only words and the camera), and calls aren't billed yet.

## How it works

| Piece | File |
|---|---|
| Intents and adult pricing | `server/src/config.ts` |
| Who can enter which room | `server/src/access.ts` |
| Matching (per-intent queues, language filter that widens after 10s, shared-tag ranking, no instant re-pairs) | `server/src/matchmaker.ts` |
| WebSocket signaling, skip, report, chat | `server/src/signaling.ts` |
| Age verification hook | `server/src/verification.ts` |
| Credits: buying packs and spending them on 24h access | `server/src/billing.ts` |
| Front end (vanilla JS + WebRTC) | `public/app.js` |
| On-device nudity blur for non-adult rooms (NSFWJS) | `public/moderation.js` |

### SEO

`server/src/seo.ts` serves one landing page per room (`/random-video-chat`,
`/music-video-chat`, `/gaming-video-chat`, `/language-exchange-video-chat`,
`/adult-video-chat`), each with its own title, description, canonical link, social
preview tags and FAQ structured data, plus `robots.txt` and `sitemap.xml`. Their "Start"
buttons open the app with that room selected (`/?intent=music`). The adult page is marked
`rating=adult` so search engines can filter it without flagging the rest of the site.
Set `SITE_URL` and `SITE_NAME` in production; edit page copy in `LANDING_PAGES`.

### Legal pages

`legal/terms.md`, `legal/privacy.md` and `legal/content-policy.md` are served at `/terms`,
`/privacy` and `/content-policy` and linked from the footer and sign-up. They're drafts for
counsel: while a file still contains "DRAFT for attorney review" its page is marked
`noindex` and left out of the sitemap. Open questions for counsel are in
`legal/NOTES-FOR-COUNSEL.md`. Pages are read at startup, so restart after editing.

### Mobile app (PWA)

The site installs to the home screen as an app: `public/manifest.webmanifest`, icons in
`public/icons/`, and `public/sw.js`, which caches the app shell (never API calls,
signaling, payments or verification). Chrome and Android show an "Install app" button;
iOS Safari shows a one-time hint to use Share → Add to Home Screen. Bump `CACHE` in
`sw.js` when changing which files are cached. App stores don't allow adult content, so
this is the mobile route. Installing requires HTTPS (or localhost).

### Adult access rules

- Every user needs `verifiedAdult = true`, set only by the verification vendor's result.
  We store the flag, the vendor's reference ID and the sex on the ID. No ID images.
- Users whose verified ID says `F` get in free. Everyone else spends 1 credit for 24 hours.
  Unlocking while a pass is active extends it.
- Credits are sold in packs (5 for $5, 12 for $10, 30 for $20; edit `CREDIT_PACKS` in
  `server/src/config.ts`) and only to verified adults who'd have to pay.
- Each payment reference is credited once, so a retried processor webhook can't double-credit.

### Refunds

Settings are `REFUND_POLICY` in `server/src/config.ts`; logic is in `server/src/billing.ts`.

- **Credits never expire.** Users can refund unused credits at any time from the credits panel.
- Credits are tracked per purchase and spent oldest first. A refund goes back to the charge
  it came from, at the price actually paid (rounded in the customer's favor).
- **Inactive accounts:** a reminder at 150 days without logging in, then an automatic refund
  at 180 days. These need to fit inside the processor's refund window, so confirm that first.
- **Failed refunds** (expired card, charge too old) leave the credits on the account, still
  usable, flagged for a manual refund by another method. Every attempt is in the `refunds` table.
- **Shutting down:** `POST /admin/wind-down` with header `x-admin-token: $ADMIN_TOKEN` stops
  credit sales and refunds every unused credit. It returns the list of users whose refunds
  failed so they can be paid another way. The route doesn't exist unless `ADMIN_TOKEN` is set.
- Access is checked when joining the queue, again at match time, and every second during
  a call, so an expired pass ends the call.
- 3 reports bans an account (MVP rule).

## Before launch

- [ ] **Verification vendor**: replace `mockVerificationProvider` with a real adapter
      (Yoti, Veriff, Persona, VerifyMy...) and add its webhook. Check the vendor's
      signature before calling `applyVerificationResult`.
- [ ] **Payments (Segpay)**: replace `mockPaymentProvider` with a Segpay adapter (hosted
      pay page with one price point per pack, postbacks calling `grantCredits` — they aren't
      signed, so check Segpay's IP ranges and re-query the transaction — and the Gateway
      API's partial credit for refunds).
- [ ] **Legal review**: counsel finalizes `legal/*.md` (fill the bracketed items, resolve
      `legal/NOTES-FOR-COUNSEL.md`), and the inactivity timings are set to fit Segpay's
      refund window.
- [ ] **Email**: the inactivity reminder and refund notices only log to the console. Hook
      `consoleNotifier` up to an email service; addresses come from the payment webhook.
- [ ] **Unclaimed property**: have an accountant handle balances whose card refund failed.
- [ ] **Production database**: set `DATABASE_URL` to the Supabase session pooler string.
- [ ] **Media server**: LiveKit Cloud project (or self-hosted) and the `LIVEKIT_*` settings.
- [ ] **Server-side moderation**: on-device blurring can be bypassed by a modified client.
      Calls now go through LiveKit, so add frame sampling there (a LiveKit agent or egress
      snapshots sent to Hive, Sightengine or Rekognition) that calls the end-call switch.
- [ ] **Moderation dashboard**: a screen for reviewing reports and using `/admin/end-call`.
- [ ] **CSAM hash matching and NCMEC reporting** (PhotoDNA or Thorn Safer).
- [ ] **TURN server** (peer-to-peer dev mode only; LiveKit includes its own).
- [ ] **Periodic face re-checks** in adult calls against the verified face.
- [ ] **Legal review**: age verification laws where your users are, 18 U.S.C. § 2257,
      and whether sex-based pricing is allowed in your markets (e.g. California's Unruh Act).
- [ ] Real accounts (email/phone login), a moderation queue for reports, terms of use and privacy policy.
