import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import * as api from '../api/client';
import type { PublicBranding } from '../api/types';
import { timezoneOptions } from '../lib/time';
import { Spinner, Banner, Button, Card, Field, inputClass } from '../components/ui';

export function SettingsTab() {
  return (
    <div className="space-y-6">
      <CalendarPointerCard />
      <BrandingPanel />
    </div>
  );
}

function CalendarPointerCard() {
  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center gap-2">
        <Users size={18} className="text-brand" />
        <h2 className="text-base font-semibold text-ink">Google Calendar</h2>
      </div>
      <p className="text-sm text-muted">
        Calendar connections are now per provider. Manage each provider's Google accounts and
        their busy / write calendars under the{' '}
        <span className="font-medium text-ink">Providers</span> tab.
      </p>
      <p className="mt-2 text-xs text-faint">
        Each provider connects their own Google account and picks which calendars block their
        availability and where confirmed events are written.
      </p>
    </Card>
  );
}

function BrandingPanel() {
  const [b, setB] = useState<PublicBranding | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.adminGetBranding().then(setB).catch((e) => setErr((e as Error).message));
  }, []);

  const save = async () => {
    if (!b) return;
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const next = await api.adminSaveBranding(b);
      setB(next);
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (err && !b) return <Banner kind="error">{err}</Banner>;
  if (!b) return <Spinner />;
  const set = (patch: Partial<PublicBranding>) => setB({ ...b, ...patch });

  return (
    <Card className="p-5">
      <h2 className="mb-3 text-base font-semibold text-ink">Branding</h2>
      {err && <Banner kind="error">{err}</Banner>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Display name">
          <input className={inputClass} value={b.displayName} onChange={(e) => set({ displayName: e.target.value })} />
        </Field>
        <Field label="Tagline">
          <input className={inputClass} value={b.tagline} onChange={(e) => set({ tagline: e.target.value })} />
        </Field>
        <Field label="Default timezone">
          <select className={inputClass} value={b.timezone} onChange={(e) => set({ timezone: e.target.value })}>
            {timezoneOptions().map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Brand color">
          <input
            type="color"
            className="h-11 w-full rounded-lg border border-hair-soft"
            value={b.brandColor}
            onChange={(e) => set({ brandColor: e.target.value })}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Avatar URL" hint="Optional image shown on the booking page.">
            <input className={inputClass} value={b.avatarUrl} onChange={(e) => set({ avatarUrl: e.target.value })} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Welcome text">
            <textarea
              className={`${inputClass} min-h-[70px]`}
              value={b.welcomeText}
              onChange={(e) => set({ welcomeText: e.target.value })}
            />
          </Field>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save branding'}
        </Button>
        {saved && <span className="text-sm text-brand">Saved</span>}
      </div>
    </Card>
  );
}
