'use strict'
const CACHE = 'rasp-offline-v2'
const BASE = new URL('.', self.location.href)
const SHELL = ['', 'index.html', 'style.css', 'app.js', 'icon.svg', 'manifest.webmanifest']
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(path => new URL(path, BASE).href))).then(() => self.skipWaiting()))
})
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('rasp-offline-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    try {
      const response = await fetch(event.request, { signal: AbortSignal.timeout(7000) })
      if (response.ok) {
        await cache.put(event.request, response.clone())
        const keys = (await cache.keys()).filter(r => new URL(r.url).pathname.includes('/data/') && !r.url.endsWith('/index.json'))
        await Promise.all(keys.slice(0, Math.max(0, keys.length - 40)).map(k => cache.delete(k)))
      }
      return response
    } catch (error) {
      const saved = await cache.match(event.request) || (event.request.mode === 'navigate' ? await cache.match(new URL('index.html', BASE).href) : null)
      if (!saved) throw error
      const headers = new Headers(saved.headers)
      headers.set('X-Rasp-Offline', 'true')
      return new Response(saved.body, { status: saved.status, headers })
    }
  })())
})
