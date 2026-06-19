import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import * as api from '../api/client';
import type { PublicBranding, ThemeMode } from '../api/types';
import { timezoneOptions } from '../lib/time';
import { applyTheme } from '../lib/brand';
import { Spinner, Banner, Button, Card, Field, inputClass } from '../components/ui';
import { ImageUpload } from '../components/ImageUpload';

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
        <Field label="Theme" hint="Color scheme of your booking page. “Auto” follows the visitor's device.">
          <select
            className={inputClass}
            value={b.theme ?? 'dark'}
            onChange={(e) => {
              const theme = e.target.value as ThemeMode;
              set({ theme });
              applyTheme(theme); // live preview in the admin
            }}
          >
            <option value="dark">Dark (default)</option>
            <option value="light">Light</option>
            <option value="auto">Auto (match device)</option>
          </select>
        </Field>
        <div className="sm:col-span-2">
          <ImageUpload
            label="Logo"
            value={b.avatarUrl}
            onChange={(v) => set({ avatarUrl: v })}
            hint="Shown on the booking page header. Square works best."
            shape="round"
            maxDim={320}
            format="png"
          />
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
        <div className="sm:col-span-2">
          <Field
            label="Sender email (optional)"
            hint="From address on confirmation & reminder emails, e.g. Clinic <bookings@yourdomain.com>. Requires a verified sending domain."
          >
            <input
              className={inputClass}
              value={b.emailFrom ?? ''}
              placeholder="Your Clinic <bookings@yourdomain.com>"
              onChange={(e) => set({ emailFrom: e.target.value })}
            />
          </Field>
        </div>
        <div className="sm:col-span-2 border-t border-hair-soft pt-4">
          <h3 className="mb-1 text-sm font-semibold text-ink">
            Track appointment bookings as a Google Ads conversion
          </h3>
          <p className="mb-3 text-xs text-faint">
            When a patient finishes booking, a conversion is reported to your own Google Ads
            account. Leave blank to turn this off. (When the widget is embedded on your site, your
            site's own Google&nbsp;Ads/GTM tag can also fire off the booking event.)
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Conversion ID" hint="From Google Ads, e.g. AW-123456789">
              <input
                className={inputClass}
                value={b.adsConversionId ?? ''}
                placeholder="AW-XXXXXXXXX"
                onChange={(e) => set({ adsConversionId: e.target.value })}
              />
            </Field>
            <Field label="Conversion label" hint="The conversion action's label">
              <input
                className={inputClass}
                value={b.adsConversionLabel ?? ''}
                placeholder="abCdEf…"
                onChange={(e) => set({ adsConversionLabel: e.target.value })}
              />
            </Field>
          </div>
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
