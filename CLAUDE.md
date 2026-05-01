# CLAUDE.md — EqualCare Concierge Agent

This repo builds the conversational concierge for EqualCare. Read this top-to-bottom before doing anything.

## What you are building

A Telegram bot that:
1. Authenticates patients via the existing email-OTP flow in the Supabase platform
2. Triages symptoms, books / reschedules / cancels appointments via existing Supabase RPCs
3. Sends 24h reminders, post-consultation PREM (T+24h), and PROM EQ-5D-5L (T+7d, T+28d)
4. Renders a clinic dashboard with PROM trends and PREM aggregates (extension of the existing Next.js app)

Two Cloudflare Workers:
- `concierge` — webhook handler, Durable Objects, Workers AI
- `scheduler` — Cron Trigger every hour, sends forms and reminders

## Source of truth

| Document | Contents |
| --- | --- |
| `docs/concierge/01-PRD.md` | Goals, non-goals, user flows, acceptance criteria |
| `docs/concierge/02-tech-spec.md` | Architecture, components, schema, prompts, payloads |
| `docs/concierge/03-migration.sql` | Schema additions to apply to existing Supabase |
| `docs/concierge/04-seed.sql` | Scaffolding for demo seed (10 patients) |

If anything in the code conflicts with these docs, the docs are wrong (likely outdated) — flag it, don't silently diverge.

## Repo layout (target)

```
.
├── apps/
│   ├── platform/              # existing Lovable Next.js app (unchanged except dashboard pages)
│   │   └── app/clinica/
│   │       ├── proms/page.tsx        # NEW
│   │       └── prems/page.tsx        # NEW
│   └── concierge/
│       ├── concierge-worker/         # NEW Cloudflare Worker
│       │   ├── src/
│       │   │   ├── index.ts          # webhook router
│       │   │   ├── patient-agent.ts  # Durable Object
│       │   │   ├── intent.ts         # LLM-based intent classifier
│       │   │   ├── triage.ts         # triage state machine
│       │   │   ├── booking.ts        # wraps Supabase RPCs
│       │   │   ├── forms/
│       │   │   │   ├── prem.ts
│       │   │   │   ├── eq5d5l.ts
│       │   │   │   └── runner.ts     # generic state machine
│       │   │   ├── faq.ts            # Vectorize lookup
│       │   │   ├── telegram.ts       # tg API wrappers
│       │   │   ├── supabase.ts       # client factory
│       │   │   └── i18n.ts           # PT/EN strings
│       │   └── wrangler.toml
│       ├── scheduler-worker/         # NEW Cloudflare Worker
│       │   ├── src/
│       │   │   ├── index.ts          # cron entrypoint + admin route
│       │   │   ├── reminders.ts
│       │   │   ├── dispatches.ts
│       │   │   └── supabase.ts
│       │   └── wrangler.toml
│       └── shared/
│           ├── eq5d5l-scoring.ts     # PT-2014 + UK-2018 value sets
│           ├── nanoid.ts
│           └── types.ts
└── supabase/
    ├── migrations/<ts>_concierge.sql
    └── seed/concierge-demo-seed.sql
```

## Working agreements

- **Small changes, big diffs are bad.** Implement one component at a time. After each component compiles, ask before moving on.
- **Read the PRD and tech spec before writing code.** When something isn't specified, ask — do not guess.
- **Do not modify existing platform code unless adding the two dashboard pages or updating the Supabase migrations folder.** The existing Lovable app is the source of truth for booking RPCs.
- **All RPC calls go through `apps/concierge/concierge-worker/src/supabase.ts`** — never raw fetch.
- **Type safety:** use generated Supabase types; don't `any` your way through.
- **Never write commit messages on my behalf without showing me the diff first.** I'll review.
- **Branching:** `feat/concierge-<area>` (e.g. `feat/concierge-bot-skeleton`). One PR per phase below.

## Phases (build order)

Phase 0 — Setup
- Create `apps/concierge/concierge-worker/` and `scheduler-worker/` scaffolds with `wrangler init`
- Add Vectorize index, KV namespace, Durable Object binding
- Apply `supabase/migrations/<ts>_concierge.sql` to local Supabase
- Confirm I can run both Workers locally with `wrangler dev`

Phase 1 — Skeleton bot
- `/start` flow with email OTP linking
- Stub all other intents to "ainda não implementado"
- Verifies Telegram → Worker → DO → Supabase plumbing

Phase 2 — Booking
- Intent classifier (Workers AI)
- BOOK / RESCHEDULE / CANCEL / LIST_APPOINTMENTS implemented against existing RPCs
- FAQ via Vectorize (seed FAQ corpus too)

Phase 3 — Triage
- Triage state machine
- Red-flag detection
- Bridges into booking flow with pre-filled specialty

Phase 4 — Forms
- Generic form runner state machine in DO
- PREM and EQ-5D-5L renderers
- EQ-5D-5L PT/UK scoring

Phase 5 — Scheduler
- Cron Worker for reminders, PREM, PROM dispatches and escalating reminders
- `POST /admin/cron/run` for demo

Phase 6 — Dashboard
- `/clinica/proms` page: line chart of EQ-5D index per patient + table
- `/clinica/prems` page: NPS distribution, recent comments

Phase 7 — Demo polish
- Seed 10 patients narrative
- Demo script (90 seconds)
- Backup recording

## Out of scope (do NOT touch)

- Specialty-specific PROMs (PHQ-9, GAD-7, etc.)
- WhatsApp, web, voice channels
- Self-registration flow via bot
- Insurance / billing / prescriptions

## Common pitfalls to avoid

1. **Telegram `callback_data` 64-byte limit** — use the encoding scheme defined in tech spec §8 (short IDs only).
2. **Workers AI cold start** — always send `sendChatAction: typing` *before* awaiting any LLM call.
3. **Durable Object naming** — use `patient:${supabase_patient_id}`, NOT Telegram ID. Telegram→patient lookup happens once at `/start`.
4. **RLS** — DO uses the patient's session JWT for booking RPCs; cron uses service role. Never mix.
5. **EQ-5D-5L wording** — must match the official Portuguese version (Ferreira 2014). Do not paraphrase. The exact strings live in `04-seed.sql`.
6. **Idempotency** — `record_form_response` is idempotent on `dispatch_id`; rely on that. Same for `dispatch_form` on `(appointment_id, schedule_label)`.

## When to escalate to me

- Schema mismatch with existing tables (column types, missing FKs)
- Existing RPC signature differs from what tech spec assumes
- A user flow has more turns than feels right for Telegram inline keyboards
- LLM model on Workers AI is not behaving in PT-PT — propose alternatives
