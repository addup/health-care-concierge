# Tech Spec — EqualCare Concierge Agent

## 1. Architecture

```
                  ┌──────────────────────────┐
                  │   Telegram Bot API        │
                  └────────────┬──────────────┘
                               │ webhook
                               ▼
        ┌──────────────────────────────────────────────┐
        │  Cloudflare Worker: concierge                │
        │  ─ /webhook/telegram   (POST)                │
        │  ─ Routes to PatientAgent (Durable Object)   │
        └─────┬────────────────────┬───────────────────┘
              │                    │
              ▼                    ▼
        ┌──────────┐        ┌──────────────┐        ┌────────────┐
        │ Durable  │        │ Workers AI   │        │ Vectorize  │
        │ Object   │        │ Llama 3.3    │        │ FAQ embed. │
        │ per      │        │ 70B          │        └────────────┘
        │ patient  │        └──────────────┘
        └────┬─────┘
             │ Supabase JS client (with patient session)
             ▼
        ┌─────────────────────────────────────┐
        │  Supabase (Postgres) — addup/       │
        │  equal-care-platform DB             │
        │  ─ existing: profiles, doctors,     │
        │    specialties, doctor_specialties, │
        │    appointment_types, appointments, │
        │    forms, form_versions,            │
        │    form_responses (intake)          │
        │  ─ new (concierge_ namespace):      │
        │    concierge_telegram_links,        │
        │    concierge_form_templates,        │
        │    concierge_form_dispatches,       │
        │    concierge_form_responses,        │
        │    concierge_appointment_state,     │
        │    concierge_audit_log              │
        │  ─ existing RPCs reused:            │
        │    get_available_slots,             │
        │    check_slot_available             │
        │  ─ new RPCs: dispatch_form,         │
        │    record_form_response, ...        │
        └─────────────┬───────────────────────┘
                      │
                      │ direct query
                      ▼
        ┌─────────────────────────────────────┐
        │  Standalone clinic dashboard SPA    │
        │  (this repo, dashboard/)            │
        │  Vite + React + Tailwind            │
        │  ─ /proms    EQ-5D index over time  │
        │  ─ /prems    NPS + comments         │
        │    No auth — local demo only        │
        │    (uses service-role Supabase key) │
        └─────────────────────────────────────┘

        ┌─────────────────────────────────────┐
        │  Cloudflare Worker: scheduler       │
        │  ─ Cron Trigger: every 1h           │
        │  ─ Sends 24h reminders              │
        │  ─ Dispatches PREM at T+24h         │
        │  ─ Dispatches PROM at T+7d, T+28d   │
        │  ─ Sends form reminders at +48h, +7d│
        │  ─ Marks abandoned                  │
        └─────────────────────────────────────┘
```

The existing platform (`addup/equal-care-platform`) is a **single Vite + React SPA** (not Next.js, not a monorepo). The concierge lives in **its own repo** (`addup/health-care-concierge`); the only contact surface is the shared Supabase project. We do **not** add pages to the platform — the clinic dashboard is a separate small SPA built inside this repo at `dashboard/`.

## 2. Cloudflare Workers

### 2.1 `concierge` Worker

**Bindings:**
- `AI` — Workers AI binding
- `PATIENT_AGENT` — Durable Object namespace `PatientAgent`
- `FAQ_INDEX` — Vectorize index for FAQ embeddings
- `KV` — short-id ↔ uuid mappings for Telegram callbacks
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` — secrets
- `TELEGRAM_BOT_TOKEN` — secret

**Routes:**
- `POST /webhook/telegram` — receives updates, routes to DO by Telegram user ID
- `POST /admin/setup-webhook` — one-shot, sets Telegram webhook to this Worker URL
- `GET /healthz` — health check

**Single responsibility:** parse incoming Telegram update → look up Telegram user → forward to a Durable Object instance (`patient:${telegram_user_id}`) → return `200 OK`.

### 2.2 `PatientAgent` Durable Object

**Storage keys:**
- `auth` — `{ patient_id, supabase_session, linked_at } | null` (`patient_id` IS the auth user UUID; `profiles.id = auth.users.id`)
- `pending_otp` — `{ email, attempts, expires_at } | null`
- `intent_state` — current multi-turn intent (TRIAGE, BOOK, RESCHEDULE, FORM)
- `triage_state` — `{ symptoms: [...], turn: n, summary: '...' }`
- `form_state` — `{ dispatch_id, template, cursor, answers: {...} }`
- `last_message_at` — timestamp
- `locale` — `'pt' | 'en'`

**Methods (all callable via `fetch()` on the DO):**
- `handleUpdate(update)` — main entry; dispatches to `handleText`, `handleCallback`, `handleCommand`
- `handleText(text)` — runs intent classifier, routes
- `handleCallback(data)` — parses `f:<id>:q:<n>:a:<n>` style payloads
- `handleCommand(cmd, args)` — `/start`, `/cancel`, `/help`
- `dispatchExternal(payload)` — called by scheduler Worker via DO RPC to push a form or reminder

### 2.3 `scheduler` Worker

**Bindings:**
- `PATIENT_AGENT` — to push messages to specific patients
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- `TELEGRAM_BOT_TOKEN`

**Cron triggers (`wrangler.toml`):** `0 * * * *` — hourly.

**Logic per run** (note: `appointments` has no `start_at` / `end_at` — use `scheduled_at` and `(scheduled_at + duration_min * interval '1 minute')` for the end; bookkeeping lives in `concierge_appointment_state`, not in `appointments` itself):

1. **24h reminders.**
   ```sql
   select a.* from appointments a
   left join concierge_appointment_state s on s.appointment_id = a.id
   where a.scheduled_at between now()+'23 hours' and now()+'25 hours'
     and a.status in ('scheduled','confirmed')
     and s.reminder_sent_at is null
   ```
   Push, then `upsert` `reminder_sent_at` on the state row.
2. **PREM creation @ T+24h.** Same pattern using `(a.scheduled_at + a.duration_min * interval '1 minute') <= now() - '24 hours'` and `s.prem_dispatched_at is null` and `a.status = 'completed'`.
3. **PROM_T7d / PROM_T28d** identically with the `(end + Nd)` predicate and the corresponding state column.
4. Send-due / reminder cascade reads from `concierge_form_dispatches` exactly as before.
5. `select abandon_stale_concierge_dispatches()`.

## 3. Intent classification

Single LLM call per inbound text, JSON-mode. Prompt template (PT-PT system, locale-specific):

```
System:
You are an intent classifier for the EqualCare clinic concierge.
Classify the patient's message into ONE intent and extract entities.

Intents:
  GREET, FAQ, TRIAGE, BOOK, RESCHEDULE, CANCEL,
  LIST_APPOINTMENTS, FORM_RESPONSE, IDENTIFY, OTHER

Output STRICT JSON, no prose:
{
  "intent": "...",
  "confidence": 0.0-1.0,
  "entities": {
    "specialty": null | "...",
    "date_hint": null | "...",
    "time_hint": null | "...",
    "appointment_ref": null | "...",
    "symptoms": [],
    "email": null | "..."
  },
  "language": "pt-PT" | "en"
}
```

Model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (fast variant). Fallback to `@cf/meta/llama-3.1-8b-instruct` if the 70B times out.

## 4. Triage prompt

Separate prompt, only invoked when intent=TRIAGE or symptoms detected. Goals: collect 2–4 follow-up data points, then output `{ specialty, urgency: 'routine'|'soon'|'red_flag', summary }`.

Red-flag whitelist (immediate escalation, **no booking**):
- Chest pain (especially radiating, with sweating, dyspnea)
- Sudden severe dyspnea
- Sudden focal neurological deficit (weakness, slurred speech, vision loss, severe headache)
- Severe abdominal pain with rigidity
- Suicidal ideation or self-harm
- Severe bleeding
- Anaphylaxis signs
- Pregnant + heavy bleeding / severe abdominal pain
- Pediatric: high fever + lethargy, persistent vomiting

Triage state machine: max 4 turns; if no clear specialty after 4 turns → default to Medicina Geral with summary.

## 5. FAQ via Vectorize

- Author 20–30 FAQs in PT-PT and EN (clinic info, hours, address, payment, parking, what specialties are offered, what insurance is accepted, COVID policy, what to bring to first appointment, etc.)
- Embed using `@cf/baai/bge-m3` (multilingual)
- Index in Vectorize with metadata `{ id, lang, question, answer }`
- On FAQ intent: embed query → top-3 retrieval → if top result similarity > 0.75, return `answer` directly; else fall back to LLM with retrieved context

## 6. Database changes (Supabase)

All concierge-owned tables are prefixed `concierge_` to namespace them away from existing platform tables — this matters because `form_responses` already exists in the platform with a different shape.

### 6.1 New tables

```sql
-- Maps Telegram users to EqualCare patients (profiles)
create table concierge_telegram_links (
  telegram_user_id  bigint primary key,
  patient_id        uuid not null references profiles(id) on delete cascade,
  linked_at         timestamptz not null default now(),
  last_active_at    timestamptz not null default now(),
  locale            text not null default 'pt'
);

-- Form templates (PREM and EQ-5D-5L only in V1)
create table concierge_form_templates (
  id          text primary key,
  kind        text not null check (kind in ('PREM','PROM')),
  name        text not null,
  schema      jsonb not null,
  version     int  not null default 1,
  created_at  timestamptz not null default now()
);

-- One row per scheduled form send (PREM at T+24h, PROM at T+7d and T+28d)
create table concierge_form_dispatches (
  id                text primary key,                -- nanoid(10)
  appointment_id    uuid not null references appointments(id) on delete cascade,
  patient_id        uuid not null references profiles(id) on delete cascade,
  template_id       text not null references concierge_form_templates(id),
  schedule_label    text not null,                   -- 'PREM_T24h' | 'PROM_T7d' | 'PROM_T28d'
  scheduled_for     timestamptz not null,
  sent_at           timestamptz,
  reminder_count    int not null default 0,
  last_reminder_at  timestamptz,
  completed_at      timestamptz,
  abandoned_at      timestamptz,
  channel           text not null default 'telegram',
  unique (appointment_id, schedule_label)
);

-- Concierge form responses. Note: distinct from the existing platform
-- `form_responses` table, which stores intake forms keyed by appointment.
create table concierge_form_responses (
  id            uuid primary key default gen_random_uuid(),
  dispatch_id   text not null unique references concierge_form_dispatches(id) on delete cascade,
  patient_id    uuid not null references profiles(id) on delete cascade,
  template_id   text not null references concierge_form_templates(id),
  answers       jsonb not null,
  score         jsonb not null,
  completed_at  timestamptz not null default now()
);

-- Sidecar bookkeeping for appointments. We do NOT alter the existing
-- appointments table; the concierge tracks its own per-appointment state.
create table concierge_appointment_state (
  appointment_id          uuid primary key references appointments(id) on delete cascade,
  reminder_sent_at        timestamptz,
  prem_dispatched_at      timestamptz,
  prom_t7_dispatched_at   timestamptz,
  prom_t28_dispatched_at  timestamptz,
  updated_at              timestamptz not null default now()
);

-- Audit log for the agent (one row per agent action)
create table concierge_audit_log (
  id                uuid primary key default gen_random_uuid(),
  patient_id        uuid references profiles(id) on delete set null,
  telegram_user_id  bigint,
  intent            text,
  action            text not null,
  payload           jsonb,
  created_at        timestamptz not null default now()
);
```

### 6.2 New RLS policies

- `concierge_telegram_links`: only service role and the matching patient can read; only service role can write
- `concierge_form_dispatches` / `_form_responses` / `_appointment_state`: only service role can write; matching patient can read their own
- Clinic staff (`profiles.role = 'admin'`, checked via existing `has_role(auth.uid(), 'admin')` helper) can read `concierge_form_responses`, `concierge_form_dispatches`, `concierge_audit_log`
- `concierge_audit_log`: only service role and admin can read

### 6.3 Integration with existing platform — auth, listing, booking

The agent does **NOT** introduce new RPCs for auth or appointment lifecycle. It uses what is already in `addup/equal-care-platform`:

**Authentication** — Supabase Auth native, *not* custom RPCs. The platform uses email/SMS magic-link OTP via `supabase.auth.signInWithOtp` and `supabase.auth.verifyOtp`. The agent does the same:

```ts
// 1) Patient gives email
await supabase.auth.signInWithOtp({
  email,
  options: { shouldCreateUser: false }    // bot does not register new patients
})

// 2) Patient pastes the 6-digit code
const { data, error } = await supabase.auth.verifyOtp({
  email, token, type: 'email'
})
// data.user.id IS the patient_id (profiles.id = auth.users.id)
```

After verification, the bot stores the session in DO storage and writes the `concierge_telegram_links` row via service role.

**Listing & booking** — direct table operations + two existing RPCs:

| Need | Mechanism |
| --- | --- |
| List specialties | `select id, name, color from specialties where is_active = true` |
| List doctors for a specialty | `select d.* from doctors d join doctor_specialties ds on ds.doctor_id = d.id where ds.specialty_id = $1` |
| Map specialty → `appointment_type_id` | `select id, name, default_duration_min from appointment_types where specialty_id = $1 and is_active = true`. **If the result has one row**, use it. **If more than one**, the bot renders an inline keyboard with one button per type (label = `name`, e.g. "Primeira consulta" vs "Consulta de seguimento") and waits for the tap before continuing. The chosen row's `default_duration_min` flows into the slot RPCs and the appointments insert. |
| List availability | `rpc('get_available_slots', { _appointment_type_id, _target_date, _doctor_id_filter })` returns `jsonb[]` of slots |
| Pre-flight slot check | `rpc('check_slot_available', { _doctor_id, _scheduled_at, _duration_min })` returns `boolean` |
| Confirm booking | `insert into appointments (patient_id, doctor_id, appointment_type_id, scheduled_at, duration_min, status) values (..., 'scheduled')`, RLS-gated |
| List my appointments | `select * from appointments where patient_id = auth.uid() order by scheduled_at` |
| Reschedule | `update appointments set scheduled_at = $new where id = $appt and patient_id = auth.uid()` (preceded by `check_slot_available`) |
| Cancel | `update appointments set status = 'cancelled' where id = $appt and patient_id = auth.uid()` |

**Status enum:** `scheduled | confirmed | completed | cancelled | no_show`. The bot creates with `scheduled`; transitions to `completed` happen in the existing platform flow (clinician closes the consultation).

**Existing helpers reused:** `has_role(auth.uid(), 'admin'::app_role)` for clinic-staff RLS gates, `is_clinical_director(auth.uid())` if a read-only oversight role is later wanted.

### 6.4 Existing Edge Functions in `addup/equal-care-platform`

For reference — none of these are integration endpoints for the bot, but they affect adjacent behaviour:

| Function | Purpose | Concierge interaction |
| --- | --- | --- |
| `auth-email-hook` | Customizes the OTP email body | Transparent — `signInWithOtp` continues to work |
| `process-email-queue` | Drains the platform's email send queue | None |
| `process-reminder-queue` | Sends 24h appointment reminder **emails** | **Coexists** with our scheduler-worker's Telegram reminder for V1. See PRD §9 risk row. |
| `send-transactional-email`, `preview-transactional-email` | Email send + preview | None |
| `handle-email-unsubscribe`, `handle-email-suppression` | Email-side compliance | None |
| `admin-invite-doctor`, `admin-remove-doctor`, `admin-update-email` | Admin operations on doctors / accounts | None |
| `generate-data-export` | GDPR data export | None |

There is **no** Edge Function for booking, listing, or appointment lifecycle — those operations are exclusively client-side via the two existing RPCs and direct table writes. The concierge does the same.

### 6.5 New RPCs (concierge-owned)

All `security definer`, service role only:

- `concierge_link_telegram(p_telegram_user_id bigint, p_patient_id uuid, p_locale text default 'pt')` — upsert link
- `concierge_unlink_telegram(p_telegram_user_id bigint)` — delete link
- `concierge_lookup_patient_by_telegram(p_telegram_user_id bigint)` returns `(patient_id uuid, locale text)`
- `dispatch_concierge_form(p_id text, p_appointment_id uuid, p_template_id text, p_schedule_label text, p_scheduled_for timestamptz)` — idempotent on `(appointment_id, schedule_label)`
- `mark_concierge_form_sent(p_dispatch_id text, p_is_reminder boolean default false)`
- `record_concierge_form_response(p_dispatch_id text, p_answers jsonb, p_score jsonb)` — idempotent on `dispatch_id`
- `abandon_stale_concierge_dispatches() returns int`
- `log_concierge_action(p_patient_id uuid, p_telegram_user_id bigint, p_intent text, p_action text, p_payload jsonb default '{}')`
- `concierge_set_appointment_state(p_appointment_id uuid, p_field text, p_value timestamptz)` — upsert helper for the four bookkeeping columns

## 7. Form schemas (seed)

### 7.1 PREM (4 questions)

```jsonc
{
  "id": "PREM_v1",
  "kind": "PREM",
  "name": "Experiência da consulta",
  "questions": [
    {
      "id": "nps",
      "type": "scale",
      "min": 0, "max": 10,
      "prompt_pt": "De 0 a 10, qual a probabilidade de recomendares a EQUAL Care a um amigo?",
      "prompt_en": "On 0-10, how likely are you to recommend EQUAL Care to a friend?"
    },
    {
      "id": "wait_time",
      "type": "likert5",
      "prompt_pt": "Como classificas o tempo de espera?",
      "prompt_en": "How would you rate the waiting time?",
      "labels_pt": ["Muito mau","Mau","Razoável","Bom","Muito bom"],
      "labels_en": ["Very poor","Poor","Fair","Good","Very good"]
    },
    {
      "id": "communication",
      "type": "likert5",
      "prompt_pt": "O profissional explicou-te tudo de forma clara?",
      "prompt_en": "Did the professional explain things clearly?"
    },
    {
      "id": "comment",
      "type": "free_text",
      "optional": true,
      "prompt_pt": "Algo que queiras partilhar? (opcional)",
      "prompt_en": "Anything you'd like to share? (optional)"
    }
  ]
}
```

Score: `{ "nps": <0-10>, "nps_segment": "detractor"|"passive"|"promoter", "wait_time": 1-5, "communication": 1-5, "comment": "..." }`.

### 7.2 EQ-5D-5L (PROM)

Use the official Portuguese EQ-5D-5L wording (Ferreira et al. 2014). Five dimensions, each 5 levels:

1. `mobility`
2. `self_care`
3. `usual_activities`
4. `pain_discomfort`
5. `anxiety_depression`

Plus EQ-VAS: 0–100, presented as 11 buttons (0, 10, 20, ..., 100).

Score: `{ "profile": "12321", "eq5d_index": 0.812, "vas": 75 }`. Index computed from Portuguese value set (Ferreira 2014) when locale is PT-PT, UK value set (Devlin 2018) otherwise.

## 8. Telegram callback payload encoding

64-byte limit. Format: `t:<topic>:<args>`

- Form answer: `f:<dispatch_id_10>:q:<idx>:a:<value>` (e.g. `f:V1StGXR8_:q:2:a:4`)
- Booking slot: `b:<short_id_10>` — the slot blob returned by `get_available_slots` is JSON; the DO assigns a 10-char short ID per slot and stores the mapping in KV with 30-min TTL
- Reschedule confirm: `r:<appt_id_10>` (uuid → 10-char shortid in KV)
- Cancel confirm: `x:<appt_id_10>`
- 24h reminder action: `m:<appt_id_10>:<confirm|cancel>`
- Locale switch: `l:pt|en`

## 9. Demo orchestration (for hackathon)

The cron worker runs hourly in production. For the live demo, we expose `POST /admin/cron/run` on the scheduler Worker (gated by an admin secret) that runs the full cron logic on demand. The demo script triggers this between steps to simulate time passing.

The seed includes pre-back-dated appointments such that the first cron run will dispatch PREMs and PROMs immediately for several seeded patients.

## 10. Open questions (post-audit of `addup/equal-care-platform`)

- *(resolved)* **`profiles.registration_completed = false`** → bot blocks booking and redirects to the app. FAQ remains available. The check happens right after `verifyOtp` succeeds, before linking. Implementation: read `profiles.registration_completed` for `data.user.id`; if `false`, reply "Para marcar consultas, termina primeiro o registo na app: <APP_URL>" and stay in a "FAQ-only" state. Do **not** write the `concierge_telegram_links` row in this case — re-check on each `/start` so the patient can retry after finishing registration.
- **Patient identifier in scheduler context.** Service-role queries do `patient_id = profiles.id`. RLS-gated patient queries do `patient_id = auth.uid()`. Same UUID; never confuse the two clients.
- *(resolved)* **Multiple `appointment_types` per specialty.** Bot renders inline buttons, one per active type, labelled by `appointment_types.name`. Patient taps to choose; that selection drives `_appointment_type_id` and `default_duration_min` for the rest of the booking flow. No extra copy beyond the type names themselves.
- *(resolved)* **Dashboard auth.** No auth for the demo. The SPA reads `concierge_form_responses` directly via the Supabase service-role key, which is OK because it runs **locally only**. **Never deploy this dashboard to a public URL as-is** — bundling the service-role key would expose every row in the project. Productionising means switching to Supabase auth + the `has_role(auth.uid(), 'admin')` gate.

## 11. Observability

- Every agent action writes to `concierge_audit_log`
- Worker logs streamed via `wrangler tail` during demo
- Telegram messages stored only as IDs in the audit log (no message content) for privacy

## 12. Deferred (V2+)

- Specialty-specific PROMs (PHQ-9, GAD-7, Oswestry, DASH, ...)
- Multi-channel (WhatsApp, web, voice)
- Pre-consultation intake form (note: platform already has one — bot integration deferred)
- Lab result interpretation
- Prescription renewal
- Insurance reimbursement
- Patient self-registration via bot
- Unifying `concierge_form_responses` with platform `form_responses` if/when product wants a single response store
