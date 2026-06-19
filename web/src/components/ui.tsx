import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-muted">
      <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-hair-soft border-t-brand" />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

export function Button({
  variant = 'primary',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'outline' | 'danger';
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-xl px-5 min-h-[46px] text-sm font-semibold tracking-wide transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg';
  const styles: Record<string, string> = {
    primary:
      'text-brand-fg shadow-gold-glow hover:-translate-y-0.5 [background:linear-gradient(100deg,var(--brand-light),var(--brand)_55%,var(--brand-dark))]',
    ghost: 'text-muted hover:text-ink hover:bg-overlay',
    outline: 'border border-hair text-ink hover:border-brand/60 hover:bg-overlay-soft',
    danger: 'bg-red-500/90 text-white hover:bg-red-500',
  };
  return (
    <button className={`${base} ${styles[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-hair-soft bg-surface shadow-lux ${className}`}>
      {children}
    </div>
  );
}

export function Banner({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'error' | 'success';
  children: ReactNode;
}) {
  const styles: Record<string, string> = {
    info: 'bg-overlay-soft text-muted border-hair-soft',
    error: 'bg-red-500/10 text-red-300 border-red-500/30',
    success: 'bg-brand/10 text-brand-light border-brand/30',
  };
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${styles[kind]}`}>{children}</div>
  );
}

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: ReactNode;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted">
        {label}
        {required && <span className="text-red-400"> *</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-faint">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-xl border border-hair-soft bg-surface-2 px-3.5 py-3 text-sm text-ink placeholder-faint shadow-sm transition focus:border-brand/60 focus:outline-none focus:ring-1 focus:ring-brand/40';
