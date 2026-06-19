import type { IntakeQuestion, AnswerValue } from '../api/types';
import { Field, inputClass } from '../components/ui';

/** Light, lenient phone formatting as you type. US 10/11-digit numbers get
 * (xxx) xxx-xxxx; anything starting with '+' or longer is left untouched so
 * international numbers aren't mangled. */
export function formatPhone(input: string): string {
  if (input.trim().startsWith('+')) return input; // international — leave as typed
  const d = input.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1')
    return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length > 10) return input; // unusual length — don't reformat
  if (d.length > 6) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length > 3) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return d;
}

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
    case 'phone': {
      const s = typeof value === 'string' ? value.trim() : '';
      if (q.required && !s) return 'Please enter a phone number.';
      if (s && (s.match(/\d/g)?.length ?? 0) < 7) return 'Please enter a valid phone number.';
      if (s.length > 40) return 'Please keep this under 40 characters.';
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
  const label = q.label;

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
          <span>
            {label}
            {q.required && <span className="text-red-400"> *</span>}
          </span>
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
      <Field label={label} required={q.required} hint={q.helpText}>
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
      <Field label={label} required={q.required} hint={q.helpText}>
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
      <Field label={label} required={q.required} hint={q.helpText}>
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

  // --- phone (telephone-optimized) ---
  if (q.type === 'phone') {
    const s = typeof value === 'string' ? value : '';
    return (
      <Field label={label} required={q.required} hint={q.helpText}>
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          className={inputClass}
          value={s}
          placeholder={q.placeholder || '(555) 123-4567'}
          maxLength={40}
          onChange={(e) => onChange(formatPhone(e.target.value))}
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
