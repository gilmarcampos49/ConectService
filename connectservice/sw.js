// Service worker: permite instalar o app e abrir a estrutura offline.
// Estratégia "rede primeiro": sempre busca a versão nova e só usa o cache se estiver sem internet.
// Nunca guarda chamadas ao Supabase nem a outros domínios.

const CACHE = 'connectservice-v2';
const SHELL = [
    'index.html', 'manifest.json', 'css/style.css',
    'js/config.js', 'js/utils.js', 'js/auth.js', 'js/map.js', 'js/menu.js', 'js/payment.js', 'js/app.js',
    'icons/icon-192.png', 'icons/icon-512.png', 'logo_conect_service_pro_horizontal.jpg'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    const url = new URL(req.url);
    if (req.method !== 'GET' || url.origin !== self.location.origin) return;

    event.respondWith(
        fetch(req)
            .then((res) => {
                if (res.ok) {
                    const copy = res.clone();
                    caches.open(CACHE).then((cache) => cache.put(req, copy));
                }
                return res;
            })
            .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined)))
    );
});
