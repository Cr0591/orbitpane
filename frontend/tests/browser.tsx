import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useWebSocket, applyRealtimeEvent, applyRealtimeEvents, applySubmittedTask } from '../src/hooks/useWebSocket'
import { MessageList } from '../src/components/MessageList'
import { CommandPalette } from '../src/components/CommandPalette'
import { FileMentionPicker } from '../src/components/FileMentionPicker'
import MarkdownContent from '../src/components/MarkdownContent'
import type { Conversation } from '../src/lib/types'
import '../src/index.css'
import '../src/App.css'

const conversation = { id: 1, name: 'Test', provider: 'fake', path: '/tmp', preferred_model: 'test' } as Conversation
const noop = () => {}
export function Harness() {
  const active = useRef<Conversation | null>(conversation)
  const hook = useWebSocket(active, noop, noop)
  const end = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState('messages')
  const [all, setAll] = useState(false)
  const [focused, setFocused] = useState<number>()
  const [content, setContent] = useState('')
  const [streaming, setStreaming] = useState(true)
  Object.assign(window, { testApi: { hook, active, setMode, setAll, setFocused, setContent, setStreaming,
    applyRealtimeEvent, applyRealtimeEvents, applySubmittedTask } })
  return <>
    <div id="history-error">{hook.historyError}</div>
    <div id="history-loading">{String(hook.isHistoryLoading)}</div>
    {mode === 'messages' && <div className="chat-messages" style={{ height: 600, maxHeight: 600 }}>
      <div className="chat-message-list">
        <MessageList messages={hook.messages} copiedMessageKey={null} isAgentThinking={false} isDrawerSwiping={false}
          copyMessageText={noop} handleFeedback={noop} regenerateLastResponse={noop} formatTimestamp={() => ''}
          messagesEndRef={end} renderAll={all} focusedMessageId={focused} />
      </div>
    </div>}
    {mode === 'search' && <CommandPalette isOpen onClose={noop} onNewWorkspace={noop} onToggleTheme={noop}
      theme="dark" onClearMessages={noop} onExportImage={noop} onSelectConv={noop} conversations={[]}
      showToast={noop} isAgentThinking={false} />}
    {mode === 'markdown' && <MarkdownContent content={content} isStreaming={streaming} enableCodeBlocks />}
    {mode === 'file-error' && <FileMentionPicker items={[]} loading={false} query="file" activeIndex={0}
      workspacePath="/tmp" showingRecent={false} onSelect={noop} error="无法连接后端服务" truncated={false} onRetry={noop} />}
    {mode === 'file-truncated' && <FileMentionPicker items={[]} loading={false} query="file" activeIndex={0}
      workspacePath="/tmp" showingRecent={false} onSelect={noop} error="" truncated onRetry={noop} />}
  </>
}
createRoot(document.getElementById('root')!).render(<Harness />)
