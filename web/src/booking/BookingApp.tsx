import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import * as api from '../api/client';
import type { PublicBranding, PublicEventType, BookingConfirmation } from '../api/types';
import { applyBrand } from '../lib/brand';
import { isEmbedded, useEmbedResize } from '../lib/embed';
import { Spinner, Banner } from '../components/ui';
import { EventTypePicker } from './EventTypePicker';
import { Scheduler } from './Scheduler';
import { DetailsForm } from './DetailsForm';
import { Confirmed } from './Confirmed';

type Step = 'pick' | 'schedule' | 'details' | 'done';

export function BookingApp() {
  const embedded = isEmbedded();
  useEmbedResize(embedded);

  const [branding, setBranding] = useState<PublicBranding | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [types, setTypes] = useState<PublicEventType[] | null>(null);
  const [selected, setSelected] = useState<PublicEventType | null>(null);
  const [slot, setSlot] = useState<{ iso: string; tz: string } | null>(null);
  const [confirmation, setConfirmation] = useState<BookingConfirmation | null>(null);
  const [step, setStep] = useState<Step>('pick');

  const slugParam = new URLSearchParams(window.location.search).get('type');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const b = await api.getBranding();
        if (!alive) return;
        setBranding(b);
        applyBrand(b.brandColor);
        document.title = `Book with ${b.displayName}`;
        if (slugParam) {
          const t = await api.getEventType(slugParam);
          if (!alive) return;
          setSelected(t);
          setStep('schedule');
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

  const back = () => {
    if (step === 'details') setStep('schedule');
    else if (step === 'schedule' && !slugParam) {
      setSelected(null);
      setStep('pick');
    }
  };
  const canGoBack = step === 'details' || (step === 'schedule' && !slugParam);

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
                onSelect={(t) => {
                  setSelected(t);
                  setStep('schedule');
                }}
              />
            )}
          </>
        )}

        {step === 'schedule' && selected && (
          <Scheduler
            eventType={selected}
            defaultTz={branding.timezone}
            onPick={(iso, tz) => {
              setSlot({ iso, tz });
              setStep('details');
            }}
          />
        )}

        {step === 'details' && selected && slot && (
          <DetailsForm
            eventType={selected}
            slot={slot}
            embedded={embedded}
            onDone={(c) => {
              setConfirmation(c);
              setStep('done');
            }}
          />
        )}

        {step === 'done' && confirmation && <Confirmed confirmation={confirmation} />}
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
