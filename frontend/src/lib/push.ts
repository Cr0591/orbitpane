import { apiFetch } from './api'
import { readText, writeText } from './storage'

export interface PushConfig { enabled: boolean; public_key: string }

// Serialize refresh/toggle/logout so an in-flight refresh cannot restore a
// subscription after the user has disabled notifications or signed out.
let pendingOperation: Promise<unknown> = Promise.resolve()
const PUSH_DISABLED_KEY = 'orbitpane_push_disabled'
let disabledInMemory = false
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = pendingOperation.then(operation, operation)
  pendingOperation = next.catch(() => {})
  return next
}

export function pushUnavailableReason(): string | null {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  if (ios && !standalone) return '请先在 Safari 中将 OrbitPane 添加到主屏幕，再从主屏幕打开并开启通知（需 iOS 16.4+）。'
  if (!window.isSecureContext || !('serviceWorker' in navigator)
    || !('PushManager' in window) || !('Notification' in window)) {
    return '当前浏览器不支持推送通知，请使用 HTTPS 和支持推送的浏览器。'
  }
  return null
}

export async function pushRegistration(): Promise<ServiceWorkerRegistration> {
  // An old/offline install or dev server may never register a worker.
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('应用尚未准备好接收通知，请更新应用后重试。')), 10000)
      }),
    ])
  } finally { clearTimeout(timeout) }
}

function encodeKey(key: ArrayBuffer | null | undefined) {
  return key ? btoa(String.fromCharCode(...new Uint8Array(key)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : ''
}

export async function savePushSubscription(subscription: PushSubscription, publicKey: string) {
  await apiFetch('/api/push/subscription', {
    method: 'PUT',
    body: JSON.stringify({ ...subscription.toJSON(), application_server_key: publicKey }),
  })
}

export function syncPushSubscription(config: PushConfig): Promise<boolean> {
  return serialize(async () => {
    if (disabledInMemory || readText(PUSH_DISABLED_KEY) === 'true') return false
    if (pushUnavailableReason() || Notification.permission !== 'granted' || !config.enabled) return false
    const registration = await pushRegistration()
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription || encodeKey(subscription.options.applicationServerKey) !== config.public_key) return false
    await savePushSubscription(subscription, config.public_key)
    return true
  })
}

export async function enablePush(config: PushConfig, permission: Promise<NotificationPermission>) {
  if (await permission !== 'granted') throw new Error('通知权限未开启，请在系统设置中允许 OrbitPane 发送通知。')
  return serialize(async () => {
    const registration = await pushRegistration()
    // A waiting update can leave the old worker active, without push handlers.
    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel()
      const timer = setTimeout(() => {
        channel.port1.close()
        reject(new Error('请先更新应用并重新打开，再开启任务通知。'))
      }, 3000)
      channel.port1.onmessage = event => {
        if (event.data?.ready) {
          clearTimeout(timer)
          channel.port1.close()
          resolve()
        }
      }
      registration.active?.postMessage({ type: 'ORBITPANE_PUSH_READY' }, [channel.port2])
    })
    let subscription = await registration.pushManager.getSubscription()
    if (subscription && encodeKey(subscription.options.applicationServerKey) !== config.public_key) {
      await removeSubscription(subscription)
      subscription = null
    }
    if (!subscription) {
      const raw = atob(config.public_key.replace(/-/g, '+').replace(/_/g, '/'))
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: Uint8Array.from(raw, char => char.charCodeAt(0)),
      })
    }
    await savePushSubscription(subscription, config.public_key)
    disabledInMemory = false
    writeText(PUSH_DISABLED_KEY, 'false')
  })
}

async function removeSubscription(subscription: PushSubscription) {
  await apiFetch('/api/push/subscription', {
    method: 'DELETE', body: JSON.stringify({ endpoint: subscription.endpoint }),
  })
  await subscription.unsubscribe()
}

export function disablePush() {
  disabledInMemory = true
  writeText(PUSH_DISABLED_KEY, 'true')
  return serialize(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
    const registration = await navigator.serviceWorker.getRegistration()
    const subscription = await registration?.pushManager.getSubscription()
    if (!subscription) return
    await removeSubscription(subscription)
  })
}
