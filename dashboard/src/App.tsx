import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom"
import PromsPage from "./pages/PromsPage"
import PremsPage from "./pages/PremsPage"

function NavBar() {
  const { pathname } = useLocation()
  const tab = (path: string, label: string) => {
    const active = pathname === path || (path === "/proms" && pathname === "/")
    return (
      <Link
        to={path}
        className={`px-4 py-2 text-sm font-medium rounded-md ${
          active ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-200"
        }`}
      >
        {label}
      </Link>
    )
  }
  return (
    <nav className="flex items-center justify-between border-b bg-white px-6 py-3">
      <div className="flex items-center gap-3">
        <span className="text-base font-semibold">EQUAL Care · Dashboard</span>
        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
          DEMO ONLY — local use, no auth
        </span>
      </div>
      <div className="flex gap-2">
        {tab("/proms", "PROMs")}
        {tab("/prems", "PREMs")}
      </div>
    </nav>
  )
}

export default function App() {
  return (
    <div className="min-h-screen">
      <NavBar />
      <main className="mx-auto max-w-6xl px-6 py-6">
        <Routes>
          <Route path="/" element={<Navigate to="/proms" replace />} />
          <Route path="/proms" element={<PromsPage />} />
          <Route path="/prems" element={<PremsPage />} />
          <Route path="*" element={<div>Not found.</div>} />
        </Routes>
      </main>
    </div>
  )
}
