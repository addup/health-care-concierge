# PRD — EqualCare Concierge Agent

## 1. Context

EqualCare is a micro-clinic management SaaS targeting small private clinics in emerging markets. The existing platform (`addup/equal-care-platform`, Lovable-generated **Vite + React SPA on Supabase**) covers patient authentication via Supabase native email/SMS OTP, appointment scheduling, patient profile, and listing of upcoming/past appointments.

This document specifies a **conversational concierge agent** that sits on top of the same Supabase project. The agent lives in its own repo (`addup/health-care-concierge`) and never modifies the platform repo — the only contact surface is the database. The agent is delivered via Telegram bot for the hackathon demo; the architecture is designed so that adding WhatsApp or web chat later is straightforward, but multi-channel is **not** in scope for V1.

The concierge is built for **Cloudflare Agents Day**, targeting the Cloudflare "Personal Agent" challenge. It must therefore be deployed on Cloudflare Workers using the Agents SDK.

## 2. Problem

Patients of small private clinics today rely on phone calls, e-mail, or web forms to:
- Ask basic questions ("do you do nutrition?", "what is the address?")
- Book a first appointment
- Reschedule or cancel
- Receive post-consultation outcome and experience surveys

The clinic absorbs the cost of every interaction, no-show rates are high (typical 15–25% in private clinics), and structured patient-reported data (PROM/PREM) is essentially never collected. EqualCare's thesis is that an AI concierge solves all four in a single conversation surface.

## 3. Goals (V1)

The agent must:

1. **Answer FAQs** about the clinic in natural language (PT-PT and EN)
2. **Triage symptoms** before booking — ask follow-up questions, suggest a specialty, escalate red-flags (chest pain, sudden dyspnea, neurological deficit) to urgent care instead of booking
3. **Book appointments** by translating natural language into existing Supabase RPC calls
4. **Reschedule and cancel** existing appointments
5. **Send 24h appointment reminders** via Telegram with a one-tap cancel option
6. **Dispatch and collect a PREM** (Patient-Reported Experience Measure) 24h after every consultation
7. **Dispatch and collect a PROM** (EQ-5D-5L, generic) 7 days and 28 days after every consultation
8. **Send escalating reminders** for unanswered forms (T+48h after dispatch, T+7d after dispatch, then mark abandoned)
9. **Render a standalone clinic-facing dashboard** (a separate small Vite SPA built in this repo, not a change to the existing platform) with PROM trends per patient (EQ-5D index over time) and PREM aggregates (NPS, top comments)

## 4. Non-Goals (V1)

- WhatsApp, voice, or web chat channel
- Patient self-registration via the bot (patients must already exist in the platform; bot links to existing account via email OTP)
- Multi-language beyond PT-PT and EN
- Specialty-specific PROMs (only EQ-5D-5L generic; specialty-specific PROMs deferred to V2)
- Pre-consultation structured intake, prescription renewal, lab result interpretation (all deferred)
- Insurance reimbursement automation
- Payment / invoicing
- Real-time agent ↔ clinician handoff

## 5. Users

**Primary — Patient.** Existing EqualCare patient. Has email-OTP credentials. Wants to book / reschedule / cancel and answer follow-up surveys without phone calls.

**Secondary — Clinic operator (clinician or front-desk).** Reads PROM/PREM dashboard. Doesn't interact with the bot.

**Out of scope — Anonymous prospect.** Someone who isn't yet a patient. They can use the FAQ but cannot book until they go through the existing platform sign-up.

## 6. Key User Flows

### 6.1 First-time link

```
Patient: /start
Bot:    Olá! Sou o concierge da EQUAL Care. Para te identificar,
        qual o teu email?
Patient: pedro@example.com
Bot:    Enviei um código para o teu email. Cola aqui.
Patient: 847291
Bot:    Pronto, Pedro. Como posso ajudar?
        [Marcar consulta] [Ver as minhas consultas] [Tenho uma dúvida]
```

Behind the scenes, the bot calls the existing OTP RPCs and stores the resulting `(telegram_user_id, patient_id)` mapping in a new `telegram_links` table.

### 6.2 Triage → Book

```
Patient: Tenho dores de barriga há 3 dias
Bot:    Lamento. Algumas perguntas rápidas para te ajudar a marcar a
        consulta certa:
        - A dor está localizada num sítio específico?
        - Tens febre, vómitos ou sangue nas fezes?
        - Numa escala de 0 a 10, qual a intensidade?
[multi-turn triage]
Bot:    Sugiro Medicina Geral. Slots disponíveis:
        [Qui 7 May 09:30] [Qui 7 May 14:00] [Sex 8 May 11:00] [Mais opções]
Patient: [taps Qui 7 May 09:30]
Bot:    Confirmado: Medicina Geral, Dr. X, 7 maio 09:30. Lembrete 24h antes.
```

Red-flag path: if symptoms include chest pain, sudden severe dyspnea, neurological signs (sudden weakness, slurred speech, vision loss), severe abdominal pain with rigidity, or suicidal ideation, the bot does **not** book. It says: *"Os teus sintomas precisam de avaliação urgente. Liga 112 ou dirige-te ao serviço de urgência mais próximo. Posso ligar à clínica para te ajudar?"*

### 6.3 Reschedule / Cancel

```
Patient: tenho de mudar a consulta de quinta
Bot:    Tens consulta marcada Qui 7 May 09:30 — Medicina Geral, Dr. X.
        Queres [Reagendar] [Cancelar] [Manter]?
Patient: [taps Reagendar]
Bot:    Quando preferes? [Esta semana] [Próxima semana] [Escrever data]
[continues with availability list]
```

### 6.4 Reminder 24h

Cron worker, every hour, finds appointments starting in 24h ± 30min that haven't been reminded. Sends:

```
Bot:    Lembrete: amanhã 09:30, Medicina Geral, Dr. X.
        [Confirmar presença] [Cancelar]
```

### 6.5 PREM dispatch (T+24h)

```
Bot:    Olá Pedro. Como correu a consulta de ontem?
        Numa escala de 0 a 10, qual a probabilidade de recomendares
        a EQUAL Care a um amigo?
        [0][1][2]...[9][10]
Patient: [taps 9]
Bot:    Boa! Como classificas o tempo de espera?
        [Muito mau][Mau][Razoável][Bom][Muito bom]
[3 more questions, including optional free-text comment]
Bot:    Obrigado! O teu feedback ajuda a clínica a melhorar.
```

### 6.6 PROM dispatch (T+7d, T+28d) — EQ-5D-5L

Five dimensions, each 5 levels (1=no problems, 5=extreme problems): mobility, self-care, usual activities, pain/discomfort, anxiety/depression. Plus EQ-VAS (0–100, in steps of 10). Inline keyboards throughout. EQ-5D-5L index computed server-side using the Portuguese value set (Ferreira et al. 2014) when patient locale is PT, UK value set (Devlin et al. 2018) otherwise.

### 6.7 Reminder cascade for unanswered forms

- Initial dispatch at scheduled time
- Reminder at sent_at + 48h if not completed
- Final reminder at sent_at + 7d if still not completed
- Marked `abandoned_at` 48h after the final reminder

## 7. Acceptance Criteria

A judge or stakeholder using the demo Telegram bot must be able to:

1. Type `/start`, complete OTP login with a seeded patient
2. Have a triage conversation in PT-PT that suggests the correct specialty and books an appointment that appears in the existing Supabase
3. Reschedule that appointment via natural language
4. Receive a (manually-triggered, for the demo) 24h reminder
5. Receive a PREM and answer it inline
6. Receive a PROM (EQ-5D-5L) and answer it inline
7. Have an EQ-5D index computed and visible in the clinic dashboard
8. View `/clinica/proms` and see at least one line chart of EQ-5D index over time for one of the seeded patients
9. View `/clinica/prems` and see NPS aggregates plus a list of free-text comments

## 8. Success Metrics (post-pilot, not for the demo)

- ≥ 70% of bookings via the bot vs phone/web in pilot clinics
- ≥ 50% PROM completion rate (industry baseline ~20–30% without reminders)
- ≥ 60% PREM completion rate
- ≥ 30% reduction in no-show rate vs the 30 days preceding rollout
- NPS ≥ 50 from patients on bot experience itself (separate metric)

## 9. Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Workers AI cold-start latency makes bot feel dead | Send `sendChatAction: typing` immediately; cap LLM calls to ≤ 2s timeout with fallback to rule-based intents |
| Telegram callback_data 64-byte limit | Use short nanoid IDs for dispatches; keep callback payloads compact (`f:<10char>:q:<n>:a:<n>`) |
| Patient gives wrong email at /start | After 3 failed OTP attempts, refuse and direct to clinic phone |
| Red-flag triage misses a true emergency | Bias prompt toward false positives; always include 112 / urgent care fallback even when not red-flag |
| EQ-5D-5L licensing | EuroQol Foundation registration is free for non-commercial; demo is fine, register before any paid pilot |
| Form fatigue (3 forms per consultation) | PREM short (4 questions); PROM at T+7d and T+28d uses same instrument; single-tap inline UX |
| Bot answers a clinical question it shouldn't | System prompt explicitly forbids diagnostic statements; bot defers all clinical questions to the clinician |
| No atomic booking RPC — bot must do `check_slot_available` + INSERT in two steps | Tight latency window between check and insert; the platform's UI does the same dance, so worst case mirrors current behaviour. If a race happens, surface "esse horário foi entretanto ocupado" and re-list. |
| Existing reminder queue (`process-reminder-queue` Edge Function + 24h email template) double-sends with bot reminder | **Decided: coexist in V1.** Telegram + email both fire; no platform changes. V2 may add an opt-out for Telegram-linked patients. |

## 10. Open Questions for Pedro

- Confirm Portuguese EQ-5D-5L value set (Ferreira 2014) is acceptable, or use TTO-based UK set
- Is there a single seed of "clinic FAQ" content somewhere, or do we author it for the demo?
- For the demo, is it acceptable to manually trigger the cron worker, or should it run on Cloudflare's hourly schedule and be demonstrated with timestamp manipulation?
- Dashboard auth: the standalone dashboard SPA — does it sign in with the same Supabase auth as the platform (admin role required), or do we expose it via a separate admin token? Default plan: Supabase auth + `has_role(auth.uid(), 'admin')` gate.

### Resolved against the platform repo audit

- `profiles` is the patient table (PK = `auth.users.id`). No `patients` table.
- Auth is Supabase native OTP — no `auth_request_otp` / `auth_verify_otp` RPCs.
- Booking is a 2-step pattern (`check_slot_available` + INSERT), not an atomic RPC.
- Specialty → `appointment_type_id` mapping is via `appointment_types.specialty_id`. `default_duration_min` lives on `appointment_types`.
- Existing `form_responses` is for **pre-consultation intake**, not PREM/PROM. Concierge follow-up forms get their own `concierge_*` tables.
- `preferred_language` enum is `'pt' | 'en'` (no region tag).
