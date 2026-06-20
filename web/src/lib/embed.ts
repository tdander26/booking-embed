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
    let last = 0;
    const post = () => {
      // scrollHeight reflects true content height even when a wrapper is clipped;
      // take the max across the document so step/question changes are captured.
      const height = Math.ceil(
        Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight ?? 0,
          document.body?.offsetHeight ?? 0,
        ),
      );
      if (height && height !== last) {
        last = height;
        window.parent.postMessage({ event: 'booking.resize', payload: { height } }, target);
      }
    };
    // ResizeObserver fires on box-size changes; MutationObserver covers content
    // swaps (navigating steps, rendering questions, showing errors) that don't
    // necessarily resize an observed box. Both funnel through the deduped post().
    const ro = new ResizeObserver(post);
    ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
    const mo = new MutationObserver(post);
    if (document.body) {
      mo.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    }
    window.addEventListener('load', post);
    post();
    return () => {
      ro.disconnect();
      mo.disconnect();
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
