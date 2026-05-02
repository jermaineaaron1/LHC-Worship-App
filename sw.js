const CACHE      = 'lhc-worship-shell-v4';
const DATA_CACHE = 'lhc-pending-data';
const BASE       = '/LHC-Worship-App';
const REQUIRED   = [BASE + '/index.html', BASE + '/manifest.json'];
const OPTIONAL   = [BASE + '/icons/icon.svg', BASE + '/icons/icon-192.png', BASE + '/icons/icon-512.png', BASE + '/icons/apple-touch-icon.png'];

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async c => {
      await c.addAll(REQUIRED);
      await Promise.allSettled(OPTIONAL.map(u => c.add(u).catch(() => {})));
    })
  );
  self.skipWaiting();
});

// ── Activate: purge old caches ────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== DATA_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Cache helpers for pending share/file data ─────────────────────────────────
// Using Cache API so data survives SW restarts (in-memory vars get wiped).

async function _cacheStore(key, data) {
  const c = await caches.open(DATA_CACHE);
  await c.put(BASE + key, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }));
}

async function _cacheConsume(key) {
  const c    = await caches.open(DATA_CACHE);
  const resp = await c.match(BASE + key);
  if (!resp) return null;
  const data = await resp.json().catch(() => null);
  await c.delete(BASE + key);
  return data;
}

// ── Fetch handler ─────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // ── Web Share Target POST ─────────────────────────────────────────────────
  // Android fires this POST when the user picks "LHC Worship Prep" in any share sheet.
  if (url.pathname === BASE + '/share-handler' && e.request.method === 'POST') {
    e.respondWith((async () => {
      try {
        const fd         = await e.request.formData();
        const shareUrl   = (fd.get('share_url')   || '').trim();
        const shareTitle = (fd.get('share_title') || '').trim();
        const shareText  = (fd.get('share_text')  || '').trim();
        const files      = fd.getAll('share_files');

        // Find an already-open app window (app alive in background)
        const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const liveClient = allClients.find(c =>
          c.url.startsWith(self.location.origin + BASE) && !c.url.includes('share-handler')
        );

        if (files && files.length > 0) {
          // ── File share ──────────────────────────────────────────────────────
          const file    = files[0];
          let   fileData;
          if (file.size <= 8 * 1024 * 1024) {
            const b64 = _bufferToBase64(await file.arrayBuffer());
            fileData  = { shareType: 'file', name: file.name, mimeType: file.type,
                          size: file.size, title: shareTitle || file.name,
                          data: 'data:' + file.type + ';base64,' + b64, addedAt: new Date().toISOString() };
          } else {
            fileData = { shareType: 'file', name: file.name, mimeType: file.type,
                         size: file.size, title: shareTitle || file.name, data: null,
                         addedAt: new Date().toISOString() };
          }

          await _cacheStore('/_pending-share', fileData);

          if (liveClient) {
            // App is alive — wake it with a hash change (NO full reload)
            liveClient.postMessage({ type: 'lhc-bg-share', ...fileData });
            try { await liveClient.focus(); } catch(_) {}
            return Response.redirect(_wakeUrl(liveClient.url), 303);
          }

          // Cold start — use URL params + file in cache
          const r = new URL(BASE + '/', self.location.origin);
          r.searchParams.set('shareFile',  '1');
          r.searchParams.set('shareName',  file.name);
          r.searchParams.set('shareType',  file.type);
          r.searchParams.set('shareTitle', shareTitle || file.name);
          r.searchParams.set('view', 'worshipOrderView');
          return Response.redirect(r.toString(), 303);

        } else {
          // ── URL / text share ────────────────────────────────────────────────
          const sharePayload = { shareType: 'url', url: shareUrl, title: shareTitle,
                                 text: shareText, addedAt: new Date().toISOString() };
          await _cacheStore('/_pending-share', sharePayload);

          if (liveClient) {
            // App is alive — wake with hash, no reload
            liveClient.postMessage({ type: 'lhc-bg-share', ...sharePayload });
            try { await liveClient.focus(); } catch(_) {}
            return Response.redirect(_wakeUrl(liveClient.url), 303);
          }

          // Cold start — URL params
          const r = new URL(BASE + '/', self.location.origin);
          if (shareUrl)   r.searchParams.set('share_url',   shareUrl);
          if (shareTitle) r.searchParams.set('share_title', shareTitle);
          if (shareText)  r.searchParams.set('share_text',  shareText);
          r.searchParams.set('view', 'worshipOrderView');
          return Response.redirect(r.toString(), 303);
        }
      } catch (err) {
        return Response.redirect(BASE + '/?shareError=1', 303);
      }
    })());
    return;
  }

  // ── pending-share poll (shell fetches this after hash-wake or cold start) ──
  if (url.pathname === BASE + '/pending-share') {
    e.respondWith(
      _cacheConsume('/_pending-share').then(d =>
        new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }

  // ── Legacy: pending-share-file (kept for backward compat) ─────────────────
  if (url.pathname === BASE + '/pending-share-file') {
    e.respondWith(
      _cacheConsume('/_pending-share').then(d => {
        // Only return if it was a file share
        const fileData = d && d.shareType === 'file' ? d : null;
        return new Response(JSON.stringify(fileData), { headers: { 'Content-Type': 'application/json' } });
      })
    );
    return;
  }

  // ── SW version endpoint ────────────────────────────────────────────────────
  if (url.pathname === BASE + '/sw-version') {
    e.respondWith(new Response(JSON.stringify({ version: CACHE }), {
      headers: { 'Content-Type': 'application/json' }
    }));
    return;
  }

  // ── Pass Google / GAS traffic straight through ─────────────────────────────
  if (url.hostname.includes('google') || url.hostname.includes('gstatic')) return;

  // ── Cache-first for shell assets ───────────────────────────────────────────
  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) return hit;
      return fetch(e.request).catch(() => caches.match(BASE + '/index.html'));
    })
  );
});

// ── Periodic Background Sync ──────────────────────────────────────────────────
// Keeps SW fresh and the app listed in Android's share-target registry.
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

// ── Background Sync ────────────────────────────────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'lhc-retry-share') {
    e.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.postMessage({ type: 'lhc-retry-share' }))
      )
    );
  }
});

// ── Message handler (ping keepalive + skipWaiting) ─────────────────────────────
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'ping') {
    e.ports && e.ports[0] && e.ports[0].postMessage({ type: 'pong', version: CACHE });
  }
  if (e.data && e.data.type === 'skipWaiting') self.skipWaiting();
});

// ── Notification click ─────────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      const existing = clients.find(c => c.url.startsWith(self.location.origin + BASE));
      return existing ? existing.focus() : self.clients.openWindow(BASE + '/');
    })
  );
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function _wakeUrl(currentUrl) {
  // Hash change wakes the existing tab without a full reload
  return currentUrl.split('#')[0] + '#incoming-share';
}

function _bufferToBase64(buffer) {
  var binary = '', bytes = new Uint8Array(buffer), chunk = 8192;
  for (var i = 0; i < bytes.byteLength; i += chunk)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}
