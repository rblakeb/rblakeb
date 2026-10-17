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

In dev mode, age verification and payments go to mock pages (`public/dev/`) where you
choose the outcome. Those routes are disabled when `NODE_ENV=production`.

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
- [ ] **Payments**: replace `mockPaymentProvider` with an adult-friendly processor
      (CCBill, Segpay, Epoch) and add its webhook calling `grantCredits`.
- [ ] **Refund terms**: put the refund policy above in the terms of use, and set the
      inactivity timings to fit the processor's refund window.
- [ ] **Email**: the inactivity reminder and refund notices only log to the console. Hook
      `consoleNotifier` up to an email service; addresses come from the payment webhook.
- [ ] **Unclaimed property**: have an accountant handle balances whose card refund failed.
- [ ] **Production database**: create the Supabase project and set `DATABASE_URL`.
- [ ] **Server-side moderation**: on-device blurring can be bypassed by a modified client.
      Add server frame sampling (Hive, Sightengine, Rekognition), which needs media
      routed through an SFU like LiveKit instead of peer-to-peer.
- [ ] **CSAM hash matching and NCMEC reporting** (PhotoDNA or Thorn Safer).
- [ ] **TURN server**: set `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` so calls
      connect across strict NATs and mobile networks.
- [ ] **Periodic face re-checks** in adult calls against the verified face.
- [ ] **Legal review**: age verification laws where your users are, 18 U.S.C. § 2257,
      and whether sex-based pricing is allowed in your markets (e.g. California's Unruh Act).
- [ ] Real accounts (email/phone login), a moderation queue for reports, terms of use and privacy policy.
