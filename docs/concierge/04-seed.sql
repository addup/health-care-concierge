-- =============================================================
-- EqualCare Concierge — Demo Seed
-- File: supabase/seed/concierge-demo-seed.sql
-- =============================================================
-- 10 patients across 4 narrative segments. Run AFTER the main
-- seed that creates the clinic, professionals, specialties.
--
-- IMPORTANT: This file references table names and columns that
-- need to be confirmed against the actual schema. Adjust:
--   - patients(id, name, email, phone, ...)
--   - appointments(id, patient_id, professional_id, specialty_id,
--                  start_at, end_at, status, ...)
--   - any required NOT NULL columns
-- =============================================================

-- Tunable: clinic_id, specialties IDs, professional IDs all need to
-- match what already exists in the DB. The block below uses CTEs to
-- look them up by name; adapt to your schema.

with
  clinic as (
    select id from clinics order by created_at limit 1
  ),
  spec_mg as (
    select id from specialties where slug = 'medicina-geral' limit 1
  ),
  spec_nutri as (
    select id from specialties where slug = 'nutricao' limit 1
  ),
  spec_psico as (
    select id from specialties where slug = 'psicologia' limit 1
  ),
  prof_mg as (
    select id from professionals where specialty_id = (select id from spec_mg) limit 1
  ),
  prof_nutri as (
    select id from professionals where specialty_id = (select id from spec_nutri) limit 1
  ),
  prof_psico as (
    select id from professionals where specialty_id = (select id from spec_psico) limit 1
  )
select 1; -- noop; CTEs above are illustrative — Claude Code should
          -- inline these IDs once it inspects the actual schema

-- =============================================================
-- 10 PATIENTS — distributed across narrative segments
--
-- Segment A — Healthy (3): high EQ-5D, NPS 9-10
--   P01 Alice Costa, P02 Bruno Silva, P03 Catarina Lopes
-- Segment B — Improving (3): EQ-5D rising 0.55 → 0.78
--   P04 Diogo Marques, P05 Elsa Pereira, P06 Filipe Tavares
-- Segment C — Deteriorating (2): EQ-5D dropping
--   P07 Gabriela Sousa, P08 Henrique Dias
-- Segment D — Edge cases (2):
--   P09 Inês Faria — PREM critical (NPS=3)
--   P10 João Ribeiro — non-responder (all dispatches abandoned)
-- =============================================================

-- INSERT 10 patients. Use deterministic UUIDs so re-seeding is idempotent.
-- (Use uuid namespacing pattern: 11111111-1111-1111-1111-1111000000NN)

insert into patients (id, name, email, phone, locale, created_at)
values
  ('11111111-1111-1111-1111-111100000001','Alice Costa',     'alice.costa@example.com',     '+351911000001','pt-PT', now() - interval '5 months'),
  ('11111111-1111-1111-1111-111100000002','Bruno Silva',     'bruno.silva@example.com',     '+351911000002','pt-PT', now() - interval '5 months'),
  ('11111111-1111-1111-1111-111100000003','Catarina Lopes',  'catarina.lopes@example.com',  '+351911000003','pt-PT', now() - interval '4 months'),
  ('11111111-1111-1111-1111-111100000004','Diogo Marques',   'diogo.marques@example.com',   '+351911000004','pt-PT', now() - interval '4 months'),
  ('11111111-1111-1111-1111-111100000005','Elsa Pereira',    'elsa.pereira@example.com',    '+351911000005','pt-PT', now() - interval '4 months'),
  ('11111111-1111-1111-1111-111100000006','Filipe Tavares',  'filipe.tavares@example.com',  '+351911000006','pt-PT', now() - interval '3 months'),
  ('11111111-1111-1111-1111-111100000007','Gabriela Sousa',  'gabriela.sousa@example.com',  '+351911000007','pt-PT', now() - interval '3 months'),
  ('11111111-1111-1111-1111-111100000008','Henrique Dias',   'henrique.dias@example.com',   '+351911000008','pt-PT', now() - interval '3 months'),
  ('11111111-1111-1111-1111-111100000009','Inês Faria',      'ines.faria@example.com',      '+351911000009','pt-PT', now() - interval '2 months'),
  ('11111111-1111-1111-1111-111100000010','João Ribeiro',    'joao.ribeiro@example.com',    '+351911000010','pt-PT', now() - interval '2 months')
on conflict (id) do nothing;

-- =============================================================
-- APPOINTMENTS — ~30 across the 10 patients
-- Pattern: each patient has 1-3 historical appointments, all marked
-- as 'completed'. Appointments are back-dated so the cron worker, on
-- its first run, will dispatch PREMs and PROMs for several of them.
-- =============================================================

-- The block below is a TEMPLATE. Claude Code should generate the
-- full INSERT after inspecting the actual appointments schema.
-- Pattern per patient:
--   appointment 1: end_at = now() - interval '40 days'  (oldest)
--   appointment 2: end_at = now() - interval '20 days'
--   appointment 3: end_at = now() - interval '6 days'   (most recent)
--
-- For non-responder P10: include 1 recent appointment (5 days ago)
-- so a PREM dispatch is due but goes unanswered.
-- For PREM-critical P09: 1 appointment 25 days ago, PREM completed
-- with NPS=3 and a negative comment.

-- =============================================================
-- TELEGRAM LINKS — link each patient to a fake telegram_user_id
-- (in a real demo, only Pedro's actual Telegram account is linked)
-- =============================================================

insert into telegram_links (telegram_user_id, patient_id, locale)
values
  (1000000001, '11111111-1111-1111-1111-111100000001', 'pt-PT'),
  (1000000002, '11111111-1111-1111-1111-111100000002', 'pt-PT'),
  (1000000003, '11111111-1111-1111-1111-111100000003', 'pt-PT'),
  (1000000004, '11111111-1111-1111-1111-111100000004', 'pt-PT'),
  (1000000005, '11111111-1111-1111-1111-111100000005', 'pt-PT'),
  (1000000006, '11111111-1111-1111-1111-111100000006', 'pt-PT'),
  (1000000007, '11111111-1111-1111-1111-111100000007', 'pt-PT'),
  (1000000008, '11111111-1111-1111-1111-111100000008', 'pt-PT'),
  (1000000009, '11111111-1111-1111-1111-111100000009', 'pt-PT'),
  (1000000010, '11111111-1111-1111-1111-111100000010', 'pt-PT')
on conflict (telegram_user_id) do nothing;

-- =============================================================
-- FORM DISPATCHES + RESPONSES (back-dated)
-- Generate these per the narrative:
--
-- Segment A (P01,P02,P03) — for each appointment, PREM completed
-- with NPS 9-10, EQ-5D index ≈ 0.85+ on PROM_T7d and PROM_T28d.
--
-- Segment B (P04,P05,P06) — EQ-5D index rises across two
-- consultations: T+7d after first appt = 0.55, T+28d = 0.62,
-- T+7d after 2nd = 0.71, T+28d = 0.78. PREM NPS rises 6→8→9.
--
-- Segment C (P07,P08) — EQ-5D index falls 0.78 → 0.62 over 2
-- consultations. Anxiety/depression dimension worsens.
--
-- Segment D — P09 has 1 PREM completed with NPS=3 and a negative
-- free-text comment ("Esperei 1h, ninguém me avisou"). P10 has
-- a recent appointment whose PREM dispatch is sent but never
-- completed (will be reminded then abandoned).
--
-- IMPORTANT: dispatch_id values are generated as nanoid(10).
-- For seed determinism, use a recognizable prefix per patient.
-- =============================================================

-- This is left as scaffolding because the exact appointment IDs
-- and timestamps depend on the inserts above. Claude Code should
-- emit the full INSERTs once the appointments are seeded.

-- =============================================================
-- HELPER: a SQL function the demo can call to "fast-forward time"
-- by triggering all due dispatches and reminders, regardless of
-- scheduled_for. Used by `POST /admin/cron/run` in the scheduler.
-- =============================================================

create or replace function public.demo_force_dispatch_all_due()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
begin
  -- Force all not-yet-sent to "due now"
  update form_dispatches
     set scheduled_for = now() - interval '1 minute'
   where sent_at is null
     and scheduled_for > now();
  return v_count;
end;
$$;
