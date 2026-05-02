const CACHE       = 'lhc-worship-shell-v3';
const DATA_CACHE  = 'lhc-pending-data';
const BASE        = '/LHC-Worship-App';
const REQUIRED    = [BASE + '/index.html', BASE + '/manifest.json'];
const OPTIONAL    = [BASE + '/icons/icon.svg', BASE + '/icons/icon-192.png', BASE + '/icons/icon-512.png', BASE + '/icons/apple-touch-icon.png'];

// ── Install: cache shell assets ──────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async c => {
      await c.addAll(REQUIRED);
      await Promise.allSettled(OPTIONAL.map(u => c.add(u).catch(() => {})));
    })
  );
  self.skipWaiting();
});

// ── Activate: purge old caches ───────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE && k !== DATA_CACHE)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Persist pending file across SW restarts via Cache API ────────────────────
// (in-memory var is lost if the SW is killed between the POST and the GET poll)
async function storePendingFile(data) {
  const c = await caches.open(DATA_CACHE);
  await c.put(
    BASE + '/_pending-file-store',
    new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
  );
}

async function consumePendingFile() {
  const c    = await caches.open(DATA_CACHE);
  const resp = await c.match(BASE + '/_pending-file-store');
  if (!resp) return null;
  const data = await resp.json().catch(() => null);
  await c.delete(BASE + '/_pending-file-store');
  return data;
}

// ── Fetch handler ────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // ── Web Share Target POST ──────────────────────────────────────────────────
  // Android fires this when the user taps "LHC Worship Prep" in any app's share sheet.
  if (url.pathname === BASE + '/share-handler' && e.request.method === 'POST') {
    e.respondWith((async () => {
      try {
        const fd         = await e.request.formData();
        const shareUrl   = (fd.get('share_url')   || '').trim();
        const shareTitle = (fd.get('share_title') || '').trim();
        const shareText  = (fd.get('share_text')  || '').trim();
        const files      = fd.getAll('share_files');

        const redirect = new URL(BASE + '/', self.location.origin);

        if (files && files.length > 0) {
          const file = files[0];
          if (file.size <= 8 * 1024 * 1024) {
            const b64 = _bufferToBase64(await file.arrayBuffer());
            await storePendingFile({
              name:    file.name,
              type:    file.type,
              size:    file.size,
              title:   shareTitle || file.name,
              data:    'data:' + file.type + ';base64,' + b64,
              addedAt: new Date().toISOString()
            });
          } else {
            await storePendingFile({
              name: file.name, type: file.type, size: file.size,
              title: shareTitle || file.name, data: null,
              addedAt: new Date().toISOString()
            });
          }
          redirect.searchParams.set('shareFile',  '1');
          redirect.searchParams.set('shareName',  file.name);
          redirect.searchParams.set('shareType',  file.type);
          redirect.searchParams.set('shareTitle', shareTitle || file.name);
        } else {
          // URL / text share — pass as query params (survives SW restarts automatically)
          if (shareUrl)   redirect.searchParams.set('share_url',   shareUrl);
          if (shareTitle) redirect.searchParams.set('share_title', shareTitle);
          if (shareText)  redirect.searchParams.set('share_text',  shareText);
        }

        // Always land on the Orders view when a share arrives
        redirect.searchParams.set('view', 'worshipOrderView');

        return Response.redirect(redirect.toString(), 303);
      } catch (err) {
        return Response.redirect(BASE + '/?shareError=1', 303);
      }
    })());
    return;
  }

  // ── Pending-file poll (main page calls this after a file share redirect) ──
  if (url.pathname === BASE + '/pending-share-file') {
    e.respondWith(
      consumePendingFile().then(data =>
        new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }

  // ── SW version ping (shell uses this to detect when a new SW is active) ──
  if (url.pathname === BASE + '/sw-version') {
    e.respondWith(new Response(JSON.stringify({ version: CACHE }), {
      headers: { 'Content-Type': 'application/json' }
    }));
    return;
  }

  // ── Pass Google / GAS requests straight through ────────────────────────────
  if (url.hostname.includes('google') || url.hostname.includes('gstatic')) return;

  // ── Cache-first for shell assets; offline fallback for navigations ─────────
  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) return hit;
      return fetch(e.request).catch(() => caches.match(BASE + '/index.html'));
    })
  );
});

// ── Periodic Background Sync ──────────────────────────────────────────────────
// Registered once a day from the shell. Keeps the SW in the OS share-target
// registry and lets us do light background work (cache refresh, etc.).
self.addEventListener('periodicsync', e => {
  if (e.tag === 'lhc-heartbeat') {
    e.waitUntil(
      caches.open(CACHE).then(c =>
        Promise.allSettled(REQUIRED.map(u =>
          fetch(u, { cache: 'reload' }).then(r => c.put(u, r)).catch(() => {})
        ))
      )
    );
  }
});

// ── Background Sync (one-shot retry for failed share saves) ──────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'lhc-retry-share') {
    e.waitUntil(
      self.clients.matchAll().then(clients => {
        clients.forEach(c => c.postMessage({ type: 'lhc-retry-share' }));
      })
    );
  }
});

// ── Message handler (keepalive ping from the shell tab) ──────────────────────
// Receiving a message prevents the OS from killing an idle SW.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'ping') {
    e.ports && e.ports[0] && e.ports[0].postMessage({ type: 'pong', version: CACHE });
  }
  if (e.data && e.data.type === 'skipWaiting') {
    self.skipWaiting();
  }
});

// ── Notification click (required to keep SW eligible for share target) ────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      const existing = clients.find(c => c.url.startsWith(self.location.origin + BASE));
      return existing ? existing.focus() : self.clients.openWindow(BASE + '/');
    })
  );
});

// ── Helper ───────────────────────────────────────────────────────────────────
function _bufferToBase64(buffer) {
  var binary = '', bytes = new Uint8Array(buffer), chunk = 8192;
  for (var i = 0; i < bytes.byteLength; i += chunk)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}
