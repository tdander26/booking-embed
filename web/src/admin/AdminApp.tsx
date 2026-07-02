import { useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import { CalendarDays, Clock, ListChecks, MessageSquare, Settings, LogOut, Users, Code, KeyRound } from 'lucide-react';
import { getFirebaseAuth } from '../lib/firebase';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { applyBrand, applyTheme } from '../lib/brand';
import type { AdminMe } from '../api/types';
import { Spinner, Button, Banner, Card } from '../components/ui';
import { EventTypesTab } from './EventTypesTab';
import { ProvidersTab } from './ProvidersTab';
import { SchedulesTab } from './SchedulesTab';
import { BookingsTab } from './BookingsTab';
import { ConversationsTab } from './ConversationsTab';
import { EmbedTab } from './EmbedTab';
import { SettingsTab } from './SettingsTab';
import { PlatformTab } from './PlatformTab';

type Tab =
  | 'bookings'
  | 'conversations'
  | 'eventTypes'
  | 'providers'
  | 'schedules'
  | 'embed'
  | 'settings'
  | 'platform';

const TABS: { key: Tab; label: string; icon: typeof Clock }[] = [
  { key: 'bookings', label: 'Bookings', icon: ListChecks },
  { key: 'conversations', label: 'Conversations', icon: MessageSquare },
  { key: 'eventTypes', label: 'Event types', icon: CalendarDays },
  { key: 'providers', label: 'Providers', icon: Users },
  { key: 'schedules', label: 'Availability', icon: Clock },
  { key: 'embed', label: 'Embed', icon: Code },
  { key: 'settings', label: 'Settings', icon: Settings },
];

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8a12 12 0 1 1 0-24c3 0 5.8 1.1 7.9 3l5.7-5.7A20 20 0 1 0 24 44c11 0 20-8 20-20 0-1.2-.1-2.3-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8A12 12 0 0 1 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7A20 20 0 0 0 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2A12 12 0 0 1 12.7 28l-6.5 5A20 20 0 0 0 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C39 36 44 31 44 24c0-1.2-.1-2.3-.4-3.5z"
      />
    </svg>
  );
}

export function AdminApp({ tenantSlug }: { tenantSlug: string }) {
  const auth = getFirebaseAuth();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [adminOk, setAdminOk] = useState<boolean | null>(null);
  const [me, setMe] = useState<AdminMe | null>(null);
  const [tab, setTab] = useState<Tab>('bookings');

  useEffect(() => onAuthStateChanged(auth, setUser), [auth]);

  useEffect(() => {
    if (!user) {
      setAdminOk(null);
      setMe(null);
      return;
    }
    api
      .adminGetBranding()
      .then((b) => {
        applyTheme(b.theme);
        applyBrand(b.brandColor);
        setAdminOk(true);
      })
      .catch((e: ApiError) => setAdminOk(e.status === 403 ? false : true));
  }, [user]);

  useEffect(() => {
    if (adminOk !== true) {
      setMe(null);
      return;
    }
    api.adminMe().then(setMe).catch(() => setMe(null));
  }, [adminOk]);

  if (user === undefined)
    return (
      <div className="py-20">
        <Spinner />
      </div>
    );
  if (!user) return <SignIn />;

  // The platform owner gets an extra tab to mint self-serve signup access codes.
  const tabs =
    me?.role === 'platform'
      ? [...TABS, { key: 'platform' as Tab, label: 'Platform', icon: KeyRound }]
      : TABS;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-7 flex items-center justify-between">
        <h1 className="font-display text-2xl font-semibold text-ink">Scheduling admin</h1>
        <div className="flex items-center gap-3 text-sm text-muted">
          <span className="hidden sm:inline">{user.email}</span>
          <Button variant="ghost" onClick={() => signOut(auth)}>
            <LogOut size={16} /> Sign out
          </Button>
        </div>
      </header>

      {adminOk === false ? (
        <Card className="p-6">
          <Banner kind="error">
            {user.email} is signed in but isn't an admin of this practice. Ask the practice owner
            to add you as a provider with admin access, then sign out and back in.
          </Banner>
        </Card>
      ) : (
        <>
          <nav className="mb-6 flex gap-1 rounded-xl border border-hair-soft bg-surface p-1">
            {tabs.map((t) => {
              const Icon = t.icon;
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  title={t.label}
                  aria-label={t.label}
                  className={[
                    'inline-flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-2 py-2 text-sm font-medium transition lg:flex-none lg:justify-start lg:px-3',
                    active
                      ? 'bg-surface-3 text-ink shadow-sm ring-1 ring-hair'
                      : 'text-muted hover:text-ink hover:bg-overlay',
                  ].join(' ')}
                >
                  <Icon size={16} className={active ? 'text-brand' : ''} />
                  <span className="hidden lg:inline">{t.label}</span>
                </button>
              );
            })}
          </nav>

          {tab === 'bookings' && <BookingsTab />}
          {tab === 'conversations' && <ConversationsTab />}
          {tab === 'eventTypes' && <EventTypesTab />}
          {tab === 'providers' && <ProvidersTab me={me} />}
          {tab === 'schedules' && <SchedulesTab />}
          {tab === 'embed' && <EmbedTab tenantSlug={tenantSlug} />}
          {tab === 'settings' && <SettingsTab />}
          {tab === 'platform' && <PlatformTab />}
        </>
      )}
    </div>
  );
}

function SignIn() {
  const auth = getFirebaseAuth();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
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
    <div className="mx-auto max-w-sm px-4 py-20">
      <Card className="p-8 text-center">
        <h1 className="font-display text-2xl font-semibold text-ink">Admin sign in</h1>
        <p className="mb-6 mt-1.5 text-sm text-muted">
          Sign in with your Google account to manage your scheduling.
        </p>
        {err && (
          <div className="mb-4">
            <Banner kind="error">{err}</Banner>
          </div>
        )}
        <Button variant="outline" onClick={signIn} disabled={busy} className="w-full bg-overlay-soft">
          <GoogleMark /> {busy ? 'Opening Google…' : 'Continue with Google'}
        </Button>
      </Card>
    </div>
  );
}
