import { DateTime } from 'luxon';
import { ArrowRight, CalendarCheck, CalendarX, Sparkles } from 'lucide-react';
import type { PublicProvider, NextAvailableResponse, NextAvailableProvider } from '../api/types';

function fmtNextDate(dateStr: string, tz: string): string {
  // dateStr is a yyyy-MM-dd in the invitee's tz; format without shifting it.
  return DateTime.fromISO(dateStr, { zone: tz }).toFormat('ccc, LLL d');
}

function ProviderAvatar({ p }: { p: PublicProvider }) {
  if (p.avatarUrl) {
    return (
      <img
        src={p.avatarUrl}
        alt=""
        className="h-12 w-12 shrink-0 rounded-full object-cover ring-2 ring-brand/40"
      />
    );
  }
  return (
    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-lg font-display font-semibold text-brand-fg ring-2 ring-brand/40 [background:linear-gradient(135deg,var(--brand-light),var(--brand-dark))]">
      {p.name.slice(0, 1)}
    </div>
  );
}

function NextAvailLine({
  na,
  tz,
}: {
  na: NextAvailableProvider | undefined;
  tz: string;
}) {
  if (!na) {
    return (
      <span className="mt-2 inline-flex items-center gap-1.5 text-xs text-faint">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-hair-soft border-t-brand" />
        Checking availability…
      </span>
    );
  }
  if (na.hasAvailability && na.nextDate) {
    return (
      <span className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-brand-light">
        <CalendarCheck size={13} className="text-brand" />
        Next available {fmtNextDate(na.nextDate, tz)}
        {na.slotCountThatDay > 0 && (
          <span className="text-faint">· {na.slotCountThatDay} time{na.slotCountThatDay === 1 ? '' : 's'}</span>
        )}
      </span>
    );
  }
  return (
    <span className="mt-2 inline-flex items-center gap-1.5 text-xs text-faint">
      <CalendarX size={13} /> No openings in the next 60 days
    </span>
  );
}

export function ProviderPicker({
  providers,
  nextAvail,
  tz,
  onSelect,
}: {
  providers: PublicProvider[];
  nextAvail: NextAvailableResponse | null;
  tz: string;
  onSelect: (p: PublicProvider) => void;
}) {
  const naById = new Map<string, NextAvailableProvider>();
  nextAvail?.providers.forEach((p) => naById.set(p.memberId, p));

  return (
    <div>
      <h2 className="mb-1 font-display text-xl font-semibold text-ink">Choose who you'd like to see</h2>
      <p className="mb-5 text-sm text-muted">Pick a provider to view their available times.</p>

      <ul className="space-y-3">
        {providers.map((p) => {
          const na = naById.get(p.id);
          const noOpenings = !!na && !na.hasAvailability;
          return (
            <li key={p.id}>
              <button
                onClick={() => onSelect(p)}
                className={[
                  'group flex w-full items-center gap-4 rounded-xl border p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-gold-glow focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60',
                  p.featured
                    ? 'border-brand/50 bg-brand/[0.06] ring-1 ring-brand/30 hover:border-brand'
                    : 'border-hair-soft bg-surface-2 hover:border-brand/50',
                  noOpenings ? 'opacity-75' : '',
                ].join(' ')}
              >
                <ProviderAvatar p={p} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span
                      className={[
                        'block font-display font-semibold text-ink',
                        p.featured ? 'text-lg' : 'text-base',
                      ].join(' ')}
                    >
                      {p.name}
                    </span>
                    {p.featured && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-brand/40 bg-brand/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-light">
                        <Sparkles size={11} /> Featured
                      </span>
                    )}
                  </span>
                  {p.title && <span className="block text-sm text-muted">{p.title}</span>}
                  {p.featured && p.bio && (
                    <span className="mt-1 block text-sm text-muted line-clamp-2">{p.bio}</span>
                  )}
                  <span className="block">
                    <NextAvailLine na={na} tz={tz} />
                  </span>
                </span>
                <ArrowRight
                  size={18}
                  className="shrink-0 text-faint transition-all group-hover:translate-x-0.5 group-hover:text-brand"
                />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
