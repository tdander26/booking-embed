import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Code } from 'lucide-react';
import * as api from '../api/client';
import type { EventType, Member } from '../api/types';
import { Spinner, Banner, Card, Field, inputClass } from '../components/ui';

type SnippetKind = 'inline' | 'floating' | 'popup';

const KIND_LABEL: Record<SnippetKind, string> = {
  inline: 'Inline (embedded on the page)',
  floating: 'Floating button (bottom-right)',
  popup: 'Popup link',
};

const KIND_HINT: Record<SnippetKind, string> = {
  inline: 'Drops the booking page right into your layout. Resizes itself to fit.',
  floating: 'A pill button pinned to the corner that opens the booking page in a modal.',
  popup: 'Turn any link into a booking modal trigger.',
};

export function EmbedTab({ tenantSlug }: { tenantSlug: string }) {
  const [types, setTypes] = useState<EventType[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [slug, setSlug] = useState<string>('');
  const [providerId, setProviderId] = useState<string>('');
  const [kind, setKind] = useState<SnippetKind>('inline');

  useEffect(() => {
    Promise.all([api.adminGetEventTypes(), api.adminGetMembers()])
      .then(([t, m]) => {
        const active = t.eventTypes.filter((x) => x.active);
        const list = active.length ? active : t.eventTypes;
        setTypes(t.eventTypes);
        setMembers(m.members);
        if (list[0]) setSlug(list[0].slug);
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  const origin = window.location.origin;
  const selected = useMemo(() => types?.find((t) => t.slug === slug) ?? null, [types, slug]);

  // Only ACTIVE providers are offered to bookers, so only show those here too.
  const typeMembers = useMemo(() => {
    if (!selected) return [];
    return members.filter((m) => m.active && selected.memberIds.includes(m.id));
  }, [selected, members]);
  // Inactive providers assigned to this type — hidden from bookers; flag them.
  const inactiveOnType = useMemo(() => {
    if (!selected) return [];
    return members.filter((m) => !m.active && selected.memberIds.includes(m.id));
  }, [selected, members]);
  const showProvider = typeMembers.length > 1;

  const bookingUrl = useMemo(() => {
    const q = new URLSearchParams();
    if (slug) q.set('type', slug);
    if (showProvider && providerId) q.set('provider', providerId);
    // Path-based tenant routing: /{tenantSlug}/?type=…
    return `${origin}/${tenantSlug}/?${q.toString()}`;
  }, [origin, tenantSlug, slug, providerId, showProvider]);

  const embedSrc = `${origin}/embed.js`;
  // Live preview loads the real booking page in embed (transparent) mode.
  const previewUrl = `${bookingUrl}&embed=1`;

  const snippets: Record<SnippetKind, string> = useMemo(
    () => ({
      inline: `<!-- Booking widget (inline) -->
<div class="booking-inline" data-url="${bookingUrl}" style="min-width:320px;height:640px;"></div>
<script src="${embedSrc}" async></script>`,
      floating: `<!-- Booking widget (floating button) -->
<script src="${embedSrc}"></script>
<script>
  window.addEventListener('load', function () {
    Booking.initPopupButton({ url: "${bookingUrl}", text: "Book a time" });
  });
</script>`,
      popup: `<!-- Booking widget (popup link) -->
<a href="${bookingUrl}" class="booking-popup">Book a time</a>
<script src="${embedSrc}" async></script>`,
    }),
    [bookingUrl, embedSrc],
  );

  if (err && !types) return <Banner kind="error">{err}</Banner>;
  if (!types) return <Spinner />;

  if (types.length === 0)
    return (
      <Card className="p-6 text-center text-sm text-faint">
        Create an event type first, then come back to grab its embed code.
      </Card>
    );

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="mb-1 flex items-center gap-2">
          <Code size={18} className="text-brand" />
          <h2 className="text-base font-semibold text-ink">Embed on your site</h2>
        </div>
        <p className="mb-4 text-sm text-muted">
          Pick a meeting type and style, then copy the snippet into your site's HTML. The widget
          loads from <span className="font-display text-brand-light">{origin}</span> and never
          touches a foreign origin.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Meeting type">
            <select className={inputClass} value={slug} onChange={(e) => setSlug(e.target.value)}>
              {types.map((t) => (
                <option key={t.id} value={t.slug}>
                  {t.name}
                  {t.active ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </Field>
          {showProvider ? (
            <Field label="Provider" hint="Leave on “Let the booker choose” to show all providers.">
              <select
                className={inputClass}
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
              >
                <option value="">Let the booker choose</option>
                {typeMembers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Style">
              <select
                className={inputClass}
                value={kind}
                onChange={(e) => setKind(e.target.value as SnippetKind)}
              >
                {(Object.keys(KIND_LABEL) as SnippetKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>

        {showProvider && (
          <div className="mt-4">
            <Field label="Style">
              <select
                className={inputClass}
                value={kind}
                onChange={(e) => setKind(e.target.value as SnippetKind)}
              >
                {(Object.keys(KIND_LABEL) as SnippetKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}

        {inactiveOnType.length > 0 && (
          <div className="mt-4">
            <Banner kind="info">
              {inactiveOnType.map((m) => m.name).join(', ')}{' '}
              {inactiveOnType.length > 1 ? 'are' : 'is'} assigned to this meeting type but{' '}
              <strong>inactive</strong>, so {inactiveOnType.length > 1 ? 'they' : 'they'} won't appear
              to bookers. Activate in the Providers tab (and set their hours) to offer them.
            </Banner>
          </div>
        )}
      </Card>

      <PreviewCard kind={kind} url={previewUrl} />

      <SnippetCard kind={kind} code={snippets[kind]} />

      <Card className="p-5">
        <h3 className="mb-2 text-sm font-semibold text-ink">How it works</h3>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
          <li>Copy the snippet above.</li>
          <li>
            Paste it into your site's HTML where you want the widget — inline goes in the page body;
            floating and popup can go anywhere before <code className="text-brand-light">&lt;/body&gt;</code>.
          </li>
          <li>
            The shared <code className="text-brand-light">embed.js</code> loader can be included
            once even if you embed several widgets on a page.
          </li>
          <li>
            Direct link (no embed): <code className="text-brand-light">{bookingUrl}</code>
          </li>
        </ol>
      </Card>
    </div>
  );
}

function PreviewCard({ kind, url }: { kind: SnippetKind; url: string }) {
  return (
    <Card className="p-5">
      <h3 className="mb-3 text-sm font-semibold text-ink">Live preview</h3>
      {kind === 'inline' && (
        <div className="overflow-hidden rounded-xl border border-hair-soft">
          <iframe
            title="Booking preview"
            src={url}
            className="h-[560px] w-full"
            style={{ border: 0 }}
          />
        </div>
      )}

      {kind === 'floating' && (
        <div className="relative h-72 overflow-hidden rounded-xl border border-hair-soft bg-surface-2">
          <div className="space-y-2 p-5">
            <div className="h-3 w-2/3 rounded bg-overlay" />
            <div className="h-3 w-1/2 rounded bg-overlay" />
            <div className="h-3 w-3/4 rounded bg-overlay" />
            <div className="text-xs text-faint">…your page content…</div>
          </div>
          <button
            type="button"
            className="absolute bottom-4 right-4 rounded-full px-5 py-3 text-sm font-semibold text-brand-fg shadow-gold-glow [background:linear-gradient(100deg,var(--brand-light),var(--brand)_55%,var(--brand-dark))]"
          >
            Book a time
          </button>
          <div className="absolute bottom-3 left-4 text-[11px] text-faint">
            Pinned to the corner on your real site; opens the calendar in a modal.
          </div>
        </div>
      )}

      {kind === 'popup' && (
        <div className="rounded-xl border border-hair-soft bg-surface-2 p-5">
          <p className="text-sm text-muted">
            Renders as a link that opens the calendar in a modal:
          </p>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block font-medium text-brand underline"
          >
            Book a time
          </a>
          <div className="mt-4 overflow-hidden rounded-lg border border-hair-soft">
            <iframe
              title="Popup content preview"
              src={url}
              className="h-[440px] w-full"
              style={{ border: 0 }}
            />
          </div>
        </div>
      )}
    </Card>
  );
}

function SnippetCard({ kind, code }: { kind: SnippetKind; code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Fallback for non-secure contexts.
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* ignore */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-hair-soft px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-ink">{KIND_LABEL[kind]}</div>
          <div className="text-xs text-faint">{KIND_HINT[kind]}</div>
        </div>
        <button
          onClick={copy}
          className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-hair px-3 text-sm font-medium text-ink transition hover:border-brand/60 hover:bg-overlay-soft"
        >
          {copied ? <Check size={15} className="text-brand" /> : <Copy size={15} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto bg-surface-2/60 p-4 text-xs leading-relaxed text-muted">
        <code>{code}</code>
      </pre>
    </Card>
  );
}
