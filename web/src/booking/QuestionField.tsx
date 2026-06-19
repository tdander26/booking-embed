import type { IntakeQuestion, AnswerValue } from '../api/types';
import { Field, inputClass } from '../components/ui';

/** Type-appropriate empty value for a question's initial state. */
export function emptyAnswer(q: IntakeQuestion): AnswerValue {
  if (q.type === 'checkboxes') return [];
  if (q.type === 'checkbox') return false;
  return '';
}

/** Client-side validation mirroring the server (required + max lengths +
 * option membership via controls). Returns an error code/message or null. */
export function validateAnswer(q: IntakeQuestion, value: AnswerValue): string | null {
  switch (q.type) {
    case 'text':
    case 'textarea': {
      const s = typeof value === 'string' ? value.trim() : '';
      const max = q.type === 'textarea' ? 5000 : 1000;
      if (q.required && !s) return 'This field is required.';
      if (s.length > max) return `Please keep this under ${max} characters.`;
      return null;
    }
    case 'dropdown': {
      const s = typeof value === 'string' ? value : '';
      if (q.required && !s) return 'Please choose an option.';
      return null;
    }
    case 'checkboxes': {
      const arr = Array.isArray(value) ? value : [];
      if (q.required && arr.length === 0) return 'Please select at least one option.';
      return null;
    }
    case 'checkbox': {
      if (q.required && value !== true) return 'This is required to continue.';
      return null;
    }
    default:
      return null;
  }
}

export function QuestionField({
  question,
  value,
  error,
  onChange,
}: {
  question: IntakeQuestion;
  value: AnswerValue;
  error?: string;
  onChange: (v: AnswerValue) => void;
}) {
  const q = question;
  const label = q.required ? `${q.label} *` : q.label;

  // --- checkbox (single consent) renders its own inline label ---
  if (q.type === 'checkbox') {
    const checked = value === true;
    return (
      <div>
        <label className="flex min-h-[48px] cursor-pointer items-center gap-3 rounded-xl border border-hair-soft bg-surface-2 px-3.5 py-3 text-sm text-ink transition hover:border-brand/50">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            className="h-5 w-5 shrink-0 accent-[var(--brand)]"
          />
          <span>{label}</span>
        </label>
        {q.helpText && <span className="mt-1 block text-xs text-faint">{q.helpText}</span>}
        {error && <span className="mt-1 block text-xs text-red-300">{error}</span>}
      </div>
    );
  }

  // --- checkboxes (multi-select) ---
  if (q.type === 'checkboxes') {
    const arr = Array.isArray(value) ? value : [];
    const toggle = (opt: string) => {
      onChange(arr.includes(opt) ? arr.filter((o) => o !== opt) : [...arr, opt]);
    };
    return (
      <Field label={label} hint={q.helpText}>
        <div className="space-y-2">
          {(q.options ?? []).map((opt) => {
            const on = arr.includes(opt);
            return (
              <label
                key={opt}
                className={[
                  'flex min-h-[48px] cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-3 text-sm transition',
                  on
                    ? 'border-brand/60 bg-brand/10 text-ink'
                    : 'border-hair-soft bg-surface-2 text-ink hover:border-brand/40',
                ].join(' ')}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(opt)}
                  className="h-5 w-5 shrink-0 accent-[var(--brand)]"
                />
                <span>{opt}</span>
              </label>
            );
          })}
        </div>
        {error && <span className="mt-1 block text-xs text-red-300">{error}</span>}
      </Field>
    );
  }

  // --- dropdown (single select) ---
  if (q.type === 'dropdown') {
    const s = typeof value === 'string' ? value : '';
    return (
      <Field label={label} hint={q.helpText}>
        <select
          value={s}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputClass} min-h-[48px] appearance-none`}
        >
          <option value="" disabled>
            {q.placeholder || 'Select…'}
          </option>
          {(q.options ?? []).map((opt) => (
            <option key={opt} value={opt} className="bg-surface-2 text-ink">
              {opt}
            </option>
          ))}
        </select>
        {error && <span className="mt-1 block text-xs text-red-300">{error}</span>}
      </Field>
    );
  }

  // --- textarea ---
  if (q.type === 'textarea') {
    const s = typeof value === 'string' ? value : '';
    return (
      <Field label={label} hint={q.helpText}>
        <textarea
          className={`${inputClass} min-h-[84px] resize-y`}
          value={s}
          placeholder={q.placeholder}
          maxLength={5000}
          onChange={(e) => onChange(e.target.value)}
        />
        {error && <span className="mt-1 block text-xs text-red-300">{error}</span>}
      </Field>
    );
  }

  // --- text (default) ---
  const s = typeof value === 'string' ? value : '';
  return (
    <Field label={label} hint={q.helpText}>
      <input
        className={inputClass}
        value={s}
        placeholder={q.placeholder}
        maxLength={1000}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <span className="mt-1 block text-xs text-red-300">{error}</span>}
    </Field>
  );
}
