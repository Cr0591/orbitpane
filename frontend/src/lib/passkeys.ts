import { apiFetch, ApiError } from './api'

export function supportsPasskeys(): boolean {
  return window.isSecureContext && !!window.PublicKeyCredential && !!navigator.credentials
}

function decode(value: string): ArrayBuffer {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, char => char.charCodeAt(0)).buffer
}

function encode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

type DescriptorJSON = Omit<PublicKeyCredentialDescriptor, 'id'> & { id: string }
type CreationJSON = Omit<PublicKeyCredentialCreationOptions, 'challenge' | 'user' | 'excludeCredentials'> & {
  challenge: string
  user: Omit<PublicKeyCredentialUserEntity, 'id'> & { id: string }
  excludeCredentials?: DescriptorJSON[]
}
type RequestJSON = Omit<PublicKeyCredentialRequestOptions, 'challenge' | 'allowCredentials'> & {
  challenge: string
  allowCredentials?: DescriptorJSON[]
}

const descriptors = (values?: DescriptorJSON[]) => values?.map(value => ({ ...value, id: decode(value.id) }))

function serialize(credential: PublicKeyCredential) {
  const response = credential.response
  const base = { clientDataJSON: encode(response.clientDataJSON) }
  return {
    id: credential.id, rawId: encode(credential.rawId), type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: response instanceof AuthenticatorAttestationResponse
      ? { ...base, attestationObject: encode(response.attestationObject), transports: response.getTransports?.() ?? [] }
      : {
          ...base,
          authenticatorData: encode((response as AuthenticatorAssertionResponse).authenticatorData),
          signature: encode((response as AuthenticatorAssertionResponse).signature),
          userHandle: (response as AuthenticatorAssertionResponse).userHandle
            ? encode((response as AuthenticatorAssertionResponse).userHandle!) : null,
        },
  }
}

export async function loginWithPasskey(): Promise<void> {
  const options = await apiFetch<RequestJSON>('/api/passkeys/login/options', { method: 'POST' })
  const credential = await navigator.credentials.get({ publicKey: {
    ...options, challenge: decode(options.challenge), allowCredentials: descriptors(options.allowCredentials),
  } }) as PublicKeyCredential | null
  if (!credential) throw new DOMException('Cancelled', 'NotAllowedError')
  await apiFetch('/api/passkeys/login/verify', {
    method: 'POST', body: JSON.stringify({ credential: serialize(credential) }),
  })
}

export async function registerPasskey(): Promise<void> {
  const options = await apiFetch<CreationJSON>('/api/passkeys/register/options', { method: 'POST' })
  const credential = await navigator.credentials.create({ publicKey: {
    ...options, challenge: decode(options.challenge),
    user: { ...options.user, id: decode(options.user.id) },
    excludeCredentials: descriptors(options.excludeCredentials),
  } }) as PublicKeyCredential | null
  if (!credential) throw new DOMException('Cancelled', 'NotAllowedError')
  await apiFetch('/api/passkeys/register/verify', {
    method: 'POST', body: JSON.stringify({ credential: serialize(credential) }),
  })
}

export function passkeyError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'AbortError') {
      return '未完成通行密钥验证。可重试，或使用 PIN 登录。'
    }
    if (error.name === 'InvalidStateError') return '此设备已绑定通行密钥，可直接用它登录。'
    if (error.name === 'SecurityError') return '当前网址无法使用通行密钥，请从配置的 HTTPS 站点访问。'
  }
  if (error instanceof ApiError) return error.message
  if (error instanceof TypeError) return '无法连接服务，请检查网络后重试。'
  return '通行密钥操作失败，请重试或使用 PIN 登录。'
}
