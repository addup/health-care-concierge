# Claude Code Prompts — by phase

Copy-paste these one at a time into Claude Code, in order. Each prompt is self-contained but assumes the previous phases are complete and committed.

> Context for every phase: the **only** repo you modify is `addup/health-care-concierge` (this one). The companion repo `addup/equal-care-platform` (Vite + React SPA) is read-only — we share its Supabase project but never edit its source. When the prompts say "the existing schema", they mean the schema already in that Supabase project as of the platform's last applied migration.

---

## Phase 0 — Setup

```
Read CLAUDE.md, docs/concierge/01-PRD.md, and docs/concierge/02-tech-spec.md cover-to-cover.

Then:

1. Create the directory structure at the repo root (no apps/ wrapper):
     concierge-worker/
     scheduler-worker/
     shared/
     supabase/migrations/
     supabase/seed/
     dashboard/   (empty placeholder; Phase 6)

2. In concierge-worker/ run `wrangler init` and configure:
   - Durable Object binding `PATIENT_AGENT` → class `PatientAgent`
   - Workers AI binding `AI`
   - Vectorize binding `FAQ_INDEX` (also create the index via wrangler)
   - KV namespace binding `KV` (for short-id ↔ uuid mappings)
   - Secrets: TELEGRAM_BOT_TOKEN, SUPABASE_URL, SUPABASE_ANON_KEY,
     SUPABASE_SERVICE_KEY (use `wrangler secret put`)

3. In scheduler-worker/ run `wrangler init` and configure:
   - Cron trigger "0 * * * *"
   - Service binding to concierge-worker (so it can call DO methods)
   - Same Supabase secrets and TELEGRAM_BOT_TOKEN
   - Plus ADMIN_SECRET (for /admin/cron/run gating)

4. Copy docs/concierge/03-migration.sql to
   supabase/migrations/<NEW_TIMESTAMP>_concierge.sql.

   Apply it to the Supabase project (`supabase db push` or via the
   dashboard SQL editor). Before running, sanity-check by reading
   the platform repo's schema files mentally — every FK we declare
   targets profiles(id) or appointments(id), both of which exist.
   Report back any error and the resolution.

5. Copy the platform's generated DB types (from
   addup/equal-care-platform/src/integrations/supabase/types.ts)
   into shared/db-types.ts. This is the source of truth for our
   typed Supabase client. (Re-copy whenever the platform schema
   changes.)

6. Verify both workers boot with `wrangler dev`. They should compile
   and respond 200 to `/healthz` with empty handlers.

Stop here. Show me both wrangler.toml files and confirm that the
migration applied cleanly.

What you should NOT have done:
- Modified anything in addup/equal-care-platform
- Touched the existing forms / form_responses / form_versions tables
- Introduced any auth_request_otp / auth_verify_otp / list_availability
  / create_appointment / reschedule_appointment / cancel_appointment /
  list_my_appointments RPCs (none of those exist; all are direct table
  ops or Supabase native auth — see Phase 1 and Phase 2)
```

---

## Phase 1 — Skeleton bot (`/start` + Supabase native OTP)

```
Implement the /start flow per docs/concierge/01-PRD.md §6.1 and tech spec §2.

Authentication uses Supabase Auth NATIVE methods, not custom RPCs:
  await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false }
  })
  // patient pastes the 6-digit code
  await supabase.auth.verifyOtp({ email, token, type: 'email' })
  // data.user.id IS the patient_id (profiles.id = auth.users.id)

Specifically:

1. concierge-worker/src/index.ts
   - POST /webhook/telegram parses Update, extracts from.id
   - First call: lookup `concierge_lookup_patient_by_telegram(...)`
     - If linked → DO id `patient:${patient_uuid}`
     - If not   → DO id `tg:${telegram_user_id}` (pre-link namespace)
   - Forwards request to the Durable Object via fetch
   - Returns 200

2. concierge-worker/src/patient-agent.ts (Durable Object)
   - State keys per tech spec §2.2
   - handleUpdate dispatches to handleCommand / handleText / handleCallback
   - /start command:
     - If already linked, greet by chosen_name (from profiles)
       and show the main menu
     - Else: ask for email
   - Free text handler:
     - If awaiting email → call supabase.auth.signInWithOtp with
       shouldCreateUser: false. On error "User not found" reply:
       "Não encontrei essa conta. Cria primeiro a conta na app."
     - If awaiting OTP   → call supabase.auth.verifyOtp({type:'email'})
       On success: data.user.id IS the patient UUID.
       Read profiles.registration_completed for that id (service role).
         - If false → reply "Para marcar consultas, termina primeiro
           o registo na app: <APP_URL>." Do NOT call
           concierge_link_telegram. Set DO state to a FAQ-only mode
           (faq still works, booking/triage refuse with the same copy).
           Do not auto-retry; the patient sends /start again after
           finishing registration in the app.
         - If true → call concierge_link_telegram(...) via service role.
           Cache the session in DO storage. Greet using
           profiles.chosen_name.
   - Stub all other intents: "Funcionalidade em construção"

3. concierge-worker/src/telegram.ts
   - sendMessage, sendChatAction, answerCallbackQuery
   - Always call sendChatAction:typing before any LLM call later

4. concierge-worker/src/supabase.ts
   - Two factory functions: serviceClient(), patientClient(jwt)
   - Strongly typed via shared/db-types.ts

5. concierge-worker/src/i18n.ts
   - PT/EN string table; default 'pt' (matches profiles.preferred_language)
   - Auto-detect locale: "hello"/"hi"/"hey" first → 'en', else 'pt'

When done:
- Manually test: /start, send email, send OTP, get greeted
- Show me a transcript of the chat
- Don't implement anything else this phase.
```

---

## Phase 2 — Booking (BOOK / RESCHEDULE / CANCEL / FAQ / LIST)

```
Read docs/concierge/02-tech-spec.md §3, §5, §6.3, §8.

There are NO booking RPCs. The integration with the platform is:

  - SELECT specialties WHERE is_active = true       → list specialties
  - SELECT appointment_types WHERE specialty_id=... → resolve type
       (also gives default_duration_min)
  - rpc('get_available_slots', {                    → list slots
       _appointment_type_id, _target_date, _doctor_id_filter
     })
  - rpc('check_slot_available', {                   → race-check
       _doctor_id, _scheduled_at, _duration_min
     })
  - INSERT INTO appointments (patient_id, doctor_id,
       appointment_type_id, scheduled_at, duration_min,
       status='scheduled')                          → create
  - UPDATE appointments SET scheduled_at=...        → reschedule
       (preceded by check_slot_available)
  - UPDATE appointments SET status='cancelled'      → cancel
  - SELECT * FROM appointments
       WHERE patient_id = auth.uid()
       ORDER BY scheduled_at                        → list mine

All of the above except slot RPCs are RLS-gated; use patientClient(jwt).

1. concierge-worker/src/intent.ts
   - classify(text, locale) → JSON per tech spec §3
   - Workers AI Llama 3.3 70B (fp8-fast variant), JSON mode, 2s timeout
   - On timeout fall back to a tiny rule-based classifier covering
     "marcar/agendar/book", "cancelar/cancel", "reagendar/reschedule",
     and 2-3 FAQ regex hits ("morada", "horário", "telefone")
   - Logs every classification to concierge_audit_log via
     log_concierge_action(...)

2. concierge-worker/src/booking.ts
   - bookFlow(do_state, parsed_intent):
     a. If specialty unknown → list active specialties, render keyboard
     b. Resolve specialty → appointment_type_id:
          select id, name, default_duration_min from appointment_types
          where specialty_id = $1 and is_active = true
        - 1 row  → auto-pick
        - >1 row → render inline buttons (one per type, label = name,
          callback_data t:<short>) and wait for the tap. Store the
          chosen type's default_duration_min in DO state so the rest
          of the flow (slot RPC + insert) uses it.
     c. Ask "para que dia?" (today / tomorrow / pick) → call
        get_available_slots with the resolved appointment_type_id
        and target_date
     d. Render up to 6 slots as inline buttons. Each slot blob from
        get_available_slots is JSON; assign a 10-char short ID per
        slot, store mapping in KV (TTL 30min), put short ID in
        callback_data b:<short>
     e. On slot tap → check_slot_available, then INSERT appointments.
        On INSERT failure (e.g. RLS) report "Não consegui marcar.
        Tenta outra vez."
   - rescheduleFlow / cancelFlow:
     - SELECT appointments WHERE patient_id = auth.uid() AND
       status IN ('scheduled','confirmed') → list with inline keyboard
     - For reschedule: same slot-pick UX as booking, then UPDATE
     - For cancel: confirm prompt, then UPDATE status='cancelled'

3. concierge-worker/src/faq.ts
   - faqLookup(query, locale)
   - Embed via @cf/baai/bge-m3
   - Top-3 from Vectorize FAQ_INDEX
   - If top score > 0.75 return answer directly; else compose with
     LLM using the 3 retrieved FAQs as context
   - Add scripts/seed-faq.ts (one-shot) that loads ~20 PT + ~20 EN FAQs.

4. Wire all of the above through patient-agent.ts router. Replace
   the "em construção" stubs.

5. Test scripts:
   - scripts/test-book.ts — full booking against a seeded slot
   - scripts/test-cancel.ts
   - scripts/test-reschedule.ts

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

1. concierge-worker/src/triage.ts
   - State machine in DO: max 4 turns
   - Each turn: LLM call with system prompt
     "És um clínico geral a fazer triagem inicial em PT-PT. Não
      diagnostiques. Faz UMA pergunta de cada vez. Após 2-4 perguntas,
      emite JSON: {specialty, urgency: 'routine'|'soon'|'red_flag',
      summary}."
   - Red-flag whitelist hard-coded as a pre-LLM regex check on the
     patient's free text (chest pain, dispneia súbita, etc.)
     If matched → urgency='red_flag' immediately, skip booking.
     Surface 112 / urgent care text per PRD §6.2.
   - On non-red-flag completion → handoff to bookFlow with prefilled
     specialty (resolved to appointment_type_id via
     appointment_types.specialty_id).

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

All RPCs are concierge-namespaced — record_concierge_form_response,
mark_concierge_form_sent, dispatch_concierge_form. The tables are
concierge_form_templates / concierge_form_dispatches /
concierge_form_responses. Do NOT touch the platform's `forms`,
`form_versions`, or `form_responses` tables — those are intake forms.

1. concierge-worker/src/forms/runner.ts
   - startDispatch(dispatchId): loads template from
     concierge_form_templates, stores form_state in DO storage,
     sends first question
   - handleAnswer(callbackData): parses f:<id>:q:<n>:a:<v>, advances
     cursor, sends next question. On last question → compute score,
     call record_concierge_form_response RPC, clear form_state.

2. concierge-worker/src/forms/prem.ts
   - renderQuestion(q, locale)
   - scorePREM(answers) — emits {nps, nps_segment, wait_time,
     communication, comment}

3. concierge-worker/src/forms/eq5d5l.ts
   - renderQuestion(q, locale): each dimension is a single message
     with 5 inline buttons (1..5). VAS is 11 buttons (0,10,...,100).
   - scoreEQ5D5L(answers, locale): returns
     {profile: '12321', eq5d_index: number, vas: number}

4. shared/eq5d5l-scoring.ts
   - Portuguese value set (Ferreira 2014) and UK value set
     (Devlin 2018) as lookup tables. The function accepts a 5-digit
     profile string and a locale.
   - IMPORTANT: do not paraphrase the question wording. Use the
     literal strings in supabase/migrations/<...>_concierge.sql
     concierge_form_templates.schema. Hardcoded literals only.

5. End-to-end test: scripts/test-form-prem.ts and
   scripts/test-form-eq5d5l.ts simulate a dispatch and run through
   all questions, asserting that record_concierge_form_response was
   called with the correct score.

Show me both tests passing and the resulting concierge_form_responses
rows in Supabase.
```

---

## Phase 5 — Scheduler (cron + reminders)

```
Implement scheduler per tech spec §2.3 and PRD §6.4, §6.7.

Per-appointment bookkeeping does NOT live in the appointments table.
Use concierge_appointment_state via the helper RPC
concierge_set_appointment_state(p_appointment_id, p_field, p_value).

Compute the consultation end as
  scheduled_at + (duration_min || ' minutes')::interval
because appointments has no end_at column.

Note: the platform already has a `process-reminder-queue` Edge
Function that sends 24h-reminder EMAILS. V1 decision = coexist:
Telegram + email both fire, no platform changes.

1. scheduler-worker/src/index.ts
   - scheduled() handler — runs every hour
   - POST /admin/cron/run — gated by ADMIN_SECRET (header check)
   - Both call the same runOnce() function

2. scheduler-worker/src/reminders.ts
   - send24hReminders():
       SELECT a.*, p.id AS patient_id
       FROM appointments a
       LEFT JOIN concierge_appointment_state s ON s.appointment_id = a.id
       JOIN profiles p ON p.id = a.patient_id
       WHERE a.scheduled_at BETWEEN now()+'23 hours' AND now()+'25 hours'
         AND a.status IN ('scheduled','confirmed')
         AND s.reminder_sent_at IS NULL
     For each: push message via service binding to concierge-worker
     DO; then concierge_set_appointment_state(id, 'reminder_sent_at', now()).

3. scheduler-worker/src/dispatches.ts
   - createPostConsultDispatches():
       For each completed appointment whose end is past N (24h, 7d, 28d):
         dispatch_concierge_form(...) and concierge_set_appointment_state.
     Idempotent on (appointment_id, schedule_label) by RPC contract.
   - sendDueDispatchesAndReminders():
     Query the union: due-initial OR due-48h-reminder OR due-7d-reminder
     For each: push message to DO entry point dispatchExternal.
     Call mark_concierge_form_sent(dispatch_id) (or with is_reminder=true).
   - markAbandoned(): call abandon_stale_concierge_dispatches() RPC.

4. concierge-worker/src/patient-agent.ts
   - Add dispatchExternal({type, payload}) method on the DO,
     invoked via service binding. Types: 'reminder', 'form_dispatch'.
     Each delegates to existing renderers.

5. Test:
   - Insert a synthetic completed appointment with
     scheduled_at = now() - '25 hours' and duration_min = 30
   - POST /admin/cron/run with the secret
   - Confirm a PREM concierge_form_dispatches row was created and a
     Telegram message was sent
   - Answer the PREM in chat; confirm concierge_form_responses row appears.

Show me wrangler.toml cron config and an end-to-end test transcript.
```

---

## Phase 6 — Standalone clinic dashboard

```
Build a small standalone Vite + React + Tailwind SPA inside
dashboard/ of THIS repo. Do not touch addup/equal-care-platform.

Auth: NONE for the demo. The dashboard runs locally only and
queries Supabase using the service-role key (read from a local
.env). Add a big banner at the top: "DEMO ONLY — local use only,
do not deploy". Productionising will require Supabase auth + the
has_role(auth.uid(), 'admin') gate, but that's deferred.

1. dashboard/src/pages/PromsPage.tsx
   - Patient picker (search by chosen_name)
   - For the chosen patient: line chart (recharts) of eq5d_index
     over completed_at, plus a table of all responses with profile,
     index, VAS
   - Query: SELECT score, completed_at FROM concierge_form_responses
     WHERE template_id = 'EQ5D5L_v1' AND patient_id = $1
     ORDER BY completed_at

2. dashboard/src/pages/PremsPage.tsx
   - From last 90d of concierge_form_responses where
     template_id = 'PREM_v1':
     a. NPS metric: % promoters - % detractors (big number)
     b. Histogram of NPS scores 0-10
     c. Likert distribution for wait_time and communication
     d. Recent free-text comments

3. Routing: react-router-dom. Two routes /proms and /prems plus a
   simple top-nav. PT-PT UI throughout.

4. Build & run: `bun run dev` at dashboard/. Local-only — no deploy,
   no auth.

Test: open the dashboard locally, both pages load, the seed patients
show up. Don't ship this past localhost.
```

---

## Phase 7 — Demo polish + seed

```
1. Implement the patient-creation companion:
   scripts/seed-patients.ts that uses supabase.auth.admin.createUser
   to create the 10 seed users with the deterministic UUIDs in
   docs/concierge/04-seed.sql, then UPDATEs the resulting profiles
   rows to set role='patient', registration_completed=true,
   accepted_terms_version='v1', chosen_name, phone, preferred_language.

2. Then implement the appointments + dispatches + responses block in
   docs/concierge/04-seed.sql.
   - Read the actual appointment_types names in this Supabase project
     and choose three (Medicina Geral / Nutrição / Psicologia).
     If the names differ, update the CTEs in 04-seed.sql.
   - Generate ~30 appointment INSERTs with scheduled_at back-dated
     per the narrative, all status='completed' except one P10
     future-dated to exercise the 24h reminder path.
   - Generate concierge_form_dispatches and concierge_form_responses
     for each completed consultation per the narrative.
   - Use deterministic dispatch IDs like p01a1prem, p04a2pr7d, etc.

3. Run the seed; verify the dashboard shows the expected story:
   - At least one patient with rising EQ-5D index over 2 consults
   - At least one with falling
   - One PREM with NPS=3 and the negative comment visible

4. Demo script (90 seconds):
   - Open Telegram → /start as Pedro's account → triage "dor de
     cabeça intensa há 2 dias" → bot suggests Medicina Geral → book
   - Open dashboard /proms → show Diogo Marques' EQ-5D rising
   - Open dashboard /prems → show NPS distribution and critical
     comment from Inês

5. Record a 90-second backup video; place at docs/concierge/demo.mp4.

6. Five-slide pitch deck draft (markdown ok):
   - Problem: clinic no-shows + zero patient outcome data
   - Solution: AI concierge in Telegram + auto PROM/PREM
   - Demo screenshots
   - Architecture diagram (Cloudflare primitives highlighted)
   - Roadmap (specialty PROMs, multi-channel, SNS integration,
     unify with platform's pre-consultation forms)
```
