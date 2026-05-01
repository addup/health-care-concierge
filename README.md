# EqualCare Concierge

Conversational concierge for the [EqualCare](https://github.com/addup/equal-care-platform) micro-clinic platform. Telegram-first; built on Cloudflare Workers + Workers AI + Vectorize, sharing the platform's Supabase project.

> **Status:** Phase 0 — scaffolding only. See `docs/concierge/05-claude-code-prompts.md` for the build plan.

## What this repo contains

| Path | Purpose |
| --- | --- |
| `concierge-worker/` | Cloudflare Worker — Telegram webhook, `PatientAgent` Durable Object, intent classifier, triage, booking, FAQ, form runner |
| `scheduler-worker/` | Cloudflare Worker — hourly cron for 24h reminders, PREM/PROM dispatch, escalation |
| `shared/` | Code shared between Workers (DB types, EQ-5D-5L value sets) |
| `supabase/migrations/` | Concierge-namespaced (`concierge_*`) schema additions |
| `supabase/seed/` | Demo seed (10 patients across 4 narrative segments) |
| `dashboard/` | Standalone Vite SPA for clinic staff (PROM/PREM views) — Phase 6 |
| `docs/concierge/` | PRD, tech spec, migration, seed scaffold, phased Claude Code prompts |
| `CLAUDE.md` | Top-level guide read by Claude Code at the start of every session |

## Companion repo

[`addup/equal-care-platform`](https://github.com/addup/equal-care-platform) — the existing Lovable-generated Vite + React SPA. We **do not modify** it; the only contact surface is the shared Supabase project.

## Quick start (once Phase 0 is complete locally)

```bash
# Concierge Worker
cd concierge-worker
cp .dev.vars.example .dev.vars   # then fill in
npm install
npm run dev

# Scheduler Worker (separate terminal)
cd scheduler-worker
cp .dev.vars.example .dev.vars
npm install
npm run dev
```

Before either Worker can do useful work you need to:
1. Create a Cloudflare KV namespace and a Vectorize index (`concierge-faq`, 1024 dims, cosine), and paste the KV id into `concierge-worker/wrangler.toml`.
2. Apply `supabase/migrations/20260501120000_concierge.sql` to the shared Supabase project.
3. Set the secrets: `TELEGRAM_BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` (concierge), and `ADMIN_SECRET` (scheduler).

## Reading order

1. `CLAUDE.md` — top-level guide
2. `docs/concierge/01-PRD.md` — product
3. `docs/concierge/02-tech-spec.md` — architecture, schema, prompts
4. `docs/concierge/03-migration.sql` — DB additions (also copied into `supabase/migrations/`)
5. `docs/concierge/05-claude-code-prompts.md` — phased build plan
