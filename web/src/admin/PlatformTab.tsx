import { useEffect, useState } from 'react';
import { KeyRound, Copy, Check, Plus, Mail } from 'lucide-react';
import * as api from '../api/client';
import type { SignupCodeView, EmailUsageView } from '../api/client';
import { Spinner, Banner, Button, Card, Field, inputClass } from '../components/ui';

/** Platform-owner only. Mint + review the access codes that gate self-serve
 * practice sign-up at /signup. The raw code is shown ONCE on mint (only its hash
 * is stored), so it must be copied immediately. */
export function PlatformTab() {
  const [codes, setCodes] = useState<SignupCodeView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [label, setLabel] = useState('');
  const [maxUses, setMaxUses] = useState(1);
  const [expires, setExpires] = useState(''); // yyyy-mm-dd, optional
  const [minting, setMinting] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null); // the just-minted raw code
  const [copied, setCopied] = useState(false);

  const load = () =>
    api
      .platformListCodes()
      .then((r) => setCodes(r.codes.sort((a, b) => b.createdAt.localeCompare(a.createdAt))))
      .catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  const mint = async () => {
    setErr(null);
    setFresh(null);
    setCopied(false);
    if (!label.trim()) return setErr('Give the code a label so you can track it.');
    setMinting(true);
    try {
      const res = await api.platformMintCode({
        label: label.trim(),
        maxUses,
        expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
      });
      setFresh(res.code);
      setLabel('');
      setMaxUses(1);
      setExpires('');
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setMinting(false);
    }
  };

  const copy = async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh);
    } catch {
      /* ignore */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="space-y-5">
      <EmailUsageCard />

      <Card className="p-5">
        <div className="mb-1 flex items-center gap-2">
          <KeyRound size={18} className="text-brand" />
          <h2 className="text-base font-semibold text-ink">Signup access codes</h2>
        </div>
        <p className="mb-4 text-sm text-muted">
          A practice needs one of these codes to create an account at{' '}
          <span className="font-display text-brand-light">/signup</span>. The code is shown once on
          creation — copy it then; only a hash is stored.
        </p>

        {err && (
          <div className="mb-4">
            <Banner kind="error">{err}</Banner>
          </div>
        )}

        {fresh && (
          <div className="mb-4 rounded-xl border border-brand/40 bg-brand/10 p-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-brand-light">
              New code — copy it now
            </div>
            <div className="flex items-center gap-3">
              <code className="flex-1 select-all font-display text-lg font-semibold text-ink">
                {fresh}
              </code>
              <button
                onClick={copy}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-hair px-3 text-sm font-medium text-ink transition hover:border-brand/60 hover:bg-overlay"
              >
                {copied ? <Check size={15} className="text-brand" /> : <Copy size={15} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <Field label="Label" hint="e.g. the clinic's name — for your reference only.">
            <input
              className={inputClass}
              value={label}
              placeholder="Riverside Wellness"
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <Field label="Max uses">
            <input
              type="number"
              min={1}
              max={1000}
              className={`${inputClass} sm:w-24`}
              value={maxUses}
              onChange={(e) => setMaxUses(Math.max(1, parseInt(e.target.value, 10) || 1))}
            />
          </Field>
          <Field label="Expires (optional)">
            <input
              type="date"
              className={`${inputClass} sm:w-44`}
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-4">
          <Button onClick={mint} disabled={minting}>
            <Plus size={16} /> {minting ? 'Minting…' : 'Mint code'}
          </Button>
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="mb-3 text-sm font-semibold text-ink">Existing codes</h3>
        {!codes ? (
          <Spinner />
        ) : codes.length === 0 ? (
          <p className="text-sm text-faint">No codes yet.</p>
        ) : (
          <div className="space-y-2">
            {codes.map((c) => {
              const exhausted = c.uses >= c.maxUses;
              const expired = c.expiresAt ? Date.now() > new Date(c.expiresAt).getTime() : false;
              const usable = c.active && !exhausted && !expired;
              return (
                <div
                  key={c.hashPrefix}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-hair-soft bg-surface-2 px-4 py-3 text-sm"
                >
                  <span className="font-medium text-ink">{c.label || '(no label)'}</span>
                  <span className="text-faint">·</span>
                  <span className={usable ? 'text-muted' : 'text-faint'}>
                    {c.uses}/{c.maxUses} used
                  </span>
                  {!usable && (
                    <span className="rounded-full bg-overlay px-2 py-0.5 text-xs text-faint">
                      {exhausted ? 'used up' : expired ? 'expired' : 'inactive'}
                    </span>
                  )}
                  <span className="ml-auto font-mono text-xs text-faint">{c.hashPrefix}…</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

/** A labeled usage bar with shape+color state (ok / near / over the limit). */
function Meter({
  label,
  value,
  limit,
  sub,
}: {
  label: string;
  value: number;
  limit: number;
  sub: string;
}) {
  const ratio = limit > 0 ? value / limit : 0;
  const pct = Math.min(100, Math.round(ratio * 100));
  const state = ratio >= 1 ? 'over' : ratio >= 0.8 ? 'near' : 'ok';
  const color = state === 'over' ? '#dc2626' : state === 'near' ? '#d99409' : 'var(--brand)';
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-medium text-ink">{label}</span>
        <span className="text-sm text-muted">
          <span className="font-semibold text-ink">{value.toLocaleString()}</span> /{' '}
          {limit.toLocaleString()}
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-overlay">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-xs">
        <span className="text-faint">{sub}</span>
        {state !== 'ok' && (
          <span style={{ color }} className="font-medium">
            {state === 'over' ? '● Over free tier' : '▲ Near limit'}
          </span>
        )}
      </div>
    </div>
  );
}

/** Platform-wide email volume vs Resend's free tier (the binding cost limit). */
function EmailUsageCard() {
  const [u, setU] = useState<EmailUsageView | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.platformEmailUsage().then(setU).catch((e) => setErr((e as Error).message));
  }, []);

  const TYPES: { key: string; label: string }[] = [
    { key: 'reminder', label: 'reminders' },
    { key: 'confirmation', label: 'confirmations' },
    { key: 'cancellation', label: 'cancellations' },
    { key: 'other', label: 'other' },
  ];

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center gap-2">
        <Mail size={18} className="text-brand" />
        <h2 className="text-base font-semibold text-ink">Email usage</h2>
      </div>
      <p className="mb-4 text-sm text-muted">
        Every email across all practices — confirmations, reminders &amp; cancellations — against
        Resend&apos;s free tier. The daily cap is the one that bites first.
      </p>

      {err && <Banner kind="error">{err}</Banner>}
      {!u ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <Meter
            label="Today (UTC)"
            value={u.today}
            limit={u.limits.perDay}
            sub="Free tier resets daily at 00:00 UTC"
          />
          <Meter
            label={`This month · ${u.month}`}
            value={u.total}
            limit={u.limits.perMonth}
            sub={`Free tier: ${u.limits.perMonth.toLocaleString()} / month`}
          />

          {u.total > 0 && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
              {TYPES.filter((t) => (u.byType[t.key] ?? 0) > 0).map((t) => (
                <span key={t.key}>
                  <span className="font-semibold text-ink">
                    {(u.byType[t.key] ?? 0).toLocaleString()}
                  </span>{' '}
                  {t.label}
                </span>
              ))}
            </div>
          )}

          {(u.today / u.limits.perDay >= 0.8 || u.total / u.limits.perMonth >= 0.8) && (
            <div className="rounded-xl border border-hair bg-overlay-soft p-3 text-xs text-muted">
              Approaching the free tier.{' '}
              <span className="font-medium text-ink">Resend Pro is $20/mo</span> for 50,000
              emails/month and removes the 100/day cap.
            </div>
          )}

          {Object.keys(u.byTenant).length > 0 && (
            <div className="border-t border-hair-soft pt-3">
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-faint">
                By practice (this month)
              </h3>
              <div className="space-y-1">
                {Object.entries(u.byTenant)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 8)
                  .map(([slug, n]) => (
                    <div key={slug} className="flex items-center justify-between text-sm">
                      <span className="text-muted">{slug}</span>
                      <span className="text-ink">{n.toLocaleString()}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
