/*!
 * booking-embed loader. Put this script on any site to embed the booking page.
 *
 *   Inline:   <div class="booking-inline" data-url="https://YOURAPP/?type=intro-call"></div>
 *             <script src="https://YOURAPP/embed.js"></script>
 *
 *   Popup link: <a class="booking-popup" data-url="https://YOURAPP/?type=intro-call">Book</a>
 *
 *   Floating:  Booking.initPopupButton({ url: "https://YOURAPP/?type=intro-call", text: "Book a time" });
 *
 * The widget origin is taken from THIS script's own src, so it works on any
 * deploy domain. All postMessage traffic is validated against that origin.
 */
(function () {
  'use strict';

  var SCRIPT = document.currentScript;
  var WIDGET_ORIGIN = (function () {
    try {
      return new URL(SCRIPT.src).origin;
    } catch (e) {
      return window.location.origin;
    }
  })();
  var EVENT_PREFIX = 'booking.';
  var frames = new Map(); // contentWindow -> iframe element (multi-embed safe)

  function buildUrl(raw) {
    try {
      var u = new URL(raw, WIDGET_ORIGIN);
      if (u.origin !== WIDGET_ORIGIN) return null; // never load a foreign origin
      u.searchParams.set('embed', '1');
      // Tell the child our origin so it can postMessage back to us specifically
      // (instead of '*'), keeping booking events off other ancestors.
      u.searchParams.set('host', window.location.origin);
      return u.toString();
    } catch (e) {
      return null;
    }
  }

  function makeIframe(url) {
    var iframe = document.createElement('iframe'); // DOM API, never innerHTML
    iframe.src = url;
    iframe.title = 'Scheduling';
    iframe.setAttribute('frameborder', '0');
    iframe.allow = 'fullscreen';
    iframe.style.cssText = 'width:100%;height:100%;border:0;background:transparent;';
    iframe.addEventListener('load', function () {
      if (iframe.contentWindow) frames.set(iframe.contentWindow, iframe);
    });
    return iframe;
  }

  function mountInline(container) {
    if (container.getAttribute('data-booking-mounted')) return;
    var url = buildUrl(container.getAttribute('data-url') || '');
    if (!url) return;
    container.setAttribute('data-booking-mounted', '1');
    // The container must be free to GROW as the iframe auto-resizes to its
    // content. A fixed `height` in the snippet would clip the calendar/slots and
    // force scrolling, so demote any fixed height to a min-height floor and let
    // the box grow with its content.
    if (!container.style.minHeight) container.style.minHeight = container.style.height || '640px';
    container.style.height = 'auto';
    container.style.width = container.style.width || '100%';
    var iframe = makeIframe(url);
    iframe.style.minHeight = '640px';
    container.replaceChildren(iframe);
    frames.set(iframe.contentWindow, iframe); // best-effort pre-load mapping
  }

  // ---- Popup (overlay) ----
  var overlay = null;
  function openPopup(rawUrl) {
    var url = buildUrl(rawUrl);
    if (!url) return;
    closePopup();
    overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.55);' +
      'display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closePopup();
    });

    var box = document.createElement('div');
    box.style.cssText =
      'position:relative;width:100%;max-width:480px;height:min(720px,90vh);' +
      'background:#0a0a0b;border-radius:18px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.6);';

    var close = document.createElement('button');
    close.setAttribute('aria-label', 'Close');
    close.textContent = '✕';
    close.style.cssText =
      'position:absolute;top:8px;right:8px;z-index:2;width:36px;height:36px;border:0;' +
      'border-radius:50%;background:rgba(255,255,255,.9);font-size:16px;cursor:pointer;';
    close.addEventListener('click', closePopup);

    var iframe = makeIframe(url);
    box.appendChild(close);
    box.appendChild(iframe);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onEsc);
  }
  function onEsc(e) {
    if (e.key === 'Escape') closePopup();
  }
  function closePopup() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    document.removeEventListener('keydown', onEsc);
  }

  // ---- Floating badge button ----
  function initPopupButton(opts) {
    if (!opts || !opts.url) return;
    var btn = document.createElement('button');
    btn.textContent = opts.text || 'Book a time';
    btn.style.cssText =
      'position:fixed;right:20px;bottom:20px;z-index:2147482000;border:0;cursor:pointer;' +
      'padding:14px 20px;border-radius:999px;font:600 15px/1 -apple-system,system-ui,sans-serif;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.25);' +
      'background:' + (opts.color || '#c9a84c') + ';color:' + (opts.textColor || '#0a0a0b') + ';';
    btn.addEventListener('click', function () {
      openPopup(opts.url);
    });
    document.body.appendChild(btn);
    return btn;
  }

  // ---- postMessage handling (resize + lifecycle) ----
  function isTrusted(e) {
    return (
      e.origin === WIDGET_ORIGIN &&
      e.data &&
      typeof e.data.event === 'string' &&
      e.data.event.indexOf(EVENT_PREFIX) === 0
    );
  }
  window.addEventListener('message', function (e) {
    if (!isTrusted(e)) return;
    var event = e.data.event;
    var payload = e.data.payload || {};
    if (event === EVENT_PREFIX + 'resize' && typeof payload.height === 'number') {
      var iframe = e.source ? frames.get(e.source) : null;
      if (iframe) {
        iframe.style.height = payload.height + 'px';
        iframe.style.minHeight = '0px'; // release the pre-load 640px floor
        var parent = iframe.parentElement;
        if (parent && parent.getAttribute('data-booking-mounted')) {
          parent.style.minHeight = '0px';
        }
      }
    }
    // Re-dispatch so host pages can listen via document events.
    try {
      document.dispatchEvent(new CustomEvent(event, { detail: payload }));
    } catch (err) {
      /* old browsers */
    }
  });

  function init() {
    var inline = document.querySelectorAll('.booking-inline[data-url], .booking-inline-widget[data-url]');
    for (var i = 0; i < inline.length; i++) mountInline(inline[i]);
    var links = document.querySelectorAll('.booking-popup[data-url]');
    for (var j = 0; j < links.length; j++) {
      (function (el) {
        el.addEventListener('click', function (e) {
          e.preventDefault();
          openPopup(el.getAttribute('data-url'));
        });
      })(links[j]);
    }
  }

  window.Booking = {
    initInlineWidget: function (opts) {
      if (!opts || !opts.parentElement) return;
      opts.parentElement.setAttribute('data-url', opts.url);
      mountInline(opts.parentElement);
    },
    initPopupWidget: function (opts) {
      if (opts && opts.url) openPopup(opts.url);
    },
    initPopupButton: initPopupButton,
    initBadgeWidget: initPopupButton,
    closePopup: closePopup,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
