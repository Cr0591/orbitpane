import { useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import { AUTH_EXPIRED_EVENT } from '../lib/auth'
import { bindRunLocalId, ensureLocalId, ensureLocalIds } from '../lib/messageIdentity'
import { asOptionalText, asText, normalizeMessages } from '../lib/normalize'
import { cacheHistory, readCachedHistory, remove } from '../lib/storage'
import { broadcast, emitTaskChange } from '../lib/appEvents'
import type { Conversation, Message, TaskRecord } from '../lib/types'

export interface RealtimeEvent {
  type: string
  conversation_id?: number
  run_id?: string
  sequence?: number
  user_content?: string
  content?: string
  thought?: string
  full_content?: string
  full_thought?: string
  elapsed?: number
  duration?: number
  model?: string
  provider?: string
  code?: string
  /** Verbatim agent output accompanying an `error` event, when there is any. */
  detail?: string
  status?: string
  input_chars?: number
  output_chars?: number
  context_chars?: number
  task?: TaskRecord
  queue?: TaskRecord[]
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function moveResponseAfterPrompt(
  messages: Message[],
  responseIndex: number,
  promptIndex: number,
): number {
  if (responseIndex === promptIndex + 1) return responseIndex
  const [response] = messages.splice(responseIndex, 1)
  if (responseIndex < promptIndex) promptIndex -= 1
  const targetIndex = promptIndex + 1
  messages.splice(targetIndex, 0, response)
  return targetIndex
}

/**
 * Attach the server acknowledgement to the optimistic turn that produced it.
 *
 * A socket can acknowledge several sends after React has already rendered all
 * of them. Picking the last unbound user row swaps run ids in that case, so the
 * eventual replies appear beside the wrong prompts. Acknowledgements arrive in
 * send order; bind the oldest matching optimistic turn instead.
 */
export function applySubmittedTask(messages: Message[], task: TaskRecord): Message[] {
  const next = [...messages]
  let userIndex = next.findIndex(message => (
    message.role === 'user' && message.run_id === task.run_id
  ))

  if (userIndex < 0) {
    const optimisticUserIndexes = next.flatMap((message, index) => (
      message.role === 'user' && message.isOptimistic && !message.run_id
        ? [index]
        : []
    ))
    userIndex = optimisticUserIndexes.find(index => next[index].content === task.prompt)
      ?? optimisticUserIndexes[0]
      ?? -1
    if (userIndex >= 0) {
      const userMessage = next[userIndex]
      next[userIndex] = {
        ...userMessage,
        run_id: task.run_id,
        isOptimistic: false,
      }
      if (userMessage.localId) {
        bindRunLocalId('user', task.run_id, userMessage.localId)
      }
    }
  }

  let agentIndex = next.findIndex(message => (
    message.role === 'agent' && message.run_id === task.run_id
  ))
  if (agentIndex < 0 && userIndex >= 0) {
    const candidateIndex = userIndex + 1
    const candidate = next[candidateIndex]
    if (
      candidate
      && candidate.role === 'agent'
      && !candidate.run_id
      && candidate.isOptimistic
    ) {
      agentIndex = candidateIndex
      next[agentIndex] = {
        ...candidate,
        run_id: task.run_id,
        isOptimistic: false,
      }
      if (candidate.localId) {
        bindRunLocalId('agent', task.run_id, candidate.localId)
      }
    }
  }

  if (agentIndex >= 0) {
    const isQueued = task.status === 'queued'
    const currentAgent = next[agentIndex]
    const hasAlreadyStarted = (
      currentAgent.streamSequence !== undefined && !currentAgent.isQueued
    )
    const keepCurrentState = currentAgent.streamFinished || hasAlreadyStarted
    next[agentIndex] = {
      ...currentAgent,
      isThinking: keepCurrentState ? currentAgent.isThinking : !isQueued,
      isQueued: keepCurrentState ? currentAgent.isQueued : isQueued,
      queuePosition: keepCurrentState
        ? currentAgent.queuePosition
        : (isQueued ? task.position : undefined),
      isOptimistic: false,
    }
  }

  return next
}

function ensureRunAgent(
  messages: Message[],
  event: RealtimeEvent,
): { messages: Message[]; agentIndex: number } {
  const next = [...messages]
  const runId = event.run_id
  const existingAgentIndex = runId
    ? next.findIndex(message => message.role === 'agent' && message.run_id === runId)
    : -1
  let userIndex = runId
    ? next.findIndex(message => message.role === 'user' && message.run_id === runId)
    : -1

  if (runId && userIndex < 0 && typeof event.user_content === 'string') {
    for (let index = 0; index < next.length; index += 1) {
      const message = next[index]
      if (
        message.role === 'user'
        && !message.run_id
        && message.content === event.user_content
      ) {
        userIndex = index
        next[index] = { ...message, run_id: runId, isOptimistic: false }
        // The server's copy of this turn must reuse the key it already has.
        if (message.localId) bindRunLocalId('user', runId, message.localId)
        break
      }
    }
    if (userIndex < 0) {
      const userMessage: Message = ensureLocalId({
        role: 'user',
        content: event.user_content,
        timestamp: new Date().toISOString(),
        provider: event.provider,
        run_id: runId,
      })
      if (existingAgentIndex >= 0) {
        userIndex = existingAgentIndex
        next.splice(existingAgentIndex, 0, userMessage)
      } else {
        userIndex = next.length
        next.push(userMessage)
      }
    }
  }

  let agentIndex = runId
    ? next.findIndex(message => message.role === 'agent' && message.run_id === runId)
    : -1

  if (agentIndex < 0 && runId && userIndex >= 0) {
    const candidateIndex = userIndex + 1
    const candidate = next[candidateIndex]
    if (
      candidate
      && candidate.role === 'agent'
      && !candidate.run_id
      && (candidate.isThinking || candidate.isQueued)
    ) {
      agentIndex = candidateIndex
      next[agentIndex] = {
        ...candidate,
        run_id: runId,
        isOptimistic: false,
      }
      if (candidate.localId) bindRunLocalId('agent', runId, candidate.localId)
    }
  }

  if (agentIndex < 0 && !runId) {
    for (let index = next.length - 1; index >= 0; index -= 1) {
      if (next[index].role === 'agent' && next[index].isThinking) {
        agentIndex = index
        break
      }
    }
  }

  if (agentIndex < 0) {
    const agentMessage = ensureLocalId({
      role: 'agent',
      content: '',
      thought: '',
      isThinking: true,
      isQueued: false,
      elapsedSoFar: isFiniteNumber(event.elapsed) ? event.elapsed : 0,
      model: event.model,
      provider: event.provider,
      run_id: runId,
      streamSequence: -1,
    })
    // A response belongs immediately after its user prompt. Appending it to
    // the whole list puts reconnect/sync replies below turns that were queued
    // later, making those queued prompts look as if they preceded the reply
    // currently being generated.
    agentIndex = userIndex >= 0 ? userIndex + 1 : next.length
    next.splice(agentIndex, 0, agentMessage)
  } else if (userIndex >= 0 && agentIndex !== userIndex + 1) {
    // Repair an already-misordered transient row as soon as another event for
    // that run arrives. This also covers state restored by an older cache.
    agentIndex = moveResponseAfterPrompt(next, agentIndex, userIndex)
  }

  return { messages: next, agentIndex }
}

export function applyRealtimeEvent(messages: Message[], event: RealtimeEvent): Message[] {
  const ensured = ensureRunAgent(messages, event)
  const next = ensured.messages
  const current = next[ensured.agentIndex]
  const currentSequence = current.streamSequence ?? -1
  const incomingSequence = isFiniteNumber(event.sequence)
    ? event.sequence
    : currentSequence + 1
  const elapsed = isFiniteNumber(event.elapsed)
    ? Math.max(current.elapsedSoFar ?? 0, event.elapsed)
    : current.elapsedSoFar
  const common = {
    ...(event.run_id ? { run_id: event.run_id } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(elapsed !== undefined ? { elapsedSoFar: elapsed } : {}),
    isOptimistic: false,
  }

  if (event.type !== 'done' && current.streamFinished) {
    return next
  }

  if (event.type === 'start') {
    if (incomingSequence < currentSequence) return next
    next[ensured.agentIndex] = {
      ...current,
      ...common,
      isThinking: true,
      isQueued: false,
      streamSequence: incomingSequence,
    }
  } else if (event.type === 'sync_state') {
    if (incomingSequence < currentSequence) return next
    next[ensured.agentIndex] = {
      ...current,
      ...common,
      content: asText(event.content),
      thought: asText(event.thought),
      isThinking: true,
      isQueued: false,
      streamSequence: incomingSequence,
    }
  } else if (event.type === 'elapsed') {
    next[ensured.agentIndex] = {
      ...current,
      ...common,
      isThinking: true,
      isQueued: false,
    }
  } else if (event.type === 'thought' || event.type === 'token' || event.type === 'answer') {
    if (incomingSequence <= currentSequence) {
      next[ensured.agentIndex] = { ...current, ...common }
      return next
    }
    const content = asText(event.content)
    next[ensured.agentIndex] = {
      ...current,
      ...common,
      content: asOptionalText(event.full_content) ?? (
        event.type === 'thought' ? current.content : current.content + content
      ),
      thought: asOptionalText(event.full_thought) ?? (
        event.type === 'thought' ? (current.thought ?? '') + content : current.thought
      ),
      isThinking: true,
      streamSequence: incomingSequence,
    }
  } else if (event.type === 'done') {
    const duration = isFiniteNumber(event.duration)
      ? event.duration
      : (isFiniteNumber(event.elapsed) ? event.elapsed : current.elapsedSoFar)
    const hasCurrentNewerContent = incomingSequence < currentSequence
    next[ensured.agentIndex] = {
      ...current,
      ...common,
      content: hasCurrentNewerContent
        ? current.content
        : (asOptionalText(event.content) ?? current.content),
      thought: hasCurrentNewerContent
        ? current.thought
        : (asOptionalText(event.thought) ?? current.thought),
      isThinking: false,
      isQueued: false,
      streamFinished: true,
      streamSequence: Math.max(currentSequence, incomingSequence),
      ...(duration !== undefined
        ? { thinkingDuration: duration, elapsedSoFar: duration }
        : {}),
      input_chars: event.input_chars ?? current.input_chars,
      output_chars: event.output_chars ?? current.output_chars,
      context_chars: event.context_chars ?? current.context_chars,
    }
  }

  return next
}

export function mergeHistoryWithTransientMessages(
  history: Message[],
  current: Message[],
): Message[] {
  // `ensureLocalId` resolves each server row through the run-id bridge, so a
  // turn that streamed in this session keeps the key it streamed under.
  const merged = ensureLocalIds(history).map(message => ({ ...message }))
  const trackedRunIds = new Set(current.flatMap(message => (
    message.run_id
    && (
      message.isThinking
      || message.isQueued
      || message.streamSequence !== undefined
    )
      ? [message.run_id]
      : []
  )))
  const transient = current.filter(message => (
    message.isOptimistic
    || (message.run_id !== undefined && trackedRunIds.has(message.run_id))
    || (message.isThinking && !message.run_id)
    || message.role === 'system'
  ))

  for (const message of transient) {
    let matchingIndex = -1
    if (message.run_id) {
      matchingIndex = merged.findIndex(candidate => (
        candidate.role === message.role && candidate.run_id === message.run_id
      ))
    } else if (message.role === 'user' && message.isOptimistic) {
      for (let index = merged.length - 1; index >= 0; index -= 1) {
        if (merged[index].role === 'user' && merged[index].content === message.content) {
          matchingIndex = index
          break
        }
      }
    }

    if (matchingIndex < 0) {
      merged.push(message)
      continue
    }

    if (message.role === 'agent') {
      merged[matchingIndex] = {
        ...merged[matchingIndex],
        isThinking: false,
        streamFinished: true,
      }
    }
  }

  // A silent history refresh can race the first realtime event and otherwise
  // replay a temporarily misordered array. Keep the turn invariant even when
  // no further token happens to arrive immediately afterward.
  for (const runId of trackedRunIds) {
    const userIndex = merged.findIndex(message => (
      message.role === 'user' && message.run_id === runId
    ))
    const agentIndex = merged.findIndex(message => (
      message.role === 'agent' && message.run_id === runId
    ))
    if (userIndex >= 0 && agentIndex >= 0 && agentIndex !== userIndex + 1) {
      moveResponseAfterPrompt(merged, agentIndex, userIndex)
    }
  }

  return merged
}

export function useWebSocket(
  /**
   * The live conversation, shared with `useConversations` rather than mirrored.
   *
   * A private copy synced from a `useEffect` lagged the state it tracked by a
   * commit, and every guard in here reads it to decide whether a reply still
   * belongs to the open project. Selecting a project assigns the ref and calls
   * `loadHistory` in the same tick, so a mirror could still be pointing at the
   * previous project when the response arrived, and drop a transcript the user
   * was looking at.
   */
  activeConvRef: React.MutableRefObject<Conversation | null>,
  showToast: (msg: string) => void,
  loadConversations: (isInitial?: boolean) => void,
  scrollToBottom: (smooth?: boolean) => void
) {
  const [messages, setMessages] = useState<Message[]>([])
  const [isHistoryLoading, setIsHistoryLoading] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const socketRef = useRef<WebSocket | null>(null)
  const socketConversationIdRef = useRef<number | null>(null)
  const isAgentThinkingRef = useRef<boolean>(false)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastPongRef = useRef(Date.now())
  const reconnectAttemptRef = useRef<number>(0)
  const historyRequestRef = useRef(0)
  /**
   * How many history loads are in flight.
   *
   * The skeleton comes down when this reaches zero, rather than on the success
   * path of one particular request. A reply that lost its race used to return
   * early with the flag still raised, and the request that supersedes it is
   * usually a silent background refresh that never lowers it — so a cold start
   * whose first load raced the socket's own `ready` refresh kept its skeleton
   * up until the user switched projects.
   */
  const historyInFlightRef = useRef(0)
  /**
   * Stream events waiting to be folded into `messages`, with the conversation
   * each one belongs to.
   *
   * An agent emits tokens far faster than a screen refreshes, and every one of
   * them used to commit its own render of the whole transcript. On a long
   * conversation that is where the stutter came from: the work is proportional
   * to the messages already on screen, not to the token that arrived. Folding a
   * frame's worth of events into a single update makes the cost of streaming
   * independent of how fast the agent is talking, and no update is ever skipped
   * — they are applied in order, just together.
   */
  const streamBufferRef = useRef<Array<{ conversationId: number; event: RealtimeEvent }>>([])
  const streamFrameRef = useRef<number | null>(null)
  const pendingSendMessagesRef = useRef(new Map<
    number,
    Array<{ content: string; model: string; provider: string }>
  >())

  const isAgentThinking = messages.some(message => (
    message.role === 'agent' && message.isThinking
  ))
  useEffect(() => {
    isAgentThinkingRef.current = isAgentThinking
  }, [isAgentThinking])

  const clearStreamBuffer = useCallback(() => {
    streamBufferRef.current = []
    if (streamFrameRef.current !== null) {
      cancelAnimationFrame(streamFrameRef.current)
      streamFrameRef.current = null
    }
  }, [])

  const flushStreamBuffer = useCallback(() => {
    if (streamFrameRef.current !== null) {
      cancelAnimationFrame(streamFrameRef.current)
      streamFrameRef.current = null
    }
    const queued = streamBufferRef.current
    if (queued.length === 0) return
    streamBufferRef.current = []
    setMessages(previous => {
      const conversationId = activeConvRef.current?.id
      let next = previous
      for (const entry of queued) {
        // Re-checked here rather than on arrival: the reader can move to
        // another project between an event being queued and the frame landing.
        if (entry.conversationId !== conversationId) continue
        next = applyRealtimeEvent(next, entry.event)
      }
      if (next === previous) return previous
      isAgentThinkingRef.current = next.some(message => (
        message.role === 'agent' && message.isThinking
      ))
      return next
    })
  }, [activeConvRef])

  const queueStreamEvent = useCallback((conversationId: number, event: RealtimeEvent) => {
    streamBufferRef.current.push({ conversationId, event })
    if (streamFrameRef.current === null) {
      streamFrameRef.current = requestAnimationFrame(() => {
        streamFrameRef.current = null
        flushStreamBuffer()
      })
    }
  }, [flushStreamBuffer])

  useEffect(() => clearStreamBuffer, [clearStreamBuffer])

  const disconnectCurrentSocket = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current)
      heartbeatTimerRef.current = null
    }
    clearStreamBuffer()
    const currentSocket = socketRef.current
    socketRef.current = null
    socketConversationIdRef.current = null
    if (currentSocket) {
      currentSocket.onopen = null
      currentSocket.onmessage = null
      currentSocket.onerror = null
      currentSocket.onclose = null
      try { currentSocket.close() } catch {}
    }
    setIsConnected(false)
    setIsReconnecting(false)
  }, [clearStreamBuffer])

  const loadHistory = useCallback((convId: number, silent = false) => {
    if (!silent) setIsHistoryLoading(true)
    const requestId = ++historyRequestRef.current
    historyInFlightRef.current += 1
    const settle = () => {
      historyInFlightRef.current -= 1
      if (historyInFlightRef.current === 0) setIsHistoryLoading(false)
    }
    /** Whether this reply still describes what the reader is looking at. */
    const isCurrent = () => (
      requestId === historyRequestRef.current
      && activeConvRef.current?.id === convId
    )
    return apiFetch<Message[]>(`/api/history/${convId}`)
      .then(data => {
        settle()
        if (!isCurrent()) return null
        // Normalized before it is cached, so a bad row cannot be replayed from
        // localStorage on every later load either.
        const history = normalizeMessages(data)
        cacheHistory(convId, history)
        let finalMerged: Message[] = []
        setMessages(current => {
          const merged = mergeHistoryWithTransientMessages(history, current)
          isAgentThinkingRef.current = merged.some(message => (
            message.role === 'agent' && message.isThinking
          ))
          finalMerged = merged
          return merged
        })
        setTimeout(() => scrollToBottom(false), 100)
        return finalMerged
      })
      .catch(err => {
        console.error(err)
        settle()
        if (isCurrent()) {
          const cached = normalizeMessages(readCachedHistory<unknown>(convId, []))
          setMessages(current => {
            const merged = mergeHistoryWithTransientMessages(cached, current)
            isAgentThinkingRef.current = merged.some(message => (
              message.role === 'agent' && message.isThinking
            ))
            return merged
          })
        }
        return null
      })
  }, [activeConvRef, scrollToBottom])

  const connectWebSocket = useCallback((conv: Conversation, isManual = false) => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    const currentSocket = socketRef.current
    const isCurrentConversation = socketConversationIdRef.current === conv.id
    if (
      currentSocket
      && isCurrentConversation
      && !isManual
      && (
        currentSocket.readyState === WebSocket.OPEN
        || currentSocket.readyState === WebSocket.CONNECTING
      )
    ) {
      if (currentSocket.readyState === WebSocket.OPEN) {
        setIsConnected(true)
        setIsReconnecting(false)
      }
      return
    }

    disconnectCurrentSocket()
    setIsReconnecting(true)
    if (isManual) showToast('正在尝试连接 AI 后台 agent...')

    const loc = window.location
    const wsProtocol = loc.protocol === 'https:' ? 'wss:' : 'ws:'
    let ws: WebSocket
    try {
      ws = new WebSocket(`${wsProtocol}//${loc.host}/api/chat`)
    } catch (err) {
      console.error('WS construction error:', err)
      setIsReconnecting(false)
      return
    }

    socketRef.current = ws
    socketConversationIdRef.current = conv.id
    let awaitingPendingStart = false

    const belongsToActiveConversation = () => (
      socketRef.current === ws
      && socketConversationIdRef.current === conv.id
      && activeConvRef.current?.id === conv.id
    )

    ws.onopen = () => {
      if (!belongsToActiveConversation()) return
      setIsConnected(true)
      setIsReconnecting(false)
      reconnectAttemptRef.current = 0
      lastPongRef.current = Date.now()
      if (isManual) showToast('已成功连接后台 AI agent')
      ws.send(JSON.stringify({ conversation_id: conv.id }))

      const pending = pendingSendMessagesRef.current.get(conv.id) || []
      if (pending.length > 0) {
        awaitingPendingStart = true
        pendingSendMessagesRef.current.delete(conv.id)
        pending.forEach(message => ws.send(JSON.stringify(message)))
      }

      heartbeatTimerRef.current = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return
        if (Date.now() - lastPongRef.current > 45_000) {
          ws.close(4000, 'heartbeat timeout')
          return
        }
        ws.send(JSON.stringify({ action: 'ping' }))
      }, 20_000)
    }

    ws.onmessage = event => {
      if (!belongsToActiveConversation()) return
      try {
        const data = JSON.parse(event.data) as RealtimeEvent
        if (
          isFiniteNumber(data.conversation_id)
          && data.conversation_id !== conv.id
        ) return

        if (data.type === 'pong') {
          lastPongRef.current = Date.now()
          return
        }

        if (data.type === 'submitted' && data.task) {
          const task = data.task
          setMessages(previous => applySubmittedTask(previous, task))
          emitTaskChange()
          return
        }

        if (data.type === 'queue_changed') {
          const positions = new Map((data.queue || []).map(task => [task.run_id, task.position]))
          setMessages(previous => previous.map(message => {
            if (!message.run_id || !message.isQueued) return message
            const position = positions.get(message.run_id)
            return position
              ? { ...message, queuePosition: position }
              : {
                  ...message,
                  isQueued: false,
                  queuePosition: undefined,
                  // Leaving the queue normally means this run is starting.
                  // Marking it finished here made the following `start` and
                  // token events get discarded as stale.
                  streamFinished: false,
                }
          }))
          emitTaskChange()
          return
        }

        if (data.type === 'history_cleared') {
          // The server dropped messages, summaries and the whole queue, so no
          // transient turn may survive here either — including tokens still
          // sitting in the frame buffer.
          clearStreamBuffer()
          historyRequestRef.current += 1
          isAgentThinkingRef.current = false
          awaitingPendingStart = false
          pendingSendMessagesRef.current.delete(conv.id)
          remove(`orbitpane_history_${conv.id}`)
          setMessages([])
          emitTaskChange()
          return
        }

        if (data.type === 'ready') {
          if (!awaitingPendingStart) {
            isAgentThinkingRef.current = false
            setMessages(previous => previous.map(message => (
              message.isThinking
                ? { ...message, isThinking: false, streamFinished: true }
                : message
            )))
          }
          loadHistory(conv.id, true)
          return
        }

        if (
          data.type === 'start'
          || data.type === 'sync_state'
          || data.type === 'elapsed'
          || data.type === 'thought'
          || data.type === 'token'
          || data.type === 'answer'
          || data.type === 'done'
        ) {
          if (data.type === 'start') awaitingPendingStart = false
          queueStreamEvent(conv.id, data)
          // A turn beginning or ending changes what the whole screen shows —
          // the thinking indicator, the toolbar, the composer — so it lands
          // now rather than on the next frame. Draining the buffer through the
          // same path keeps every event in the order it arrived.
          if (
            data.type === 'start'
            || data.type === 'sync_state'
            || data.type === 'done'
          ) {
            flushStreamBuffer()
          }
          if (data.type === 'done') {
            loadConversations(false)
            loadHistory(conv.id, true)
            emitTaskChange()
            if (
              document.visibilityState !== 'visible'
              && typeof Notification !== 'undefined'
              && Notification.permission === 'granted'
            ) {
              const notification = new Notification(`${conv.name} · 任务已完成`, {
                body: data.status === 'failed'
                  ? 'Agent 执行失败，点击查看详情'
                  : `已生成 ${data.output_chars ?? 0} 个字符的结果`,
                icon: '/pwa-192x192.png',
                tag: `orbitpane-${data.run_id || conv.id}`,
              })
              notification.onclick = () => {
                window.focus()
                const url = new URL(window.location.href)
                url.searchParams.set('id', String(conv.id))
                window.location.href = url.toString()
              }
            }
            broadcast({ type: 'task-done', conversationId: conv.id })
          }
          return
        }

        if (data.type === 'error') {
          if (data.code === 'unauthorized') {
            window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
            return
          }
          const requestRejected = (
            data.code === 'busy'
            || data.code === 'invalid_request'
            || data.code === 'not_found'
          )
          if (requestRejected) awaitingPendingStart = false
          setMessages(previous => {
            if (activeConvRef.current?.id !== conv.id) return previous
            const next = requestRejected
              ? previous.filter(message => !message.isOptimistic)
              : [...previous]
            next.push({
              role: 'system',
              content: asText(data.content) || '未知错误',
              errorCode: asText(data.code) || 'provider_error',
              errorDetail: asText(data.detail),
              isError: true,
            })
            if (requestRejected) {
              isAgentThinkingRef.current = next.some(message => (
                message.role === 'agent' && message.isThinking
              ))
            }
            return next
          })
        }
      } catch (err) {
        console.error('WS message parse error:', err)
      }
    }

    ws.onerror = err => {
      if (socketRef.current === ws) console.error('WS error:', err)
    }

    ws.onclose = event => {
      if (
        socketRef.current !== ws
        || socketConversationIdRef.current !== conv.id
      ) return
      socketRef.current = null
      socketConversationIdRef.current = null
      setIsConnected(false)
      setIsReconnecting(false)
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current)
        heartbeatTimerRef.current = null
      }

      if (activeConvRef.current?.id !== conv.id) return
      const attempt = reconnectAttemptRef.current
      reconnectAttemptRef.current = attempt + 1
      const delay = Math.min(1000 * Math.pow(1.5, Math.min(attempt, 6)), 10000)
      console.log(`[WS] Disconnected (code ${event.code}). Auto-reconnecting in ${Math.round(delay)}ms (attempt ${attempt + 1})`)
      reconnectTimerRef.current = setTimeout(() => {
        if (!socketRef.current && activeConvRef.current?.id === conv.id) {
          connectWebSocket(activeConvRef.current, false)
        }
      }, delay)
    }
  }, [
    activeConvRef,
    clearStreamBuffer,
    disconnectCurrentSocket,
    flushStreamBuffer,
    loadConversations,
    loadHistory,
    queueStreamEvent,
    showToast,
  ])

  return {
    messages,
    setMessages,
    isHistoryLoading,
    isConnected,
    isReconnecting,
    socketRef,
    socketConversationIdRef,
    isAgentThinking,
    isAgentThinkingRef,
    pendingSendMessagesRef,
    historyRequestRef,
    loadHistory,
    connectWebSocket,
    disconnectCurrentSocket,
  }
}
