# Notes for counsel

These drafts (`terms.md`, `privacy.md`, `content-policy.md`) were written from the way the software actually behaves today, so they're a starting point, not legal advice. They're served on the site at `/terms`, `/privacy` and `/content-policy`. Edit the Markdown files directly. Remove the "DRAFT" notice at the top of each file once final.

## How the product works (facts the drafts rely on)

- **Rooms.** The site is 18+ only, confirmed by a click-through at sign-up. Users pick a room: Just Chat, Music & DJ, Gaming, Language Exchange, or Adult 18+. They're randomly paired 1-on-1 with someone in the same room.
- **Adult room verification.** Entry requires ID + live selfie + face match through a third-party vendor (planned: Didit). We store only:
  - pass/fail
  - an 18+ flag
  - the sex printed on the ID
  - the vendor's reference

  We store no images, no biometrics, no name and no date of birth.
- **Calls.** Audio and video go through a media server (LiveKit). They are not recorded. Moderators can end any call instantly for both sides. Automated nudity blurring runs in non-adult rooms. Server-side frame analysis is planned.
- **Reports.** Users can report each other. 3 reports automatically bans an account.
- **Credits.**
  - Packs: 5 for $5, 12 for $10, 30 for $20. 1 credit = 24 hours of adult-room access.
  - Credits never expire.
  - Unused credits are refundable at any time, to the original charge, at the price paid.
  - Inactive accounts get a reminder email at 150 days and an automatic refund at 180 days.
  - If the site shuts down, all unused credits are refunded.
  - If a card refund fails, the credits stay on the account and the user is refunded another way.
- **Payment processor.** Planned: Segpay.

## Open questions

1. **Sex-based pricing.** Verified women enter the adult room free; men pay. This may conflict with California's Unruh Civil Rights Act and similar state laws. Tinder's age-based pricing and "ladies' night" promotions have been challenged under Unruh. The draft Terms describe it in brackets in section 7. Should we keep it, restrict it by state, or replace it with a sex-neutral model (for example, free entry for anyone who has been verified for X days, or promotional credits)?
2. **Site-wide 18+.** The whole site currently requires users to be 18+ via click-through; only the adult room requires ID. Segpay's research flagged non-adult rooms open to minors as an underwriting risk, so the drafts make the entire site 18+. Is click-through enough for the non-adult rooms, given state age-verification laws, or should ID be required site-wide?
3. **State age-verification laws** for the adult room (for example Texas, Utah, Louisiana, and the other states with laws covering sites with sexual content), plus the UK Online Safety Act if UK users are allowed. Is our vendor-based ID + selfie check enough? Should certain jurisdictions be geo-blocked?
4. **Biometric privacy.** Face matching is done by the vendor. Under Illinois BIPA, Texas CUBI and Washington's biometric law, do we need our own written consent and retention schedule, given that we never receive biometric data? The vendor contract should cover this.
5. **18 U.S.C. § 2257 / § 2257A.** We don't produce, record or store sexual content; it's live, user-to-user and unrecorded. Do record-keeping requirements apply? Is any statement or exemption notice needed?
6. **Card-network rules.** Mastercard's 2021 adult-content standards (AN 5196) and Visa's integrity program require:
   - age and consent verification of everyone depicted;
   - content review;
   - a complaint process with resolution within 7 business days;
   - an appeal process.

   Do the Content & Moderation Policy and our live, unrecorded model satisfy "review before publication"?
7. **Credits.**
   - Do non-expiring, refundable credits trigger prepaid-access or money-transmitter rules?
   - How should unclaimed-property (escheat) reporting be handled for balances whose refund failed?
   - Is withholding credits from accounts banned for fraud allowed?
   - The 180-day auto-refund depends on Segpay's refund window, which is still to be confirmed.
8. **Section 230 / FOSTA-SESTA.** Section 4.7 bans payment for sexual activity. Is that enough, or do we need further measures?
9. **Dispute terms.** Choose governing law, venue, and whether to use arbitration and a class-action waiver (Terms section 13).
10. **Retention periods.** The bracketed numbers in the Privacy Policy are placeholders.
11. **Business entity and statement descriptor.** These fill [COMPANY NAME] and [STATEMENT DESCRIPTOR].
