const CACHE_NAME = 'esprin-nemo-web-v1';
const HOME_URL = '/';
const SHELL_FILES = ['/', '/boot.js', '/window_appearance.js', '/web_host.js'];
const SHELL_PREFIXES = ['/styles/', '/scripts/', '/fonts/', '/src/', '/node_modules/material-symbols/'];
const BYPASS_PREFIXES = ['/sync', '/admin', '/health'];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await Promise.all(SHELL_FILES.map((path) => cache.add(path).catch(() => {})));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
        await self.clients.claim();
    })());
});

function sameOrigin(url) {
    return url.origin === self.location.origin;
}

function isBypassed(url) {
    return BYPASS_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
}

function isShell(url) {
    if (url.pathname === HOME_URL || SHELL_FILES.includes(url.pathname)) return true;
    return SHELL_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

async function refresh(request, cache) {
    const response = await fetch(request);
    if (response && response.ok) await cache.put(request, response.clone());
    return response;
}

async function networkFirst(request, cache) {
    try {
        const response = await refresh(request, cache);
        if (request.mode === 'navigate' && response && response.ok && request.url === `${self.location.origin}/`) {
            await cache.put(HOME_URL, response.clone());
        }
        return response;
    } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
            const home = await cache.match(HOME_URL);
            if (home) return home;
        }
        return Response.error();
    }
}

async function cacheFirst(request, cache) {
    const cached = await cache.match(request);
    if (cached) {
        refresh(request, cache).catch(() => {});
        return cached;
    }
    try {
        return await refresh(request, cache);
    } catch (error) {
        return Response.error();
    }
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (!sameOrigin(url) || isBypassed(url)) return;
    if (request.headers.get('authorization')) return;

    if (request.mode === 'navigate') {
        event.respondWith((async () => networkFirst(request, await caches.open(CACHE_NAME)))());
        return;
    }

    if (!isShell(url)) return;

    event.respondWith((async () => cacheFirst(request, await caches.open(CACHE_NAME)))());
});
