# Adult AI companion: technology and vendor options (November 2026)

Research for the 18+ flirty companion, which can't run on Claude. **How reliable this is:** the research tools couldn't open most vendor sites directly, so every policy finding comes from search excerpts, third-party policy trackers or law-firm alerts. Each is marked **[confirmed text]**, **[secondhand]** or **[unknown]**. Get every "allowed" in writing before committing.

## Bottom line

1. **Payments decide whether this launches, not technology.** Segpay's compliance docs bring "AI-generated and computer content" under its prohibited-content rules. Its own blog says only a few acquiring banks take AI adult content. Visa requires merchant code 5967 for adult content "including AI-generated adult content." **Start Segpay underwriting first.**
2. **Explicit voice and conversation are achievable; explicit real-time video isn't.** Every hosted avatar company checked forbids sexual content, and open-source real-time models only animate a head-and-shoulders face. Plan a clothed talking-head avatar, with the adult content in the voice and conversation.
3. **Hosted services work for the conversation model; self-host the vision, avatar and probably voice.** Mainstream voice and avatar vendors forbid explicit content or are unclear.

## 1. Conversation model

| Option | Adult-content policy | Price / notes |
|---|---|---|
| **Venice API** | Docs describe "more permissive policies with dedicated uncensored models" [secondhand]. Reported bans: minors, non-consensual and real-person content [unconfirmed]. | ~$0.20 in / $0.90 out per 1M tokens (roleplay model $0.50 / $2.00). Says it doesn't log prompts. |
| **OpenRouter** | Defers to each model's and provider's terms [confirmed text]. Only a router; pin a permissive provider. | |
| Featherless, NanoGPT, Infermatic, Arli, Mancer | Marketed for uncensored roleplay; no policy text found [secondhand]. | Consumer flat rates; would need a business agreement. |
| Together, Fireworks, DeepInfra | No sexual-content clause found; Together bars "obscene" content [secondhand]. | Treat as **not allowed** until confirmed in writing. |
| OpenAI | Reportedly lets approved businesses enable explicit content [secondhand]; its adult mode was reportedly shelved in 2026. | Not a launch option. |
| xAI | Bans pornographic depictions of real people; tightened after January 2026 incidents. | Unclear. |
| Google Gemini / Gemma | **Forbidden** ("sexual chatbots" named explicitly). | Excluded. |

**Self-hosting:** Qwen3 / Qwen3.5 (Apache-2.0), Mistral Small (Apache-2.0) or DeepSeek / GLM (MIT) and their roleplay fine-tunes; one leaderboard ranked Qwen3.5-27B the top roleplay model in July 2026. Llama's license adds its own use policy. Avoid Gemma. Check each fine-tune's own license and training data. A 24–32B model on one H100 or L40S handles roughly 20–40 simultaneous voice calls (estimate).

## 2. Seeing the user's camera

- **Hosted:** no mainstream API says it allows nude images; "uncensored" vision models on Venice or Featherless have no explicit policy [unknown].
- **Self-hosted (recommended):** Qwen3-VL 4B/8B or an uncensored fine-tune (8B needs ~24 GB GPU memory).
- **Minor detection:** run an open-source age estimator (MiVOLO, ~4 years average error) on every frame with a conservative threshold (e.g. estimated under 25 means re-verify; a stronger signal ends the call), plus a "second person in frame" check. Yoti offers a hosted alternative.
- Process frames in memory only; never store them. Face analysis may trigger Illinois and Texas biometric laws, so ask counsel.

## 3. Speech recognition and voice

| Vendor | Adult-content policy |
|---|---|
| ElevenLabs | Bans minors and sexual audio of real people without consent; a tracker says no blanket ban on consensual adult audio [secondhand]. Its image and video terms ban explicit content. |
| Cartesia | Policy dated July 2025; sexual-content clause not seen [unknown]. |
| Deepgram | No sexual-content rule found [unknown]. Lower risk (it only transcribes). |
| Tavus, Hedra, Pika | Forbid sexual content. |

**Self-hosted:** faster-whisper or NVIDIA Parakeet for speech recognition (~150–300 ms); Chatterbox (MIT, expressive, low latency), Kokoro (fast, less emotional) or Zonos (MIT) for voice. One consumer-grade GPU serves many voice streams.

## 4. Real-time avatar

- **Hosted:** Tavus (bans sexual or nude material, "real or AI-generated"), HeyGen and Hedra forbid it; Simli, D-ID, Anam and LemonSlice have no policy found. Even a clothed face voicing explicit audio may break their rules, so ask.
- **Self-hosted:** MuseTalk 1.5 (MIT, ~30 fps), AVTR-1 (2026, 25 fps, ~85–90 ms per chunk), LiveTalking (wraps these and streams over WebRTC). Budget about one L40S or 4090 per 1–2 simultaneous calls. Needs a custom video output into LiveKit Agents or Pipecat.
- **State of the art:** convincing head-and-shoulders lip-sync is achievable now; real-time full-body or explicit generated video isn't, and would be the hardest thing to get past card-network review.

## 5. GPU hosting

| Provider | Adult content | Price (Oct 2026) |
|---|---|---|
| RunPod | **Forbidden** [secondhand] | H100 $2.89–3.99/h, L40S $1.09/h |
| Hetzner | Appears forbidden [secondhand] | |
| Vast.ai, Lambda, CoreWeave, OVH | Unknown | Vast H100 ~$2.14/h; Lambda H100 $2.99–3.99/h |

Need a written yes from the host. Adult-friendly GPU hosts are a niche; ask Segpay or industry peers for referrals.

## 6. Rules that shape the product

- **Mastercard:** 2021 rules require documented age, identity and consent for everyone depicted, review, and a complaint and appeal process. Its monitoring program was revised for 2026 [secondhand]; reported 2026 extensions to AI content are **unconfirmed**.
- **Visa:** requires merchant code 5967 for AI adult content; "fictional depictions intended to mimic egregious adult content" are flagged as higher risk.
- **Segpay:** asks how AI content was generated, how consent was obtained and whether people can request removal; underwrites AI sites like user-generated-content sites; bans user uploads on AI sites; requires a 2257 statement and its due-diligence checklist. No companion-specific policy found.
- **New York (in force Nov 2025):** say the companion isn't human at the start and **at least every 3 hours**; have a crisis protocol with hotline referral. Penalties up to $15k/day [secondhand].
- **California SB 243 (Jan 2026):** AI disclosure, a published crisis protocol, annual reports from July 2027, $1,000 per violation.
- **Also:** Washington (Jan 2027), Oregon and Nebraska have similar laws; the TAKE IT DOWN Act (May 2026) requires removing reported non-consensual intimate imagery within 48 hours.

**What these mean for the product:**
1. No childlike characters, looks, voices or themes; filter what users say and what the AI says.
2. No characters based on real people; no user-supplied faces or voices.
3. Avatars and voices from licensed sources, with documented consent from the voice actors and face models.
4. ID and selfie verification before adult mode, plus in-call age monitoring that ends the call on a minor signal.
5. An "I'm an AI" disclosure at the start of every call and at least every 3 hours.
6. Crisis detection with an out-of-character hotline referral, and the protocol published.
7. Filters for non-consent, violence, bestiality and incest.
8. A complaint, takedown and appeal process with a 24–48 hour turnaround, and a path for NCMEC reports.
9. Clear per-minute pricing.

## Recommended setups

Assumes per minute of call: 3 AI turns, ~9k tokens in and 240 out, ~500 characters spoken, one camera still per turn, and at least 50% GPU utilization once launched.

| | **A. Fastest to launch (hosted)** | **B. Hybrid (recommended)** | **C. All self-hosted** |
|---|---|---|---|
| Conversation | Venice (~$0.002–0.005) | Venice or OpenRouter pinned to a permissive provider (~$0.003) | Qwen3.5-27B or Mistral Small tune on an H100 (~$0.002–0.004) |
| Speech recognition | Deepgram (~$0.005–0.008, policy TBC) | faster-whisper (~$0.002) | same |
| Voice | ElevenLabs (~$0.025–0.05, written OK needed) | Chatterbox (~$0.003) | same |
| Vision and age check | Qwen3-VL-4B + MiVOLO, self-hosted (~$0.003) | same | same |
| Avatar | Simli or LemonSlice if they approve (~$0.02–0.10, unconfirmed) | MuseTalk / AVTR-1 on L40S or 4090 (~$0.01–0.04) | same |
| **Cost per minute** | **$0.06–0.17** | **$0.02–0.06** | **$0.02–0.05 at scale**; ~$3–6k/month in always-on GPUs at launch |
| Main risks | A vendor can cut access without notice; higher cost | Running your own GPUs; still relies on Venice | Most engineering; fixed GPU cost at low volume; finding an adult-friendly host |

The avatar and voice drive the cost, not the conversation model. Aim for under 1.2 seconds from the user finishing speaking to the avatar replying.

At the current price of $1 per 10 minutes ($0.10/minute), setup B leaves a healthy margin before processor fees; setup A is marginal at the top of its range.

## Confirm in writing before committing

1. **Segpay:** will it underwrite an AI companion with explicit voice or chat? Which bank, which merchant code, what reserves and fees?
2. **Venice or the OpenRouter provider:** commercial permission for sexual roleplay between verified adults, and data-retention terms.
3. **GPU host:** an explicit yes for adult workloads (RunPod and Hetzner appear to say no).
4. **ElevenLabs, Cartesia, Deepgram, Simli, LemonSlice:** is consensual adult content allowed through their APIs?
5. **Mastercard's 2026 AI rules:** what documentation is needed for synthetic characters and the people behind their voices and faces.
6. **Counsel:** biometric law for the age-estimation and selfie flows, and the 2257 position for content with no real performers.

## Sources

Segpay: [prohibited content](https://gethelp.segpay.com/docs/Content/ComplianceDocs/ProhibitedContent.htm), [user-generated content](https://gethelp.segpay.com/docs/Content/ComplianceDocs/UserGeneratedContent.htm), [adult AI roadmap](https://segpay.com/blog/your-roadmap-for-adult-ai-site-approval/), [AI content risks](https://segpay.com/blog/ai-generated-content/), [monetizing with AI](https://segpay.com/blog/monetizing-merchant-site-ai/).
Card networks: [Mastercard 2021](https://mastercard.com/news/perspectives/2021/protecting-our-network-protecting-you-preventing-illegal-adult-content-on-our-network), [LegitScript on Visa VIRP](https://www.legitscript.com/regulatory-and-card-brand-compliance/adult-escort-and-dating-merchants-are-your-practices-in-line-with-virp-updates/), [Centrobill on Mastercard 2026](https://centrobill.com/blog/mastercard-mmp-2026-high-risk-merchant-compliance/), [specialty merchant fees (unverified)](https://merchantcostconsulting.com/lower-credit-card-processing-fees/mastercard-specialty-merchant-registration-program-fees-updates/).
Companion laws: [MoFo on NY and CA](https://www.mofo.com/resources/insights/251120-new-york-and-california-enact-landmark-ai), [NY A6767](https://www.nysenate.gov/legislation/bills/2025/A6767), [NY Governor letter](https://www.governor.ny.gov/news/governor-hochul-pens-letter-ai-companion-companies-notifying-them-safeguard-requirements-are), [FPF on SB 243](https://fpf.org/blog/understanding-the-new-wave-of-chatbot-legislation-california-sb-243-and-beyond/), [FPF 2026 landscape](https://fpf.org/blog/the-chatbot-moment-mapping-the-emerging-2026-u-s-chatbot-legislative-landscape/), [Hunton on Washington](https://hunton.com/privacy-and-cybersecurity-law-blog/washington-state-enacts-law-regulating-ai-companion-chatbots-with-private-right-of-action), [Orrick 2026](https://www.orrick.com/en/Insights/2026/04/2026-State-Chatbot-Laws-Key-Provisions-and-Regulatory-Trends), [WilmerHale](https://www.wilmerhale.com/en/insights/client-alerts/20260615-the-take-it-down-act-goes-live) and [Covington](https://www.insideprivacy.com/united-states/federal-trade-commission/the-take-it-down-acts-notice-and-removal-requirements-enter-into-effect/) on TAKE IT DOWN.
Models: [Venice API](https://docs.venice.ai/api-reference), [Venice pricing](https://www.usagepricing.com/blueprint/venice), [OpenRouter terms](https://conductatlas.com/platform/openrouter/openrouter-terms-of-service/), [Featherless](https://featherless.ai/blog/best-uncensored-ai-models-2026), [provider policies roundup](https://foreverse.app/blog/nsfw-roleplay-provider-policies), [Together AI](https://conductatlas.com/platform/together-ai/together-ai-terms-of-service/acceptable-use-policy-and-content-restrictions/), [OpenAI](https://conductatlas.com/platform/openai/openai-usage-policies/restrictions-on-sexual-and-adult-content/), [xAI](https://x.ai/legal/acceptable-use-policy/previous-2026-06-26), [Gemma](https://ai.google.dev/gemma/prohibited_use_policy), [Llama](https://developer.meta.com/ai/use-policy/), [roleplay leaderboard](https://www.benchlm.ai/best/roleplay).
Voice and avatar: [ElevenLabs use policy](https://elevenlabs.io/use-policy), [ElevenLabs image and video terms](https://elevenlabs.io/image-and-video-terms), [policy tracker](https://aihaven.com/ai-adult-content-policy-tracker/), [Cartesia](https://cartesia.ai/legal/acceptable-use), [Deepgram](https://deepgram.com/legal/terms), [open TTS overview](https://bentoml.com/blog/exploring-the-world-of-open-source-text-to-speech-models), [TTS comparison](https://smallest.ai/blog/best-tts-models-in-2026-quality-latency-and-production-fit), [Tavus](https://www.tavus.io/acceptable-use-policy), [HeyGen](https://www.heygen.com/moderation-policy), [Hedra](https://www.hedra.com/acceptable-use), [LiveKit avatar plugins](https://docs.livekit.io/agents/models/avatar/), [live avatar](https://sequencer.media/live-avatar), [avatar latency](https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/real-time-avatar-lipsync-in-call), [AVTR-1](https://huggingface.co/avaturn-live/avtr-1), [open lip-sync models](https://ltx.io/blog/open-source-lip-sync-models), [LiveTalking](https://home.wonlab.top/en/blog/open-source-projects/196-livetalking).
Vision and age: [Qwen3-VL uncensored](https://featherless.ai/models/Felldude/Qwen3-VL-8B-Instruct-Uncensored), [MiVOLO](https://arxiv.org/html/2307.04616v1), [Yoti](https://developers.yoti.com/v8.0/age-estimation).
Hosting: [RunPod terms](https://conductatlas.com/platform/runpod/runpod-terms-of-service/prohibited-content-categories-in-service/), [Vast.ai](https://vast.ai/terms), [Hetzner discussion](https://lowendtalk.com/discussion/comment/4502754), [CoreWeave](https://docs.coreweave.com/policies/terms-of-service/acceptable-use-policy), [GPU pricing](https://neurohive.io/en/guides/cloud-gpu-pricing/), [GPU providers](https://jarvislabs.ai/ai-faqs/best-cloud-gpu-providers-2026).
