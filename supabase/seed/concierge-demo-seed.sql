-- =============================================================
-- EqualCare Concierge — Demo Seed
-- File: supabase/seed/concierge-demo-seed.sql
-- =============================================================
-- This seed depends on the platform's main seed running first
-- (specialties, doctors, doctor_specialties, appointment_types).
--
-- Patient creation: profiles.id references auth.users(id), so we
-- cannot create patients with raw SQL alone. This file assumes a
-- companion script `scripts/seed-patients.ts` has already created
-- 10 auth users and let the platform's `handle_new_user` trigger
-- (or equivalent) populate `profiles`. The deterministic UUIDs
-- below must match what that script generates.
--
-- The seed-patients.ts script should call:
--   await supabase.auth.admin.createUser({
--     id: '11111111-1111-1111-1111-111100000001',
--     email: 'alice.costa@example.com',
--     email_confirm: true,
--     user_metadata: { chosen_name: 'Alice Costa', preferred_language: 'pt' }
--   })
-- and afterwards UPDATE profiles SET role = 'patient',
-- registration_completed = true, accepted_terms_version = 'v1',
-- chosen_name = ..., phone = ... where id = ...
-- =============================================================

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
--
-- Deterministic UUID pattern: 11111111-1111-1111-1111-1111000000NN
-- =============================================================

-- Sanity check: ensure the 10 patient profiles exist (created by
-- the companion script). If any are missing, abort the seed.
do $$
declare
  v_missing int;
begin
  select 10 - count(*) into v_missing
  from profiles
  where id in (
    '11111111-1111-1111-1111-111100000001',
    '11111111-1111-1111-1111-111100000002',
    '11111111-1111-1111-1111-111100000003',
    '11111111-1111-1111-1111-111100000004',
    '11111111-1111-1111-1111-111100000005',
    '11111111-1111-1111-1111-111100000006',
    '11111111-1111-1111-1111-111100000007',
    '11111111-1111-1111-1111-111100000008',
    '11111111-1111-1111-1111-111100000009',
    '11111111-1111-1111-1111-111100000010'
  );
  if v_missing > 0 then
    raise exception 'Seed precondition failed: % patient profiles missing. Run scripts/seed-patients.ts first.', v_missing;
  end if;
end$$;

-- =============================================================
-- TELEGRAM LINKS — one fake telegram_user_id per seeded patient.
-- In a live demo only Pedro's real Telegram account is linked, but
-- having the rows lets the scheduler-worker push to all patients
-- regardless (skipped silently when the chat doesn't exist).
-- =============================================================

insert into concierge_telegram_links (telegram_user_id, patient_id, locale)
values
  (1000000001, '11111111-1111-1111-1111-111100000001', 'pt'),
  (1000000002, '11111111-1111-1111-1111-111100000002', 'pt'),
  (1000000003, '11111111-1111-1111-1111-111100000003', 'pt'),
  (1000000004, '11111111-1111-1111-1111-111100000004', 'pt'),
  (1000000005, '11111111-1111-1111-1111-111100000005', 'pt'),
  (1000000006, '11111111-1111-1111-1111-111100000006', 'pt'),
  (1000000007, '11111111-1111-1111-1111-111100000007', 'pt'),
  (1000000008, '11111111-1111-1111-1111-111100000008', 'pt'),
  (1000000009, '11111111-1111-1111-1111-111100000009', 'pt'),
  (1000000010, '11111111-1111-1111-1111-111100000010', 'pt')
on conflict (telegram_user_id) do nothing;

-- =============================================================
-- APPOINTMENTS — ~30 across the 10 patients
--
-- Schema reminder (platform):
--   appointments(id uuid pk default gen_random_uuid(),
--                patient_id uuid -> profiles(id),
--                doctor_id  uuid -> doctors(id),
--                appointment_type_id uuid -> appointment_types(id),
--                scheduled_at timestamptz,
--                duration_min int,
--                status appointment_status,    -- scheduled|confirmed|completed|cancelled|no_show
--                notes text,
--                created_at timestamptz,
--                updated_at timestamptz)
--
-- We need real doctor_id and appointment_type_id values from the
-- main platform seed. Pull them with CTEs by name. If the names
-- below differ in your seed, adjust.
-- =============================================================

-- TEMPLATE — Claude Code should expand this into the full INSERT
-- after confirming names exist. Pattern per patient:
--   appointment 1: scheduled_at = now() - interval '40 days'  (oldest)
--   appointment 2: scheduled_at = now() - interval '20 days'
--   appointment 3: scheduled_at = now() - interval '6 days'   (most recent)
-- All status='completed' except for one P10 future-dated appointment
-- (so the scheduler exercises the 24h-reminder path).

with
  spec_mg as (
    select id from specialties where name = 'Medicina Geral' and is_active limit 1
  ),
  spec_nutri as (
    select id from specialties where name = 'Nutrição' and is_active limit 1
  ),
  spec_psico as (
    select id from specialties where name = 'Psicologia' and is_active limit 1
  ),
  type_mg as (
    select id, default_duration_min from appointment_types
     where specialty_id = (select id from spec_mg) and is_active
     order by name limit 1
  ),
  type_nutri as (
    select id, default_duration_min from appointment_types
     where specialty_id = (select id from spec_nutri) and is_active
     order by name limit 1
  ),
  type_psico as (
    select id, default_duration_min from appointment_types
     where specialty_id = (select id from spec_psico) and is_active
     order by name limit 1
  ),
  doc_mg as (
    select d.id from doctors d
     join doctor_specialties ds on ds.doctor_id = d.id
     where ds.specialty_id = (select id from spec_mg)
     limit 1
  ),
  doc_nutri as (
    select d.id from doctors d
     join doctor_specialties ds on ds.doctor_id = d.id
     where ds.specialty_id = (select id from spec_nutri)
     limit 1
  ),
  doc_psico as (
    select d.id from doctors d
     join doctor_specialties ds on ds.doctor_id = d.id
     where ds.specialty_id = (select id from spec_psico)
     limit 1
  )
select 1; -- noop: CTEs above are reference only.
          -- Claude Code: expand into 30 INSERTs in Phase 7.

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
-- IMPORTANT: dispatch_id values are 10-char nanoid; for seed
-- determinism use a recognizable prefix per patient
-- (e.g. p01a1prem, p04a2pr7d, p09a1prem).
-- =============================================================

-- Left as scaffolding because exact appointment IDs depend on the
-- inserts above. Claude Code: emit the full INSERTs once the
-- appointments are seeded, in Phase 7.

-- =============================================================
-- HELPER: a SQL function the demo can call to "fast-forward time"
-- by triggering all due dispatches and reminders, regardless of
-- scheduled_for. Used by `POST /admin/cron/run` in the scheduler.
-- =============================================================

create or replace function public.demo_force_concierge_dispatch_all_due()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
begin
  update concierge_form_dispatches
     set scheduled_for = now() - interval '1 minute'
   where sent_at is null
     and scheduled_for > now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
