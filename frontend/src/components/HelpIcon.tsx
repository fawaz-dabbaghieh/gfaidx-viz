import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface HelpIconProps {
  text: string
}

interface TooltipPosition {
  top: number
  left: number
}

// A small "(?)" affordance for options whose effect isn't obvious from their
// label alone. Deliberately its own visible icon rather than a bare `title`
// attribute on the label: a plain title isn't discoverable - nothing on
// screen signals that hovering it does anything.
//
// The tooltip itself is portaled to document.body and positioned from the
// icon's live bounding rect rather than pinned via CSS position:absolute,
// because call sites can sit inside panels that clip or scroll their
// overflow - a CSS-anchored tooltip would get cut off there.
const VIEWPORT_MARGIN = 8

export function HelpIcon({ text }: HelpIconProps) {
  const iconRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLSpanElement>(null)
  const [position, setPosition] = useState<TooltipPosition | null>(null)
  // The tooltip's own width isn't known until it's actually in the DOM (it
  // depends on the text), so it first renders hidden at the icon-centered
  // position, gets measured, and only becomes visible once nudged back
  // inside the viewport - otherwise a help icon near the left/right edge of
  // the window produced a tooltip that ran off-screen and was unreadable.
  const [visible, setVisible] = useState(false)

  const show = () => {
    const rect = iconRef.current?.getBoundingClientRect()
    if (!rect) return
    setVisible(false)
    setPosition({ top: rect.top - 6, left: rect.left + rect.width / 2 })
  }
  const hide = () => {
    setPosition(null)
    setVisible(false)
  }

  useLayoutEffect(() => {
    if (!position || visible) return
    const tooltip = tooltipRef.current
    if (!tooltip) return

    const rect = tooltip.getBoundingClientRect()
    const halfWidth = rect.width / 2
    let left = position.left
    if (left - halfWidth < VIEWPORT_MARGIN) {
      left = halfWidth + VIEWPORT_MARGIN
    } else if (left + halfWidth > window.innerWidth - VIEWPORT_MARGIN) {
      left = window.innerWidth - VIEWPORT_MARGIN - halfWidth
    }
    const top = Math.max(position.top, rect.height + VIEWPORT_MARGIN)

    if (left !== position.left || top !== position.top) {
      setPosition({ top, left })
    }
    setVisible(true)
  }, [position, visible])

  return (
    <span
      ref={iconRef}
      className="help-icon"
      tabIndex={0}
      aria-label={text}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={event => {
        // Several call sites live inside a <label> wrapping a checkbox or
        // referencing an input via htmlFor - without this, clicking the icon
        // itself would forward the click to that control (e.g. toggling the
        // checkbox) instead of just being a no-op informational click.
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      ?
      {position &&
        createPortal(
          <span
            ref={tooltipRef}
            className="help-icon-tooltip"
            role="tooltip"
            style={{
              top: position.top,
              left: position.left,
              visibility: visible ? 'visible' : 'hidden',
            }}
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  )
}
