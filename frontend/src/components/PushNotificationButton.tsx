import { useEffect, useState } from 'react'
import { Bell, BellOff } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { disablePush, enablePush, pushUnavailableReason, syncPushSubscription } from '../lib/push'
import type { PushConfig } from '../lib/push'
import { useAppContext } from '../contexts/AppContext'

export function PushNotificationButton() {
  const { showToast } = useAppContext()
  const [config, setConfig] = useState<PushConfig | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try {
        const next = await apiFetch<PushConfig>('/api/push/config')
        if (cancelled) return
        setConfig(next)
        const active = await syncPushSubscription(next)
        if (!cancelled) setEnabled(active)
      } catch { /* Clicking the button allows a visible retry. */ }
    }
    void refresh()
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { cancelled = true; document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  const toggle = async () => {
    const reason = pushUnavailableReason()
    if (reason) { showToast(reason, 'error'); return }
    if (!enabled && !config?.enabled) {
      try {
        setConfig(await apiFetch<PushConfig>('/api/push/config'))
        showToast('请确认服务器已配置推送，然后再次点击开启通知。')
      } catch { showToast('无法读取推送设置，请稍后重试。', 'error') }
      return
    }
    // iOS requires requestPermission directly in the user gesture, before any
    // network request or service-worker await.
    const permission = !enabled ? Notification.requestPermission() : null
    setBusy(true)
    try {
      if (enabled) await disablePush()
      else await enablePush(config!, permission!)
      setEnabled(!enabled)
      showToast(enabled ? '此设备已关闭任务完成通知' : '已开启任务完成通知，关闭应用后也可接收')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '通知设置失败，请重试。', 'error')
    } finally { setBusy(false) }
  }

  return <button type="button" className="sidebar-footer-btn" disabled={busy}
    aria-pressed={enabled} onClick={() => void toggle()}
    title={enabled ? '关闭此设备的任务完成通知' : '开启此设备的任务完成通知'}>
    {enabled ? <Bell size={16} /> : <BellOff size={16} />}
    <span>{busy ? '正在设置…' : enabled ? '任务通知已开启' : '开启任务通知'}</span>
  </button>
}
