# 90-Second Demo Script — EQUAL Care Concierge

> Status: planning artifact. Edit when running the actual demo.

## Pre-flight (do once before going live)

1. Migration applied to Supabase, secrets set (see README "Quick start").
2. `cd scripts && npm install && npm run seed` — populates 10 patients, 30 appointments, 90+ form responses.
3. `cd dashboard && npm run dev` — local dashboard on http://localhost:5180.
4. `cd concierge-worker && wrangler dev` (or deploy + setup-webhook). Telegram bot reachable.
5. Pedro's real Telegram account swapped into `concierge_telegram_links` for ID `1000000010` (the João Ribeiro slot — has a future appointment for the 24h-reminder act).

## Script (≈90s)

**0:00–0:15  Hook.** "Small clinics lose 15-25% of appointments to no-shows and never collect outcome data. EQUAL Care fixes both with a Telegram bot."

**0:15–0:40  Bot — triage + booking.**
- Pedro opens Telegram, types: *"dói-me a barriga há 3 dias e tenho febre baixa"*.
- Bot asks 2 follow-ups, suggests **Medicina Geral**, lists slots, Pedro taps one → confirmation.
- (If a red-flag was typed instead: *"tenho dor no peito a irradiar para o braço esquerdo"* → bot escalates to 112 immediately, no booking.)

**0:40–0:55  Bot — PREM in chat.**
- Cut to second prepared chat where a PREM dispatch is already due. Tap through 4 questions in <10s.

**0:55–1:20  Dashboard.**
- `/proms`: pick **Diogo Marques** → EQ-5D rising 0.55 → 0.78 across two consultations.
- `/prems`: NPS aggregate, distribution chart, Inês Faria's negative comment in the comments list.

**1:20–1:30  Architecture closer.**
- "All Cloudflare-native: Workers, Durable Objects, Workers AI, Vectorize, KV. Single Supabase project shared with the platform — no duplication of the patient record."

## Backup video

Record once at `docs/concierge/demo.mp4` to show if Telegram has hiccups during the live demo. Capture the same sequence above; trim to 90s.

## Talking points (one each)

- **Why Telegram first?** Lowest distribution friction in PT/EU. Multi-channel later, design already supports it.
- **Why Cloudflare?** Latency profile of edge + 1-line cron + Vectorize + Workers AI = a single deploy unit per worker.
- **Why follow-up forms ourselves?** Platform's intake forms are pre-consultation; PREM/PROM are a different lifecycle. Same Supabase project, separate `concierge_*` tables.
