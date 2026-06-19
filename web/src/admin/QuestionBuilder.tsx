import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import type { IntakeQuestion, QuestionType } from '../api/types';
import { Button, Field, inputClass } from '../components/ui';

const TYPE_LABELS: Record<QuestionType, string> = {
  text: 'Short text',
  textarea: 'Paragraph',
  phone: 'Phone number',
  dropdown: 'Dropdown (pick one)',
  checkboxes: 'Checkboxes (pick many)',
  checkbox: 'Single checkbox (consent)',
};

const NEEDS_OPTIONS: QuestionType[] = ['dropdown', 'checkboxes'];

function newId(): string {
  return 'q_' + Math.random().toString(36).slice(2, 10);
}

function resequence(qs: IntakeQuestion[]): IntakeQuestion[] {
  return qs.map((q, i) => ({ ...q, sortOrder: i }));
}

export function QuestionBuilder({
  questions,
  onChange,
}: {
  questions: IntakeQuestion[];
  onChange: (qs: IntakeQuestion[]) => void;
}) {
  const sorted = [...questions].sort((a, b) => a.sortOrder - b.sortOrder);

  const setAt = (idx: number, patch: Partial<IntakeQuestion>) =>
    onChange(resequence(sorted.map((q, i) => (i === idx ? { ...q, ...patch } : q))));

  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= sorted.length) return;
    const next = [...sorted];
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(resequence(next));
  };

  const remove = (idx: number) => onChange(resequence(sorted.filter((_, i) => i !== idx)));

  const add = () =>
    onChange(
      resequence([
        ...sorted,
        { id: newId(), type: 'text', label: '', required: false, options: [], sortOrder: sorted.length },
      ]),
    );

  const changeType = (idx: number, type: QuestionType) => {
    const patch: Partial<IntakeQuestion> = { type };
    if (NEEDS_OPTIONS.includes(type)) {
      const existing = sorted[idx].options ?? [];
      patch.options = existing.length ? existing : [''];
    } else {
      patch.options = undefined;
    }
    setAt(idx, patch);
  };

  return (
    <div className="rounded-xl border border-hair-soft bg-surface-2/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-ink">Intake questions</h3>
          <p className="text-xs text-faint">
            Shown to the booker after their contact details. Answers are saved with the booking.
          </p>
        </div>
        <Button variant="outline" onClick={add}>
          <Plus size={15} /> Add question
        </Button>
      </div>

      {sorted.length === 0 ? (
        <p className="py-3 text-center text-sm text-faint">No custom questions.</p>
      ) : (
        <div className="space-y-3">
          {sorted.map((q, idx) => {
            const needsOptions = NEEDS_OPTIONS.includes(q.type);
            return (
              <div
                key={q.id}
                className="rounded-lg border border-hair-soft bg-surface p-3"
              >
                <div className="mb-2 flex items-start gap-2">
                  <div className="flex flex-col gap-1 pt-1">
                    <button
                      onClick={() => move(idx, -1)}
                      disabled={idx === 0}
                      className="rounded p-1 text-faint hover:text-muted disabled:opacity-30"
                      aria-label="Move up"
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      onClick={() => move(idx, 1)}
                      disabled={idx === sorted.length - 1}
                      className="rounded p-1 text-faint hover:text-muted disabled:opacity-30"
                      aria-label="Move down"
                    >
                      <ArrowDown size={15} />
                    </button>
                  </div>
                  <div className="grid flex-1 gap-3 sm:grid-cols-2">
                    <Field label="Question">
                      <input
                        className={inputClass}
                        value={q.label}
                        placeholder={
                          q.type === 'checkbox' ? 'I agree to the terms' : 'What brings you in?'
                        }
                        onChange={(e) => setAt(idx, { label: e.target.value })}
                      />
                    </Field>
                    <Field label="Type">
                      <select
                        className={inputClass}
                        value={q.type}
                        onChange={(e) => changeType(idx, e.target.value as QuestionType)}
                      >
                        {(Object.keys(TYPE_LABELS) as QuestionType[]).map((t) => (
                          <option key={t} value={t}>
                            {TYPE_LABELS[t]}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <button
                    onClick={() => remove(idx)}
                    className="mt-6 rounded-lg p-2 text-faint hover:bg-red-500/10 hover:text-red-400"
                    aria-label="Delete question"
                  >
                    <Trash2 size={17} />
                  </button>
                </div>

                {needsOptions && (
                  <div className="mb-2 ml-7 space-y-1.5">
                    <span className="block text-xs font-medium uppercase tracking-wider text-muted">
                      Options
                    </span>
                    {(q.options ?? []).map((opt, oi) => (
                      <div key={oi} className="flex items-center gap-2">
                        <input
                          className={inputClass}
                          value={opt}
                          placeholder={`Option ${oi + 1}`}
                          onChange={(e) =>
                            setAt(idx, {
                              options: (q.options ?? []).map((x, j) =>
                                j === oi ? e.target.value : x,
                              ),
                            })
                          }
                        />
                        <button
                          onClick={() =>
                            setAt(idx, {
                              options: (q.options ?? []).filter((_, j) => j !== oi),
                            })
                          }
                          className="text-faint hover:text-red-400"
                          aria-label="Remove option"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() => setAt(idx, { options: [...(q.options ?? []), ''] })}
                      className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
                    >
                      <Plus size={13} /> Add option
                    </button>
                  </div>
                )}

                <div className="ml-7">
                  <label className="flex items-center gap-2 text-sm text-muted">
                    <input
                      type="checkbox"
                      checked={q.required}
                      onChange={(e) => setAt(idx, { required: e.target.checked })}
                    />
                    Required
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Returns a human error string if any question is invalid, else null. */
export function validateQuestions(questions: IntakeQuestion[]): string | null {
  for (const q of questions) {
    if (!q.label.trim()) return 'Every intake question needs a label.';
    if (NEEDS_OPTIONS.includes(q.type)) {
      const opts = (q.options ?? []).map((o) => o.trim()).filter(Boolean);
      if (opts.length === 0)
        return `"${q.label}" is a ${q.type} and needs at least one option.`;
    }
  }
  return null;
}
