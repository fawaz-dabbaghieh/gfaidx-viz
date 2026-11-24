import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GraphPath } from '../types'
import { HelpIcon } from './HelpIcon'

interface PathsLegendProps {
  paths: GraphPath[]
  isDarkMode?: boolean
  selectedPathNames: string[]
  onTogglePath: (pathName: string) => void
  onSelectAll: () => void
  onDeselectAll: () => void
  filterToSelectedPaths: boolean
  onFilterToSelectedPathsChange: (enabled: boolean) => void
  onColorPathNodes: (pathName: string, color: string) => number
  onClearNodeColors: () => void
  // Feature C: which paths currently have a copy-number track drawn under
  // the ruler, and the toggle for it - independent of path selection/
  // coloring above, since a path's CN track is useful on its own.
  copyNumberPathNames: string[]
  onToggleCopyNumberPath: (pathName: string) => void
  // Linear layout + a reference path must be active for the track to mean
  // anything (it's drawn relative to the ruler's bp coordinate space) - the
  // toggle button stays visible but disabled otherwise, rather than hidden,
  // so it's discoverable.
  hasCopyNumberTrack: boolean
}

interface ColorFeedback {
  pathName: string
  message: string
  isError?: boolean
}

const COLOR_PRESETS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa']

// A region query can return thousands of (sub)paths at ~15 elements per row,
// so rows are rendered in batches as the list is scrolled rather than all at
// once - opening the list then costs the same however many paths there are.
const PATH_ROWS_PER_BATCH = 100

function normalizeHexColorInput(color: string): string | null {
  const trimmedColor = color.trim()
  const normalizedColor = trimmedColor.startsWith('#')
    ? trimmedColor
    : `#${trimmedColor}`

  return /^#[0-9a-fA-F]{6}$/.test(normalizedColor)
    ? normalizedColor
    : null
}

function formatWalkCoordinate(coordinate: string): string {
  const numericCoordinate = Number(coordinate)
  return coordinate !== '' && Number.isSafeInteger(numericCoordinate)
    ? numericCoordinate.toLocaleString()
    : coordinate || 'unknown'
}

interface PathListRowProps {
  path: GraphPath
  color: string
  isDarkMode: boolean
  isSelected: boolean
  hasCopyNumber: boolean
  hasCopyNumberTrack: boolean
  isColorPanelOpen: boolean
  // Only passed to the row whose color panel is open / that the feedback is
  // about, so typing a color or applying one doesn't re-render every row.
  nodeColorInput: string
  colorFeedback: ColorFeedback | null
  onTogglePath: (pathName: string) => void
  onToggleColorPanel: (pathName: string) => void
  onToggleCopyNumberPath: (pathName: string) => void
  onNodeColorInputChange: (color: string) => void
  onApplyNodeColor: (pathName: string, color: string) => void
}

// Memoized, so ticking one path re-renders that row only.
const PathListRow = memo(function PathListRow({
  path,
  color,
  isDarkMode,
  isSelected,
  hasCopyNumber,
  hasCopyNumberTrack,
  isColorPanelOpen,
  nodeColorInput,
  colorFeedback,
  onTogglePath,
  onToggleColorPanel,
  onToggleCopyNumberPath,
  onNodeColorInputChange,
  onApplyNodeColor,
}: PathListRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        fontSize: '12px',
        opacity: isSelected ? 1 : 0.8,
      }}
    >
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onTogglePath(path.name)}
        />
        <div
          style={{
            width: '30px',
            height: '3px',
            backgroundColor: color,
            borderRadius: '2px',
            flexShrink: 0,
          }}
        />
        <span
          title={path.name}
          style={{
            color: isDarkMode ? '#ccc' : '#555',
            minWidth: 0,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {path.name}
        </span>
        <span
          style={{
            color: isDarkMode ? '#888' : '#999',
            fontSize: '11px',
            marginLeft: 'auto',
            flexShrink: 0,
          }}
        >
          {path.nodeIds.length} nodes
        </span>
        <button
          type="button"
          onClick={event => {
            event.preventDefault()
            onToggleColorPanel(path.name)
          }}
          title="Color nodes in this path"
          style={{
            padding: '3px 7px',
            borderRadius: '4px',
            border: isDarkMode ? '1px solid #555' : '1px solid #ccc',
            background: isDarkMode ? '#3a3a3a' : '#fff',
            color: isDarkMode ? '#e0e0e0' : '#333',
            cursor: 'pointer',
            fontSize: '11px',
            flexShrink: 0,
          }}
        >
          Color
        </button>
        <button
          type="button"
          onClick={event => {
            event.preventDefault()
            onToggleCopyNumberPath(path.name)
          }}
          disabled={!hasCopyNumberTrack}
          title={
            hasCopyNumberTrack
              ? 'Show/hide a copy-number track for this path under the ruler'
              : 'Enable Linear Layout with a reference path first'
          }
          style={{
            padding: '3px 7px',
            borderRadius: '4px',
            border: hasCopyNumber
              ? `1px solid ${color}`
              : isDarkMode
                ? '1px solid #555'
                : '1px solid #ccc',
            background: hasCopyNumber
              ? color
              : isDarkMode
                ? '#3a3a3a'
                : '#fff',
            color: hasCopyNumber
              ? '#fff'
              : isDarkMode
                ? '#e0e0e0'
                : '#333',
            cursor: hasCopyNumberTrack ? 'pointer' : 'not-allowed',
            opacity: hasCopyNumberTrack ? 1 : 0.5,
            fontSize: '11px',
            flexShrink: 0,
          }}
        >
          Copy #
        </button>
      </label>
      {path.walk && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            columnGap: '10px',
            rowGap: '4px',
            paddingLeft: '22px',
            color: isDarkMode ? '#aaa' : '#666',
            fontSize: '11px',
            flexWrap: 'wrap',
          }}
        >
          <strong style={{ color: isDarkMode ? '#ddd' : '#444' }}>
            {path.recordType === 'P' ? 'P' : 'W'}
          </strong>
          <span>Sample: {path.walk.sampleName}</span>
          <span>Haplotype: {path.walk.haplotypeIndex}</span>
          <span>Sequence: {path.walk.sequenceName}</span>
          <span>
            Coordinates:{' '}
            {formatWalkCoordinate(path.walk.sequenceStart)}
            {' - '}
            {formatWalkCoordinate(path.walk.sequenceEnd)}
          </span>
          {path.walk.tags.length > 0 && (
            <span
              title={path.walk.tags.join('\t')}
              style={{ overflowWrap: 'anywhere' }}
            >
              Tags: {path.walk.tags.join(', ')}
            </span>
          )}
        </div>
      )}
      {isColorPanelOpen && (
        <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          paddingLeft: '22px',
          flexWrap: 'wrap',
        }}
        >
          {COLOR_PRESETS.map(preset => (
            <button
              key={preset}
              type="button"
              aria-label={`Color nodes ${preset}`}
              onClick={() => {
                onApplyNodeColor(path.name, preset)
              }}
              style={{
                width: '20px',
                height: '20px',
                borderRadius: '4px',
                border: isDarkMode ? '1px solid #777' : '1px solid #aaa',
                background: preset,
                cursor: 'pointer',
              }}
            />
          ))}
          <input
            type="text"
            value={nodeColorInput}
            onChange={event => onNodeColorInputChange(event.currentTarget.value)}
            style={{
              width: '82px',
              boxSizing: 'border-box',
              padding: '4px 6px',
              borderRadius: '4px',
              border: isDarkMode ? '1px solid #555' : '1px solid #ccc',
              background: isDarkMode ? '#1f1f1f' : '#fff',
              color: isDarkMode ? '#e0e0e0' : '#333',
              fontSize: '12px',
            }}
          />
          <button
            type="button"
            onClick={() => onApplyNodeColor(path.name, nodeColorInput)}
            style={{
              padding: '4px 8px',
              borderRadius: '4px',
              border: isDarkMode ? '1px solid #555' : '1px solid #ccc',
              background: isDarkMode ? '#3a3a3a' : '#fff',
              color: isDarkMode ? '#e0e0e0' : '#333',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            Apply
          </button>
          {colorFeedback && (
            <span
              style={{
                color: colorFeedback.isError
                  ? '#ef5350'
                  : isDarkMode
                    ? '#aaa'
                    : '#666',
                fontSize: '11px',
              }}
            >
              {colorFeedback.message}
            </span>
          )}
        </div>
      )}
    </div>
  )
})

// Memoized (with stable callbacks from App), so App updates unrelated to
// paths - e.g. switching control tabs - don't re-render the whole list.
export const PathsLegend = memo(function PathsLegend({
  paths,
  isDarkMode = true,
  selectedPathNames,
  onTogglePath,
  onSelectAll,
  onDeselectAll,
  filterToSelectedPaths,
  onFilterToSelectedPathsChange,
  onColorPathNodes,
  onClearNodeColors,
  copyNumberPathNames,
  onToggleCopyNumberPath,
  hasCopyNumberTrack,
}: PathsLegendProps) {
  const copyNumberPathNameSet = useMemo(
    () => new Set(copyNumberPathNames),
    [copyNumberPathNames],
  )
  const [searchQuery, setSearchQuery] = useState('')
  const [renderedRowCount, setRenderedRowCount] = useState(PATH_ROWS_PER_BATCH)
  const listRef = useRef<HTMLDivElement>(null)
  const moreRowsRef = useRef<HTMLDivElement>(null)
  const [activeColorPathName, setActiveColorPathName] = useState<string | null>(
    null,
  )
  const [nodeColorInput, setNodeColorInput] = useState('#e53935')
  const [colorFeedback, setColorFeedback] = useState<ColorFeedback | null>(null)

  // Generate colors matching GraphCanvas, keyed by name so each path keeps
  // its color when the list is filtered.
  const pathColors = useMemo(() => {
    const hueStep = 360 / paths.length
    return new Map(
      paths.map((path, idx) => [path.name, `hsl(${idx * hueStep}, 70%, 50%)`]),
    )
  }, [paths])
  const selectedPathNameSet = useMemo(
    () => new Set(selectedPathNames),
    [selectedPathNames],
  )
  // Search narrows the list in the panel only; selection state still lives in
  // App so filtering the list never clears an existing selection.
  const filteredPaths = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase()
    if (!normalizedQuery) {
      return paths
    }

    return paths.filter(path => {
      const searchableValues = [
        path.name,
        path.walk?.sampleName,
        path.walk?.haplotypeIndex,
        path.walk?.sequenceName,
        path.walk?.sequenceStart,
        path.walk?.sequenceEnd,
        ...(path.walk?.tags ?? []),
      ]

      return searchableValues.some(value =>
        value?.toLowerCase().includes(normalizedQuery),
      )
    })
  }, [paths, searchQuery])
  const hasMoreRows = filteredPaths.length > renderedRowCount

  useEffect(() => {
    setRenderedRowCount(PATH_ROWS_PER_BATCH)
  }, [paths])

  // Renders the next batch once the "more" marker at the end of the list
  // scrolls into (or near) view. Observing again after each batch also
  // catches a marker that's still in view, e.g. after a fast scroll.
  useEffect(() => {
    const marker = moreRowsRef.current
    if (!hasMoreRows || !marker) return
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setRenderedRowCount(count => count + PATH_ROWS_PER_BATCH)
        }
      },
      { root: listRef.current, rootMargin: '300px' },
    )
    observer.observe(marker)
    return () => observer.disconnect()
  }, [hasMoreRows, renderedRowCount])

  const applyNodeColor = useCallback(
    (pathName: string, color: string) => {
      const normalizedColor = normalizeHexColorInput(color)
      if (!normalizedColor) {
        setColorFeedback({
          pathName,
          message: 'Enter a 6-digit hex color.',
          isError: true,
        })
        return
      }

      setNodeColorInput(normalizedColor)
      const coloredNodeCount = onColorPathNodes(pathName, normalizedColor)
      setColorFeedback({
        pathName,
        message:
          coloredNodeCount === 0
            ? 'No matching displayed nodes found.'
            : `Colored ${coloredNodeCount.toLocaleString()} displayed node${coloredNodeCount === 1 ? '' : 's'}.`,
        isError: coloredNodeCount === 0,
      })
    },
    [onColorPathNodes],
  )

  const toggleColorPanel = useCallback((pathName: string) => {
    setActiveColorPathName(current => (current === pathName ? null : pathName))
  }, [])

  return (
    <div
      style={{
        background: isDarkMode ? '#2a2a2a' : '#f5f5f5',
        border: isDarkMode ? '1px solid #444' : '1px solid #ddd',
        borderRadius: '8px',
        padding: '12px',
        marginTop: '10px',
      }}
    >
      <div
        style={{
          fontSize: '13px',
          fontWeight: 'bold',
          marginBottom: '8px',
          color: isDarkMode ? '#e0e0e0' : '#333',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}
      >
        Paths
        <HelpIcon
          text={
            '"Color" paints the nodes a path traverses. "Copy #" draws a ' +
            "chart under the ruler showing how many times that path revisits " +
            'each part of the reference backbone - a value above 1 means a ' +
            'local duplication/repeat relative to the backbone. Requires ' +
            'Linear Layout with a reference path selected.'
          }
        />
      </div>
      {/* Large path sets are easier to work with when the panel can be filtered
          independently of the graph rendering state. */}
      <input
        type="search"
        value={searchQuery}
        onChange={e => {
          setSearchQuery(e.target.value)
          setRenderedRowCount(PATH_ROWS_PER_BATCH)
          listRef.current?.scrollTo({ top: 0 })
        }}
        placeholder="Search paths..."
        style={{
          width: '100%',
          boxSizing: 'border-box',
          marginBottom: '10px',
          padding: '8px 10px',
          borderRadius: '6px',
          border: isDarkMode ? '1px solid #555' : '1px solid #ccc',
          background: isDarkMode ? '#1f1f1f' : '#fff',
          color: isDarkMode ? '#e0e0e0' : '#333',
          fontSize: '13px',
        }}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '10px',
          flexWrap: 'wrap',
        }}
      >
        <button
          type="button"
          onClick={onSelectAll}
          style={{
            padding: '4px 8px',
            borderRadius: '4px',
            border: isDarkMode ? '1px solid #555' : '1px solid #ccc',
            background: isDarkMode ? '#3a3a3a' : '#fff',
            color: isDarkMode ? '#e0e0e0' : '#333',
            cursor: 'pointer',
            fontSize: '12px',
          }}
        >
          Select all
        </button>
        <button
          type="button"
          onClick={onDeselectAll}
          style={{
            padding: '4px 8px',
            borderRadius: '4px',
            border: isDarkMode ? '1px solid #555' : '1px solid #ccc',
            background: isDarkMode ? '#3a3a3a' : '#fff',
            color: isDarkMode ? '#e0e0e0' : '#333',
            cursor: 'pointer',
            fontSize: '12px',
          }}
        >
          Deselect all
        </button>
        <button
          type="button"
          onClick={() => {
            onClearNodeColors()
            setColorFeedback(null)
          }}
          style={{
            padding: '4px 8px',
            borderRadius: '4px',
            border: isDarkMode ? '1px solid #555' : '1px solid #ccc',
            background: isDarkMode ? '#3a3a3a' : '#fff',
            color: isDarkMode ? '#e0e0e0' : '#333',
            cursor: 'pointer',
            fontSize: '12px',
          }}
        >
          Clear node colors
        </button>
        <label
          title={
            selectedPathNames.length === 0
              ? 'Select at least one path first'
              : undefined
          }
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '7px',
            color: isDarkMode ? '#ccc' : '#555',
            cursor: selectedPathNames.length === 0 ? 'not-allowed' : 'pointer',
            fontSize: '12px',
            opacity: selectedPathNames.length === 0 ? 0.6 : 1,
          }}
        >
          <input
            type="checkbox"
            checked={filterToSelectedPaths}
            disabled={selectedPathNames.length === 0}
            onChange={event =>
              onFilterToSelectedPathsChange(event.currentTarget.checked)
            }
          />
          <span>Selected paths only</span>
          <HelpIcon
            text={
              'When ticked, only nodes and edges traversed by the ' +
              'selected paths stay on screen - everything else is removed.'
            }
          />
        </label>
        <span
          style={{
            color: isDarkMode ? '#aaa' : '#666',
            fontSize: '12px',
            marginLeft: 'auto',
          }}
        >
          {selectedPathNames.length} / {paths.length} selected
        </span>
      </div>
      <div
        ref={listRef}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          maxHeight: '320px',
          overflowY: 'auto',
          paddingRight: '4px',
        }}
      >
        {filteredPaths.slice(0, renderedRowCount).map(path => {
          const isColorPanelOpen = activeColorPathName === path.name
          return (
            <PathListRow
              key={path.name}
              path={path}
              color={pathColors.get(path.name) ?? '#888'}
              isDarkMode={isDarkMode}
              isSelected={selectedPathNameSet.has(path.name)}
              hasCopyNumber={copyNumberPathNameSet.has(path.name)}
              hasCopyNumberTrack={hasCopyNumberTrack}
              isColorPanelOpen={isColorPanelOpen}
              nodeColorInput={isColorPanelOpen ? nodeColorInput : ''}
              colorFeedback={
                colorFeedback?.pathName === path.name ? colorFeedback : null
              }
              onTogglePath={onTogglePath}
              onToggleColorPanel={toggleColorPanel}
              onToggleCopyNumberPath={onToggleCopyNumberPath}
              onNodeColorInputChange={setNodeColorInput}
              onApplyNodeColor={applyNodeColor}
            />
          )
        })}
        {hasMoreRows && (
          <div
            ref={moreRowsRef}
            style={{
              color: isDarkMode ? '#888' : '#777',
              fontSize: '12px',
              padding: '8px 2px',
            }}
          >
            Showing {renderedRowCount.toLocaleString()} of{' '}
            {filteredPaths.length.toLocaleString()} paths - scroll for more.
          </div>
        )}
        {filteredPaths.length === 0 && (
          <div
            style={{
              color: isDarkMode ? '#888' : '#777',
              fontSize: '12px',
              padding: '8px 2px',
            }}
          >
            No paths match "{searchQuery}".
          </div>
        )}
      </div>
    </div>
  )
})
