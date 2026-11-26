import { useMemo } from 'react'
import type { ColorScheme, LayoutOptions, GraphPath } from '../types'
import { pathHasRepeatedSegments } from '../utils/displayGraph'
import { HAPLOTYPE_SHARING_GRADIENT } from '../utils/haplotypeSharingColor'
import { HelpIcon } from './HelpIcon'
import { SearchSelect } from './SearchSelect'

// A Reference Path choice: a path, or '' for node-ID order.
interface ReferenceOption {
  name: string
  label: string
  // A path that repeats a segment can't be laid out as a straight line.
  disabled: boolean
}

// Module-level so SearchSelect's per-item search text is computed once.
const referenceOptionLabel = (option: ReferenceOption) => option.label
const referenceOptionDisabled = (option: ReferenceOption) => option.disabled

interface DisplayControlsProps {
  options: LayoutOptions
  onChange: (options: LayoutOptions) => void
  isComputing: boolean
  zoom: number
  onZoomChange: (zoom: number) => void
  hasPathsInGraph: boolean
  // False when node IDs aren't all integers: the layout engine can't order
  // those, so Linear Layout then needs a reference path.
  canOrderByNodeId: boolean
  paths: GraphPath[]
  colorScheme: ColorScheme
  onColorSchemeChange: (scheme: ColorScheme) => void
  // Haplotypes in the graph, for the Haplotype Sharing legend (0 unless
  // that scheme is chosen).
  haplotypeCount: number
  drawLabels: boolean
  onDrawLabelsChange: (draw: boolean) => void
  // Feature B: gene track toggle. Disabled (not hidden) when there are no
  // genes for the drawn reference, so the control is still discoverable.
  hasGeneTrack: boolean
  // Where the genes come from (the user's BED file or the built-in set).
  geneTrackSource: string | null
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
  canOrderByNodeId,
  paths,
  colorScheme,
  onColorSchemeChange,
  haplotypeCount,
  drawLabels,
  onDrawLabelsChange,
  hasGeneTrack,
  geneTrackSource,
  showGeneTrack,
  onShowGeneTrackChange,
}: DisplayControlsProps) {
  // The zoom slider is temporarily hidden (broken sync with canvas wheel-zoom);
  // `zoom`/`onZoomChange` stay in the prop contract for when it's re-enabled.
  const repeatedReferencePathNames = useMemo(() => {
    const repeatedPaths = new Set<string>()

    for (const path of paths) {
      if (pathHasRepeatedSegments(path.nodeIds))
        repeatedPaths.add(path.name)
    }

    return repeatedPaths
  }, [paths])
  // A pangenome graph can have hundreds of haplotype paths, so the list can
  // be searched as well as scrolled.
  const referenceOptions = useMemo((): ReferenceOption[] => {
    const pathOptions = paths.map(path => {
      const disabled = repeatedReferencePathNames.has(path.name)
      return {
        name: path.name,
        label: disabled
          ? `${path.name} (repeated segments - unavailable)`
          : path.name,
        disabled,
      }
    })
    return canOrderByNodeId
      ? [{ name: '', label: 'Node ID order', disabled: false }, ...pathOptions]
      : pathOptions
  }, [canOrderByNodeId, paths, repeatedReferencePathNames])
  const linearLayoutUnavailable = !canOrderByNodeId && !hasPathsInGraph

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
                'Haplotype Sharing: a heat map of how many haplotypes carry ' +
                'each node, from red (one) to blue (all); grey where none ' +
                'does. ' +
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
            <option value="haplotypes">Haplotype Sharing</option>
            <option value="grey">Grey</option>
          </select>
          {colorScheme === 'haplotypes' &&
            (haplotypeCount > 0 ? (
              <div className="haplotype-sharing-legend">
                <div
                  className="haplotype-sharing-gradient"
                  style={{ background: HAPLOTYPE_SHARING_GRADIENT }}
                />
                <div className="haplotype-sharing-labels">
                  <span>1 haplotype</span>
                  <span>all {haplotypeCount.toLocaleString()}</span>
                </div>
              </div>
            ) : (
              <div className="control-hint">
                This graph has no paths, so there are no haplotypes to count.
              </div>
            ))}
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
            Show Gene Track{!hasGeneTrack && ' (no genes for this view)'}
          </label>
          <div className="control-hint">
            {hasGeneTrack && geneTrackSource
              ? `Genes from ${geneTrackSource}. `
              : 'Genes are added automatically when a GRCh38 or CHM13 ' +
                'path is drawn with Linear Layout. '}
            Load your own BED in the Styling tab to replace them.
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
              disabled={isComputing || linearLayoutUnavailable}
            />{' '}
            Linear Layout{linearLayoutUnavailable && ' (needs a path)'}
          </label>
          <div className="control-hint">
            {linearLayoutUnavailable
              ? "Node IDs aren't numeric, so nodes can't be ordered by ID, " +
                'and this graph has no path to straighten instead.'
              : canOrderByNodeId
                ? 'Use node-ID ordering, or straighten a selected reference ' +
                  'path after force-directed layout.'
                : 'Straighten a selected reference path after ' +
                  'force-directed layout.'}{' '}
            Applies on the next Redraw.
          </div>
        </div>

        {options.linearLayout && hasPathsInGraph && (
          <div className="control-group">
            <label htmlFor="reference-path-select">
              <strong>Reference Path:</strong>
            </label>
            <SearchSelect
              id="reference-path-select"
              items={referenceOptions}
              selectedIndex={referenceOptions.findIndex(
                option => option.name === options.referencePathName,
              )}
              getLabel={referenceOptionLabel}
              isDisabled={referenceOptionDisabled}
              onSelect={index =>
                onChange({
                  ...options,
                  referencePathName: referenceOptions[index]!.name,
                })
              }
              placeholder="Choose a reference path..."
              disabled={isComputing}
            />
            <div className="control-hint">
              Keep the selected path horizontal in traversal order.
              {!canOrderByNodeId &&
                " Node IDs aren't numeric, so a path is required."}
            </div>
            {repeatedReferencePathNames.size > 0 && (
              <div className="control-error">
                {repeatedReferencePathNames.size} path
                {repeatedReferencePathNames.size === 1 ? '' : 's'} cannot be
                used as a reference because they repeat a segment.
              </div>
            )}
          </div>
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
