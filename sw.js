// Debunkly — Service Worker
// Estratégia: network-first para o app shell (garante que o usuário sempre
// veja a versão mais recente do index.html), com fallback pro cache quando
// estiver offline. Sobe a versão do CACHE_NAME sempre que fizer deploy de
// uma mudança que precise "furar" o cache de aparelhos já instalados.

const CACHE_NAME = 'debunkly-cache-v1';
const APP_SHELL = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Só cuidamos de navegação/GET do próprio app; deixa passar direto
  // requisições pro proxy de análise (Val Town) e afins.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
  );
});
