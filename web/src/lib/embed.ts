import { useEffect } from 'react';

/** True when this page is being rendered inside the embed iframe. */
export function isEmbedded(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get('embed') === '1' || window.self !== window.top;
}

/**
 * The exact origin to postMessage back to — passed by embed.js as `?host=`,
 * falling back to the referrer's origin. Returns '*' only if neither is known
 * (older/manual iframes), so the widget still works without leaking to a
 * specific hostile origin.
 */
function parentTarget(): string {
  const host = new URLSearchParams(window.location.search).get('host');
  if (host) {
    try {
      return new URL(host).origin;
    } catch {
      /* fall through */
    }
  }
  if (document.referrer) {
    try {
      return new URL(document.referrer).origin;
    } catch {
      /* fall through */
    }
  }
  return '*';
}

/**
 * While embedded, continuously report content height to the parent so the host
 * page can auto-resize the iframe. Re-fires on every layout change (the booking
 * flow's steps differ in height).
 */
export function useEmbedResize(active: boolean): void {
  useEffect(() => {
    if (!active || window.self === window.top) return;
    const target = parentTarget();
    const post = () => {
      const height = Math.ceil(document.documentElement.scrollHeight);
      window.parent.postMessage({ event: 'booking.resize', payload: { height } }, target);
    };
    const ro = new ResizeObserver(post);
    ro.observe(document.documentElement);
    window.addEventListener('load', post);
    post();
    return () => {
      ro.disconnect();
      window.removeEventListener('load', post);
    };
  }, [active]);
}

/** Notify the parent page that a booking completed (carries no PII). */
export function postScheduled(bookingId: string, startUtc: string): void {
  if (window.self === window.top) return;
  window.parent.postMessage(
    { event: 'booking.event_scheduled', payload: { bookingId, startUtc } },
    parentTarget(),
  );
}
