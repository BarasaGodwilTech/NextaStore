// NextaStore service worker
// Strategy:
//  - Navigations (HTML pages): network-first, falling back to cache, then offline.html
//  - Same-origin static assets (css/js/images/fonts): stale-while-revalidate
//  - Anything cross-origin (the API on a different host/port, CDNs, etc.): left
//    completely alone — we never intercept those requests, so auth, live data
//    and mobile-money flows always hit the network like normal.
//  - Web Push (bottom of this file): `push` shows the notification, and
//    `notificationclick` routes the tap. Neither touches the caches above.
// Bump this whenever any precached/cached file changes (js/main.js,
// js/auth.js, css, etc.) — the activate handler below only deletes caches
// whose NAME differs from CACHE_NAME, so an unchanged version number means
// returning visitors keep serving old cached JS indefinitely (stale-while-
// revalidate hands back the cached copy instantly and only refreshes it in
// the background), even after the files on disk/server have changed. A
// mismatched old-file/new-file combo across separately-cached scripts is
// exactly what produces a "<something> is not defined" error like the
// TokenStorage one that motivated this comment.
const CACHE_VERSION = 'v20';
const CACHE_NAME = `nextastore-cache-${CACHE_VERSION}`;
const OFFLINE_URL = '/offline.html';

// Keep this list small and safe — every entry is fetched individually during
// install, and a missing file just gets skipped instead of failing the whole
// install (so this never blocks first load if a path here goes stale).
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/offline.html',
  '/manifest.json',
  '/css/main.css',
  '/css/mobile.css',
  '/js/main.js',
  '/js/api.js',
  '/assets/brand/png/icon/icon-192.png',
  '/assets/brand/png/icon/icon-512.png',
  '/assets/brand/png/favicon/favicon.ico'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const response = await fetch(url, { cache: 'no-cache' });
            if (response.ok) await cache.put(url, response);
          } catch (err) {
            // Ignore — that asset just won't be precached this time.
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('nextastore-cache-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

function isStaticAsset(url) {
  return /\.(css|js|png|jpg|jpeg|svg|webp|gif|ico|woff2?|ttf)$/i.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only ever handle same-origin GET requests. Everything else (the backend
  // API on its own origin/port, POST/PUT/DELETE, third-party fonts/CDNs)
  // passes straight through untouched.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Page navigations: try the network first so users always see fresh
  // content when online, fall back to a cached copy, then to offline.html.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, fresh.clone());
          return fresh;
        } catch (err) {
          const cache = await caches.open(CACHE_NAME);
          const cached = await cache.match(request);
          return cached || (await cache.match(OFFLINE_URL));
        }
      })()
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        const networkFetch = fetch(request)
          .then((response) => {
            if (response && response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })()
    );
  }
});


// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------
// The server half is nextastore-backend/src/push.js: it sends a small JSON
// body `{ type, title, body, link }` (see createNotification / notifyNewMessage
// in helpers.js). Everything below turns that into an OS notification and
// routes the tap. This code runs while every NextaStore tab is closed, so it
// must not depend on anything from the page (no localStorage, no `app`).

// The large `icon` stays the NextaStore mark for every push — it's the
// notification's brand identity, not a category signal, and Android mostly
// doesn't show it at all (only the badge below appears in the status bar).
const PUSH_ICON = '/assets/brand/png/icon/icon-192.png';
// `badge` is what Android actually shows in the status bar, drawn from its
// alpha channel only (a white glyph on a transparent background, never the
// full-colour icon) — so this is the one place that's worth differentiating
// by notification type, and the only one a person glances at before opening
// the tray. `badge-96.png` (the plain "N" mark) is also the fallback for any
// type not listed here (`general`, `test`, and anything added server-side
// before its badge is).
const PUSH_BADGE = '/assets/brand/png/badge/badge-96.png';
const PUSH_BADGES_BY_TYPE = {
  new_message: '/assets/brand/png/badge/new_message.png',
  new_order: '/assets/brand/png/badge/new_order.png',
  low_stock: '/assets/brand/png/badge/low_stock.png',
  order_cancelled: '/assets/brand/png/badge/order_cancelled.png',
  new_product: '/assets/brand/png/badge/new_product.png',
  subscription: '/assets/brand/png/badge/subscription.png'
};
function pushBadgeFor(type) {
  return PUSH_BADGES_BY_TYPE[type] || PUSH_BADGE;
}
const PUSH_DEFAULT_TITLE = 'NextaStore';
const PUSH_TITLE_MAX = 120;
const PUSH_BODY_MAX = 300;
const PUSH_ACCOUNT_MAX = 40;

/** Reads the push body without ever throwing. A push with no data, invalid
 *  JSON, or JSON that isn't an object still has to produce a notification —
 *  see the note on the `push` handler. */
function readPushPayload(event) {
  if (!event.data) return {};
  try {
    const parsed = event.data.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    try {
      const text = event.data.text();
      return text ? { body: text } : {};
    } catch (err2) {
      return {};
    }
  }
}

function pushText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function appScope() {
  return (self.registration && self.registration.scope) || `${self.location.origin}/`;
}

/** Turns a `link` from the server into a same-origin path that is safe to
 *  open, or '/' if it isn't one. The server's links are relative
 *  ("messages.html?conversation=…", "dashboard.html#orders") or root-relative
 *  ("/subscription.html"); anything else — another origin, a
 *  protocol-relative "//host", "javascript:", a nested or non-.html path — is
 *  ignored rather than opened, because a notification is something a person
 *  taps without reading a URL first. */
function resolveAppLink(raw) {
  try {
    if (typeof raw !== 'string' || !raw.trim()) return '/';
    const url = new URL(raw.trim(), appScope());
    if (url.origin !== self.location.origin) return '/';
    if (!/^\/(?:[A-Za-z0-9_-]+\.html)?$/.test(url.pathname)) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (err) {
    return '/';
  }
}

/** Messages collapse to one notification per conversation, so ten replies in
 *  a chat leave one banner showing the latest, not ten. Everything else gets
 *  no tag on purpose: every order links to the same dashboard.html#orders, so
 *  tagging by link would let a second order replace the first. */
function pushTag(type, link) {
  if (type !== 'new_message') return undefined;
  const conversation = /[?&]conversation=([A-Za-z0-9_-]+)/.exec(link);
  return conversation ? `ns-msg-${conversation[1]}` : undefined;
}

// A push must always end in a visible notification. Chrome shows its own
// generic "This site has been updated in the background" one if we don't, and
// Safari/iOS revokes the subscription after a few pushes that show nothing.
// That is why a malformed or empty payload still gets a title and a link
// home, and why the notification also shows while a NextaStore tab is focused
// (at the cost of one redundant banner).
self.addEventListener('push', (event) => {
  const payload = readPushPayload(event);
  const type = pushText(payload.type, 40) || 'general';
  const link = resolveAppLink(payload.link);
  const tag = pushTag(type, link);

  const isMessage = type === 'new_message';
  const title = pushText(payload.title, PUSH_TITLE_MAX) || PUSH_DEFAULT_TITLE;
  // One device can hold several people's accounts, so the notification says
  // whose it is: the recipient's name goes on its own last line under the
  // message. Older payloads without `account` render exactly as before.
  const account = pushText(payload.account, PUSH_ACCOUNT_MAX);
  const message = pushText(payload.body, PUSH_BODY_MAX);
  const body = account ? `${message}${message ? '\n' : ''}Account: ${account}` : message;
  const options = {
    body,
    icon: PUSH_ICON,
    badge: pushBadgeFor(type),
    data: { url: link, type },
    ...(isMessage ? {
      actions: [{ action: 'reply', title: 'Reply' }]
    } : {}),
    // renotify makes the phone buzz again when a tagged notification is
    // replaced; without a tag it is not allowed, so only set it with one.
    ...(tag ? { tag, renotify: true } : {})
  };

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      // Open tabs update their bell straight away instead of waiting for the
      // next poll. Best effort: nobody has to be listening.
      try {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        windows.forEach((client) => client.postMessage({ type: 'ns-push-received', notificationType: type }));
      } catch (err) { /* ignore */ }
    })()
  );
});

// Tap: re-check the link (the notification's data is ours, but the check is
// cheap and this is the one place it turns into navigation), then reuse a
// NextaStore window if there is one — on the exact page if possible — and
// only open a new one when there isn't.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = resolveAppLink(event.notification.data && event.notification.data.url);
  const isReplyAction = event.action === 'reply'
    && event.notification.data
    && event.notification.data.type === 'new_message';
  const targetLink = isReplyAction
    ? `${link}${link.includes('?') ? '&' : '?'}focusComposer=1`
    : link;
  const targetUrl = new URL(targetLink, appScope()).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const visible = (c) => (c.visibilityState === 'visible' ? 0 : 1);
      const candidates = windows
        .filter((c) => { try { return new URL(c.url).origin === self.location.origin; } catch (err) { return false; } })
        .sort((a, b) => visible(a) - visible(b));

      const samePage = candidates.find((c) => c.url === targetUrl);
      const client = samePage || candidates[0];
      if (client) {
        try {
          const focused = (await client.focus()) || client;
          if (!samePage && typeof focused.navigate === 'function') await focused.navigate(targetUrl);
          return;
        } catch (err) {
          // navigate() rejects for a window this worker doesn't control;
          // fall through and open a fresh one.
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
    })()
  );
});

// The browser rotated or expired the subscription (Chrome/Firefox fire this;
// Safari does not). Get a new one with the same key and hand it to an open
// page, which is the only place with a login to tell the server about it.
// With no page open the browser still holds the new subscription and the page
// module re-registers it on the next visit.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      let subscription = event.newSubscription || null;
      try {
        if (!subscription) {
          const key = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
          if (key) subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        }
      } catch (err) {
        subscription = null;
      }
      try {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        windows.forEach((client) => client.postMessage({
          type: 'ns-push-subscription-changed',
          subscription: subscription && typeof subscription.toJSON === 'function' ? subscription.toJSON() : null
        }));
      } catch (err) { /* ignore */ }
    })()
  );
});
