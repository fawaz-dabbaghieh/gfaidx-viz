import { useMemo, useState } from 'react'
import type { ColorScheme, LayoutOptions, GraphPath } from '../types'
import { pathHasRepeatedSegments } from '../utils/displayGraph'
import { HelpIcon } from './HelpIcon'

interface DisplayControlsProps {
  options: LayoutOptions
  onChange: (options: LayoutOptions) => void
  isComputing: boolean
  zoom: number
  onZoomChange: (zoom: number) => void
  hasPathsInGraph: boolean
  paths: GraphPath[]
  colorScheme: ColorScheme
  onColorSchemeChange: (scheme: ColorScheme) => void
  drawLabels: boolean
  onDrawLabelsChange: (draw: boolean) => void
  // Feature B: gene track toggle. Disabled (not hidden) when no BED is
  // loaded yet, so the control is discoverable before the user has one.
  hasGeneTrack: boolean
  showGeneTrack: boolean
  onShowGeneTrackChange: (show: boolean) => void
}

// The everyday display choices (the "Display" tab). Linear Layout and the
// reference path need a Redraw; the rest apply to the current drawing
// immediately. Fine-tuning sliders live in AdvancedControls.
export function DisplayControls({
  options,
  onChange,
  isComputing,
  hasPathsInGraph,
  paths,
  colorScheme,
  onColorSchemeChange,
  drawLabels,
  onDrawLabelsChange,
  hasGeneTrack,
  showGeneTrack,
  onShowGeneTrackChange,
}: DisplayControlsProps) {
  // The zoom slider is temporarily hidden (broken sync with canvas wheel-zoom);
  // `zoom`/`onZoomChange` stay in the prop contract for when it's re-enabled.
  const [referencePathQuery, setReferencePathQuery] = useState('')
  const repeatedReferencePathNames = useMemo(() => {
    const repeatedPaths = new Set<string>()

    for (const path of paths) {
      if (pathHasRepeatedSegments(path.nodeIds))
        repeatedPaths.add(path.name)
    }

    return repeatedPaths
  }, [paths])
  // A pangenome graph can have hundreds of haplotype paths, at which point
  // scrolling a plain <select> to find one by eye stops being practical.
  const filteredReferencePaths = useMemo(() => {
    const query = referencePathQuery.trim().toLocaleLowerCase()
    if (!query) return paths
    return paths.filter(path => path.name.toLocaleLowerCase().includes(query))
  }, [paths, referencePathQuery])
  const selectedReferencePathIsVisible =
    options.referencePathName === '' ||
    filteredReferencePaths.some(path => path.name === options.referencePathName)

  return (
    <div className="settings-tab-content">
      <div className="settings-grid">
        <div className="control-group">
          <label>
            <strong>Color Scheme:</strong>
            <HelpIcon
              text={
                'Uniform: one color for every contig. ' +
                'Rainbow: a distinct color per contig. ' +
                'Color by Depth: color scaled by sequencing depth. ' +
                'Grey: greyscale, useful when relying on path colors instead.'
              }
            />
          </label>
          <select
            value={colorScheme}
            onChange={e => onColorSchemeChange(e.target.value as ColorScheme)}
            disabled={isComputing}
            className="color-scheme-select"
          >
            <option value="uniform">Uniform Color</option>
            <option value="random">Rainbow</option>
            <option value="depth">Color by Depth</option>
            <option value="grey">Grey</option>
          </select>
        </div>

        <div className="control-group">
          <label>
            <input
              type="checkbox"
              checked={drawLabels}
              onChange={e => onDrawLabelsChange(e.target.checked)}
              disabled={isComputing}
            />{' '}
            Draw Labels
          </label>
          <div className="control-hint">
            Show contig names on the graph. Set the minimum contig length in
            the Advanced tab.
          </div>
        </div>

        <div className="control-group">
          <label>
            <input
              type="checkbox"
              checked={showGeneTrack}
              onChange={e => onShowGeneTrackChange(e.target.checked)}
              disabled={isComputing || !hasGeneTrack}
            />{' '}
            Show Gene Track{!hasGeneTrack && ' (no BED loaded)'}
          </label>
          <div className="control-hint">
            Draw genes above the ruler. Load a BED file from the Styling tab,
            and select a reference path with Linear Layout.
          </div>
        </div>

        <div className="control-group">
          <label>
            <input
              type="checkbox"
              checked={options.linearLayout}
              onChange={e =>
                onChange({ ...options, linearLayout: e.target.checked })
              }
              disabled={isComputing}
            />{' '}
            Linear Layout
          </label>
          <div className="control-hint">
            Use node-ID ordering, or straighten a selected reference path
            after force-directed layout. Applies on the next Redraw.
          </div>
        </div>

        {options.linearLayout && hasPathsInGraph && (
          <>
            {paths.length > 8 && (
              <div className="control-group">
                <label htmlFor="reference-path-search">
                  Search Reference Paths
                </label>
                <input
                  id="reference-path-search"
                  className="control-input"
                  type="search"
                  value={referencePathQuery}
                  onChange={event =>
                    setReferencePathQuery(event.currentTarget.value)
                  }
                  onKeyDown={event => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    const firstMatch = filteredReferencePaths.find(
                      path => !repeatedReferencePathNames.has(path.name),
                    )
                    if (firstMatch) {
                      onChange({
                        ...options,
                        referencePathName: firstMatch.name,
                      })
                    }
                  }}
                  placeholder="Type a path or sample name"
                  disabled={isComputing}
                />
                <div className="control-hint">
                  {filteredReferencePaths.length.toLocaleString()} of{' '}
                  {paths.length.toLocaleString()} paths
                </div>
              </div>
            )}
            <div className="control-group">
              <label htmlFor="reference-path-select">
                <strong>Reference Path:</strong>
              </label>
              <select
                id="reference-path-select"
                className="control-select"
                value={
                  selectedReferencePathIsVisible ? options.referencePathName : ''
                }
                onChange={event =>
                  onChange({
                    ...options,
                    referencePathName: event.currentTarget.value,
                  })
                }
                disabled={isComputing}
              >
                <option value="">Node ID order</option>
                {!selectedReferencePathIsVisible && (
                  <option value={options.referencePathName} disabled>
                    {options.referencePathName} (hidden by search)
                  </option>
                )}
                {filteredReferencePaths.map(path => {
                  const hasRepeatedSegments =
                    repeatedReferencePathNames.has(path.name)
                  return (
                    <option
                      key={path.name}
                      value={path.name}
                      disabled={hasRepeatedSegments}
                    >
                      {path.name}
                      {hasRepeatedSegments
                        ? ' (repeated segments - unavailable)'
                        : ''}
                    </option>
                  )
                })}
              </select>
              <div className="control-hint">
                Keep the selected path horizontal in traversal order.
              </div>
              {repeatedReferencePathNames.size > 0 && (
                <div className="control-error">
                  {repeatedReferencePathNames.size} path
                  {repeatedReferencePathNames.size === 1 ? '' : 's'} cannot be
                  used as a reference because they repeat a segment.
                </div>
              )}
            </div>
          </>
        )}

        {options.linearLayout && options.referencePathName && (
          <div className="control-group">
            <label>
              <strong>Path Straightening Rounds:</strong>
              <span className="control-value">
                {options.referencePathRelaxRounds}
              </span>
            </label>
            <input
              type="range"
              min="1"
              max="8"
              value={options.referencePathRelaxRounds}
              onChange={e =>
                onChange({
                  ...options,
                  referencePathRelaxRounds: parseInt(e.target.value),
                })
              }
              disabled={isComputing}
            />
            <div className="control-hint">
              How many times the layout re-settles around the straightened
              reference path. Higher = straighter neighborhood, slower
              computation.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
