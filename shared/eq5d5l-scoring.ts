/**
 * EQ-5D-5L scoring.
 *
 * Computes the EQ-5D-5L index value from a 5-digit health profile
 * (mobility, self-care, usual activities, pain/discomfort,
 * anxiety/depression — each 1..5).
 *
 * Two value sets are supported:
 *   - "pt"  Ferreira et al. 2014 (Portugal, TTO)
 *   - "uk"  Devlin et al. 2018 (United Kingdom, hybrid)
 *
 * IMPORTANT — these coefficients are placeholders close to the published
 * values but NOT cryptographically verified line-by-line against the
 * source papers. Use them as-is for the V1 demo (shape and direction of
 * the index trends are what the dashboard renders), and replace with
 * verified coefficients before any clinical pilot. Replace just the
 * COEFFS_* tables; the scoring structure is correct.
 *
 * References:
 *   Ferreira PL et al. (2014). EQ-5D Portuguese population norms.
 *   Devlin NJ et al. (2018). Valuing health-related quality of life: an
 *   EQ-5D-5L value set for England.
 */

export type Profile = string  // 5 chars, each '1'..'5', e.g. "12321"
export type ValueSet = "pt" | "uk"

interface Coefficients {
  /** Constant, applied when ANY dimension is not at level 1 */
  constant: number
  /**
   * Per-dimension level decrements. Length 5; index `level-1` holds the
   * decrement for that level (index 0 is always 0, since level 1 = no
   * problems).
   */
  mobility:          readonly [0, number, number, number, number]
  selfCare:          readonly [0, number, number, number, number]
  usualActivities:   readonly [0, number, number, number, number]
  painDiscomfort:    readonly [0, number, number, number, number]
  anxietyDepression: readonly [0, number, number, number, number]
  /** N4 interaction term applied when any dimension is at level 4 or 5 */
  n4: number
}

// Approximate Ferreira 2014 PT coefficients.
const COEFFS_PT: Coefficients = {
  constant: 0.0667,
  mobility:          [0, 0.030, 0.080, 0.146, 0.236],
  selfCare:          [0, 0.039, 0.075, 0.127, 0.220],
  usualActivities:   [0, 0.029, 0.066, 0.116, 0.213],
  painDiscomfort:    [0, 0.058, 0.105, 0.181, 0.270],
  anxietyDepression: [0, 0.064, 0.118, 0.181, 0.281],
  n4: 0.055
}

// Approximate Devlin 2018 UK coefficients.
const COEFFS_UK: Coefficients = {
  constant: 0.0488,
  mobility:          [0, 0.058, 0.076, 0.207, 0.274],
  selfCare:          [0, 0.050, 0.080, 0.164, 0.203],
  usualActivities:   [0, 0.050, 0.063, 0.162, 0.184],
  painDiscomfort:    [0, 0.063, 0.084, 0.276, 0.335],
  anxietyDepression: [0, 0.078, 0.104, 0.285, 0.289],
  n4: 0
}

const COEFFS: Record<ValueSet, Coefficients> = { pt: COEFFS_PT, uk: COEFFS_UK }

/**
 * Score a health profile. Returns a number rounded to 3 decimals,
 * typically in the range -0.5 to 1.0.
 *
 * Profile must be exactly 5 chars, each "1".."5". Returns NaN if
 * the profile is malformed.
 */
export function scoreProfile(profile: Profile, vs: ValueSet = "pt"): number {
  if (!/^[1-5]{5}$/.test(profile)) return Number.NaN
  if (profile === "11111") return 1.0
  const c = COEFFS[vs]
  const levels = profile.split("").map((s) => Number(s) as 1 | 2 | 3 | 4 | 5) as
    [1 | 2 | 3 | 4 | 5, 1 | 2 | 3 | 4 | 5, 1 | 2 | 3 | 4 | 5, 1 | 2 | 3 | 4 | 5, 1 | 2 | 3 | 4 | 5]
  const [mo, sc, ua, pd, ad] = levels
  const anyL4plus = levels.some((l) => l >= 4)

  // Arrays are indexed by (level - 1), so a level-1 answer hits the
  // leading zero (no decrement).
  const decrement =
    c.constant +
    c.mobility[(mo - 1) as 0 | 1 | 2 | 3 | 4] +
    c.selfCare[(sc - 1) as 0 | 1 | 2 | 3 | 4] +
    c.usualActivities[(ua - 1) as 0 | 1 | 2 | 3 | 4] +
    c.painDiscomfort[(pd - 1) as 0 | 1 | 2 | 3 | 4] +
    c.anxietyDepression[(ad - 1) as 0 | 1 | 2 | 3 | 4] +
    (anyL4plus ? c.n4 : 0)

  return Math.round((1 - decrement) * 1000) / 1000
}

/** Derive the 5-char profile from question answers (1..5 each). */
export function buildProfile(answers: {
  mobility: number
  self_care: number
  usual_activities: number
  pain_discomfort: number
  anxiety_depression: number
}): Profile {
  const dims = [
    answers.mobility,
    answers.self_care,
    answers.usual_activities,
    answers.pain_discomfort,
    answers.anxiety_depression
  ]
  if (dims.some((v) => !Number.isInteger(v) || v < 1 || v > 5)) return "00000"
  return dims.join("")
}

/** Map a Locale to the right value set. Defaults to PT. */
export function valueSetForLocale(locale: "pt" | "en"): ValueSet {
  return locale === "en" ? "uk" : "pt"
}
