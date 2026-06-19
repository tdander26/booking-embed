import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import * as api from '../api/client';
import type {
  PublicBranding,
  PublicEventType,
  PublicProvider,
  NextAvailableResponse,
  BookingConfirmation,
} from '../api/types';
import { applyBrand, applyTheme } from '../lib/brand';
import { isEmbedded, useEmbedResize } from '../lib/embed';
import { guessTimezone } from '../lib/time';
import { Spinner, Banner } from '../components/ui';
import { EventTypePicker } from './EventTypePicker';
import { ProviderPicker } from './ProviderPicker';
import { Scheduler } from './Scheduler';
import { DetailsForm } from './DetailsForm';
import { Confirmed } from './Confirmed';

type Step = 'pick' | 'provider' | 'schedule' | 'details' | 'done';

const params = new URLSearchParams(window.location.search);
const slugParam = params.get('type');
const providerParam = params.get('provider');

/** featured-first, then sortOrder, then name (server should already do this; we
 * defend against an unsorted payload). */
function orderProviders(ps: PublicProvider[]): PublicProvider[] {
  return [...ps].sort(
    (a, b) =>
      Number(b.featured) - Number(a.featured) ||
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name),
  );
}

export function BookingApp() {
  const embedded = isEmbedded();
  useEmbedResize(embedded);

  const [branding, setBranding] = useState<PublicBranding | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [types, setTypes] = useState<PublicEventType[] | null>(null);
  const [selected, setSelected] = useState<PublicEventType | null>(null);
  const [provider, setProvider] = useState<PublicProvider | null>(null);
  const [nextAvail, setNextAvail] = useState<NextAvailableResponse | null>(null);
  const [slot, setSlot] = useState<{ iso: string; tz: string } | null>(null);
  const [confirmation, setConfirmation] = useState<BookingConfirmation | null>(null);
  const [step, setStep] = useState<Step>('pick');

  // Timezone is lifted here so it persists across provider/schedule remounts.
  const [tz, setTz] = useState<string>(guessTimezone() || 'UTC');
  // Provider ids found fully-booked, so "see other provider" never loops.
  const [exhausted, setExhausted] = useState<Set<string>>(new Set());

  const prefetchNextAvailable = (t: PublicEventType, zone: string) => {
    setNextAvail(null);
    api
      .getNextAvailable({
        eventTypeId: t.id,
        memberIds: t.providers.map((p) => p.id),
        tz: zone,
      })
      .then(setNextAvail)
      .catch(() => setNextAvail(null));
  };

  /** Route into the right step for a freshly-resolved (or deep-linked) type. */
  const enterType = (t: PublicEventType, zone: string, preferProviderId?: string | null) => {
    const ordered = orderProviders(t.providers);
    const resolved: PublicEventType = { ...t, providers: ordered };
    setSelected(resolved);
    setProvider(null);
    setExhausted(new Set());

    if (ordered.length === 0) {
      setStep('schedule'); // legacy single-provider
      return;
    }
    if (preferProviderId) {
      const match = ordered.find((p) => p.id === preferProviderId);
      if (match) {
        setProvider(match);
        setStep('schedule');
        return;
      }
      // bad/inactive provider param → fall through to provider step
    }
    if (ordered.length === 1) {
      setProvider(ordered[0]);
      setStep('schedule');
      return;
    }
    setStep('provider');
    prefetchNextAvailable(resolved, zone);
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const b = await api.getBranding();
        if (!alive) return;
        setBranding(b);
        applyTheme(b.theme);
        applyBrand(b.brandColor);
        document.title = `Book with ${b.displayName}`;
        // The invitee's local tz wins; fall back to the host's branding tz.
        const zone = guessTimezone() || b.timezone || 'UTC';
        setTz(zone);
        if (slugParam) {
          const t = await api.getEventType(slugParam);
          if (!alive) return;
          enterType(t, zone, providerParam);
        } else {
          const { eventTypes } = await api.getEventTypes();
          if (!alive) return;
          setTypes(eventTypes);
        }
      } catch (e) {
        if (alive) setLoadErr((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loadErr) {
    return (
      <Shell embedded={embedded}>
        <Banner kind="error">Could not load the booking page: {loadErr}</Banner>
      </Shell>
    );
  }
  if (!branding) {
    return (
      <Shell embedded={embedded}>
        <Spinner label="Loading…" />
      </Shell>
    );
  }

  const typeIsLocked = !!slugParam; // deep-linked: never go back past this type
  const multiProvider = (selected?.providers.length ?? 0) > 1;

  const back = () => {
    if (step === 'details') {
      setStep('schedule');
    } else if (step === 'schedule') {
      if (multiProvider && !provider) {
        // shouldn't happen, but guard
        setStep('provider');
      } else if (multiProvider) {
        setProvider(null);
        setStep('provider');
      } else if (!typeIsLocked) {
        setSelected(null);
        setStep('pick');
      }
    } else if (step === 'provider') {
      if (!typeIsLocked) {
        setSelected(null);
        setProvider(null);
        setStep('pick');
      }
    }
  };

  const canGoBack =
    step === 'details' ||
    (step === 'schedule' && (multiProvider || !typeIsLocked)) ||
    (step === 'provider' && !typeIsLocked);

  const goToTypes = () => {
    setSelected(null);
    setProvider(null);
    setStep('pick');
  };

  return (
    <Shell embedded={embedded}>
      <Header branding={branding} />
      {canGoBack && (
        <button
          onClick={back}
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted transition hover:text-brand"
        >
          <ArrowLeft size={15} /> Back
        </button>
      )}

      <div key={step} className="animate-rise">
        {step === 'pick' && (
          <>
            {branding.welcomeText && <p className="mb-5 text-muted">{branding.welcomeText}</p>}
            {!types ? (
              <Spinner />
            ) : types.length === 0 ? (
              <Banner>No meeting types are available right now.</Banner>
            ) : (
              <EventTypePicker
                types={types}
                onSelect={(t) => enterType(t, tz)}
              />
            )}
          </>
        )}

        {step === 'provider' && selected && (
          <ProviderPicker
            providers={selected.providers}
            nextAvail={nextAvail}
            tz={tz}
            onSelect={(p) => {
              setProvider(p);
              setStep('schedule');
            }}
          />
        )}

        {step === 'schedule' && selected && (
          <Scheduler
            eventType={selected}
            provider={provider}
            tz={tz}
            onTzChange={setTz}
            onPick={(iso, t) => {
              setSlot({ iso, tz: t });
              setStep('details');
            }}
            onSwitchProvider={(p) => {
              setProvider(p);
              setStep('schedule');
            }}
            exhausted={exhausted}
            onExhausted={(id) =>
              setExhausted((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
            }
            // Always provide an escape: a deep-linked single-provider type that's
            // full would otherwise be a buttonless dead-end. When locked, reload
            // to the full meeting-type list.
            onBackToTypes={() => {
              if (typeIsLocked) window.location.search = '';
              else goToTypes();
            }}
          />
        )}

        {step === 'details' && selected && slot && (
          <DetailsForm
            eventType={selected}
            provider={provider}
            slot={slot}
            embedded={embedded}
            onDone={(c) => {
              setConfirmation(c);
              setStep('done');
            }}
          />
        )}

        {step === 'done' && confirmation && (
          <Confirmed confirmation={confirmation} branding={branding} />
        )}
      </div>
    </Shell>
  );
}

function Shell({ embedded, children }: { embedded: boolean; children: React.ReactNode }) {
  return (
    <div className={embedded ? 'p-3' : 'mx-auto max-w-xl px-4 py-10 sm:py-14'}>
      <div className="relative overflow-hidden rounded-2xl border border-hair-soft bg-surface shadow-lux">
        {/* gold hairline top accent */}
        <div className="h-px w-full [background:linear-gradient(90deg,transparent,var(--brand)_50%,transparent)]" />
        <div className="p-6 sm:p-8">{children}</div>
      </div>
      {!embedded && (
        <p className="mt-4 text-center text-xs text-faint">
          Powered by your own scheduling — no Calendly fees.
        </p>
      )}
    </div>
  );
}

function Header({ branding }: { branding: PublicBranding }) {
  return (
    <div className="mb-6 flex items-center gap-4">
      {branding.avatarUrl ? (
        <img
          src={branding.avatarUrl}
          alt=""
          className="h-14 w-14 rounded-full object-cover ring-2 ring-brand/40"
        />
      ) : (
        <div className="flex h-14 w-14 items-center justify-center rounded-full ring-2 ring-brand/40 text-xl font-display font-semibold text-brand-fg [background:linear-gradient(135deg,var(--brand-light),var(--brand-dark))]">
          {branding.displayName.slice(0, 1)}
        </div>
      )}
      <div>
        <div className="font-display text-xl font-semibold leading-tight text-ink">
          {branding.displayName}
        </div>
        {branding.tagline && <div className="mt-0.5 text-sm text-muted">{branding.tagline}</div>}
      </div>
    </div>
  );
}
