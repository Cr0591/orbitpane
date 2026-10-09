/* Imported by the generated Workbox worker; also runs while the PWA is closed. */
self.addEventListener('message', event => {
  if (event.data?.type === 'ORBITPANE_PUSH_READY') event.ports[0]?.postMessage({ ready: true })
})

self.addEventListener('push', event => {
  let payload = {}
  try { payload = event.data?.json() || {} } catch { /* Always show a visible notification. */ }
  event.waitUntil(self.registration.showNotification(
    payload.title || 'OrbitPane · 任务完成',
    {
      body: payload.body || '任务已完成，点击查看结果。',
      icon: '/pwa-192x192.png',
      badge: '/pwa-64x64.png',
      tag: payload.tag || 'orbitpane-task',
      data: { url: payload.url },
    },
  ))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil((async () => {
    // Only the private conversation route is a valid notification destination.
    let candidate
    try { candidate = new URL(event.notification.data?.url || '/', self.location.origin) }
    catch { candidate = new URL('/', self.location.origin) }
    const url = candidate.origin === self.location.origin && candidate.pathname === '/'
      && /^\d+$/.test(candidate.searchParams.get('id') || '')
      ? new URL('/?id=' + candidate.searchParams.get('id'), self.location.origin).href
      : new URL('/', self.location.origin).href
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin
      && new URL(client.url).pathname === '/')
    if (existing) {
      try {
        const navigated = await existing.navigate(url)
        if (navigated) return await navigated.focus()
      } catch { /* The old window may have closed during the click. */ }
    }
    return self.clients.openWindow(url)
  })())
})
