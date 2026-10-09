import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../public/push-worker.js', import.meta.url), 'utf8')

function worker(windows = []) {
  const handlers = {}
  const shown = []
  const opened = []
  vm.runInNewContext(source, { URL, self: {
    location: { origin: 'https://orbitpane.example.com' },
    addEventListener: (name, handler) => { handlers[name] = handler },
    registration: { showNotification: async (title, options) => { shown.push({ title, ...options }) } },
    clients: { matchAll: async () => windows, openWindow: async url => { opened.push(url) } },
  } })
  return { shown, opened, async dispatch(name, event) {
    let pending
    handlers[name]({ ...event, waitUntil: promise => { pending = promise } })
    await pending
  } }
}

test('push displays a notification even without an open app window', async () => {
  const sw = worker()
  await sw.dispatch('push', { data: { json: () => ({ body: 'Finished', url: '/?id=42', tag: 'run-1' }) } })
  assert.equal(sw.shown.length, 1)
  assert.equal(sw.shown[0].body, 'Finished')
  assert.equal(sw.shown[0].tag, 'run-1')
})

test('invalid or absent payload still produces a visible notification', async () => {
  const sw = worker()
  await sw.dispatch('push', {})
  await sw.dispatch('push', { data: { json: () => { throw new Error() } } })
  assert.equal(sw.shown.length, 2)
  assert.ok(sw.shown.every(item => item.title && item.body))
})

test('click opens the completed conversation', async () => {
  const sw = worker()
  let closed = false
  await sw.dispatch('notificationclick', { notification: { close: () => { closed = true }, data: { url: '/?id=42' } } })
  assert.ok(closed)
  assert.deepEqual(sw.opened, ['https://orbitpane.example.com/?id=42'])
})

test('click focuses and navigates an existing private window without using share windows', async () => {
  let navigated
  let focused = false
  const sw = worker([
    { url: 'https://orbitpane.example.com/s/private-token' },
    { url: 'https://orbitpane.example.com/?id=1', navigate: async url => {
      navigated = url
      return { focus: async () => { focused = true } }
    } },
  ])
  await sw.dispatch('notificationclick', { notification: { close() {}, data: { url: '/?id=42' } } })
  assert.equal(navigated, 'https://orbitpane.example.com/?id=42')
  assert.ok(focused)
  assert.equal(sw.opened.length, 0)
})

test('external and public-share destinations cannot be opened by a push', async () => {
  for (const url of ['https://evil.example/?id=42', '/s/token', 'javascript:alert(1)', '/?id=oops']) {
    const sw = worker()
    await sw.dispatch('notificationclick', { notification: { close() {}, data: { url } } })
    assert.deepEqual(sw.opened, ['https://orbitpane.example.com/'])
  }
})
