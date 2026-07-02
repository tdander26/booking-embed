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
      <ChatAssistantPanel />
    </div>
  );
}

/** Editable knowledge base for the website chat assistant. Blank => the
 * built-in default text ships with the code; saving text overrides it live
 * (no deploy needed). */
function ChatAssistantPanel() {
  const [text, setText] = useState<string | null>(null);
  const [defaultText, setDefaultText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .adminGetChatSettings()
      .then((s) => {
        setDefaultText(s.defaultPracticeInfo);
        // Prefill the editor with the effective text so editing starts from
        // what the bot actually uses today.
        setText(s.practiceInfo || s.defaultPracticeInfo);
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  const save = async (value: string) => {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const next = await api.adminSaveChatSettings(value);
      setText(next.practiceInfo || next.defaultPracticeInfo);
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (err && text === null) return <Banner kind="error">{err}</Banner>;
  if (text === null) return <Spinner />;

  return (
    <Card className="p-5">
      <h2 className="mb-1 text-base font-semibold text-ink">Chat assistant</h2>
      <p className="mb-3 text-sm text-muted">
        Everything the website chat assistant is allowed to state as fact — hours, pricing,
        services, policies, FAQ. It will not answer beyond this text; unknown questions get
        steered to the free consult. Edits apply immediately, no deploy needed.
      </p>
      {err && <Banner kind="error">{err}</Banner>}
      <Field label="Practice info (the bot's knowledge)">
        <textarea
          className={`${inputClass} min-h-[320px] font-mono text-xs leading-relaxed`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
      </Field>
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={() => save(text)} disabled={busy}>
          {busy ? 'Saving…' : 'Save chat info'}
        </Button>
        <button
          type="button"
          className="text-sm text-muted underline-offset-2 hover:underline disabled:opacity-50"
          disabled={busy}
          onClick={() => {
            setText(defaultText);
            void save('');
          }}
        >
          Reset to default
        </button>
        {saved && <span className="text-sm text-brand">Saved</span>}
      </div>
    </Card>
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

  // Practice-wide reminder default. Absent => the built-in [1440, 60] (24h + 1h).
  const reminders = b.defaultRemindersMinutesBefore ?? [1440, 60];
  const toggleReminder = (min: number, on: boolean) => {
    const next = new Set(reminders);
    if (on) next.add(min);
    else next.delete(min);
    set({ defaultRemindersMinutesBefore: [...next].sort((x, y) => y - x) });
  };

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
          <h3 className="mb-1 text-sm font-semibold text-ink">Appointment reminders</h3>
          <p className="mb-3 text-xs text-faint">
            Reminder emails sent to patients before each appointment. Applies to event types set
            to “Use practice default.” Fewer reminders means fewer emails.
          </p>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-muted">
              <input
                type="checkbox"
                checked={reminders.includes(1440)}
                onChange={(e) => toggleReminder(1440, e.target.checked)}
              />
              Email a reminder 24 hours before
            </label>
            <label className="flex items-center gap-2 text-sm text-muted">
              <input
                type="checkbox"
                checked={reminders.includes(60)}
                onChange={(e) => toggleReminder(60, e.target.checked)}
              />
              Email a reminder 1 hour before
            </label>
            {reminders.length === 0 && (
              <p className="text-xs text-faint">
                No reminder emails will be sent — patients still get the booking confirmation.
              </p>
            )}
          </div>
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
