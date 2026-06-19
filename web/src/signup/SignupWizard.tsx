import { useEffect, useMemo, useState } from 'react';
import {
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import { CalendarCheck, ArrowRight } from 'lucide-react';
import { getFirebaseAuth } from '../lib/firebase';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { guessTimezone, timezoneOptions } from '../lib/time';
import { Spinner, Button, Banner, Card, Field, inputClass } from '../components/ui';

/** Mirror of functions/src/util/ids.ts slugify for the live URL preview. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8a12 12 0 1 1 0-24c3 0 5.8 1.1 7.9 3l5.7-5.7A20 20 0 1 0 24 44c11 0 20-8 20-20 0-1.2-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8A12 12 0 0 1 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7A20 20 0 0 0 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2A12 12 0 0 1 12.7 28l-6.5 5A20 20 0 0 0 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C39 36 44 31 44 24c0-1.2-.1-2.3-.4-3.5z" />
    </svg>
  );
}

export function SignupWizard() {
  const auth = getFirebaseAuth();
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => onAuthStateChanged(auth, setUser), [auth]);

  if (user === undefined) {
    return (
      <div className="py-20">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-4 py-12 sm:py-16">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl text-brand-fg shadow-gold-glow [background:linear-gradient(135deg,var(--brand-light),var(--brand-dark))]">
          <CalendarCheck size={22} />
        </span>
        <div>
          <h1 className="font-display text-2xl font-semibold leading-tight text-ink">
            Create your booking page
          </h1>
          <p className="text-sm text-muted">A premium scheduling page for your practice.</p>
        </div>
      </div>
      {user ? <SignupForm user={user} onSignOut={() => signOut(auth)} /> : <StartWithGoogle />}
      <p className="mt-4 text-center text-xs text-faint">
        Powered by your own scheduling — no per-seat fees.
      </p>
    </div>
  );
}

function StartWithGoogle() {
  const auth = getFirebaseAuth();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setErr(null);
    setBusy(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await signInWithPopup(auth, provider);
    } catch (e) {
      setErr((e as Error).message.replace('Firebase: ', ''));
      setBusy(false);
    }
  };

  return (
    <Card className="p-7 text-center">
      <p className="mb-5 text-sm text-muted">
        Start by signing in with the Google account you'll use to manage your practice.
      </p>
      {err && (
        <div className="mb-4">
          <Banner kind="error">{err}</Banner>
        </div>
      )}
      <Button variant="outline" onClick={start} disabled={busy} className="w-full bg-overlay-soft">
        <GoogleMark /> {busy ? 'Opening Google…' : 'Continue with Google'}
      </Button>
    </Card>
  );
}

function SignupForm({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [practiceName, setPracticeName] = useState('');
  const [slug, setSlug] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [timezone, setTimezone] = useState(guessTimezone() || 'America/Chicago');
  const [touchedSlug, setTouchedSlug] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Auto-fill the slug from the practice name until the user edits it directly.
  const effectiveSlug = useMemo(
    () => slugify(touchedSlug ? slug : practiceName),
    [touchedSlug, slug, practiceName],
  );
  const origin = window.location.origin;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!practiceName.trim()) return setErr('Please enter your practice name.');
    if (effectiveSlug.length < 3) return setErr('Your URL name needs at least 3 characters.');
    if (!accessCode.trim()) return setErr('Please enter your access code.');
    setBusy(true);
    try {
      const { adminUrl } = await api.signup({
        practiceName: practiceName.trim(),
        desiredSlug: effectiveSlug,
        accessCode: accessCode.trim(),
        timezone,
      });
      // Hard navigation so the SPA re-resolves the new tenant from the path.
      window.location.href = adminUrl;
    } catch (e) {
      const ae = e as ApiError;
      const map: Record<string, string> = {
        slug_taken: 'That URL name is taken — try another.',
        invalid_slug: 'That URL name is reserved or invalid — try another.',
        bad_code: 'That access code isn’t valid.',
        code_exhausted: 'That access code has been fully used.',
        already_owner: ae.message, // server includes the existing practice slug
        email_unverified: 'Please use a verified Google account.',
        rate_limited: 'Too many attempts — please wait a moment.',
      };
      setErr(map[ae.code] || ae.message || 'Could not create your practice.');
      setBusy(false);
    }
  };

  return (
    <Card className="p-6 sm:p-7">
      <div className="mb-4 flex items-center justify-between gap-2 text-sm">
        <span className="truncate text-muted">
          Signed in as <span className="text-ink">{user.email}</span>
        </span>
        <button onClick={onSignOut} className="shrink-0 text-faint hover:text-muted">
          Switch
        </button>
      </div>
      {err && (
        <div className="mb-4">
          <Banner kind="error">{err}</Banner>
        </div>
      )}
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Practice name" required>
          <input
            className={inputClass}
            value={practiceName}
            placeholder="Riverside Wellness"
            autoComplete="organization"
            onChange={(e) => setPracticeName(e.target.value)}
          />
        </Field>
        <Field
          label="Your booking page URL"
          required
          hint={`Patients will book at ${origin}/${effectiveSlug || 'your-practice'}`}
        >
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 text-sm text-faint">/</span>
            <input
              className={inputClass}
              value={touchedSlug ? slug : effectiveSlug}
              placeholder="riverside-wellness"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => {
                setTouchedSlug(true);
                setSlug(e.target.value);
              }}
            />
          </div>
        </Field>
        <Field label="Time zone">
          <select
            className={inputClass}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {timezoneOptions().map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Access code" required hint="The invite code we gave you.">
          <input
            className={inputClass}
            value={accessCode}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => setAccessCode(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Creating…' : 'Create my booking page'} <ArrowRight size={16} />
        </Button>
      </form>
    </Card>
  );
}
