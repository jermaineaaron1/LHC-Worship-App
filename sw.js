const CACHE    = 'lhc-worship-shell-v2';
const BASE     = '/LHC-Worship-App';
const REQUIRED = [BASE + '/index.html', BASE + '/manifest.json'];
const OPTIONAL = [BASE + '/icons/icon.svg', BASE + '/icons/icon-192.png', BASE + '/icons/icon-512.png', BASE + '/icons/apple-touch-icon.png'];

// Temporarily stores a shared file between the POST handler and the main page fetch
var _pendingFile = null;

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async c => {
      await c.addAll(REQUIRED);
      await Promise.allSettled(OPTIONAL.map(u => c.add(u).catch(() => {})));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // ── Handle Web Share Target POST ─────────────────────────────────────────
  // Android sends a POST to /LHC-Worship-App/share-handler when the user
  // shares any content (URL, image, audio, video) to this PWA.
  if (url.pathname === BASE + '/share-handler' && e.request.method === 'POST') {
    e.respondWith((async () => {
      try {
        const fd          = await e.request.formData();
        const shareUrl    = (fd.get('share_url')   || '').trim();
        const shareTitle  = (fd.get('share_title') || '').trim();
        const shareText   = (fd.get('share_text')  || '').trim();
        const files       = fd.getAll('share_files');

        const redirect = new URL(BASE + '/', self.location.origin);

        if (files && files.length > 0) {
          const file = files[0];
          // Convert to base64 data URL so it can travel via URL param or postMessage
          // Cap at 8 MB to avoid memory issues
          if (file.size <= 8 * 1024 * 1024) {
            const ab  = await file.arrayBuffer();
            const b64 = _arrayBufferToBase64(ab);
            _pendingFile = {
              name:  file.name,
              type:  file.type,
              size:  file.size,
              title: shareTitle || file.name,
              data:  'data:' + file.type + ';base64,' + b64,
              addedAt: new Date().toISOString()
            };
          } else {
            // Too large to inline — just keep metadata
            _pendingFile = {
              name:  file.name,
              type:  file.type,
              size:  file.size,
              title: shareTitle || file.name,
              data:  null,
              addedAt: new Date().toISOString()
            };
          }
          redirect.searchParams.set('shareFile', '1');
          redirect.searchParams.set('shareName',  file.name);
          redirect.searchParams.set('shareType',  file.type);
          redirect.searchParams.set('shareTitle', shareTitle || file.name);
        } else {
          // URL / text share — forward as query params
          if (shareUrl)   redirect.searchParams.set('share_url',   shareUrl);
          if (shareTitle) redirect.searchParams.set('share_title', shareTitle);
          if (shareText)  redirect.searchParams.set('share_text',  shareText);
        }

        return Response.redirect(redirect.toString(), 303);
      } catch (err) {
        return Response.redirect(BASE + '/', 303);
      }
    })());
    return;
  }

  // ── Internal API: main page polls for a pending file ─────────────────────
  if (url.pathname === BASE + '/pending-share-file') {
    const data = _pendingFile;
    _pendingFile = null;
    e.respondWith(new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' }
    }));
    return;
  }

  // ── Let all Google / GAS requests pass through untouched ─────────────────
  if (url.hostname.includes('google') || url.hostname.includes('gstatic')) return;

  // ── Cache-first for shell assets, fallback to index.html for navigation ──
  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) return hit;
      return fetch(e.request).catch(() => caches.match(BASE + '/index.html'));
    })
  );
});

function _arrayBufferToBase64(buffer) {
  var binary = '';
  var bytes   = new Uint8Array(buffer);
  var chunk   = 8192;
  for (var i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
