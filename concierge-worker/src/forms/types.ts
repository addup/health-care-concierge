/**
 * Shape of question entries inside concierge_form_templates.schema.
 * Source-of-truth: docs/concierge/03-migration.sql seed inserts.
 */

export type Locale = "pt" | "en"

interface BaseQ {
  id: string
  type: "scale" | "likert5" | "likert5_inverse" | "vas" | "free_text"
  prompt_pt?: string
  prompt_en?: string
  optional?: boolean
}

export interface ScaleQ extends BaseQ {
  type: "scale"
  min: number
  max: number
}

export interface Likert5Q extends BaseQ {
  type: "likert5"
  labels_pt?: string[]
  labels_en?: string[]
}

export interface Likert5InverseQ extends BaseQ {
  type: "likert5_inverse"
  labels_pt?: string[]
  labels_en?: string[]
}

export interface VasQ extends BaseQ {
  type: "vas"
  min: number
  max: number
  step: number
}

export interface FreeTextQ extends BaseQ {
  type: "free_text"
}

export type Question = ScaleQ | Likert5Q | Likert5InverseQ | VasQ | FreeTextQ

export interface TemplateSchema {
  id: string
  questions: Question[]
}

export interface FormState {
  dispatch_id: string
  template_id: string
  template_schema: TemplateSchema
  cursor: number
  answers: Record<string, number | string>
  awaiting_text: boolean
  chat_id: number
}

export function promptFor(q: Question, locale: Locale): string {
  return (locale === "en" ? q.prompt_en : q.prompt_pt) ?? q.prompt_pt ?? q.prompt_en ?? q.id
}

export function labelsFor(q: Likert5Q | Likert5InverseQ, locale: Locale): string[] | undefined {
  return locale === "en" ? q.labels_en ?? q.labels_pt : q.labels_pt ?? q.labels_en
}
