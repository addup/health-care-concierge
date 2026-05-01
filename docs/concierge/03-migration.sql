-- =============================================================
-- EqualCare Concierge — Schema additions
-- File: supabase/migrations/<timestamp>_concierge.sql
-- =============================================================
-- This migration adds tables and RPCs needed by the Cloudflare
-- concierge agent. It does NOT modify any existing tables.
-- It assumes the existing schema has tables `patients` and
-- `appointments` with PK type uuid. Adjust the FK types if not.
-- =============================================================

-- 1. Telegram link
create table if not exists public.telegram_links (
  telegram_user_id  bigint primary key,
  patient_id        uuid not null references public.patients(id) on delete cascade,
  linked_at         timestamptz not null default now(),
  last_active_at    timestamptz not null default now(),
  locale            text not null default 'pt-PT'
                    check (locale in ('pt-PT','en'))
);

create index if not exists idx_telegram_links_patient
  on public.telegram_links(patient_id);

-- 2. Form templates
create table if not exists public.form_templates (
  id          text primary key,
  kind        text not null check (kind in ('PREM','PROM')),
  name        text not null,
  schema      jsonb not null,
  version     int  not null default 1,
  created_at  timestamptz not null default now()
);

-- 3. Form dispatches
create table if not exists public.form_dispatches (
  id                text primary key,
  appointment_id    uuid not null references public.appointments(id) on delete cascade,
  patient_id        uuid not null references public.patients(id) on delete cascade,
  template_id       text not null references public.form_templates(id),
  schedule_label    text not null
                    check (schedule_label in ('PREM_T24h','PROM_T7d','PROM_T28d')),
  scheduled_for     timestamptz not null,
  sent_at           timestamptz,
  reminder_count    int not null default 0
                    check (reminder_count between 0 and 2),
  last_reminder_at  timestamptz,
  completed_at      timestamptz,
  abandoned_at      timestamptz,
  channel           text not null default 'telegram',
  created_at        timestamptz not null default now(),
  unique (appointment_id, schedule_label)
);

create index if not exists idx_form_dispatches_pending_initial
  on public.form_dispatches (scheduled_for)
  where sent_at is null and abandoned_at is null;

create index if not exists idx_form_dispatches_pending_reminder
  on public.form_dispatches (sent_at)
  where sent_at is not null
        and completed_at is null
        and abandoned_at is null;

create index if not exists idx_form_dispatches_patient
  on public.form_dispatches (patient_id);

-- 4. Form responses
create table if not exists public.form_responses (
  id            uuid primary key default gen_random_uuid(),
  dispatch_id   text not null unique
                references public.form_dispatches(id) on delete cascade,
  patient_id    uuid not null references public.patients(id) on delete cascade,
  template_id   text not null references public.form_templates(id),
  answers       jsonb not null,
  score         jsonb not null,
  completed_at  timestamptz not null default now()
);

create index if not exists idx_form_responses_patient_time
  on public.form_responses (patient_id, completed_at desc);

-- 5. Agent audit log
create table if not exists public.agent_audit_log (
  id                uuid primary key default gen_random_uuid(),
  patient_id        uuid references public.patients(id) on delete set null,
  telegram_user_id  bigint,
  intent            text,
  action            text not null,
  payload           jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists idx_agent_audit_patient_time
  on public.agent_audit_log (patient_id, created_at desc);

create index if not exists idx_agent_audit_action_time
  on public.agent_audit_log (action, created_at desc);

-- 6. Add columns to existing appointments table for reminder bookkeeping
-- (additive; safe if already present)
alter table public.appointments
  add column if not exists reminder_sent_at         timestamptz,
  add column if not exists prem_dispatched_at       timestamptz,
  add column if not exists prom_t7_dispatched_at    timestamptz,
  add column if not exists prom_t28_dispatched_at   timestamptz;

-- =============================================================
-- RLS
-- =============================================================
alter table public.telegram_links     enable row level security;
alter table public.form_templates     enable row level security;
alter table public.form_dispatches    enable row level security;
alter table public.form_responses     enable row level security;
alter table public.agent_audit_log    enable row level security;

-- Form templates are world-readable (no PHI, just question wording)
create policy if not exists form_templates_read_all
  on public.form_templates for select
  using (true);

-- A patient can read their own telegram link
create policy if not exists telegram_links_self_read
  on public.telegram_links for select
  using (patient_id = auth.uid());

-- A patient can read their own dispatches and responses
create policy if not exists form_dispatches_self_read
  on public.form_dispatches for select
  using (patient_id = auth.uid());

create policy if not exists form_responses_self_read
  on public.form_responses for select
  using (patient_id = auth.uid());

-- Service role bypasses RLS by default; no explicit write policies needed.
-- Clinic staff (role = 'clinic_staff' in JWT) read-all policies:
create policy if not exists form_responses_staff_read
  on public.form_responses for select
  using (
    coalesce((auth.jwt() ->> 'user_role'), '') = 'clinic_staff'
  );

create policy if not exists form_dispatches_staff_read
  on public.form_dispatches for select
  using (
    coalesce((auth.jwt() ->> 'user_role'), '') = 'clinic_staff'
  );

create policy if not exists agent_audit_staff_read
  on public.agent_audit_log for select
  using (
    coalesce((auth.jwt() ->> 'user_role'), '') = 'clinic_staff'
  );

-- =============================================================
-- RPCs
-- =============================================================

-- Link a Telegram user to a patient (service role only)
create or replace function public.link_telegram(
  p_telegram_user_id bigint,
  p_patient_id       uuid,
  p_locale           text default 'pt-PT'
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into telegram_links (telegram_user_id, patient_id, locale)
  values (p_telegram_user_id, p_patient_id, coalesce(p_locale,'pt-PT'))
  on conflict (telegram_user_id) do update
    set patient_id = excluded.patient_id,
        locale     = excluded.locale,
        last_active_at = now();
end;
$$;

revoke all on function public.link_telegram(bigint, uuid, text) from public;

-- Look up patient by Telegram ID
create or replace function public.lookup_patient_by_telegram(
  p_telegram_user_id bigint
) returns table (
  patient_id uuid,
  locale     text
)
language sql
security definer
set search_path = public
as $$
  select patient_id, locale
  from telegram_links
  where telegram_user_id = p_telegram_user_id;
$$;

-- Create a form dispatch
create or replace function public.dispatch_form(
  p_id              text,
  p_appointment_id  uuid,
  p_template_id     text,
  p_schedule_label  text,
  p_scheduled_for   timestamptz
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_patient_id uuid;
begin
  select patient_id into v_patient_id
  from appointments where id = p_appointment_id;

  if v_patient_id is null then
    raise exception 'Appointment % not found', p_appointment_id;
  end if;

  insert into form_dispatches (
    id, appointment_id, patient_id, template_id, schedule_label, scheduled_for
  ) values (
    p_id, p_appointment_id, v_patient_id, p_template_id, p_schedule_label, p_scheduled_for
  )
  on conflict (appointment_id, schedule_label) do nothing;
end;
$$;

-- Mark dispatch sent / reminded
create or replace function public.mark_form_sent(
  p_dispatch_id text,
  p_is_reminder boolean default false
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_is_reminder then
    update form_dispatches
       set reminder_count   = reminder_count + 1,
           last_reminder_at = now()
     where id = p_dispatch_id;
  else
    update form_dispatches
       set sent_at = now()
     where id = p_dispatch_id and sent_at is null;
  end if;
end;
$$;

-- Record a form response (idempotent)
create or replace function public.record_form_response(
  p_dispatch_id text,
  p_answers     jsonb,
  p_score       jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_patient_id  uuid;
  v_template_id text;
begin
  select patient_id, template_id into v_patient_id, v_template_id
  from form_dispatches where id = p_dispatch_id;

  if v_patient_id is null then
    raise exception 'Dispatch % not found', p_dispatch_id;
  end if;

  insert into form_responses (dispatch_id, patient_id, template_id, answers, score)
  values (p_dispatch_id, v_patient_id, v_template_id, p_answers, p_score)
  on conflict (dispatch_id) do nothing;

  update form_dispatches
     set completed_at = now()
   where id = p_dispatch_id and completed_at is null;
end;
$$;

-- Mark dispatches abandoned (called by cron)
create or replace function public.abandon_stale_dispatches()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  with updated as (
    update form_dispatches
       set abandoned_at = now()
     where completed_at is null
       and abandoned_at is null
       and reminder_count >= 2
       and sent_at <= now() - interval '9 days'
    returning 1
  )
  select count(*) into v_count from updated;
  return v_count;
end;
$$;

-- Audit log writer
create or replace function public.log_agent_action(
  p_patient_id        uuid,
  p_telegram_user_id  bigint,
  p_intent            text,
  p_action            text,
  p_payload           jsonb default '{}'::jsonb
) returns void
language sql
security definer
set search_path = public
as $$
  insert into agent_audit_log (patient_id, telegram_user_id, intent, action, payload)
  values (p_patient_id, p_telegram_user_id, p_intent, p_action, p_payload);
$$;

-- =============================================================
-- Seed: PREM and EQ-5D-5L templates
-- =============================================================

insert into public.form_templates (id, kind, name, version, schema)
values (
  'PREM_v1', 'PREM', 'Experiência da consulta', 1,
  $json$
  {
    "id": "PREM_v1",
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
  $json$::jsonb
)
on conflict (id) do update
  set kind   = excluded.kind,
      name   = excluded.name,
      schema = excluded.schema,
      version = excluded.version;

insert into public.form_templates (id, kind, name, version, schema)
values (
  'EQ5D5L_v1', 'PROM', 'EQ-5D-5L', 1,
  $json$
  {
    "id": "EQ5D5L_v1",
    "instrument": "EQ-5D-5L",
    "value_sets": ["pt_2014_ferreira","uk_2018_devlin"],
    "questions": [
      {
        "id": "mobility",
        "type": "likert5_inverse",
        "prompt_pt": "MOBILIDADE — selecione a frase que melhor descreve a sua saúde HOJE.",
        "labels_pt": [
          "Não tenho problemas em andar",
          "Tenho problemas ligeiros em andar",
          "Tenho problemas moderados em andar",
          "Tenho problemas graves em andar",
          "Sou incapaz de andar"
        ],
        "prompt_en": "MOBILITY — choose the statement that best describes your health TODAY.",
        "labels_en": [
          "I have no problems in walking about",
          "I have slight problems",
          "I have moderate problems",
          "I have severe problems",
          "I am unable to walk about"
        ]
      },
      {
        "id": "self_care",
        "type": "likert5_inverse",
        "prompt_pt": "CUIDADOS PESSOAIS — lavar-se ou vestir-se",
        "labels_pt": [
          "Não tenho problemas em lavar-me ou vestir-me",
          "Tenho problemas ligeiros",
          "Tenho problemas moderados",
          "Tenho problemas graves",
          "Sou incapaz de me lavar ou vestir sozinho"
        ],
        "prompt_en": "SELF-CARE — washing or dressing",
        "labels_en": [
          "I have no problems",
          "I have slight problems",
          "I have moderate problems",
          "I have severe problems",
          "I am unable to wash or dress myself"
        ]
      },
      {
        "id": "usual_activities",
        "type": "likert5_inverse",
        "prompt_pt": "ATIVIDADES HABITUAIS (ex.: trabalho, estudos, lazer)",
        "labels_pt": [
          "Não tenho problemas",
          "Tenho problemas ligeiros",
          "Tenho problemas moderados",
          "Tenho problemas graves",
          "Sou incapaz de realizar as minhas atividades habituais"
        ],
        "prompt_en": "USUAL ACTIVITIES (work, study, housework, leisure)",
        "labels_en": [
          "I have no problems",
          "I have slight problems",
          "I have moderate problems",
          "I have severe problems",
          "I am unable to do my usual activities"
        ]
      },
      {
        "id": "pain_discomfort",
        "type": "likert5_inverse",
        "prompt_pt": "DOR / MAL-ESTAR",
        "labels_pt": [
          "Não tenho dores ou mal-estar",
          "Tenho dores ou mal-estar ligeiros",
          "Tenho dores ou mal-estar moderados",
          "Tenho dores ou mal-estar graves",
          "Tenho dores ou mal-estar extremos"
        ],
        "prompt_en": "PAIN / DISCOMFORT",
        "labels_en": [
          "I have no pain or discomfort",
          "I have slight pain or discomfort",
          "I have moderate pain or discomfort",
          "I have severe pain or discomfort",
          "I have extreme pain or discomfort"
        ]
      },
      {
        "id": "anxiety_depression",
        "type": "likert5_inverse",
        "prompt_pt": "ANSIEDADE / DEPRESSÃO",
        "labels_pt": [
          "Não estou ansioso/a nem deprimido/a",
          "Estou ligeiramente ansioso/a ou deprimido/a",
          "Estou moderadamente ansioso/a ou deprimido/a",
          "Estou muito ansioso/a ou deprimido/a",
          "Estou extremamente ansioso/a ou deprimido/a"
        ],
        "prompt_en": "ANXIETY / DEPRESSION",
        "labels_en": [
          "I am not anxious or depressed",
          "I am slightly anxious or depressed",
          "I am moderately anxious or depressed",
          "I am severely anxious or depressed",
          "I am extremely anxious or depressed"
        ]
      },
      {
        "id": "vas",
        "type": "vas",
        "min": 0, "max": 100, "step": 10,
        "prompt_pt": "Numa escala de 0 (a pior saúde que pode imaginar) a 100 (a melhor saúde que pode imaginar), como classifica a sua saúde HOJE?",
        "prompt_en": "On a scale from 0 (worst health you can imagine) to 100 (best health you can imagine), how good or bad is your health TODAY?"
      }
    ]
  }
  $json$::jsonb
)
on conflict (id) do update
  set kind   = excluded.kind,
      name   = excluded.name,
      schema = excluded.schema,
      version = excluded.version;
