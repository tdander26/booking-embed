import { useEffect, useState } from 'react';
import { Check, Link2, Unlink } from 'lucide-react';
import * as api from '../api/client';
import type { PublicBranding, GoogleStatus } from '../api/types';
import { timezoneOptions } from '../lib/time';
import { Spinner, Banner, Button, Card, Field, inputClass } from '../components/ui';

export function SettingsTab() {
  return (
    <div className="space-y-6">
      <GooglePanel />
      <BrandingPanel />
    </div>
  );
}

function GooglePanel() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api.adminGoogleStatus().then(setStatus).catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  const connect = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { url } = await api.adminGoogleAuthUrl();
      window.location.href = url;
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (!confirm('Disconnect Google Calendar? New bookings will not sync.')) return;
    await api.adminGoogleDisconnect();
    load();
  };

  const flash = new URLSearchParams(window.location.search).get('google');

  return (
    <Card className="p-5">
      <h2 className="mb-1 text-base font-semibold text-ink">Google Calendar</h2>
      <p className="mb-3 text-sm text-muted">
        Connect your calendar so bookings check your real availability and create events with a
        Meet link.
      </p>
      {flash === 'connected' && <Banner kind="success">Google Calendar connected.</Banner>}
      {flash === 'norefresh' && (
        <Banner kind="error">
          Google didn't return a refresh token. Remove the app from your Google account's
          third-party access, then reconnect.
        </Banner>
      )}
      {(flash === 'error' || flash === 'expired' || flash === 'unconfigured') && (
        <Banner kind="error">Connection failed ({flash}). Please try again.</Banner>
      )}
      {err && <Banner kind="error">{err}</Banner>}

      {!status ? (
        <Spinner />
      ) : status.connected ? (
        <div className="mt-3 flex items-center gap-3">
          <span className="inline-flex items-center gap-2 rounded-lg bg-brand/10 px-3 py-2 text-sm text-brand-light">
            <Check size={16} /> Connected{status.email ? ` (${status.email})` : ''}
          </span>
          <Button variant="outline" onClick={disconnect}>
            <Unlink size={16} /> Disconnect
          </Button>
        </div>
      ) : (
        <Button onClick={connect} disabled={busy}>
          <Link2 size={16} /> {busy ? 'Redirecting…' : 'Connect Google Calendar'}
        </Button>
      )}
      <p className="mt-3 text-xs text-faint">
        Not connected? Bookings still work — they just won't check or write to a real calendar
        (a mock calendar is used).
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
