# CLAUDE.md — EqualCare Concierge Agent

This repo (`addup/health-care-concierge`) builds the conversational concierge for EqualCare. Read this top-to-bottom before doing anything.

## What you are building

A Telegram bot that:
1. Authenticates patients via the existing **Supabase native email-OTP** flow used by the platform
2. Triages symptoms, books / reschedules / cancels appointments via existing Postgres tables and RPCs
3. Sends 24h reminders, post-consultation PREM (T+24h), and PROM EQ-5D-5L (T+7d, T+28d)
4. Renders a **standalone clinic dashboard** (separate small Vite SPA in this repo) with PROM trends and PREM aggregates

Two Cloudflare Workers:
- `concierge-worker` — webhook handler, Durable Objects, Workers AI
- `scheduler-worker` — Cron Trigger every hour, sends forms and reminders

## The other repo — `addup/equal-care-platform`

Companion repo (Vite + React SPA, Lovable-generated) that this concierge integrates with via the **shared Supabase project**. We **do not modify** that repo. The audit summary of what's there:

- **Auth:** Supabase native OTP (`supabase.auth.signInWithOtp` / `verifyOtp`). No custom auth RPCs. The patient identifier IS the auth user UUID — `profiles.id = auth.users.id`.
- **Patient table:** `profiles` (NOT `patients`). PK uuid, FK to `auth.users(id)`. Includes `role: app_role` (`patient | doctor | admin | clinical_director`), `chosen_name`, `email`, `phone`, `preferred_language` (`pt | en`), `registration_completed`, etc.
- **Appointments:** `appointments(id uuid, patient_id, doctor_id, scheduled_at, duration_min, status appointment_status, appointment_type_id, notes)`. No `start_at`/`end_at` — compute end as `scheduled_at + duration_min * interval '1 minute'`. Status: `scheduled | confirmed | completed | cancelled | no_show`.
- **Booking model:** `specialties` → `appointment_types` (FK `specialty_id`, `default_duration_min`, optional `form_schema_key`/`form_id`) → `doctor_appointment_types` / `doctor_specialties` join tables → `doctors`.
- **Booking endpoints:** two RPCs only — `get_available_slots(_appointment_type_id uuid, _target_date date, _doctor_id_filter uuid default null) returns jsonb[]` and `check_slot_available(_doctor_id uuid, _scheduled_at timestamptz, _duration_min int) returns boolean`. Create / reschedule / cancel are direct table operations, RLS-gated.
- **Existing forms tables (`forms`, `form_versions`, `form_responses`)** — those are for **pre-consultation intake forms**, NOT PREM/PROM. Do NOT reuse them. Concierge follow-up forms live in their own `concierge_*` tables.
- **Edge Functions:** `auth-email-hook`, `process-email-queue`, `process-reminder-queue`, plus admin/email helpers. None handle booking. Note: a reminder queue already exists — see Pitfall #6.
- **Roles helper:** `has_role(auth.uid(), 'admin'::app_role)` for clinic-staff gating.

## Source of truth

| Document | Contents |
| --- | --- |
| `docs/concierge/01-PRD.md` | Goals, non-goals, user flows, acceptance criteria |
| `docs/concierge/02-tech-spec.md` | Architecture, components, schema, prompts, payloads |
| `docs/concierge/03-migration.sql` | Concierge-namespaced schema additions |
| `docs/concierge/04-seed.sql` | Scaffolding for demo seed (10 patients) |
| `docs/concierge/05-claude-code-prompts.md` | Phase-by-phase prompts |

If anything in the code conflicts with these docs, the docs are wrong (likely outdated) — flag it, don't silently diverge.

## Repo layout (target)

```
.
├── concierge-worker/       # Cloudflare Worker (webhook + DO)
│   ├── src/
│   │   ├── index.ts            # webhook router
│   │   ├── patient-agent.ts    # PatientAgent Durable Object
│   │   ├── intent.ts           # LLM-based intent classifier
│   │   ├── triage.ts           # triage state machine
│   │   ├── booking.ts          # wraps existing slot RPCs + table ops
│   │   ├── forms/
│   │   │   ├── prem.ts
│   │   │   ├── eq5d5l.ts
│   │   │   └── runner.ts       # generic form state machine
│   │   ├── faq.ts              # Vectorize lookup
│   │   ├── telegram.ts         # Telegram API wrappers
│   │   ├── supabase.ts         # client factory (service + patient JWT)
│   │   └── i18n.ts             # PT/EN strings
│   └── wrangler.toml
├── scheduler-worker/       # Cloudflare Worker (cron + admin route)
│   ├── src/
│   │   ├── index.ts            # cron entrypoint + /admin/cron/run
│   │   ├── reminders.ts
│   │   ├── dispatches.ts
│   │   └── supabase.ts
│   └── wrangler.toml
├── shared/
│   ├── eq5d5l-scoring.ts   # PT-2014 + UK-2018 value sets
│   ├── nanoid.ts
│   └── types.ts
├── supabase/
│   ├── migrations/         # the concierge_* tables
│   └── seed/
├── dashboard/              # standalone clinic-facing SPA (Phase 6)
│                           # Vite + React + Tailwind, queries Supabase directly
└── docs/concierge/
```

## Working agreements

- **Small changes, big diffs are bad.** Implement one component at a time. After each component compiles, ask before moving on.
- **Read the PRD and tech spec before writing code.** When something isn't specified, ask — do not guess.
- **Do NOT modify the `addup/equal-care-platform` repo.** All concierge schema lives in `concierge_*` tables in the same Supabase project. The platform repo is a companion, not part of this codebase.
- **All Supabase calls go through `concierge-worker/src/supabase.ts`** — never raw fetch. Two factory functions: `serviceClient()` (cron + writes that need RLS bypass) and `patientClient(jwt)` (gated by RLS, used during conversation).
- **Type safety:** copy `addup/equal-care-platform/src/integrations/supabase/types.ts` into `shared/db-types.ts` (or regenerate); don't `any` your way through.
- **Never write commit messages on my behalf without showing me the diff first.** I'll review.
- **Branching:** `feat/<area>` (e.g. `feat/bot-skeleton`, `feat/booking`). One PR per phase below.

## Phases (build order)

Phase 0 — Setup
- Create `concierge-worker/` and `scheduler-worker/` scaffolds with `wrangler init`
- Add Vectorize index, KV namespace, Durable Object binding
- Apply `supabase/migrations/<NEW_TIMESTAMP>_concierge.sql` to the shared Supabase
- Confirm both Workers boot with `wrangler dev`

Phase 1 — Skeleton bot
- `/start` flow with `supabase.auth.signInWithOtp` + `verifyOtp`
- Stub all other intents to "ainda não implementado"
- Verifies Telegram → Worker → DO → Supabase plumbing

Phase 2 — Booking
- Intent classifier (Workers AI)
- BOOK / RESCHEDULE / CANCEL / LIST_APPOINTMENTS implemented against existing tables and the two slot RPCs (`get_available_slots`, `check_slot_available`)
- FAQ via Vectorize (seed FAQ corpus too)

Phase 3 — Triage
- Triage state machine
- Red-flag detection
- Bridges into booking flow with pre-filled specialty (resolved to `appointment_type_id` via `appointment_types.specialty_id`)

Phase 4 — Forms
- Generic form runner state machine in DO
- PREM and EQ-5D-5L renderers
- EQ-5D-5L PT/UK scoring

Phase 5 — Scheduler
- Cron Worker for reminders, PREM, PROM dispatches and escalating reminders
- `POST /admin/cron/run` for demo
- Coordinate with the platform's existing reminder queue (see Pitfall #6)

Phase 6 — Standalone Clinic Dashboard (demo-only)
- Separate Vite + React + Tailwind SPA in `dashboard/` of this repo
- **No auth** for V1 demo: uses the Supabase service-role key locally. Local use only — do NOT deploy. Productionising requires Supabase auth + `has_role(auth.uid(), 'admin')` gate.
- Two views: `/proms` (EQ-5D index over time per patient) and `/prems` (NPS + Likert distributions + comments)

Phase 7 — Demo polish
- Seed 10 patients narrative
- Demo script (90 seconds)
- Backup recording

## Out of scope (do NOT touch)

- Specialty-specific PROMs (PHQ-9, GAD-7, etc.)
- WhatsApp, web, voice channels
- Self-registration flow via bot — patient must already be in `profiles` with `registration_completed = true`. If `false`, bot blocks booking and redirects to the app (FAQ remains available). See PRD §6.1 / Phase 1 prompt.
- Insurance / billing / prescriptions
- The existing pre-consultation intake forms (`forms` / `form_versions` / `form_responses`)
- Modifying anything in `addup/equal-care-platform`

## Common pitfalls to avoid

1. **Telegram `callback_data` 64-byte limit** — use the encoding scheme defined in tech spec §8 (10-char short IDs only; map to UUIDs via KV).
2. **Workers AI cold start** — always send `sendChatAction: typing` *before* awaiting any LLM call.
3. **Durable Object naming** — use `patient:${profile_uuid}` after link, NOT Telegram ID. Telegram → patient lookup happens once at `/start` and is cached in DO storage.
4. **RLS** — DO uses the patient's session JWT for `appointments` reads/writes; cron uses service role. Never mix. Concierge-owned tables are also RLS-protected.
5. **EQ-5D-5L wording** — must match the official Portuguese version (Ferreira 2014). Do not paraphrase. The exact strings live in `03-migration.sql`.
6. **Existing reminder infra coexists with ours (V1 decision).** The platform has `process-reminder-queue` Edge Function + `appointment-reminder-24h` email template, which keeps firing as-is. Our scheduler-worker adds a Telegram reminder on top — patients with Telegram linked will get both. Do not modify the platform path. V2 may add a Telegram-link-aware suppression.
7. **`form_responses` name collision.** The platform already has a `form_responses` table for intake forms. Our table is `concierge_form_responses` — never refer to it unprefixed.
8. **Locale enum.** Platform's `preferred_language` enum is `'pt' | 'en'`, NOT `'pt-PT' | 'en'`. Concierge tables align with this.
9. **Idempotency** — `record_concierge_form_response` is idempotent on `dispatch_id`; `dispatch_concierge_form` on `(appointment_id, schedule_label)`.

## When to escalate to me

- Schema mismatch with existing tables (column types, missing FKs)
- Reminder-queue collision behaviour (pitfall #6)
- A user flow has more turns than feels right for Telegram inline keyboards
- LLM model on Workers AI is not behaving in PT-PT — propose alternatives
- Anything that would require a change in `addup/equal-care-platform`
