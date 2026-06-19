/**
 * Google Ads conversion tracking for a completed PATIENT booking, reported to
 * the clinic's OWN Google Ads account (per-tenant conversion ID + label).
 *
 * Fires gtag only on the direct, non-embedded booking page (the patient may have
 * arrived straight from an ad, so the gclid is on this page). When the widget is
 * embedded in the clinic's site, a tag inside our iframe is on OUR origin and
 * would miss the host's gclid — so in that case the host page's own GTM/gtag
 * should fire the conversion off the `booking.event_scheduled` postMessage (see
 * lib/embed.ts). No PII is ever sent in the conversion payload.
 */

interface GtagWindow {
  dataLayer?: unknown[];
  __adsAccountLoaded?: Record<string, boolean>;
}

let fired = false;

export function fireBookingConversion(opts: {
  adsConversionId?: string;
  adsConversionLabel?: string;
}): void {
  if (fired) return;
  const id = opts.adsConversionId?.trim();
  if (!id) return;
  // Embedded → the host page fires its own conversion off our postMessage.
  if (window.self !== window.top) return;

  fired = true;
  const w = window as unknown as GtagWindow;
  w.dataLayer = w.dataLayer || [];
  // Standard gtag shim.
  function gtag(...args: unknown[]) {
    (w.dataLayer as unknown[]).push(args);
  }

  w.__adsAccountLoaded = w.__adsAccountLoaded || {};
  if (!w.__adsAccountLoaded[id]) {
    w.__adsAccountLoaded[id] = true;
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
    document.head.appendChild(s);
    gtag('js', new Date());
    gtag('config', id);
  }

  const sendTo = opts.adsConversionLabel ? `${id}/${opts.adsConversionLabel}` : id;
  gtag('event', 'conversion', { send_to: sendTo });
}
