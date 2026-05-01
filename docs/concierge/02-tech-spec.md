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
        │  Supabase (Postgres)                │
        │  ─ existing: patients, appointments,│
        │    professionals, specialties       │
        │  ─ new: form_templates,             │
        │    form_dispatches, form_responses, │
        │    telegram_links, agent_audit_log  │
        │  ─ existing RPCs: auth_request_otp, │
        │    auth_verify_otp, list_avail...   │
        │  ─ new RPCs: dispatch_form,         │
        │    record_form_response, ...        │
        └─────────────┬───────────────────────┘
                      │
                      │ realtime / direct query
                      ▼
        ┌─────────────────────────────────────┐
        │  Next.js dashboard (existing)       │
        │  ─ /clinica/proms (new page)        │
        │  ─ /clinica/prems (new page)        │
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

## 2. Cloudflare Workers

### 2.1 `concierge` Worker

**Bindings:**
- `AI` — Workers AI binding
- `PATIENT_AGENT` — Durable Object namespace `PatientAgent`
- `FAQ_INDEX` — Vectorize index for FAQ embeddings
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` — secrets
- `TELEGRAM_BOT_TOKEN` — secret

**Routes:**
- `POST /webhook/telegram` — receives updates, routes to DO by Telegram user ID
- `POST /admin/setup-webhook` — one-shot, sets Telegram webhook to this Worker URL
- `GET /healthz` — health check

**Single responsibility:** parse incoming Telegram update → look up Telegram user → forward to a Durable Object instance (`patient:${telegram_user_id}`) → return `200 OK`.

### 2.2 `PatientAgent` Durable Object

**Storage keys:**
- `auth` — `{ patient_id, supabase_session, linked_at } | null`
- `pending_otp` — `{ email, attempts, expires_at } | null`
- `intent_state` — current multi-turn intent (TRIAGE, BOOK, RESCHEDULE, FORM)
- `triage_state` — `{ symptoms: [...], turn: n, summary: '...' }`
- `form_state` — `{ dispatch_id, template, cursor, answers: {...} }`
- `last_message_at` — timestamp
- `locale` — `'pt-PT' | 'en'` (auto-detected from first text, can be overridden)

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

**Logic per run:**
1. `SELECT * FROM appointments WHERE start_at BETWEEN now()+23h AND now()+25h AND reminder_sent_at IS NULL` → send 24h reminder, set `reminder_sent_at`
2. `SELECT * FROM appointments WHERE end_at <= now()-24h AND prem_dispatched_at IS NULL` → create `form_dispatches` row (kind=PREM), then process below
3. `SELECT * FROM appointments WHERE end_at <= now()-7d AND prom_t7_dispatched_at IS NULL` → create `form_dispatches` row (kind=PROM, schedule_label='T+7d')
4. Same for T+28d
5. `SELECT * FROM form_dispatches WHERE completed_at IS NULL AND abandoned_at IS NULL AND ((sent_at IS NULL AND scheduled_for <= now()) OR (sent_at IS NOT NULL AND reminder_count = 0 AND sent_at <= now()-48h) OR (sent_at IS NOT NULL AND reminder_count = 1 AND sent_at <= now()-7d))` → for each, look up `telegram_links`, push to `PatientAgent`, increment `reminder_count` or set `sent_at`
6. `UPDATE form_dispatches SET abandoned_at = now() WHERE reminder_count >= 2 AND sent_at <= now()-9d AND completed_at IS NULL`

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

### 6.1 New tables

```sql
-- Maps Telegram users to EqualCare patients
create table telegram_links (
  telegram_user_id  bigint primary key,
  patient_id        uuid not null references patients(id) on delete cascade,
  linked_at         timestamptz not null default now(),
  last_active_at    timestamptz not null default now(),
  locale            text not null default 'pt-PT'
);

create index on telegram_links(patient_id);

-- Form templates (PREM and EQ-5D-5L only in V1)
create table form_templates (
  id          text primary key,
  kind        text not null check (kind in ('PREM','PROM')),
  name        text not null,
  schema      jsonb not null,
  version     int  not null default 1,
  created_at  timestamptz not null default now()
);

-- One row per scheduled form send (PREM at T+24h, PROM at T+7d and T+28d)
create table form_dispatches (
  id                text primary key,                -- nanoid(10)
  appointment_id    uuid not null references appointments(id) on delete cascade,
  patient_id        uuid not null references patients(id) on delete cascade,
  template_id       text not null references form_templates(id),
  schedule_label    text not null,                   -- 'PREM_T24h' | 'PROM_T7d' | 'PROM_T28d'
  scheduled_for     timestamptz not null,
  sent_at           timestamptz,
  reminder_count    int not null default 0,
  last_reminder_at  timestamptz,
  completed_at      timestamptz,
  abandoned_at      timestamptz,
  channel           text not null default 'telegram'
);

create index on form_dispatches (scheduled_for) where sent_at is null;
create index on form_dispatches (sent_at) where completed_at is null and abandoned_at is null;
create index on form_dispatches (patient_id);

-- Form responses
create table form_responses (
  id            uuid primary key default gen_random_uuid(),
  dispatch_id   text not null unique references form_dispatches(id) on delete cascade,
  patient_id    uuid not null references patients(id) on delete cascade,
  template_id   text not null references form_templates(id),
  answers       jsonb not null,    -- { "mobility":1, "self_care":2, ... } or { "nps":9, ... }
  score         jsonb not null,    -- { "eq5d_index":0.812, "vas":75 } or { "nps_segment":"promoter" }
  completed_at  timestamptz not null default now()
);

create index on form_responses (patient_id, completed_at);

-- Audit log for the agent (one row per agent action)
create table agent_audit_log (
  id            uuid primary key default gen_random_uuid(),
  patient_id    uuid references patients(id) on delete set null,
  telegram_user_id bigint,
  intent        text,
  action        text not null,         -- 'book','reschedule','cancel','triage','faq','form_send','form_complete'
  payload       jsonb,
  created_at    timestamptz not null default now()
);
```

### 6.2 New RLS policies

- `telegram_links`: only service role and the matching patient can read; only service role can write
- `form_dispatches`: only service role can write; matching patient can read their own
- `form_responses`: only service role can write; matching patient and clinic staff can read
- `agent_audit_log`: only service role and clinic staff (admin) can read

### 6.3 New / required RPCs

The agent calls these via Supabase JS with the patient's session JWT (so RLS applies) where possible, and via service role only for cross-patient operations (scheduler).

To be confirmed against existing repo:

- `auth_request_otp(p_email text)` — assumed to exist
- `auth_verify_otp(p_email text, p_code text)` — assumed to exist; should return session
- `list_availability(p_specialty text, p_from timestamptz, p_to timestamptz)` — assumed to exist
- `create_appointment(p_slot_id, p_patient_id, p_notes)` — assumed to exist
- `reschedule_appointment(p_appointment_id, p_new_slot_id)` — assumed to exist
- `cancel_appointment(p_appointment_id)` — assumed to exist
- `list_my_appointments(p_patient_id, p_from, p_to)` — assumed to exist

**New RPCs to author:**
- `link_telegram(p_telegram_user_id bigint, p_patient_id uuid, p_locale text)` — service role
- `unlink_telegram(p_telegram_user_id bigint)` — service role
- `dispatch_form(p_appointment_id uuid, p_template_id text, p_schedule_label text, p_scheduled_for timestamptz)` — service role
- `record_form_response(p_dispatch_id text, p_answers jsonb, p_score jsonb)` — service role; idempotent on (dispatch_id)

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

Use the official Portuguese EQ-5D-5L wording (Ferreira et al. 2014). Five dimensions, each 5 levels (no problems → extreme problems / unable):

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
- Booking slot: `b:<slot_id_10>` (slot IDs must be ≤ 10 chars; if longer, store mapping in DO storage)
- Reschedule confirm: `r:<appt_id_10>`
- Cancel confirm: `x:<appt_id_10>`
- 24h reminder action: `m:<appt_id_10>:<confirm|cancel>`
- Locale switch: `l:pt|en`

If the existing system uses UUIDs > 10 chars, the DO maintains a short-id ↔ uuid map per session.

## 9. Demo orchestration (for hackathon)

The cron worker runs hourly in production. For the live demo, we expose `POST /admin/cron/run` on the scheduler Worker (gated by an admin secret) that runs the full cron logic on demand. The demo script triggers this between steps to simulate time passing.

The seed includes pre-back-dated appointments such that the first cron run will dispatch PREMs and PROMs immediately for several seeded patients.

## 10. Observability

- Every agent action writes to `agent_audit_log`
- Worker logs streamed via `wrangler tail` during demo
- Telegram messages stored only as IDs in audit log (no message content) for privacy

## 11. Deferred (V2+)

- Specialty-specific PROMs (PHQ-9, GAD-7, Oswestry, DASH, ...)
- Multi-channel (WhatsApp, web, voice)
- Pre-consultation intake form
- Lab result interpretation
- Prescription renewal
- Insurance reimbursement
- Patient self-registration via bot
