import { useRef } from 'react'
import type { GraphNode } from '../types'
import type { EdgePathGroup } from '../utils/displayGraph'

export type SelectionInfo =
  | {
      kind: 'node'
      node: GraphNode
      sequencePreview: string | null
      csvMetadata?: Record<string, string>
      paths: { name: string; count: number }[]
    }
  | {
      kind: 'edge'
      fromName: string
      toName: string
      groups: EdgePathGroup[]
      totalPathCount: number
      visiblePathCount: number
    }

// Exported so App can size the canvas to the space the panel leaves. The gap
// between canvas and panel doubles as the drag handle for resizing it.
export const SELECTION_INFO_PANEL_DEFAULT_WIDTH = 280
export const SELECTION_INFO_PANEL_MIN_WIDTH = 200
export const SELECTION_INFO_PANEL_GAP = 12

interface SelectionInfoPanelProps {
  selection: SelectionInfo | null
  width: number
  maxWidth: number
  onWidthChange?: (width: number) => void
  height: number
  getPathColor: (pathName: string) => string
  isPathVisible: (pathName: string) => boolean
  onUseAsStartNode?: (nodeName: string) => void
}

// One row per path; the "(N×)" suffix only appears for paths that cross the
// edge / visit the node more than once, e.g. through a collapsed repeat.
function PathRow({
  name,
  count,
  color,
  visible,
}: {
  name: string
  count: number
  color: string
  visible: boolean
}) {
  return (
    <div className={`selection-path-row${visible ? '' : ' dimmed'}`}>
      <span className="selection-path-swatch" style={{ background: color }} />
      <span className="selection-path-name" title={name}>
        {name}
      </span>
      {count > 1 && <span className="selection-path-count">({count}×)</span>}
    </div>
  )
}

export function SelectionInfoPanel({
  selection,
  width,
  maxWidth,
  onWidthChange,
  height,
  getPathColor,
  isPathVisible,
  onUseAsStartNode,
}: SelectionInfoPanelProps) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  // The panel sits right of the canvas, so dragging the handle left widens it.
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || !onWidthChange) return
    const nextWidth = drag.startWidth + drag.startX - event.clientX
    onWidthChange(
      Math.round(
        Math.min(maxWidth, Math.max(SELECTION_INFO_PANEL_MIN_WIDTH, nextWidth)),
      ),
    )
  }

  const endDrag = () => {
    dragRef.current = null
  }

  return (
    <>
      <div
        className="selection-info-resizer"
        style={{ width: SELECTION_INFO_PANEL_GAP, height }}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize info panel"
        title="Drag to resize, double-click to reset"
        onPointerDown={event => {
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          dragRef.current = { startX: event.clientX, startWidth: width }
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() =>
          onWidthChange?.(
            Math.min(maxWidth, SELECTION_INFO_PANEL_DEFAULT_WIDTH),
          )
        }
      />
      <aside className="selection-info-panel" style={{ width, height }}>
        {!selection && (
          <div className="selection-info-empty">
            Click a node or connection to see its details here.
          </div>
        )}

        {selection?.kind === 'node' && (
          <>
            <h4 title={selection.node.name}>{selection.node.name}</h4>
            <dl className="selection-info-fields">
              <dt>Length</dt>
              <dd>{selection.node.length.toLocaleString()} bp</dd>
              <dt>Depth</dt>
              <dd>{selection.node.depth.toFixed(2)}×</dd>
              <dt>Sequence</dt>
              <dd className="selection-info-mono">
                {selection.sequencePreview ?? 'Not available'}
              </dd>
              {Object.entries(selection.node.tags ?? {}).map(([tag, value]) => (
                <SelectionField key={`tag:${tag}`} label={tag} value={value} />
              ))}
              {Object.entries(selection.csvMetadata ?? {}).map(
                ([column, value]) => (
                  <SelectionField
                    key={`csv:${column}`}
                    label={column}
                    value={value}
                  />
                ),
              )}
            </dl>
            {onUseAsStartNode && (
              <button
                type="button"
                className="selection-info-action"
                onClick={() => onUseAsStartNode(selection.node.name)}
              >
                Use as Start Node
              </button>
            )}
            {selection.paths.length > 0 && (
              <div className="selection-info-section">
                <h5>Paths ({selection.paths.length})</h5>
                {selection.paths.map(path => (
                  <PathRow
                    key={path.name}
                    name={path.name}
                    count={path.count}
                    color={getPathColor(path.name)}
                    visible={isPathVisible(path.name)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {selection?.kind === 'edge' && (
          <>
            <h4>Connection</h4>
            <div className="selection-info-subtitle">
              {selection.fromName} — {selection.toName}
            </div>
            {selection.totalPathCount > 0 && (
              <div className="selection-info-section">
                <h5>
                  Paths ({selection.visiblePathCount} visible /{' '}
                  {selection.totalPathCount} total)
                </h5>
                {selection.groups.map(group => (
                  <div
                    key={`${group.from}->${group.to}`}
                    className="selection-info-direction"
                  >
                    <div className="selection-info-direction-title">
                      {group.from} → {group.to}
                    </div>
                    {group.paths.map(path => (
                      <PathRow
                        key={path.name}
                        name={path.name}
                        count={path.count}
                        color={getPathColor(path.name)}
                        visible={isPathVisible(path.name)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </aside>
    </>
  )
}

function SelectionField({
  label,
  value,
}: {
  label: string
  value: string | number
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}
