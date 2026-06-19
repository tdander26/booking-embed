import { Clock, Video, Phone, MapPin, ArrowRight } from 'lucide-react';
import type { PublicEventType, LocationType } from '../api/types';

function LocationIcon({ type }: { type: LocationType }) {
  if (type === 'google_meet') return <Video size={14} />;
  if (type === 'phone') return <Phone size={14} />;
  return <MapPin size={14} />;
}

const locationLabel: Record<LocationType, string> = {
  google_meet: 'Google Meet',
  phone: 'Phone',
  in_person: 'In person',
  custom: 'Details on confirmation',
};

export function EventTypePicker({
  types,
  onSelect,
}: {
  types: PublicEventType[];
  onSelect: (t: PublicEventType) => void;
}) {
  return (
    <ul className="space-y-3">
      {types.map((t) => (
        <li key={t.id}>
          <button
            onClick={() => onSelect(t)}
            className="group flex w-full items-center gap-4 rounded-xl border border-hair-soft bg-surface-2 p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-brand/50 hover:shadow-gold-glow focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
          >
            <span
              className="h-12 w-1 shrink-0 rounded-full"
              style={{
                background: `linear-gradient(var(--brand-light), ${t.color || 'var(--brand)'})`,
              }}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="block font-display text-lg font-semibold text-ink">{t.name}</span>
              {t.description && (
                <span className="mt-0.5 block truncate text-sm text-muted">{t.description}</span>
              )}
              <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
                <span className="inline-flex items-center gap-1.5">
                  <Clock size={13} className="text-brand" /> {t.durationMinutes} min
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <LocationIcon type={t.location.type} /> {locationLabel[t.location.type]}
                </span>
              </span>
            </span>
            <ArrowRight
              size={18}
              className="shrink-0 text-faint transition-all group-hover:translate-x-0.5 group-hover:text-brand"
            />
          </button>
        </li>
      ))}
    </ul>
  );
}
