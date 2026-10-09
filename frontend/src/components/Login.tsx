import React, { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { LogoIcon } from '../LogoIcon'
import { apiFetch, ApiError } from '../lib/api'
import { loginWithPasskey, passkeyError, supportsPasskeys } from '../lib/passkeys'
import { Lock, AlertCircle, Fingerprint } from 'lucide-react'
import './Login.css'

export function Login({ onLogin }: { onLogin: () => void }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const passkeysSupported = supportsPasskeys()
  const [usePin, setUsePin] = useState(!passkeysSupported)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  /* The screen sizes itself to the visual viewport, so the field is normally
     already inside the strip the keyboard leaves. It is not on a short phone
     in landscape, where the column is taller than that strip and starts at the
     top of it — and iOS will not scroll a position:fixed page to the caret.
     Nudging the field into view covers that case, and is a no-op when the card
     fits, which is the common one. */
  const revealInput = useCallback(() => {
    if (document.activeElement !== inputRef.current) return
    inputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [])

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    viewport.addEventListener('resize', revealInput)
    return () => viewport.removeEventListener('resize', revealInput)
  }, [revealInput])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!pin) return
    setLoading(true)
    setError('')

    try {
      const data = await apiFetch<{ success: boolean }>('/api/login', {
        method: 'POST',
        body: JSON.stringify({ pin })
      })
      if (data.success) {
        onLogin()
      } else {
        throw new Error('Invalid PIN')
      }
    } catch (error) {
      setError(error instanceof ApiError && error.status === 401 ? 'PIN 不正确，请重试。'
        : error instanceof ApiError && error.status === 429 ? '尝试次数过多，请稍后重试。' : '登录失败，请检查网络后重试。')
      setPin('')
    } finally {
      setLoading(false)
    }
  }

  const handlePasskey = async () => {
    setLoading(true)
    setError('')
    try {
      await loginWithPasskey()
      onLogin()
    } catch (error) {
      setError(passkeyError(error))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-screen">
      <div className="login-scroll">
        <div className="login-card">
          <div className="login-header">
            <div className="login-brand-row">
              <LogoIcon size={44} />
              <h1 className="login-brand-title">OrbitPane</h1>
            </div>
            {/* One line of orientation. The card previously showed a name and a
                field with nothing to say what this machine is. */}
            <p className="login-brand-sub">自托管的编码 Agent 工作台</p>
          </div>

          <div className="login-form-area">
            {!usePin && (
              <>
                <button type="button" className="login-submit-btn" disabled={loading} onClick={handlePasskey}>
                  {loading ? <div className="login-spinner" /> : <><Fingerprint size={20} />使用通行密钥登录</>}
                </button>
                <p className="login-passkey-hint">使用 Face ID、Touch ID 或设备通行密钥。<br />首次使用请先用 PIN 登录，再在侧栏绑定。</p>
              </>
            )}
            {usePin && <form onSubmit={handleSubmit} className="login-form-area">
              <div className="login-input-group">
                <label className="login-input-label">访问 PIN</label>
                <div className="login-input-wrapper">
                  <input
                    ref={inputRef}
                    type="password"
                    value={pin}
                    onChange={e => { setPin(e.target.value); setError(''); }}
                    // The resize listener catches the keyboard opening; this catches
                    // a re-focus while it is already up, when no resize fires.
                    onFocus={() => window.setTimeout(revealInput, 300)}
                    placeholder="输入访问 PIN"
                    className={`login-input ${error ? 'login-input-error' : ''}`}
                    autoFocus
                    disabled={loading}
                    aria-label="输入访问 PIN"
                  />
                  <Lock className="login-input-icon" size={18} strokeWidth={2.5} />
                </div>


              </div>

              <button
                type="submit"
                disabled={loading || !pin.trim()}
                className="login-submit-btn"
                aria-label={loading ? '正在验证' : '提交 PIN'}
              >
                {loading ? <div className="login-spinner" /> : '登录'}
              </button>
            </form>}
            <AnimatePresence>
              {error && <motion.div role="alert" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="login-error-message">
                <AlertCircle size={14} /><span>{error}</span>
              </motion.div>}
            </AnimatePresence>
            {passkeysSupported ? (
              <button type="button" className="login-switch-btn" disabled={loading} onClick={() => { setUsePin(!usePin); setError(''); setPin('') }}>
                {usePin ? '改用通行密钥登录' : '使用 PIN 登录'}
              </button>
            ) : <p className="login-passkey-hint">当前环境不支持通行密钥，请使用 PIN 登录。通行密钥需要 HTTPS 和支持的浏览器。</p>}
          </div>

        </div>
      </div>
      {/* Fine print belongs to the screen, not inside the card: a build number
          centred under the primary action read as part of the form. */}
      <div className="login-footer">OrbitPane v2.1</div>
    </div>
  )
}
