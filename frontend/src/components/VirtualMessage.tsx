import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/** Keep only nearby message contents mounted, retaining measured row heights. */
export function VirtualMessage({ children, initialVisible, forceVisible, messageId }: {
  children: ReactNode
  initialVisible: boolean
  forceVisible: boolean
  messageId?: number
}) {
  const elementRef = useRef<HTMLDivElement>(null)
  const heightRef = useRef(220)
  const [visible, setVisible] = useState(initialVisible)
  const mounted = visible || forceVisible

  useLayoutEffect(() => {
    const element = elementRef.current
    const root = element?.closest('.chat-messages')
    if (!element || !root) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root, rootMargin: '1000px 0px',
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element || !mounted) return
    const measure = () => {
      const height = element.getBoundingClientRect().height
      if (height > 0) heightRef.current = height
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [mounted])

  return (
    <div ref={elementRef} className="virtual-message" data-virtual-message-id={messageId}
      style={mounted ? undefined : { height: heightRef.current }}>
      {mounted ? children : null}
    </div>
  )
}
