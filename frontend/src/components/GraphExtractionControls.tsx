import { useEffect, useMemo, useRef, useState } from 'react'
import type { GfaidxJobProgress } from '../api/gfaidx'
import type { BedAnnotation, IndexedGraph, RegionPath } from '../types'
import {
  geneAssemblyForTracks,
  geneRegion,
  type GeneAssembly,
  type GeneLocation,
} from '../utils/builtInGenes'
import {
  EXAMPLE_FLANK_BP,
  EXAMPLE_GENE,
  EXAMPLE_GENE_ASSEMBLY,
} from '../utils/exampleQuery'
import { formatRegion, parseRegion, REGION_EXAMPLE } from '../utils/regionText'
import { BedAnnotationPanel } from './BedAnnotationPanel'
import { GeneSearch } from './GeneSearch'
import { HelpIcon } from './HelpIcon'
import { SearchSelect } from './SearchSelect'

// 'gene' and 'bed' fill in the same track and region as 'region' (picking a
// BED annotation also switches back to 'region'), so switching modes keeps
// the region.
type ExtractionMode = 'region' | 'gene' | 'neighborhood' | 'bed'

const EXTRACTION_MODES: { mode: ExtractionMode; label: string }[] = [
  { mode: 'region', label: 'Coordinate Region' },
  { mode: 'gene', label: 'Gene Name' },
  { mode: 'neighborhood', label: 'Node Neighborhood' },
  { mode: 'bed', label: 'BED File' },
]

// Module-level so SearchSelect's per-item search text is computed once.
const graphLabel = (graph: IndexedGraph) => graph.name
const graphSearchText = (graph: IndexedGraph) => `${graph.name} ${graph.id}`
const trackLabel = (track: RegionPath) => track.label
const trackSearchText = (track: RegionPath) =>
  track.reference
    ? `${track.label} ${track.reference}#${track.haplotype}#${track.sequence}`
    : track.label

// The gene the region follows, kept with its assembly: it also applies to
// another graph of that assembly, and it's dropped once the region or track
// is edited by hand.
interface PickedGene {
  assembly: GeneAssembly
  query: string
  gene: GeneLocation | null
}

interface GraphExtractionControlsProps {
  graphs: IndexedGraph[]
  selectedGraphId: string
  onSelectedGraphIdChange: (graphId: string) => void
  supportsExtraction: boolean
  selectedGraphIsLocal: boolean
  graphListError: string | null
  isLoadingGraphs: boolean
  nodeMaxNodes: string
  onNodeMaxNodesChange: (value: string) => void
  regionMaxNodes: string
  onRegionMaxNodesChange: (value: string) => void
  withCoords: boolean
  onWithCoordsChange: (enabled: boolean) => void
  nodeStart: string
  onNodeStartChange: (value: string) => void
  onExtractNode: () => void
  regionPaths: RegionPath[]
  selectedRegionPathIndex: number
  onSelectedRegionPathIndexChange: (index: number) => void
  regionPathError: string | null
  isLoadingRegionPaths: boolean
  manualRegionReference: string
  onManualRegionReferenceChange: (value: string) => void
  manualRegionSequence: string
  regionStart: string
  regionEnd: string
  // Sets the track (null when the graph has none: sequence is then sent as
  // typed) and the region on it.
  onSetRegion: (
    regionPathIndex: number | null,
    sequence: string,
    start: number,
    end: number,
  ) => void
  allHaplotypes: boolean
  onAllHaplotypesChange: (enabled: boolean) => void
  onExtractRegion: () => void
  isExtracting: boolean
  jobProgress: GfaidxJobProgress | null
  // Shown right by the submit button, not just in the page-level banner -
  // users who scrolled down past the header were missing extraction
  // failures entirely otherwise.
  extractionError: string | null
  // Set when the extraction finished but is too large to display.
  extractionDownloadUrl: string | null
  // The gfaidx command to run the failed query locally, when it was too large.
  extractionCommand: string | null
  bedAnnotations: BedAnnotation[]
  selectedBedAnnotation: BedAnnotation | null
  onBedAnnotationsChange: (annotations: BedAnnotation[]) => void
  onSelectBedAnnotation: (annotation: BedAnnotation, flankBp: number) => void
}

function formatElapsedSeconds(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

// Keep queue terminology visible so users can distinguish waiting in the
// backend queue from gfaidx execution and result transfer.
function describeJobProgress(progress: GfaidxJobProgress): string {
  switch (progress.phase) {
    case 'SUBMITTING':
      return 'Submitting gfaidx job'
    case 'PENDING':
      return 'Waiting in backend queue'
    case 'RUNNING':
      return 'gfaidx is running'
    case 'COMPLETE':
      return 'Extraction complete'
    case 'DOWNLOADING':
      return 'Downloading extracted GFA'
    case 'ERROR':
      return 'gfaidx job failed'
  }
}

export function GraphExtractionControls({
  graphs,
  selectedGraphId,
  onSelectedGraphIdChange,
  supportsExtraction,
  selectedGraphIsLocal,
  graphListError,
  isLoadingGraphs,
  nodeMaxNodes,
  onNodeMaxNodesChange,
  regionMaxNodes,
  onRegionMaxNodesChange,
  withCoords,
  onWithCoordsChange,
  nodeStart,
  onNodeStartChange,
  onExtractNode,
  regionPaths,
  selectedRegionPathIndex,
  onSelectedRegionPathIndexChange,
  regionPathError,
  isLoadingRegionPaths,
  manualRegionReference,
  onManualRegionReferenceChange,
  manualRegionSequence,
  regionStart,
  regionEnd,
  onSetRegion,
  allHaplotypes,
  onAllHaplotypesChange,
  onExtractRegion,
  isExtracting,
  jobProgress,
  extractionError,
  extractionDownloadUrl,
  extractionCommand,
  bedAnnotations,
  selectedBedAnnotation,
  onBedAnnotationsChange,
  onSelectBedAnnotation,
}: GraphExtractionControlsProps) {
  // The backend queue/gfaidx/download phases can each individually sit still
  // for a while - an elapsed-time readout at least confirms the request is
  // still being worked on rather than stuck.
  const [jobElapsedMs, setJobElapsedMs] = useState(0)
  useEffect(() => {
    if (!isExtracting) {
      setJobElapsedMs(0)
      return
    }

    const startedAt = Date.now()
    setJobElapsedMs(0)
    const intervalId = window.setInterval(() => {
      setJobElapsedMs(Date.now() - startedAt)
    }, 250)

    return () => window.clearInterval(intervalId)
  }, [isExtracting])
  const [extractionMode, setExtractionMode] =
    useState<ExtractionMode>('region')
  const [commandCopied, setCommandCopied] = useState(false)
  const selectedRegionPath = regionPaths[selectedRegionPathIndex]
  const controlsDisabled =
    isExtracting ||
    isLoadingGraphs ||
    graphs.length === 0 ||
    !supportsExtraction
  const regionInputsDisabled = controlsDisabled || isLoadingRegionPaths
  const useManualRegion = supportsExtraction && regionPaths.length === 0

  // The region field holds the text as typed; a valid text sets the track
  // and region, and any other change to them rewrites the text.
  const [regionText, setRegionText] = useState('')
  const [isRegionFocused, setIsRegionFocused] = useState(false)
  const parsedRegion = useMemo(
    () => parseRegion(regionText, regionPaths, selectedRegionPathIndex),
    [regionPaths, regionText, selectedRegionPathIndex],
  )
  const formattedRegion = formatRegion(
    selectedRegionPath?.sequence ?? manualRegionSequence,
    regionStart,
    regionEnd,
  )
  useEffect(() => {
    setRegionText(current => {
      const parsed = parseRegion(current, regionPaths, selectedRegionPathIndex)
      const unchanged =
        !('error' in parsed) &&
        parsed.trackIndex ===
          (regionPaths.length > 0 ? selectedRegionPathIndex : null) &&
        formatRegion(parsed.sequence, parsed.start, parsed.end) ===
          formattedRegion
      return unchanged ? current : formattedRegion
    })
  }, [formattedRegion, regionPaths, selectedRegionPathIndex])

  const [pickedGene, setPickedGene] = useState<PickedGene | null>({
    assembly: EXAMPLE_GENE_ASSEMBLY,
    query: EXAMPLE_GENE.symbol,
    gene: EXAMPLE_GENE,
  })
  const [geneFlank, setGeneFlank] = useState(String(EXAMPLE_FLANK_BP))
  const [geneError, setGeneError] = useState<string | null>(null)
  const geneAssembly = useMemo(
    () =>
      geneAssemblyForTracks(regionPaths, selectedRegionPathIndex, selectedGraphId),
    [regionPaths, selectedGraphId, selectedRegionPathIndex],
  )
  const activeGene =
    pickedGene && pickedGene.assembly === geneAssembly ? pickedGene : null

  // Fills in the gene's region and returns an error, if any.
  const fillGeneRegion = (
    gene: GeneLocation,
    flankText: string,
    assembly: GeneAssembly,
  ): string | null => {
    const flankBp = Number(flankText)
    if (flankText.trim() === '' || !Number.isInteger(flankBp) || flankBp < 0) {
      return 'The flank must be a whole number of bp.'
    }
    const region = geneRegion(gene, flankBp, assembly, regionPaths, selectedGraphId)
    if ('error' in region) return region.error
    onSetRegion(
      region.trackIndex,
      regionPaths[region.trackIndex]!.sequence,
      region.start,
      region.end,
    )
    return null
  }

  // A newly loaded graph gets the picked gene's region (on first load, the
  // example gene's), if it has the gene's assembly.
  const geneFilledTracks = useRef<RegionPath[] | null>(null)
  useEffect(() => {
    if (geneFilledTracks.current === regionPaths) return
    geneFilledTracks.current = regionPaths
    if (!activeGene?.gene || regionPaths.length === 0) return
    setGeneError(fillGeneRegion(activeGene.gene, geneFlank, activeGene.assembly))
  })

  const clearPickedGene = () => {
    setPickedGene(null)
    setGeneError(null)
  }

  const regionSubmitDisabled =
    regionInputsDisabled || 'error' in parsedRegion
  const submitDisabled =
    extractionMode === 'neighborhood' ? controlsDisabled : regionSubmitDisabled
  const submitLabel = isExtracting
    ? 'Extracting...'
    : extractionMode === 'neighborhood'
      ? 'Extract Node Subgraph'
      : allHaplotypes
        ? 'Extract All Haplotypes'
        : 'Extract Region'

  useEffect(() => {
    setCommandCopied(false)
  }, [extractionCommand])

  const regionField = (
    <div className="control-group query-main-field">
      <label htmlFor="region-input">
        Region
        <HelpIcon
          text={
            'name:start-end on a coordinate track, e.g. ' +
            `${REGION_EXAMPLE}. The name is the track's sequence ` +
            '(chr1) or path name (CHM13#0#chr1). Coordinates are ' +
            '0-based and the end is exclusive, as in BED files. "," ' +
            'or "." thousands separators are fine.'
          }
        />
      </label>
      <input
        id="region-input"
        className="control-input"
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder={REGION_EXAMPLE}
        value={regionText}
        onFocus={() => setIsRegionFocused(true)}
        onBlur={() => setIsRegionFocused(false)}
        onChange={event => {
          const text = event.currentTarget.value
          setRegionText(text)
          clearPickedGene()
          const parsed = parseRegion(text, regionPaths, selectedRegionPathIndex)
          if (!('error' in parsed)) {
            onSetRegion(parsed.trackIndex, parsed.sequence, parsed.start, parsed.end)
          }
        }}
        disabled={regionInputsDisabled}
      />
      {'error' in parsedRegion && !isRegionFocused && regionText !== '' && (
        <div className="control-error">{parsedRegion.error}</div>
      )}
    </div>
  )

  return (
    <div className="graph-extraction-controls">
      {jobProgress && (
        <div
          className="gfaidx-job-status"
          role="status"
          aria-live="polite"
        >
          <strong>
            {describeJobProgress(jobProgress)} (
            {formatElapsedSeconds(jobElapsedMs)})
          </strong>
          {jobProgress.ticket && (
            <span>
              Ticket: <code>{jobProgress.ticket}</code>
            </span>
          )}
        </div>
      )}

      <div
        className="query-mode-bar"
        role="radiogroup"
        aria-label="Extract by"
      >
        <span className="query-mode-title">
          Extract by
          <HelpIcon
            text={
              'Coordinate Region: a range on a reference or haplotype. ' +
              'Gene Name: a GRCh38 or CHM13 gene plus a flank. Node ' +
              'Neighborhood: grow outward from a node. BED File: load a ' +
              'BED file and pick a region from it.'
            }
          />
        </span>
        {EXTRACTION_MODES.map(({ mode, label }) => (
          <label key={mode}>
            <input
              type="radio"
              name="extraction-target"
              checked={extractionMode === mode}
              onChange={() => setExtractionMode(mode)}
              disabled={controlsDisabled}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>

      <form
        className="graph-control-form"
        onSubmit={event => {
          event.preventDefault()
          if (submitDisabled) return
          if (extractionMode === 'neighborhood') {
            onExtractNode()
          } else if (extractionMode !== 'bed') {
            onExtractRegion()
          }
        }}
      >
        <div className="query-main-row">
          <div className="control-group query-main-field">
            <label htmlFor="indexed-graph-select">Graph</label>
            <SearchSelect
              id="indexed-graph-select"
              items={graphs}
              selectedIndex={graphs.findIndex(graph => graph.id === selectedGraphId)}
              getLabel={graphLabel}
              getSearchText={graphSearchText}
              onSelect={index => onSelectedGraphIdChange(graphs[index]!.id)}
              placeholder={
                isLoadingGraphs
                  ? 'Loading graphs...'
                  : graphs.length === 0
                    ? 'No graphs found'
                    : 'Choose a graph'
              }
              disabled={isLoadingGraphs || isExtracting || graphs.length === 0}
            />
            {selectedGraphIsLocal ? (
              <div className="control-hint">
                This graph is loaded only in the browser. Queries need a
                graph from the backend.
              </div>
            ) : (
              graphListError && (
                <div className="control-error">{graphListError}</div>
              )
            )}
          </div>

          {extractionMode === 'region' && (
            <div className="control-group query-main-field">
              <label htmlFor="region-path-select">
                Coordinate Track
                <HelpIcon
                  text={
                    'A reference or haplotype whose coordinates the ' +
                    'region is on. Type to search by sample, haplotype ' +
                    'or sequence name.'
                  }
                />
              </label>
              <SearchSelect
                id="region-path-select"
                items={regionPaths}
                selectedIndex={selectedRegionPathIndex}
                getLabel={trackLabel}
                getSearchText={trackSearchText}
                onSelect={index => {
                  clearPickedGene()
                  onSelectedRegionPathIndexChange(index)
                }}
                placeholder={
                  isLoadingRegionPaths
                    ? 'Loading coordinate tracks...'
                    : 'No coordinate tracks'
                }
                disabled={regionInputsDisabled || regionPaths.length === 0}
              />
              {regionPathError ? (
                <div className="control-error">{regionPathError}</div>
              ) : (
                useManualRegion &&
                !isLoadingRegionPaths && (
                  <div className="control-hint">
                    Type the sequence name in Region instead.
                  </div>
                )
              )}
            </div>
          )}

          {extractionMode === 'gene' && (
            <div className="control-group query-main-field">
              <label htmlFor="gene-search-input">
                Gene Name
                <HelpIcon
                  text={
                    'A protein-coding gene (MANE Select) on the GRCh38 ' +
                    'or CHM13 track, plus the flank on both sides.'
                  }
                />
              </label>
              <div className="gene-field-row">
                <GeneSearch
                  id="gene-search-input"
                  assembly={geneAssembly}
                  query={activeGene?.query ?? ''}
                  disabled={regionInputsDisabled}
                  onQueryChange={query => {
                    setPickedGene(
                      geneAssembly ? { assembly: geneAssembly, query, gene: null } : null,
                    )
                    setGeneError(null)
                  }}
                  onPick={gene => {
                    if (!geneAssembly) return
                    setPickedGene({ assembly: geneAssembly, query: gene.symbol, gene })
                    setGeneError(fillGeneRegion(gene, geneFlank, geneAssembly))
                  }}
                />
                <span className="gene-flank">
                  ±
                  <input
                    className="control-input"
                    type="number"
                    min="0"
                    step="1000"
                    aria-label="Flank (bp)"
                    title="Added on both sides of the gene"
                    value={geneFlank}
                    onChange={event => {
                      const flankText = event.currentTarget.value
                      setGeneFlank(flankText)
                      if (activeGene?.gene) {
                        setGeneError(
                          fillGeneRegion(activeGene.gene, flankText, activeGene.assembly),
                        )
                      }
                    }}
                    disabled={regionInputsDisabled || !geneAssembly}
                  />
                  bp
                </span>
              </div>
              {geneError && <div className="control-error">{geneError}</div>}
            </div>
          )}

          {(extractionMode === 'region' || extractionMode === 'gene') &&
            regionField}

          {extractionMode === 'neighborhood' && (
            <div className="control-group query-main-field">
              <label htmlFor="subgraph-start-node">
                Start Node ID
                <HelpIcon
                  text={
                    'The node to grow the neighborhood outward from, ' +
                    'as shown on the graph (e.g. "1042"). Hover a ' +
                    'node on the graph to find its ID, or click a ' +
                    'node and choose "Use as Start Node" in the info ' +
                    'panel.'
                  }
                />
              </label>
              <input
                id="subgraph-start-node"
                className="control-input"
                type="text"
                placeholder="e.g. 1042"
                value={nodeStart}
                onChange={event =>
                  onNodeStartChange(event.currentTarget.value)
                }
                disabled={controlsDisabled}
              />
            </div>
          )}
        </div>

        {extractionMode !== 'bed' && (
          <>
            <div className="query-options-row">
              {extractionMode === 'neighborhood' ? (
                <label className="query-option">
                  Max Nodes
                  <HelpIcon text="Maximum neighborhood size." />
                  <input
                    className="control-input query-option-number"
                    type="number"
                    min="1"
                    step="1"
                    value={nodeMaxNodes}
                    onChange={event =>
                      onNodeMaxNodesChange(event.currentTarget.value)
                    }
                    disabled={controlsDisabled}
                  />
                </label>
              ) : (
                <>
                  <div
                    className="query-option extraction-mode-options"
                    role="radiogroup"
                    aria-label="Extraction method"
                  >
                    <span>
                      Method
                      <HelpIcon
                        text={
                          'All Haplotypes: the exact region on the track, ' +
                          'plus the matching span of every other ' +
                          'haplotype. BFS: a breadth-first neighborhood ' +
                          'around the region, up to Max Nodes.'
                        }
                      />
                    </span>
                    <label>
                      <input
                        type="radio"
                        name="coordinate-region-mode"
                        checked={allHaplotypes}
                        onChange={() => onAllHaplotypesChange(true)}
                        disabled={controlsDisabled}
                      />
                      <span>All Haplotypes</span>
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="coordinate-region-mode"
                        checked={!allHaplotypes}
                        onChange={() => onAllHaplotypesChange(false)}
                        disabled={controlsDisabled}
                      />
                      <span>BFS</span>
                    </label>
                  </div>
                  {!allHaplotypes && (
                    <label className="query-option">
                      Max Nodes
                      <input
                        className="control-input query-option-number"
                        type="number"
                        min="1"
                        step="1"
                        value={regionMaxNodes}
                        onChange={event =>
                          onRegionMaxNodesChange(event.currentTarget.value)
                        }
                        disabled={controlsDisabled}
                      />
                    </label>
                  )}
                  {useManualRegion && (
                    <label className="query-option">
                      Reference Sample
                      <HelpIcon
                        text={
                          'Which sample/haplotype defines the ' +
                          'coordinates, when the graph has more than one. ' +
                          "Leave blank if there's no ambiguity."
                        }
                      />
                      <input
                        className="control-input"
                        type="text"
                        value={manualRegionReference}
                        onChange={event =>
                          onManualRegionReferenceChange(event.currentTarget.value)
                        }
                        placeholder="optional"
                        disabled={regionInputsDisabled}
                      />
                    </label>
                  )}
                </>
              )}
              <label className="query-option">
                <input
                  type="checkbox"
                  checked={withCoords}
                  onChange={event =>
                    onWithCoordsChange(event.currentTarget.checked)
                  }
                  disabled={controlsDisabled}
                />
                With Coordinates
                <HelpIcon text="Give the extracted paths and walks their coordinates." />
              </label>
            </div>

            <div className="query-submit">
              <button
                className="compute-button"
                type="submit"
                disabled={submitDisabled}
              >
                {submitLabel}
              </button>
            </div>
            {extractionError && (
              <div className="gfaidx-job-error" role="alert">
                {extractionError}
                {extractionDownloadUrl && (
                  <div>
                    <a
                      href={extractionDownloadUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Download GFA
                    </a>
                  </div>
                )}
                {extractionCommand && (
                  <div className="gfaidx-command">
                    <div>
                      To extract it on your own machine, download the indexed
                      graph and run:
                    </div>
                    <div className="gfaidx-command-line">
                      <code>{extractionCommand}</code>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard
                            .writeText(extractionCommand)
                            .then(() => setCommandCopied(true))
                            .catch(() => setCommandCopied(false))
                        }}
                      >
                        {commandCopied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </form>

      {/* Hidden, not unmounted: it keeps the loaded file between visits. */}
      <div hidden={extractionMode !== 'bed'}>
        <BedAnnotationPanel
          annotations={bedAnnotations}
          selectedAnnotation={selectedBedAnnotation}
          onAnnotationsChange={onBedAnnotationsChange}
          onSelectAnnotation={(annotation, flankBp) => {
            clearPickedGene()
            onSelectBedAnnotation(annotation, flankBp)
            setExtractionMode('region')
          }}
        />
      </div>
    </div>
  )
}
