/* Rainier Spark · 62d AW Innovation Dashboard — Service Worker
 * Makes the PWA truly installable + offline-capable.
 *
 * Bump VERSION to ship a new build (old caches are purged on activate).
 * Strategies:
 *   - navigations        → network-first, fall back to cached shell (offline)
 *   - same-origin assets → cache-first, refresh in background
 *   - CDN libs & fonts   → stale-while-revalidate
 *   - API / analytics    → not intercepted (always live network)
 */
const VERSION = 'v2';
const SHELL_CACHE = `rainier-shell-${VERSION}`;
const RUNTIME_CACHE = `rainier-runtime-${VERSION}`;
const SCOPE = self.registration.scope;

// App shell — resolved against the SW scope so this works whether the site is
// served from the domain root or a /project-page/ subpath.
const SHELL = [
  '',
  'index.html',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-1024.png',
  'apple-touch-icon.png',
].map((p) => new URL(p, SCOPE).toString());

const SHELL_FALLBACK = new URL('index.html', SCOPE).toString();

// Cross-origin hosts whose GETs are safe to cache at runtime (libraries + fonts).
const RUNTIME_HOSTS = new Set([
  'cdn.tailwindcss.com',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
]);

// Hosts/paths we must never intercept — leaderboard API must stay live, and
// analytics beacons should hit the network untouched.
function isBypass(url) {
  return (
    url.hostname.endsWith('.workers.dev') ||
    url.hostname === 'static.cloudflareinsights.com' ||
    url.pathname.startsWith('/cdn-cgi/')
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // cache:'reload' bypasses the HTTP cache so we precache fresh copies.
      await Promise.all(
        SHELL.map((u) =>
          cache
            .add(new Request(u, { cache: 'reload' }))
            .catch(() => {/* tolerate a missing optional asset */})
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, RUNTIME_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.map((n) => (keep.has(n) ? null : caches.delete(n))));
      await self.clients.claim();
    })()
  );
});

// Allow the page to trigger an immediate update swap.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// ── Web Push: show notification + focus/open the app on click ──
self.addEventListener('push', (event) => {
  let data = { title: 'Rainier Spark', body: "Today's puzzle is live." };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch (e) {
    try { if (event.data) data.body = event.data.text(); } catch (e2) {}
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: new URL('icon-192.png', SCOPE).toString(),
      badge: new URL('icon-192.png', SCOPE).toString(),
      tag: data.tag || 'rainier-spark',
      data: { url: data.url || SHELL_FALLBACK },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || SHELL_FALLBACK;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if ('focus' in c) { c.focus(); return; }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (isBypass(url)) return; // leave API/analytics to the network

  // App navigations: network-first so users get fresh content online, with the
  // cached shell as the offline fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          // Cache each page under its own URL so a second page (e.g. admin.html)
          // never overwrites the root's offline copy.
          const cache = await caches.open(SHELL_CACHE);
          cache.put(req, fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match(req);
          return cached || (await caches.match(SHELL_FALLBACK)) || Response.error();
        }
      })()
    );
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const runtimeCacheable = RUNTIME_HOSTS.has(url.hostname);
  if (!sameOrigin && !runtimeCacheable) return; // other cross-origin: passthrough

  if (sameOrigin) {
    // Cache-first for our own static assets; refresh the copy in the background.
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              caches.open(SHELL_CACHE).then((c) => c.put(req, res.clone()));
            }
            return res;
          })
          .catch(() => null);
        return cached || (await network) || Response.error();
      })()
    );
    return;
  }

  // Cross-origin libs/fonts: stale-while-revalidate.
  event.respondWith(
    (async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          // Cache opaque (fonts) and ok responses; skip error statuses.
          if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      return cached || (await network) || Response.error();
    })()
  );
});
