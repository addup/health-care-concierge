# Claude Code Prompts — by phase

Copy-paste these one at a time into Claude Code, in order. Each prompt is self-contained but assumes the previous phases are complete and committed.

---

## Phase 0 — Setup

```
Read docs/concierge/CLAUDE.md, 01-PRD.md, 02-tech-spec.md cover-to-cover.

Then:

1. Create the directory structure under apps/concierge/ exactly as
   described in CLAUDE.md "Repo layout (target)".

2. In apps/concierge/concierge-worker/ run `wrangler init` and configure:
   - Durable Object binding `PATIENT_AGENT` → class `PatientAgent`
   - Workers AI binding `AI`
   - Vectorize binding `FAQ_INDEX` (create the index too)
   - KV namespace binding `KV`  (for short-id mappings)
   - Secrets: TELEGRAM_BOT_TOKEN, SUPABASE_URL, SUPABASE_ANON_KEY,
     SUPABASE_SERVICE_KEY (use `wrangler secret put`)

3. In apps/concierge/scheduler-worker/ run `wrangler init` and configure:
   - Cron trigger "0 * * * *"
   - Service binding to concierge-worker (so it can call DO methods)
   - Same Supabase secrets and TELEGRAM_BOT_TOKEN

4. Place docs/concierge/03-migration.sql at
   supabase/migrations/<NEW_TIMESTAMP>_concierge.sql.
   Run `supabase migration up` locally, fix any FK issues against the
   existing schema, and report back the actual column types you
   encountered. Do NOT modify the existing tables beyond the additive
   ALTERs already in the migration.

5. Verify both workers boot with `wrangler dev`. They should compile
   and respond 200 to `/healthz` even with empty handlers.

Stop here, show me the wrangler.toml for both workers and the SQL
migration as actually applied (after any tweaks for schema mismatch).
```

---

## Phase 1 — Skeleton bot (`/start` + OTP linking)

```
Implement the /start flow per docs/concierge/01-PRD.md §6.1 and tech
spec §2.

Specifically:

1. apps/concierge/concierge-worker/src/index.ts
   - POST /webhook/telegram parses Update, extracts from.id (Telegram
     user ID), looks up `patient:${supabase_patient_id}` if linked,
     else uses `tg:${telegram_user_id}` namespace
   - Forwards request to the Durable Object via fetch
   - Returns 200

2. apps/concierge/concierge-worker/src/patient-agent.ts (Durable Object)
   - State keys per tech spec §2.2
   - handleUpdate dispatches to handleCommand / handleText / handleCallback
   - /start command:
     - If already linked, greet by name and show main menu
     - Else: ask for email
   - Free text handler:
     - If awaiting email → call existing RPC auth_request_otp
       (CONFIRM the exact RPC name against the actual repo first;
        if it doesn't exist, list what does and ask me)
     - If awaiting OTP → call auth_verify_otp; on success, look up
       patient_id from session, write telegram_links via service-role
       client, store auth in DO storage, greet
   - Stub all other intents with "Funcionalidade em construção"

3. apps/concierge/concierge-worker/src/telegram.ts
   - sendMessage, sendChatAction, answerCallbackQuery
   - Always call sendChatAction:typing before any LLM call later

4. apps/concierge/concierge-worker/src/supabase.ts
   - Two factory functions: serviceClient(), patientClient(jwt)
   - Both reuse one createClient call per worker invocation

5. apps/concierge/concierge-worker/src/i18n.ts
   - Minimal PT/EN string table; auto-detect locale from first text
     ("hello"/"hi"/"hey" → en; default pt-PT)

When done:
- Manually test: /start, send email, send OTP, get greeted
- Show me a screen recording or transcript of the chat
- Don't implement anything else this phase.
```

---

## Phase 2 — Booking (BOOK / RESCHEDULE / CANCEL / FAQ / LIST)

```
Read docs/concierge/02-tech-spec.md §3, §5, §8.

1. apps/concierge/concierge-worker/src/intent.ts
   - Single classify(text, locale) function
   - Workers AI Llama 3.3 70B (fp8-fast variant), JSON mode, 2s timeout
   - On timeout fall back to a tiny rule-based classifier covering
     "marcar/agendar/book", "cancelar/cancel", "reagendar/reschedule",
     and 2-3 FAQ regex hits ("morada", "horário", "telefone")
   - Returns the schema in tech spec §3
   - Logs every classification to agent_audit_log

2. apps/concierge/concierge-worker/src/booking.ts
   - bookFlow(do_state, parsed_intent): drives the BOOK turn machine
     - if specialty unknown → ask
     - call list_availability via patientClient → up to 6 slots
     - render inline keyboard (callback_data: b:<short_id>)
     - on slot tap → call create_appointment, confirm
   - rescheduleFlow / cancelFlow: get list_my_appointments, pick one
     via inline keyboard, then proceed
   - Short-ID mapping: when slot/appointment IDs exceed 10 chars,
     write a kv pair short_id → uuid in DO storage with 30min TTL

3. apps/concierge/concierge-worker/src/faq.ts
   - faqLookup(query, locale)
   - Embed via @cf/baai/bge-m3
   - Top-3 from Vectorize FAQ_INDEX
   - If top score > 0.75 return answer directly; else compose with
     LLM using the 3 retrieved FAQs as context
   - Add seedFaq.ts script (one-shot) that loads 20 PT + 20 EN FAQs.
     Use the FAQ list at the bottom of this prompt.

4. Wire all of the above through patient-agent.ts router. Replace
   the "em construção" stubs.

5. Test scripts:
   - scripts/test-book.ts — simulates the full booking flow
   - scripts/test-cancel.ts

Show me each command tested end-to-end.

FAQ seed list (PT, expand mentally to EN):
- Onde fica a clínica?
- Quais os horários de funcionamento?
- Que especialidades têm?
- Que seguros aceitam?
- Como pago?
- Há estacionamento?
- Como devo preparar a primeira consulta?
- Posso levar acompanhante?
- Fazem teleconsultas?
- Como cancelo uma consulta?
- (etc., 20 total)
```

---

## Phase 3 — Triage

```
Implement triage per PRD §6.2 and tech spec §4.

1. apps/concierge/concierge-worker/src/triage.ts
   - State machine in DO: max 4 turns
   - Each turn: LLM call with system prompt
     "Es um clínico geral a fazer triagem inicial em PT-PT. Não
      diagnostiques. Faz UMA pergunta de cada vez. Após 2-4 perguntas,
      emite JSON: {specialty, urgency: 'routine'|'soon'|'red_flag',
      summary}."
   - Red-flag whitelist hard-coded as a pre-LLM regex check on the
     patient's free text (chest pain, dispneia súbita, etc.)
     If matched → urgency='red_flag' immediately, skip booking.
   - On non-red-flag completion → handoff to bookFlow with prefilled
     specialty.

2. Add TRIAGE intent handling to patient-agent.ts router.

3. Tests:
   - scripts/test-triage-routine.ts — "dói-me a barriga há 3 dias"
   - scripts/test-triage-redflag.ts — "tenho dor no peito a irradiar
     para o braço esquerdo"

Show me both tests passing.
```

---

## Phase 4 — Forms (PREM + EQ-5D-5L)

```
Implement the form runner per PRD §6.5, §6.6 and tech spec §7.

1. apps/concierge/concierge-worker/src/forms/runner.ts
   - startDispatch(dispatchId): loads template from form_templates,
     stores form_state in DO storage, sends first question
   - handleAnswer(callbackData): parses f:<id>:q:<n>:a:<v>, advances
     cursor, sends next question. On last question → compute score,
     call record_form_response RPC, clear form_state.

2. apps/concierge/concierge-worker/src/forms/prem.ts
   - renderQuestion(q, locale)
   - scorePREM(answers) — emits {nps, nps_segment, wait_time,
     communication, comment}

3. apps/concierge/concierge-worker/src/forms/eq5d5l.ts
   - renderQuestion(q, locale): each dimension is a single message
     with 5 inline buttons (1..5). VAS is 11 buttons (0,10,...,100).
   - scoreEQ5D5L(answers, locale): returns
     {profile: '12321', eq5d_index: number, vas: number}

4. apps/concierge/shared/eq5d5l-scoring.ts
   - Portuguese value set (Ferreira 2014) and UK value set
     (Devlin 2018) as lookup tables. The function accepts a 5-digit
     profile string and a locale.
   - IMPORTANT: do not paraphrase the question wording. Use the
     literal strings from supabase/seed/<...>/03-migration.sql
     form_templates.schema. The wording is licensed by EuroQol;
     hardcoded literals are sourced from the migration file.

5. End-to-end test: scripts/test-form-prem.ts and
   scripts/test-form-eq5d5l.ts simulate a dispatch and run through
   all questions, asserting that record_form_response was called with
   the correct score.

Show me both tests passing and the resulting form_responses rows in
Supabase.
```

---

## Phase 5 — Scheduler (cron + reminders)

```
Implement scheduler per tech spec §2.3 and PRD §6.4, §6.7.

1. apps/concierge/scheduler-worker/src/index.ts
   - scheduled() handler — runs every hour
   - POST /admin/cron/run — gated by ADMIN_SECRET (header check)
   - Both call the same runOnce() function

2. apps/concierge/scheduler-worker/src/reminders.ts
   - send24hReminders():
     SELECT appointments WHERE start_at BETWEEN now()+23h AND now()+25h
                          AND reminder_sent_at IS NULL
     For each: push message via service binding to concierge-worker DO,
     set reminder_sent_at via service-role update.

3. apps/concierge/scheduler-worker/src/dispatches.ts
   - createPostConsultDispatches():
     - PREM at end_at + 24h
     - PROM_T7d at end_at + 7d
     - PROM_T28d at end_at + 28d
     Idempotent on (appointment_id, schedule_label).
   - sendDueDispatchesAndReminders():
     - Query the union: due-initial OR due-48h-reminder OR due-7d-reminder
     - For each: push message to DO (DO entry point: dispatchExternal)
     - Update sent_at or reminder_count + last_reminder_at
   - markAbandoned():
     - call abandon_stale_dispatches() RPC

4. apps/concierge/concierge-worker/src/patient-agent.ts
   - Add dispatchExternal({type, payload}) RPC method on the DO,
     invoked via service binding. Types: 'reminder', 'form_dispatch'.
     Each delegates to existing renderers.

5. Test:
   - Insert a synthetic appointment with end_at = now()-24h
   - POST /admin/cron/run with the secret
   - Confirm a PREM dispatch row was created and a Telegram message
     was sent
   - Answer the PREM in chat; confirm form_responses row appears.

Show me wrangler.toml cron config and an end-to-end test transcript.
```

---

## Phase 6 — Clinic dashboard

```
Add two pages to apps/platform/ (the existing Next.js app).

1. apps/platform/app/clinica/proms/page.tsx
   - Server component, queries form_responses joined with patients
     and form_templates where template_id = 'EQ5D5L_v1'
   - Shows:
     a) A patient picker (search by name)
     b) For the chosen patient: a line chart (recharts) of
        eq5d_index over time
     c) Below the chart: a table of all responses with profile,
        index, VAS
   - PT-PT UI

2. apps/platform/app/clinica/prems/page.tsx
   - Server component, queries form_responses where template_id =
     'PREM_v1' from the last 90 days
   - Shows:
     a) NPS metric: % promoters - % detractors, big number
     b) Histogram of NPS scores 0-10
     c) Likert distribution for wait_time and communication
     d) Recent comments list (free_text answers)
   - PT-PT UI

3. Auth: both pages require role 'clinic_staff' (use the existing
   middleware/auth pattern in this app — DO NOT roll a new one).

4. Add nav links from the existing clinic dashboard.

Test by signing in as a clinic_staff user and verifying the seed
patients show up.
```

---

## Phase 7 — Demo polish + seed

```
1. Implement docs/concierge/04-seed.sql in full.
   - Read the actual appointments schema, fill in the appointment
     INSERTs with end_at back-dated per the narrative comments
     (segments A/B/C/D)
   - Generate form_dispatches and form_responses for each completed
     consultation per the narrative
   - Use deterministic dispatch IDs like p01a1prem, p04a2promt7, etc.

2. Run the seed; verify the dashboard shows the expected story:
   - At least one patient with rising EQ-5D index over 2 consults
   - At least one with falling
   - One PREM with NPS=3 and the negative comment visible

3. Demo script:
   - Open Telegram → /start as Pedro's account → triage "dor de
     cabeça intensa há 2 dias" → bot suggests Medicina Geral →
     book Thursday 09:30
   - Open dashboard /clinica/proms → show Diogo Marques' EQ-5D rising
   - Open dashboard /clinica/prems → show NPS distribution and
     critical comment from Inês

4. Record a 90-second backup video; place at docs/concierge/demo.mp4.

5. Five-slide pitch deck draft (markdown ok):
   - Problem: clinic no-shows + zero patient outcome data
   - Solution: AI concierge in Telegram + auto PROM/PREM
   - Demo screenshots
   - Architecture diagram (Cloudflare primitives highlighted)
   - Roadmap (specialty PROMs, multi-channel, SNS integration)
```
