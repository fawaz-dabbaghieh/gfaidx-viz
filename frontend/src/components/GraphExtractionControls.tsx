import { useEffect, useMemo, useState } from 'react'
import type { GfaidxJobProgress } from '../api/gfaidx'
import type { BedAnnotation, IndexedGraph, RegionPath } from '../types'
import { BedAnnotationPanel } from './BedAnnotationPanel'
import { HelpIcon } from './HelpIcon'

// 'bed' isn't a query of its own: picking an annotation fills in the
// coordinate-region fields and switches back to 'region'.
type ExtractionMode = 'region' | 'neighborhood' | 'bed'

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
  onManualRegionSequenceChange: (value: string) => void
  regionStart: string
  onRegionStartChange: (value: string) => void
  regionEnd: string
  onRegionEndChange: (value: string) => void
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
  onManualRegionSequenceChange,
  regionStart,
  onRegionStartChange,
  regionEnd,
  onRegionEndChange,
  allHaplotypes,
  onAllHaplotypesChange,
  onExtractRegion,
  isExtracting,
  jobProgress,
  extractionError,
  extractionDownloadUrl,
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
  const [coordinateTrackQuery, setCoordinateTrackQuery] = useState('')
  const selectedRegionPath = regionPaths[selectedRegionPathIndex]
  const controlsDisabled =
    isExtracting ||
    isLoadingGraphs ||
    graphs.length === 0 ||
    !supportsExtraction
  const useManualRegion = supportsExtraction && regionPaths.length === 0
  const filteredRegionPaths = useMemo(() => {
    const query = coordinateTrackQuery.trim().toLocaleLowerCase()

    // Retain original indices because the parent stores the selection by index.
    return regionPaths
      .map((regionPath, index) => ({ regionPath, index }))
      .filter(({ regionPath }) => {
        if (!query) {
          return true
        }

        return [
          regionPath.label,
          regionPath.source,
          regionPath.reference,
          regionPath.haplotype,
          regionPath.sequence,
        ].some(value => value.toLocaleLowerCase().includes(query))
      })
  }, [coordinateTrackQuery, regionPaths])
  const selectedRegionPathIsVisible = filteredRegionPaths.some(
    ({ index }) => index === selectedRegionPathIndex,
  )
  const regionPathSelectValue = selectedRegionPathIsVisible
    ? String(selectedRegionPathIndex)
    : ''
  const regionSubmitDisabled =
    controlsDisabled ||
    isLoadingRegionPaths ||
    (useManualRegion && !manualRegionSequence.trim())
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
    setCoordinateTrackQuery('')
  }, [selectedGraphId])

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

      <section className="query-options">
        <div className="control-group query-graph-select">
          <label htmlFor="indexed-graph-select">Available Graph</label>
          <select
            id="indexed-graph-select"
            className="control-select"
            value={selectedGraphId}
            onChange={event =>
              onSelectedGraphIdChange(event.currentTarget.value)
            }
            disabled={
              isLoadingGraphs || isExtracting || graphs.length === 0
            }
          >
            {graphs.length === 0 ? (
              <option value="">
                {isLoadingGraphs ? 'Loading graphs...' : 'No graphs found'}
              </option>
            ) : (
              graphs.map(graph => (
                <option key={graph.id} value={graph.id}>
                  {graph.name}
                </option>
              ))
            )}
          </select>
          {selectedGraphIsLocal ? (
            <div className="control-hint">
              This graph is loaded only in the browser. Node and coordinate
              extraction require a graph registered with the backend.
            </div>
          ) : graphListError ? (
            <div className="control-error">{graphListError}</div>
          ) : (
            <div className="control-hint">
              Graphs are loaded from the backend registry.
            </div>
          )}
        </div>

        <div className="control-group">
          <label>
            Extract By
            <HelpIcon
              text={
                'Coordinate Region: pull nodes that fall within a ' +
                'genomic range on a reference. Node Neighborhood: ' +
                'grow outward from a chosen node by graph distance. ' +
                'From BED File: load a BED file and pick a region ' +
                'to fill in a coordinate-region query.'
              }
            />
          </label>
          <div
            className="extraction-mode-options"
            role="radiogroup"
            aria-label="Extraction target"
          >
            <label>
              <input
                type="radio"
                name="extraction-target"
                checked={extractionMode === 'region'}
                onChange={() => setExtractionMode('region')}
                disabled={controlsDisabled}
              />
              <span>Coordinate Region</span>
            </label>
            <label>
              <input
                type="radio"
                name="extraction-target"
                checked={extractionMode === 'neighborhood'}
                onChange={() => setExtractionMode('neighborhood')}
                disabled={controlsDisabled}
              />
              <span>Node Neighborhood</span>
            </label>
            <label>
              <input
                type="radio"
                name="extraction-target"
                checked={extractionMode === 'bed'}
                onChange={() => setExtractionMode('bed')}
                disabled={controlsDisabled}
              />
              <span>From BED File</span>
            </label>
          </div>
        </div>
      </section>

      <div hidden={extractionMode !== 'bed'}>
        <BedAnnotationPanel
          annotations={bedAnnotations}
          selectedAnnotation={selectedBedAnnotation}
          onAnnotationsChange={onBedAnnotationsChange}
          onSelectAnnotation={(annotation, flankBp) => {
            onSelectBedAnnotation(annotation, flankBp)
            setExtractionMode('region')
          }}
        />
      </div>

      <form
        className="graph-control-form"
        hidden={extractionMode === 'bed'}
        onSubmit={event => {
          event.preventDefault()
          if (extractionMode === 'neighborhood') {
            onExtractNode()
          } else {
            onExtractRegion()
          }
        }}
      >
        <div className="query-fields">
          {extractionMode === 'neighborhood' ? (
            <>
              <div className="control-group">
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
                  value={nodeStart}
                  onChange={event =>
                    onNodeStartChange(event.currentTarget.value)
                  }
                  disabled={controlsDisabled}
                />
              </div>

              <div className="control-group">
                <label htmlFor="node-max-nodes">Max Nodes</label>
                <input
                  id="node-max-nodes"
                  className="control-input"
                  type="number"
                  min="1"
                  step="1"
                  value={nodeMaxNodes}
                  onChange={event =>
                    onNodeMaxNodesChange(event.currentTarget.value)
                  }
                  disabled={controlsDisabled}
                />
                <div className="control-hint">
                  Maximum neighborhood size. No testing cap is enforced here.
                </div>
              </div>

              <div className="control-group">
                <label className="checkbox-control-label">
                  <input
                    type="checkbox"
                    checked={withCoords}
                    onChange={event =>
                      onWithCoordsChange(event.currentTarget.checked)
                    }
                    disabled={controlsDisabled}
                  />
                  <strong>With Coordinates</strong>
                </label>
                <div className="control-hint">
                  Calculate coordinate-bearing path and walk records.
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="control-group">
                <label>Extraction Method</label>
                <div
                  className="extraction-mode-options"
                  role="radiogroup"
                  aria-label="Coordinate region extraction method"
                >
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
                <div className="control-hint">
                  {allHaplotypes
                    ? 'Extract exact anchor-supported path and walk spans across all haplotypes.'
                    : 'Extract a bounded breadth-first neighborhood around the requested region.'}
                </div>
              </div>
              {!allHaplotypes && (
                <div className="control-group">
                  <label htmlFor="region-max-nodes">Max Nodes</label>
                  <input
                    id="region-max-nodes"
                    className="control-input"
                    type="number"
                    min="1"
                    step="1"
                    value={regionMaxNodes}
                    onChange={event =>
                      onRegionMaxNodesChange(event.currentTarget.value)
                    }
                    disabled={controlsDisabled}
                  />
                  <div className="control-hint">
                    Maximum number of nodes returned by BFS.
                  </div>
                </div>
              )}
              <div className="control-group">
                <label htmlFor="region-path-search">
                  Search Coordinate Tracks
                  <HelpIcon
                    text={
                      'A coordinate track is one haplotype whose ' +
                      'genomic span is known, so you can pick a ' +
                      'region on it below. Narrows the list by path, ' +
                      'sample, or sequence name.'
                    }
                  />
                </label>
                <input
                  id="region-path-search"
                  className="control-input"
                  type="search"
                  value={coordinateTrackQuery}
                  onChange={event =>
                    setCoordinateTrackQuery(event.currentTarget.value)
                  }
                  onKeyDown={event => {
                    if (event.key !== 'Enter') {
                      return
                    }

                    event.preventDefault()
                    const firstMatch = filteredRegionPaths[0]
                    if (firstMatch) {
                      onSelectedRegionPathIndexChange(firstMatch.index)
                    }
                  }}
                  placeholder="Type a path, sample, or sequence name"
                  disabled={
                    controlsDisabled ||
                    isLoadingRegionPaths ||
                    regionPaths.length === 0
                  }
                />
                {regionPaths.length > 0 && (
                  <div className="control-hint">
                    {filteredRegionPaths.length.toLocaleString()} of{' '}
                    {regionPaths.length.toLocaleString()} tracks
                  </div>
                )}
              </div>
              <div className="control-group">
                <label htmlFor="region-path-select">Coordinate Track</label>
                <select
                  id="region-path-select"
                  className="control-select"
                  value={regionPathSelectValue}
                  onChange={event =>
                    onSelectedRegionPathIndexChange(
                      Number(event.currentTarget.value),
                    )
                  }
                  disabled={
                    controlsDisabled ||
                    isLoadingRegionPaths ||
                    regionPaths.length === 0
                  }
                >
                  {regionPaths.length === 0 ? (
                    <option value="0">
                      {isLoadingRegionPaths
                        ? 'Loading coordinate tracks...'
                        : 'No coordinate tracks found'}
                    </option>
                  ) : filteredRegionPaths.length === 0 ? (
                    <option value="">No matching coordinate tracks</option>
                  ) : (
                    <>
                      {!selectedRegionPathIsVisible && (
                        <option value="">Choose a matching track</option>
                      )}
                      {filteredRegionPaths.map(({ regionPath, index }) => (
                        <option
                          key={`${regionPath.label}-${index}`}
                          value={index}
                        >
                          {regionPath.label}
                        </option>
                      ))}
                    </>
                  )}
                </select>
                {selectedGraphIsLocal ? (
                  <div className="control-hint">
                    Coordinate tracks are unavailable for local browser uploads.
                  </div>
                ) : regionPathError ? (
                  <div className="control-error">{regionPathError}</div>
                ) : selectedRegionPath ? (
                  <div className="control-hint">
                    Available interval: {selectedRegionPath.start.toLocaleString()}
                    {' - '}
                    {selectedRegionPath.end === null
                      ? 'unknown (length not indexed - enter an end coordinate manually)'
                      : selectedRegionPath.end.toLocaleString()}
                  </div>
                ) : (
                  <div className="control-hint">
                    No coordinate index found. Enter the sequence manually below.
                  </div>
                )}
              </div>

              {useManualRegion && (
                <>
                  <div className="control-group">
                    <label htmlFor="manual-region-sequence">
                      Sequence
                      <HelpIcon
                        text={
                          'The chromosome or contig name to extract ' +
                          'from, matching how it appears in the graph ' +
                          '(e.g. "chr22").'
                        }
                      />
                    </label>
                    <input
                      id="manual-region-sequence"
                      className="control-input"
                      type="text"
                      value={manualRegionSequence}
                      onChange={event =>
                        onManualRegionSequenceChange(event.currentTarget.value)
                      }
                      placeholder="chr22"
                      disabled={controlsDisabled || isLoadingRegionPaths}
                    />
                  </div>

                  <div className="control-group">
                    <label htmlFor="manual-region-reference">
                      Reference Sample
                      <HelpIcon
                        text={
                          'Which sample/haplotype defines the ' +
                          'coordinate system for Sequence, when the ' +
                          'graph has more than one. Leave blank if ' +
                          "there's no ambiguity."
                        }
                      />
                    </label>
                    <input
                      id="manual-region-reference"
                      className="control-input"
                      type="text"
                      value={manualRegionReference}
                      onChange={event =>
                        onManualRegionReferenceChange(event.currentTarget.value)
                      }
                      placeholder="optional"
                      disabled={controlsDisabled || isLoadingRegionPaths}
                    />
                  </div>
                </>
              )}

              <div className="control-row">
                <div className="control-group">
                  <label htmlFor="region-start">
                    Start
                    <HelpIcon
                      text={
                        '0-based, inclusive - matches BED-style ' +
                        'coordinates, not the 1-based numbering some ' +
                        'genome browsers display. "." or "," thousands ' +
                        'separators are fine, e.g. 2,500,000 or ' +
                        '2.500.000.'
                      }
                    />
                  </label>
                  <input
                    id="region-start"
                    className="control-input"
                    type="text"
                    inputMode="numeric"
                    placeholder="e.g. 2,500,000"
                    value={regionStart}
                    onChange={event =>
                      onRegionStartChange(event.currentTarget.value)
                    }
                    disabled={controlsDisabled || isLoadingRegionPaths}
                  />
                </div>

                <div className="control-group">
                  <label htmlFor="region-end">
                    End
                    <HelpIcon
                      text={
                        '0-based, exclusive - the base at this ' +
                        'position itself is not included. "." or "," ' +
                        'thousands separators are fine.'
                      }
                    />
                  </label>
                  <input
                    id="region-end"
                    className="control-input"
                    type="text"
                    inputMode="numeric"
                    placeholder="e.g. 2,600,000"
                    value={regionEnd}
                    onChange={event =>
                      onRegionEndChange(event.currentTarget.value)
                    }
                    disabled={controlsDisabled || isLoadingRegionPaths}
                  />
                </div>
              </div>

              <div className="control-group">
                <label className="checkbox-control-label">
                  <input
                    type="checkbox"
                    checked={withCoords}
                    onChange={event =>
                      onWithCoordsChange(event.currentTarget.checked)
                    }
                    disabled={controlsDisabled}
                  />
                  <strong>With Coordinates</strong>
                </label>
                <div className="control-hint">
                  Calculate coordinate-bearing path and walk records.
                </div>
              </div>
            </>
          )}
        </div>

        <button
          className="compute-button"
          type="submit"
          disabled={submitDisabled}
        >
          {submitLabel}
        </button>
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
          </div>
        )}
      </form>
    </div>
  )
}
