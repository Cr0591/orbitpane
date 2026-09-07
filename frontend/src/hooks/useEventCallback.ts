import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * A handler with a stable identity that always sees the current render's state.
 *
 * `MessageRow` is memoised, but memoisation is only worth anything when every
 * prop holds its identity: one handler rebuilt on each render re-rendered the
 * entire transcript on every streamed token, re-parsing each message's markdown
 * and re-highlighting each code block, which is what made a long conversation
 * stutter while an answer came in.
 *
 * Such a handler is an event rather than a reactive value — it reads what is
 * true at the moment it fires, not at the moment it was created — so listing
 * the state it touches as a dependency is exactly the wrong contract. This is
 * the established pattern for that shape, and is what React's own
 * `useEffectEvent` will replace once it ships.
 */
export function useEventCallback<Args extends unknown[], Result>(
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  const handlerRef = useRef(handler)
  // Layout phase rather than passive, so the handler is already current for
  // anything that can run between the commit and the next paint.
  useLayoutEffect(() => {
    handlerRef.current = handler
  })
  return useCallback((...args: Args) => handlerRef.current(...args), [])
}
