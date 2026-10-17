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
| Day pass billing hook | `server/src/billing.ts` |
| Front end (vanilla JS + WebRTC) | `public/app.js` |
| On-device nudity blur for non-adult rooms (NSFWJS) | `public/moderation.js` |

### Adult access rules

- Every user needs `verifiedAdult = true`, set only by the verification vendor's result.
  We store the flag, the vendor's reference ID and the sex on the ID. No ID images.
- Users whose verified ID says `F` get in free. Everyone else needs a $1 / 24h day pass.
  Buying while a pass is active extends it.
- Access is checked when joining the queue, again at match time, and every second during
  a call, so an expired pass ends the call.
- 3 reports bans an account (MVP rule).

## Before launch

- [ ] **Verification vendor**: replace `mockVerificationProvider` with a real adapter
      (Yoti, Veriff, Persona, VerifyMy...) and add its webhook. Check the vendor's
      signature before calling `applyVerificationResult`.
- [ ] **Payments**: replace `mockPaymentProvider` with an adult-friendly processor
      (CCBill, Segpay, Epoch) and add its webhook calling `grantDayPass`.
- [ ] **Database**: users live in memory (`server/src/users.ts`) and vanish on restart.
      Move them to Postgres.
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
