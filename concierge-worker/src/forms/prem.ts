/**
 * PREM-specific scoring. Question ids match the seed in 03-migration.sql:
 *   nps (scale 0-10), wait_time (likert5), communication (likert5),
 *   comment (free_text, optional).
 */

export interface PremScore {
  nps: number
  nps_segment: "detractor" | "passive" | "promoter"
  wait_time: number | null
  communication: number | null
  comment: string | null
}

export function scorePREM(answers: Record<string, number | string>): PremScore {
  const nps = toInt(answers.nps) ?? 0
  return {
    nps,
    nps_segment: nps >= 9 ? "promoter" : nps >= 7 ? "passive" : "detractor",
    wait_time: toInt(answers.wait_time),
    communication: toInt(answers.communication),
    comment: typeof answers.comment === "string" && answers.comment.trim().length > 0
      ? answers.comment.trim()
      : null
  }
}

function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v
  if (typeof v === "string") {
    const n = parseInt(v, 10)
    return Number.isInteger(n) ? n : null
  }
  return null
}
