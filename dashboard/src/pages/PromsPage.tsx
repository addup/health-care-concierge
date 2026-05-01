import { useEffect, useMemo, useState } from "react"
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts"
import { supabase } from "@/lib/supabase"

interface PatientOption {
  id: string
  chosen_name: string | null
  email: string | null
}

interface ResponseRow {
  id: string
  patient_id: string
  template_id: string
  score: { profile?: string; eq5d_index?: number; vas?: number } | null
  completed_at: string
}

export default function PromsPage() {
  const [patients, setPatients] = useState<PatientOption[]>([])
  const [selectedId, setSelectedId] = useState<string>("")
  const [rows, setRows] = useState<ResponseRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load patients (anyone with at least one EQ-5D-5L response).
  useEffect(() => {
    let alive = true
    ;(async () => {
      setError(null)
      const { data: respPatients, error: e1 } = await supabase
        .from("concierge_form_responses")
        .select("patient_id")
        .eq("template_id", "EQ5D5L_v1")
      if (e1) {
        setError(e1.message)
        return
      }
      const ids = Array.from(new Set((respPatients ?? []).map((r) => r.patient_id)))
      if (ids.length === 0) {
        if (alive) setPatients([])
        return
      }
      const { data: profiles, error: e2 } = await supabase
        .from("profiles")
        .select("id, chosen_name, email")
        .in("id", ids)
      if (e2) {
        setError(e2.message)
        return
      }
      if (!alive) return
      setPatients(
        (profiles ?? []).map((p) => ({ id: p.id, chosen_name: p.chosen_name, email: p.email }))
      )
      if (!selectedId && profiles && profiles.length > 0 && profiles[0]) {
        setSelectedId(profiles[0].id)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load responses for the selected patient.
  useEffect(() => {
    if (!selectedId) return
    let alive = true
    ;(async () => {
      setLoading(true)
      const { data, error: e } = await supabase
        .from("concierge_form_responses")
        .select("id, patient_id, template_id, score, completed_at")
        .eq("template_id", "EQ5D5L_v1")
        .eq("patient_id", selectedId)
        .order("completed_at")
      if (!alive) return
      if (e) setError(e.message)
      else setRows((data ?? []) as unknown as ResponseRow[])
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [selectedId])

  const chartData = useMemo(
    () =>
      rows
        .filter((r) => typeof r.score?.eq5d_index === "number")
        .map((r) => ({
          date: r.completed_at.slice(0, 10),
          eq5d: r.score!.eq5d_index!,
          vas: r.score?.vas ?? null
        })),
    [rows]
  )

  return (
    <section className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">PROMs · EQ-5D-5L</h1>
        <select
          className="rounded border bg-white px-3 py-1.5 text-sm"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
        >
          <option value="">— escolhe paciente —</option>
          {patients.map((p) => (
            <option key={p.id} value={p.id}>
              {p.chosen_name ?? p.email ?? p.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="rounded-lg border bg-white p-4">
        <h2 className="mb-3 text-sm font-medium text-slate-600">Índice EQ-5D ao longo do tempo</h2>
        <div className="h-72">
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis domain={[0, 1]} />
              <Tooltip />
              <Line type="monotone" dataKey="eq5d" stroke="#0f172a" strokeWidth={2} dot />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rounded-lg border bg-white p-4">
        <h2 className="mb-3 text-sm font-medium text-slate-600">Respostas</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="pb-2">Data</th>
              <th className="pb-2">Profile</th>
              <th className="pb-2">Index</th>
              <th className="pb-2">VAS</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} className="py-3 text-slate-500">
                  A carregar…
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="py-2">{r.completed_at.slice(0, 10)}</td>
                  <td className="py-2 font-mono">{r.score?.profile ?? "—"}</td>
                  <td className="py-2">{r.score?.eq5d_index?.toFixed(3) ?? "—"}</td>
                  <td className="py-2">{r.score?.vas ?? "—"}</td>
                </tr>
              ))}
            {!loading && rows.length === 0 && selectedId && (
              <tr>
                <td colSpan={4} className="py-3 text-slate-500">
                  Sem respostas para este paciente.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
