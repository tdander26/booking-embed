/**
 * Custom intake answers: server-authoritative validation + human-readable
 * formatting. Definitions live on the event type (`eventType.questions`); the
 * validated, normalized snapshot lives on the booking (`booking.answers`).
 *
 * Validation is the only place a stale/hostile client can be caught: option
 * membership, required-ness, and length caps are all checked against the
 * CURRENT event-type questions (the server is the source of truth). Unknown
 * keys in the raw payload are dropped so a stale or crafted form cannot smuggle
 * extra data into the booking doc.
 *
 * Per-type rules (canonical question types):
 *   text      string, trim, ≤ 1000 chars
 *   textarea  string, trim, ≤ 5000 chars
 *   dropdown  string ∈ options (single-select)
 *   checkboxes string[] ⊆ options, deduped (multi-select)
 *   checkbox  boolean (single consent; required ⇒ must be true)
 */
import { ApiError } from '../util/http';
import type { BookingAnswer, EventType, IntakeQuestion } from '../types';

const TEXT_MAX = 1000;
const TEXTAREA_MAX = 5000;

type FieldError = 'required' | 'invalid_option' | 'too_long' | 'invalid_type';

/**
 * Build a 400 `invalid_answers` error with a per-field detail payload attached.
 * `badRequest` in util/http only carries (status, code, message); we attach the
 * structured `{ fields }` on the instance so the error handler / client can map
 * errors back onto individual form fields without changing the shared helper.
 */
function invalidAnswers(fields: Record<string, FieldError>): ApiError {
  const err = new ApiError(400, 'invalid_answers', 'Please review the highlighted fields.');
  (err as ApiError & { details?: unknown }).details = { fields };
  return err;
}

/**
 * Validate a raw `Record<questionId, value>` against the event type's current
 * questions and return the normalized `BookingAnswer[]` to store (label/type
 * snapshotted per the stable-id rule). Throws `badRequest(..., 'invalid_answers',
 * { fields })` where `fields` maps each offending questionId to a reason.
 *
 * Unknown keys are ignored. Empty optional answers are omitted from the result.
 */
export function validateAnswers(
  eventType: EventType,
  raw: Record<string, unknown> | undefined,
): BookingAnswer[] {
  const questions = eventType.questions ?? [];
  if (questions.length === 0) return [];

  const input = raw ?? {};
  const out: BookingAnswer[] = [];
  const fields: Record<string, FieldError> = {};

  for (const q of questions) {
    const present = Object.prototype.hasOwnProperty.call(input, q.id);
    const rawVal = present ? input[q.id] : undefined;

    switch (q.type) {
      case 'text':
      case 'textarea': {
        const max = q.type === 'text' ? TEXT_MAX : TEXTAREA_MAX;
        if (rawVal == null || rawVal === '') {
          if (q.required) fields[q.id] = 'required';
          continue; // omit empty optional
        }
        if (typeof rawVal !== 'string') {
          fields[q.id] = 'invalid_type';
          continue;
        }
        const trimmed = rawVal.trim();
        if (trimmed.length === 0) {
          if (q.required) fields[q.id] = 'required';
          continue;
        }
        if (trimmed.length > max) {
          fields[q.id] = 'too_long';
          continue;
        }
        out.push(answer(q, trimmed));
        break;
      }

      case 'dropdown': {
        const options = q.options ?? [];
        if (rawVal == null || rawVal === '') {
          if (q.required) fields[q.id] = 'required';
          continue;
        }
        if (typeof rawVal !== 'string') {
          fields[q.id] = 'invalid_type';
          continue;
        }
        if (!options.includes(rawVal)) {
          fields[q.id] = 'invalid_option';
          continue;
        }
        out.push(answer(q, rawVal));
        break;
      }

      case 'checkboxes': {
        const options = q.options ?? [];
        if (rawVal == null) {
          if (q.required) fields[q.id] = 'required';
          continue;
        }
        if (!Array.isArray(rawVal)) {
          fields[q.id] = 'invalid_type';
          continue;
        }
        if (rawVal.some((v) => typeof v !== 'string')) {
          fields[q.id] = 'invalid_type';
          continue;
        }
        // De-dupe while preserving first-seen order; reject unknown options.
        const seen = new Set<string>();
        const picked: string[] = [];
        let bad = false;
        for (const v of rawVal as string[]) {
          if (!options.includes(v)) {
            bad = true;
            break;
          }
          if (!seen.has(v)) {
            seen.add(v);
            picked.push(v);
          }
        }
        if (bad) {
          fields[q.id] = 'invalid_option';
          continue;
        }
        if (picked.length === 0) {
          if (q.required) fields[q.id] = 'required';
          continue; // omit empty optional
        }
        out.push(answer(q, picked));
        break;
      }

      case 'checkbox': {
        // Single consent checkbox. Missing/falsy coerces to false.
        const checked = rawVal === true;
        if (q.required && !checked) {
          fields[q.id] = 'required';
          continue;
        }
        out.push(answer(q, checked));
        break;
      }

      default: {
        // Unknown question type — never trust it; treat as invalid if required.
        if (q.required) fields[q.id] = 'invalid_type';
      }
    }
  }

  if (Object.keys(fields).length > 0) throw invalidAnswers(fields);
  return out;
}

function answer(q: IntakeQuestion, value: BookingAnswer['value']): BookingAnswer {
  return { questionId: q.id, label: q.label, type: q.type, value };
}

/** Render one stored value to a human string. */
function formatValue(a: BookingAnswer): string {
  if (a.type === 'checkbox') return a.value === true ? 'Yes' : 'No';
  if (Array.isArray(a.value)) return a.value.join(', ');
  return String(a.value);
}

/**
 * A multi-line "Label: value" block for the Google Calendar event description
 * and emails. Empty values are skipped. Question deleted after booking → the
 * snapshot label is still on the answer, so historical answers are never lost.
 */
export function formatAnswersText(answers: BookingAnswer[]): string {
  const lines: string[] = [];
  for (const a of answers) {
    const v = formatValue(a);
    if (v === '' || v == null) continue;
    const label = a.label || `Question (${a.questionId})`;
    lines.push(`${label}: ${v}`);
  }
  return lines.join('\n');
}
