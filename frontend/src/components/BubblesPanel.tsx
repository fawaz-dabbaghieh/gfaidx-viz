import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BUBBLE_HIGHLIGHT_COLORS,
  BUBBLE_TYPE_LABELS,
  type Bubble,
  type BubbleSet,
  type BubbleType,
  bubbleId,
  bubblesToJson,
  bubblesToTsv,
} from '../utils/bubbleGun'

// About 10,000 bubbles for a 30,000-node region, so rows are rendered in
// batches as the list scrolls, like the Paths list.
const BUBBLE_ROWS_PER_BATCH = 100

type SortKey = 'id' | 'nodes' | 'bp' | 'nestedness'

const SORT_VALUES: Record<SortKey, (bubble: Bubble) => number> = {
  id: bubble => bubble.index,
  nodes: bubble => bubble.inside.length,
  bp: bubble => bubble.insideBp,
  nestedness: bubble => bubble.nestedness,
}

const COLUMNS: { key: SortKey | null; label: string; numeric?: boolean }[] = [
  { key: 'id', label: 'ID', numeric: true },
  { key: null, label: 'Type' },
  { key: null, label: 'Ends' },
  { key: 'nodes', label: 'Nodes inside', numeric: true },
  { key: 'bp', label: 'bp inside', numeric: true },
  { key: 'nestedness', label: 'Nestedness', numeric: true },
]

interface BubblesPanelProps {
  bubbles: BubbleSet | null
  graphName: string | null
  isDarkMode: boolean
  highlightedBubble: number | null
  onShowBubble: (bubbleIndex: number) => void
  onDownload: (text: string, filename: string) => void
}

export function BubblesPanel({
  bubbles,
  graphName,
  isDarkMode,
  highlightedBubble,
  onShowBubble,
  onDownload,
}: BubblesPanelProps) {
  const [typeFilter, setTypeFilter] = useState<BubbleType | 'all'>('all')
  // Biggest first by default.
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: 'nodes',
    descending: true,
  })
  const [renderedRowCount, setRenderedRowCount] = useState(
    BUBBLE_ROWS_PER_BATCH,
  )
  const listRef = useRef<HTMLDivElement>(null)
  const moreRowsRef = useRef<HTMLTableRowElement>(null)

  const shownBubbles = useMemo(() => {
    if (!bubbles) return []
    const value = SORT_VALUES[sort.key]
    const direction = sort.descending ? -1 : 1
    return bubbles.bubbles
      .filter(bubble => typeFilter === 'all' || bubble.type === typeFilter)
      .sort(
        (a, b) => direction * (value(a) - value(b)) || a.index - b.index,
      )
  }, [bubbles, sort, typeFilter])
  const hasMoreRows = shownBubbles.length > renderedRowCount

  useEffect(() => {
    setRenderedRowCount(BUBBLE_ROWS_PER_BATCH)
    listRef.current?.scrollTo({ top: 0 })
  }, [shownBubbles])

  // Renders the next batch once the "more" marker scrolls near view.
  useEffect(() => {
    const marker = moreRowsRef.current
    if (!hasMoreRows || !marker) return
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setRenderedRowCount(count => count + BUBBLE_ROWS_PER_BATCH)
        }
      },
      { root: listRef.current, rootMargin: '300px' },
    )
    observer.observe(marker)
    return () => observer.disconnect()
  }, [hasMoreRows, renderedRowCount])

  if (!bubbles || !graphName) {
    return (
      <div className="settings-tab-content">
        <div className="control-hint">
          {graphName
            ? 'Finding bubbles...'
            : 'Bubbles and superbubbles are found as soon as a graph is loaded.'}
        </div>
      </div>
    )
  }

  const baseName = graphName.replace(/\.gfa[12]?(\.gz)?$/i, '')
  const sortBy = (key: SortKey) =>
    setSort(current =>
      current.key === key
        ? { key, descending: !current.descending }
        : { key, descending: key !== 'id' },
    )
  const theme = isDarkMode ? 'dark' : 'light'

  return (
    <div className="settings-tab-content bubbles-panel">
      <div className="bubbles-panel-toolbar">
        <span>
          {bubbles.bubbles.length.toLocaleString()} bubbles:{' '}
          {bubbles.counts.simple.toLocaleString()} simple,{' '}
          {bubbles.counts.super.toLocaleString()} super,{' '}
          {bubbles.counts.insertion.toLocaleString()} insertions
        </span>
        <select
          className="control-input bubbles-panel-filter"
          value={typeFilter}
          onChange={event =>
            setTypeFilter(event.currentTarget.value as BubbleType | 'all')
          }
          aria-label="Bubble type"
        >
          <option value="all">All types</option>
          <option value="simple">Simple bubbles</option>
          <option value="super">Superbubbles</option>
          <option value="insertion">Insertions</option>
        </select>
        <button
          type="button"
          className="bubbles-panel-download"
          onClick={() =>
            onDownload(bubblesToTsv(bubbles, graphName), `${baseName}.bubbles.tsv`)
          }
        >
          Download TSV
        </button>
        <button
          type="button"
          className="bubbles-panel-download"
          onClick={() =>
            onDownload(
              bubblesToJson(bubbles, graphName),
              `${baseName}.bubbles.json`,
            )
          }
        >
          Download JSON
        </button>
      </div>
      <div className="control-hint">
        Click a bubble to highlight it in the graph and zoom to it; click it
        again to remove the highlight. Nestedness is how many bubbles it is
        nested in (0 = top level). Highlighted:{' '}
        <span
          className="bubbles-panel-swatch"
          style={{ background: BUBBLE_HIGHLIGHT_COLORS.end[theme] }}
        />{' '}
        ends,{' '}
        <span
          className="bubbles-panel-swatch"
          style={{ background: BUBBLE_HIGHLIGHT_COLORS.inside[theme] }}
        />{' '}
        inside.
      </div>
      <div className="bubbles-panel-list" ref={listRef}>
        <table>
          <thead>
            <tr>
              {COLUMNS.map(column => (
                <th
                  key={column.label}
                  className={column.numeric ? 'numeric' : undefined}
                  aria-sort={
                    column.key === sort.key
                      ? sort.descending
                        ? 'descending'
                        : 'ascending'
                      : undefined
                  }
                >
                  {column.key ? (
                    <button
                      type="button"
                      onClick={() => sortBy(column.key!)}
                      title={`Sort by ${column.label.toLowerCase()}`}
                    >
                      {column.label}
                      {column.key === sort.key &&
                        (sort.descending ? ' ▼' : ' ▲')}
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shownBubbles.slice(0, renderedRowCount).map(bubble => (
              <tr
                key={bubble.index}
                className={
                  bubble.index === highlightedBubble ? 'highlighted' : undefined
                }
                tabIndex={0}
                onClick={() => onShowBubble(bubble.index)}
                onKeyDown={event => {
                  if (event.key === 'Enter') onShowBubble(bubble.index)
                }}
              >
                <td className="numeric">{bubbleId(bubble)}</td>
                <td>{BUBBLE_TYPE_LABELS[bubble.type]}</td>
                <td className="bubbles-panel-ends">
                  {bubble.source} – {bubble.sink}
                </td>
                <td className="numeric">
                  {bubble.inside.length.toLocaleString()}
                </td>
                <td className="numeric">{bubble.insideBp.toLocaleString()}</td>
                <td className="numeric">{bubble.nestedness}</td>
              </tr>
            ))}
            {hasMoreRows && (
              <tr ref={moreRowsRef}>
                <td colSpan={COLUMNS.length} className="bubbles-panel-more">
                  Loading more bubbles...
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
