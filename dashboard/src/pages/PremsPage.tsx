import { useEffect, useMemo, useState } from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts"
import { supabase } from "@/lib/supabase"

interface PremScore {
  nps?: number
  nps_segment?: "detractor" | "passive" | "promoter"
  wait_time?: number | null
  communication?: number | null
  comment?: string | null
}

interface PremRow {
  id: string
  patient_id: string
  score: PremScore | null
  completed_at: string
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000

export default function PremsPage() {
  const [rows, setRows] = useState<PremRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const since = new Date(Date.now() - NINETY_DAYS_MS).toISOString()
      const { data, error: e } = await supabase
        .from("concierge_form_responses")
        .select("id, patient_id, score, completed_at")
        .eq("template_id", "PREM_v1")
        .gte("completed_at", since)
        .order("completed_at", { ascending: false })
      if (!alive) return
      if (e) setError(e.message)
      else setRows((data ?? []) as unknown as PremRow[])
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [])

  const stats = useMemo(() => {
    const npsValues: number[] = []
    const waitDist = [0, 0, 0, 0, 0]
    const commDist = [0, 0, 0, 0, 0]
    const npsHist = Array.from({ length: 11 }, (_, i) => ({ score: i, count: 0 }))
    let promoters = 0
    let detractors = 0
    for (const r of rows) {
      const s = r.score
      if (!s) continue
      if (typeof s.nps === "number") {
        npsValues.push(s.nps)
        npsHist[s.nps]!.count += 1
        if (s.nps_segment === "promoter") promoters += 1
        if (s.nps_segment === "detractor") detractors += 1
      }
      if (typeof s.wait_time === "number" && s.wait_time >= 1 && s.wait_time <= 5) {
        waitDist[s.wait_time - 1]! += 1
      }
      if (typeof s.communication === "number" && s.communication >= 1 && s.communication <= 5) {
        commDist[s.communication - 1]! += 1
      }
    }
    const total = npsValues.length || 1
    const nps = Math.round(((promoters - detractors) / total) * 100)
    return { nps, npsCount: npsValues.length, npsHist, waitDist, commDist }
  }, [rows])

  const comments = useMemo(
    () => rows
      .map((r) => r.score?.comment)
      .filter((c): c is string => !!c && c.trim().length > 0),
    [rows]
  )

  return (
    <section className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">PREMs · Experiência</h1>
        <span className="text-sm text-slate-500">últimos 90 dias</span>
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-lg border bg-white p-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">NPS</div>
          <div className="mt-2 text-4xl font-bold">{loading ? "…" : stats.nps}</div>
          <div className="mt-1 text-xs text-slate-500">
            {stats.npsCount} {stats.npsCount === 1 ? "resposta" : "respostas"}
          </div>
        </div>
        <div className="rounded-lg border bg-white p-4 md:col-span-2">
          <h2 className="mb-3 text-sm font-medium text-slate-600">Distribuição NPS (0–10)</h2>
          <div className="h-40">
            <ResponsiveContainer>
              <BarChart data={stats.npsHist}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="score" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="count" fill="#0f172a" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <LikertCard title="Tempo de espera" dist={stats.waitDist} />
        <LikertCard title="Comunicação" dist={stats.commDist} />
      </div>

      <div className="rounded-lg border bg-white p-4">
        <h2 className="mb-3 text-sm font-medium text-slate-600">Comentários recentes</h2>
        {loading && <div className="text-sm text-slate-500">A carregar…</div>}
        {!loading && comments.length === 0 && (
          <div className="text-sm text-slate-500">Sem comentários ainda.</div>
        )}
        <ul className="space-y-2">
          {comments.map((c, i) => (
            <li key={i} className="rounded border-l-4 border-slate-300 bg-slate-50 px-3 py-2 text-sm">
              {c}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

const LIKERT_LABELS_PT = ["Muito mau", "Mau", "Razoável", "Bom", "Muito bom"]

function LikertCard({ title, dist }: { title: string; dist: number[] }) {
  const data = dist.map((count, i) => ({ label: LIKERT_LABELS_PT[i] ?? `${i + 1}`, count }))
  return (
    <div className="rounded-lg border bg-white p-4">
      <h2 className="mb-3 text-sm font-medium text-slate-600">{title}</h2>
      <div className="h-40">
        <ResponsiveContainer>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="count" fill="#475569" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
