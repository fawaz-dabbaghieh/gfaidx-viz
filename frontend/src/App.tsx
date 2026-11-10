import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { GraphCanvas } from './components/GraphCanvas'
import { LengthDistribution } from './components/LengthDistribution'
import { DisplayControls } from './components/DisplayControls'
import { AdvancedControls } from './components/AdvancedControls'
import {
  SELECTION_INFO_PANEL_DEFAULT_WIDTH,
  SELECTION_INFO_PANEL_GAP,
  SELECTION_INFO_PANEL_MIN_WIDTH,
} from './components/SelectionInfoPanel'
import { PathsLegend } from './components/PathsLegend'
import { StatsPanel } from './components/StatsPanel'
import { GraphExtractionControls } from './components/GraphExtractionControls'
import { NodeStyleCsvPanel } from './components/NodeStyleCsvPanel'
import { BandageLayoutWorker } from './utils/BandageLayoutWorker'
import { parseGFA } from './utils/gfaParser'
import { convertGFAToGraph } from './utils/gfaConverter'
import {
  pathHasRepeatedSegments,
  stripNodeOrientation,
} from './utils/displayGraph'
import { parseNodeStyleCsv, applyNodeStyleCsv } from './utils/nodeStyleCsv'
import { parseGeneTrackBed, type GeneRecord } from './utils/geneTrackBed'
import { clampZoom } from './utils/zoom'
import {
  GfaidxResultTooLargeError,
  readBackendError,
  runGfaidxJob,
} from './api/gfaidx'
import type { GfaidxJobProgress } from './api/gfaidx'
import type {
  LayoutOptions,
  LayoutResult,
  ColorScheme,
  Graph,
  IndexedGraph,
  RegionPath,
  BedAnnotation,
} from './types'
import './App.css'

interface AppProps {
  // null briefly while AppLoader is respawning the worker after a Stop
  // Layout request - see onStopLayout.
  worker: BandageLayoutWorker | null
  // Terminates the current layout worker (cancelling anything in progress)
  // and replaces it with a fresh one, ready for the next computeLayout call.
  onStopLayout: () => Promise<void>
}

function getConfiguredBackendUrl(): string {
  return import.meta.env.VITE_BACKEND_URL || 'https://search-dev.foldseek.com'
}

// Hidden for now: the deployed site should just point at the shared backend
// above without exposing a user-facing override control. The underlying
// localStorage override (see getDefaultBackendUrl) still works from devtools
// if a different backend is ever needed for testing; flip this back on to
// restore the visible control.
const SHOW_BACKEND_URL_CONTROL = false

function getDefaultBackendUrl(): string {
  // Host-mode development uses the Vite API proxy. Prefer that configured URL
  // over a stale LAN address saved by an earlier browser session.
  if (import.meta.env.VITE_PREFER_BACKEND_URL === 'true') {
    return getConfiguredBackendUrl()
  }

  return localStorage.getItem('backendUrl') || getConfiguredBackendUrl()
}

function normalizeBackendUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

// Genomic coordinates are always whole basepairs, so any "." or "," a user
// types is a thousands separator - either convention, e.g. "2,500,000" or
// "2.500.000" - never a decimal point. Strip both before parsing.
function parseCoordinateInput(value: string): number {
  return Number(value.replace(/[.,]/g, ''))
}

function formatElapsedSeconds(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

const LOCAL_GRAPH_ID_PREFIX = '__local_graph__:'
// Bump this when the beta notice's wording changes meaningfully, so it
// reappears once for users who already dismissed an older version.
const BETA_BANNER_VERSION = '1'

// Past this many nodes, force-directed layout (and especially linear layout
// with a reference path - see runReferencePathRelax) can take long enough,
// and use enough memory, that the browser tab can feel stuck. This doesn't
// block layout, just makes sure the user knows what they're getting into
// before waiting on it - they can always download the graph and lay it out
// with a desktop tool instead.
const LARGE_GRAPH_NODE_WARNING_THRESHOLD = 50000

// The canvas fills the graph section's width (minus the info panel) and about
// one screen of height. CHROME is the section's own header and padding.
const MIN_CANVAS_WIDTH = 400
const MIN_CANVAS_HEIGHT = 480
const GRAPH_SECTION_CHROME_HEIGHT = 90

const CONTROL_TABS = [
  { id: 'query', label: 'Query' },
  { id: 'display', label: 'Display' },
  { id: 'paths', label: 'Paths' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'styling', label: 'Styling' },
] as const
type ControlTab = (typeof CONTROL_TABS)[number]['id']

// Matches the Go backend's gfaidxMaxNodes cap (gfaidx 2.1.0+): gfaidx
// reserves memory proportional to max_nodes up front, so the server rejects
// anything above this. Mirrored here so an over-large request fails fast
// client-side instead of waiting on a round trip to learn the same limit.
const GFAIDX_MAX_NODES = 1_000_000

function App({ worker, onStopLayout }: AppProps) {
  const [layoutOptions, setLayoutOptions] = useState<LayoutOptions>({
    quality: 2,
    linearLayout: false,
    referencePathName: '',
    referencePathRelaxRounds: 4,
    componentSeparation: 15.0,
    aspectRatio: 1.5,
    nodeLengthPerMegabase: 2000.0,
    minimumNodeLength: 3.0,
    nodeSegmentLength: 5.0,
    edgeLength: 2.0,
  })
  // Set when a coordinate-region query's own path/walk couldn't be used as
  // the linear layout backbone (it repeats a segment), so the user knows why
  // they got the normal force-directed layout instead of what they asked for.
  const [linearLayoutFallbackWarning, setLinearLayoutFallbackWarning] =
    useState<string | null>(null)
  const [layoutResult, setLayoutResult] = useState<LayoutResult | null>(null)
  // Snapshot of the options that actually produced layoutResult, distinct
  // from the live layoutOptions state: the coordinate ruler needs to know
  // what's really drawn, not what's pending in the controls until Redraw.
  const [appliedLayoutOptions, setAppliedLayoutOptions] =
    useState<LayoutOptions | null>(null)
  const [layoutDuration, setLayoutDuration] = useState<number | null>(null)
  const [isComputing, setIsComputing] = useState(false)
  // A single computeLayout() call has no way to report intermediate
  // progress (the WASM/FMMM computation is one opaque blocking call), so
  // this is the best available substitute: a live elapsed-time readout that
  // at least confirms the app is still working rather than stuck, especially
  // since a poorly-covering linear layout reference path can take a minute
  // or more (see runReferencePathRelax).
  const [layoutElapsedMs, setLayoutElapsedMs] = useState(0)
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const [statsDialogOpen, setStatsDialogOpen] = useState(false)
  const [urlDialogOpen, setUrlDialogOpen] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [loadingFile, setLoadingFile] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // An extraction whose result is too large to display; its download link is
  // shown only while loadError is still that extraction's message.
  const [oversizedResult, setOversizedResult] = useState<{
    message: string
    downloadUrl: string
  } | null>(null)
  const oversizedResultUrl =
    oversizedResult && oversizedResult.message === loadError
      ? oversizedResult.downloadUrl
      : null
  const [currentGraph, setCurrentGraph] = useState<Graph | null>(null)
  // The raw GFA text currentGraph was parsed from, kept only so "Download
  // GFA" can hand back exactly what was loaded rather than re-serializing
  // the parsed model (which could lose tags/fields it doesn't interpret).
  // Only used for browser-uploaded/URL-loaded graphs, which have no backend
  // job to re-fetch from; extraction results use currentGraphTicket instead.
  const [currentGraphGfaText, setCurrentGraphGfaText] = useState<
    string | null
  >(null)
  // Ticket of the gfaidx job that produced currentGraph, when it came from a
  // backend extraction. The result stays fetchable from the backend by this
  // ticket, so "Download GFA" re-fetches it instead of holding a second copy
  // of (potentially large) GFA text in memory for the whole session.
  const [currentGraphTicket, setCurrentGraphTicket] = useState<string | null>(
    null,
  )
  const [downloadingGfa, setDownloadingGfa] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem('darkMode')
    return saved !== null ? JSON.parse(saved) : true
  })
  // Bumping BETA_BANNER_VERSION makes the notice reappear even for users who
  // already dismissed an older version of it.
  const [betaBannerDismissed, setBetaBannerDismissed] = useState(
    () => localStorage.getItem('betaBannerDismissed') === BETA_BANNER_VERSION,
  )
  const [colorScheme, setColorScheme] = useState<ColorScheme>('uniform')
  const [zoom, setZoom] = useState<number>(1)
  const [zoomRequestId, setZoomRequestId] = useState(0)
  const [displayZoom, setDisplayZoom] = useState<number>(1)
  const [nodeLocatorInput, setNodeLocatorInput] = useState('')
  const [nodeLocatorError, setNodeLocatorError] = useState<string | null>(null)
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null)
  const [focusNodeRequestId, setFocusNodeRequestId] = useState(0)
  const [contigThickness, setContigThickness] = useState<number>(6)
  const [connectorThickness, setConnectorThickness] = useState<number>(3)
  const [drawLabels, setDrawLabels] = useState<boolean>(false)
  const [labelLengthThreshold, setLabelLengthThreshold] = useState<number>(0)
  const [drawPaths, setDrawPaths] = useState<boolean>(false)
  // Keep path visibility in the React layer so toggling paths never requires
  // recomputing the layout itself.
  const [selectedPathNames, setSelectedPathNames] = useState<string[]>([])
  // Feature C: paths toggled in the Paths legend to show a copy-number
  // track for, under the linear-layout ruler. Independent of
  // selectedPathNames (which drives path-colored edge overlays) since a
  // user may want the CN chart for a path without also drawing its edges.
  const [copyNumberPathNames, setCopyNumberPathNames] = useState<string[]>([])
  const [filterToSelectedPaths, setFilterToSelectedPaths] = useState(false)
  const [nodeColorOverrides, setNodeColorOverrides] = useState<
    Record<string, string>
  >({})
  // Kept separate from nodeColorOverrides/above (rather than merged into one
  // map with provenance tracking) so a CSV load/clear can never disturb
  // path-sourced colors: the two maps are only combined at render time in
  // GraphCanvas, with the CSV taking precedence on any node both cover.
  const [csvColorOverrides, setCsvColorOverrides] = useState<
    Record<string, string>
  >({})
  const [csvLabelOverrides, setCsvLabelOverrides] = useState<
    Record<string, string>
  >({})
  const [csvNodeMetadata, setCsvNodeMetadata] = useState<
    Record<string, Record<string, string>>
  >({})
  // Summary info for the styling panel (headers/separator/match counts/
  // category legend) - kept distinct from the override maps above so the
  // panel can render its own UI without re-deriving this from the raw CSV.
  const [nodeStyleCsvInfo, setNodeStyleCsvInfo] = useState<{
    headers: string[]
    separator: '\t' | ','
    matchedNodes: number
    unmatchedRows: number[]
    categoryColours: Record<string, string>
  } | null>(null)
  // Feature B (gene track): raw parsed BED records, unfiltered - the match
  // against the active reference path's sequenceName happens in GraphCanvas,
  // since that's where referencePathCoordinates (and therefore which
  // reference is even active) already lives.
  const [geneTrackAnnotations, setGeneTrackAnnotations] = useState<
    GeneRecord[]
  >([])
  const [geneTrackFileName, setGeneTrackFileName] = useState<string | null>(
    null,
  )
  const [showGeneTrack, setShowGeneTrack] = useState(true)
  const [indexedGraphs, setIndexedGraphs] = useState<IndexedGraph[]>([])
  const [selectedIndexedGraph, setSelectedIndexedGraph] = useState('')
  const [localGraphOption, setLocalGraphOption] =
    useState<IndexedGraph | null>(null)
  const [isLoadingIndexedGraphs, setIsLoadingIndexedGraphs] = useState(false)
  const [indexedGraphError, setIndexedGraphError] = useState<string | null>(null)
  const [regionPaths, setRegionPaths] = useState<RegionPath[]>([])
  const [selectedRegionPathIndex, setSelectedRegionPathIndex] = useState(0)
  const [isLoadingRegionPaths, setIsLoadingRegionPaths] = useState(false)
  const [regionPathError, setRegionPathError] = useState<string | null>(null)
  const [subgraphStartNode, setSubgraphStartNode] = useState('')
  const [subgraphMaxNodes, setSubgraphMaxNodes] = useState('200')
  const [regionMaxNodes, setRegionMaxNodes] = useState('200')
  const [extractionWithCoords, setExtractionWithCoords] = useState(false)
  const [extractAllHaplotypes, setExtractAllHaplotypes] = useState(true)
  const [manualRegionReference, setManualRegionReference] = useState('')
  const [manualRegionSequence, setManualRegionSequence] = useState('')
  const [regionStart, setRegionStart] = useState('')
  const [regionEnd, setRegionEnd] = useState('')
  const [gfaidxJobProgress, setGfaidxJobProgress] =
    useState<GfaidxJobProgress | null>(null)
  const gfaidxJobAbortController = useRef<AbortController | null>(null)
  const [controlTab, setControlTab] = useState<ControlTab>('query')
  const [bedAnnotations, setBedAnnotations] = useState<BedAnnotation[]>([])
  const [selectedBedAnnotation, setSelectedBedAnnotation] =
    useState<BedAnnotation | null>(null)
  const [backendUrl, setBackendUrl] = useState(getDefaultBackendUrl)
  const [backendUrlInput, setBackendUrlInput] = useState(getDefaultBackendUrl)
  const isExtractingSubgraph = gfaidxJobProgress !== null

  const graphSelectionOptions = useMemo(() => {
    if (!localGraphOption) return indexedGraphs

    return [
      localGraphOption,
      ...indexedGraphs.filter(graph => graph.id !== localGraphOption.id),
    ]
  }, [indexedGraphs, localGraphOption])

  const selectedGraphSupportsExtraction = useMemo(
    () => indexedGraphs.some(graph => graph.id === selectedIndexedGraph),
    [indexedGraphs, selectedIndexedGraph],
  )

  const selectedGraphIsLocal =
    localGraphOption?.id === selectedIndexedGraph

  // Drop any stale selections from a previous graph load and preserve the
  // current graph's path ordering for the selector.
  const visiblePathNames = useMemo(() => {
    if (!currentGraph?.paths) return []

    const availablePathNames = new Set(currentGraph.paths.map(path => path.name))
    return selectedPathNames.filter(pathName => availablePathNames.has(pathName))
  }, [currentGraph?.paths, selectedPathNames])

  const visiblePathNameSet = useMemo(
    () => new Set(visiblePathNames),
    [visiblePathNames],
  )

  const handleControlZoomChange = useCallback((nextZoom: number) => {
    const clampedZoom = clampZoom(nextZoom)
    setZoom(clampedZoom)
    setZoomRequestId(currentId => currentId + 1)
    setDisplayZoom(clampedZoom)
  }, [])

  const handleCanvasZoomChange = useCallback((nextZoom: number) => {
    setDisplayZoom(clampZoom(nextZoom))
  }, [])

  const handleLocateNode = useCallback(() => {
    const query = nodeLocatorInput.trim()
    if (!query) {
      setNodeLocatorError('Enter a node ID')
      return
    }

    if (!currentGraph || !layoutResult) {
      setNodeLocatorError('Load and lay out a graph first')
      return
    }

    const normalizedQuery = stripNodeOrientation(query)
    const matchingNode =
      currentGraph.nodes.find(
        node => node.id === query || node.name === query,
      ) ??
      currentGraph.nodes.find(
        node => stripNodeOrientation(node.id) === normalizedQuery,
      )

    if (!matchingNode) {
      setNodeLocatorError(`Node "${query}" is not in the current graph`)
      return
    }

    setNodeLocatorError(null)
    setFocusNodeId(matchingNode.id)
    setFocusNodeRequestId(currentId => currentId + 1)
  }, [currentGraph, layoutResult, nodeLocatorInput])

  const handleApplyBackendUrl = useCallback(() => {
    const nextBackendUrl = normalizeBackendUrl(backendUrlInput)
    if (!nextBackendUrl) return

    localStorage.setItem('backendUrl', nextBackendUrl)
    setBackendUrl(nextBackendUrl)
  }, [backendUrlInput])

  const handleResetBackendUrl = useCallback(() => {
    const defaultBackendUrl = normalizeBackendUrl(getConfiguredBackendUrl())

    localStorage.removeItem('backendUrl')
    setBackendUrl(defaultBackendUrl)
    setBackendUrlInput(defaultBackendUrl)
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadIndexedGraphs = async () => {
      try {
        setIsLoadingIndexedGraphs(true)
        setIndexedGraphError(null)

        const response = await fetch(`${backendUrl}/api/gfaidx/graphs`)
        if (!response.ok) {
          const errorText = await readBackendError(response)
          throw new Error(errorText || `Backend returned HTTP ${response.status}`)
        }

        const graphs = (await response.json()) as IndexedGraph[]
        if (cancelled) return

        setIndexedGraphs(graphs)
        setSelectedIndexedGraph(currentGraphId => {
          if (currentGraphId.startsWith(LOCAL_GRAPH_ID_PREFIX)) {
            return currentGraphId
          }

          if (graphs.some(graph => graph.id === currentGraphId)) {
            return currentGraphId
          }

          return graphs[0]?.id ?? ''
        })
      } catch (error) {
        if (cancelled) return

        const message =
          error instanceof Error ? error.message : 'Failed to load graph list'
        setIndexedGraphError(message)
        setIndexedGraphs([])
        setSelectedIndexedGraph(currentGraphId =>
          currentGraphId.startsWith(LOCAL_GRAPH_ID_PREFIX)
            ? currentGraphId
            : '',
        )
      } finally {
        if (!cancelled) {
          setIsLoadingIndexedGraphs(false)
        }
      }
    }

    loadIndexedGraphs()

    return () => {
      cancelled = true
    }
  }, [backendUrl])

  useEffect(() => {
    let cancelled = false

    const loadRegionPaths = async () => {
      if (!selectedIndexedGraph || !selectedGraphSupportsExtraction) {
        setIsLoadingRegionPaths(false)
        setRegionPathError(null)
        setRegionPaths([])
        setSelectedRegionPathIndex(0)
        setManualRegionReference('')
        setManualRegionSequence('')
        setRegionStart('')
        setRegionEnd('')
        return
      }

      try {
        setIsLoadingRegionPaths(true)
        setRegionPathError(null)
        setRegionPaths([])
        setSelectedRegionPathIndex(0)
        setManualRegionReference('')
        setManualRegionSequence('')
        setRegionStart('')
        setRegionEnd('')

        const response = await fetch(
          `${backendUrl}/api/gfaidx/graphs/${encodeURIComponent(
            selectedIndexedGraph,
          )}/region-paths`,
        )
        if (!response.ok) {
          const errorText = await readBackendError(response)
          throw new Error(errorText || `Backend returned HTTP ${response.status}`)
        }

        const paths = (await response.json()) as RegionPath[]
        if (cancelled) return

        setRegionPaths(paths)
        setSelectedRegionPathIndex(0)
        const firstPath = paths[0]
        if (firstPath) {
          // See handleSelectedRegionPathChange for why null is handled here.
          const defaultEnd =
            firstPath.end === null
              ? firstPath.start + 100000
              : Math.min(firstPath.start + 100000, firstPath.end)
          setManualRegionReference(firstPath.reference)
          setManualRegionSequence(firstPath.sequence)
          setRegionStart(String(firstPath.start))
          setRegionEnd(String(defaultEnd))
        } else {
          setManualRegionReference('')
          setManualRegionSequence('')
          setRegionStart('')
          setRegionEnd('')
        }
      } catch (error) {
        if (cancelled) return

        const message =
          error instanceof Error
            ? error.message
            : 'Failed to load coordinate tracks'
        setRegionPathError(message)
        setRegionPaths([])
        setSelectedRegionPathIndex(0)
        setManualRegionReference('')
        setManualRegionSequence('')
        setRegionStart('')
        setRegionEnd('')
      } finally {
        if (!cancelled) {
          setIsLoadingRegionPaths(false)
        }
      }
    }

    loadRegionPaths()

    return () => {
      cancelled = true
    }
  }, [backendUrl, selectedGraphSupportsExtraction, selectedIndexedGraph])

  const handleSelectedRegionPathChange = useCallback(
    (index: number) => {
      const regionPath = regionPaths[index]
      setSelectedRegionPathIndex(index)

      if (regionPath) {
        // regionPath.end is null for a path gfaidx can't size (e.g. a pggb
        // P-line with no .cdx entry) - there's no known upper bound to clamp
        // against in that case, so just offer a 100kb window from the start.
        const defaultEnd =
          regionPath.end === null
            ? regionPath.start + 100000
            : Math.min(regionPath.start + 100000, regionPath.end)
        setManualRegionReference(regionPath.reference)
        setManualRegionSequence(regionPath.sequence)
        setRegionStart(String(regionPath.start))
        setRegionEnd(String(defaultEnd))
      }
    },
    [regionPaths],
  )

  const handleBedAnnotationsChange = useCallback(
    (annotations: BedAnnotation[]) => {
      setBedAnnotations(annotations)
      setSelectedBedAnnotation(null)
    },
    [],
  )

  const handleSelectBedAnnotation = useCallback(
    (annotation: BedAnnotation, flankBp: number) => {
      if (
        !annotation.chromosome ||
        annotation.start === null ||
        annotation.end === null ||
        annotation.end <= annotation.start
      ) {
        setLoadError(
          'Choose valid chromosome, start, and end columns before using this annotation.',
        )
        return
      }

      const normalizeName = (name: string) =>
        name.trim().toLowerCase().replace(/^chr/, '')
      const annotationChromosome = normalizeName(annotation.chromosome)
      const matchingRegionPathIndex = regionPaths.findIndex(regionPath => {
        const sequence = normalizeName(regionPath.sequence)
        const label = normalizeName(regionPath.label)

        return (
          sequence === annotationChromosome ||
          label === annotationChromosome ||
          label.includes(annotation.chromosome.trim().toLowerCase())
        )
      })
      const matchingRegionPath =
        matchingRegionPathIndex >= 0
          ? regionPaths[matchingRegionPathIndex]
          : undefined
      const flankedStart = Math.max(
        matchingRegionPath?.start ?? 0,
        annotation.start - flankBp,
      )
      // As above: a null path end means there's nothing to clamp against.
      const flankedEnd =
        matchingRegionPath && matchingRegionPath.end !== null
          ? Math.min(matchingRegionPath.end, annotation.end + flankBp)
          : annotation.end + flankBp

      setSelectedBedAnnotation(annotation)
      setRegionStart(String(flankedStart))
      setRegionEnd(String(flankedEnd))

      if (matchingRegionPathIndex >= 0) {
        setSelectedRegionPathIndex(matchingRegionPathIndex)
        setManualRegionReference(
          regionPaths[matchingRegionPathIndex]?.reference ?? '',
        )
        setManualRegionSequence(
          regionPaths[matchingRegionPathIndex]?.sequence ?? annotation.chromosome,
        )
        setLoadError(null)
      } else {
        setManualRegionReference('')
        setManualRegionSequence(annotation.chromosome)
        setLoadError(null)
      }
    },
    [regionPaths],
  )

  // Handle loading GFA from text
  const loadGFAFromText = useCallback(
    (
      text: string,
      filename: string,
      source: 'browser' | 'backend-extraction' = 'browser',
      ticket?: string,
      // Only set for a coordinate-region extraction: identifies the
      // path/walk the user actually queried, so it can become the linear
      // layout backbone automatically instead of forcing another manual
      // step to re-select what was just asked for.
      regionQuery?: { reference: string; sequence: string },
    ) => {
      try {
        setLoadingFile(true)
        setLoadError(null)
        setLinearLayoutFallbackWarning(null)

        const gfaGraph = parseGFA(text)
        const graph = convertGFAToGraph(gfaGraph, filename)

        if (source === 'browser') {
          const localGraphId = `${LOCAL_GRAPH_ID_PREFIX}${filename}`
          setLocalGraphOption({
            id: localGraphId,
            name: `${filename} (local, not indexed)`,
            description:
              'Loaded in the browser without backend-accessible index files',
          })
          setSelectedIndexedGraph(localGraphId)
        } else {
          setLocalGraphOption(null)
        }

        setCurrentGraph(graph)
        // Extraction results are re-downloadable by ticket, so there's no
        // need to also keep the text around; uploaded/URL text has no
        // backend copy to fall back on, so that one is kept.
        setCurrentGraphGfaText(ticket ? null : text)
        setCurrentGraphTicket(ticket ?? null)
        setColorScheme('uniform')
        setDrawLabels(false)

        const queriedPath = regionQuery
          ? graph.paths?.find(
              path =>
                path.walk?.sequenceName === regionQuery.sequence &&
                (!regionQuery.reference ||
                  path.walk?.sampleName === regionQuery.reference),
            )
          : undefined

        if (queriedPath && pathHasRepeatedSegments(queriedPath.nodeIds)) {
          setLinearLayoutFallbackWarning(
            `Couldn't use "${queriedPath.name}" as the linear layout backbone ` +
              'because it repeats a segment (it contains a loop) - showing ' +
              'the normal layout instead.',
          )
        }

        // Linear layout and path display both key off path names from the
        // previous graph, which almost never exist in a newly loaded one -
        // except right after a coordinate-region query, where the queried
        // path is a natural default backbone as long as it isn't a loop.
        setLayoutOptions(current => ({
          ...current,
          linearLayout:
            queriedPath !== undefined &&
            !pathHasRepeatedSegments(queriedPath.nodeIds),
          referencePathName:
            queriedPath && !pathHasRepeatedSegments(queriedPath.nodeIds)
              ? queriedPath.name
              : '',
        }))
        setDrawPaths(false)
        setFileMenuOpen(false)
        // Both are keyed by node identity (CSV) or reference sequence name
        // (gene track) from the *previous* graph - carrying them over could
        // silently mis-apply to a same-shaped but different new graph rather
        // than just doing nothing, which is worse than clearing them.
        setCsvColorOverrides({})
        setCsvLabelOverrides({})
        setCsvNodeMetadata({})
        setNodeStyleCsvInfo(null)
        setGeneTrackAnnotations([])
        setGeneTrackFileName(null)
      } catch (error) {
        console.error('Failed to parse GFA:', error)
        setLoadError(
          error instanceof Error ? error.message : 'Failed to parse GFA file',
        )
      } finally {
        setLoadingFile(false)
      }
    },
    [],
  )

  const saveGfaTextAsFile = useCallback((text: string, filename: string) => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, [])

  // Extraction results are re-fetched from the backend by ticket rather than
  // re-serialized from a client-held copy - the backend's result endpoint
  // serves the file inline (not as an attachment) and lives on a different
  // origin than the GitHub Pages frontend, so the browser's `download`
  // attribute can't apply to a direct link to it; fetching the bytes
  // ourselves and handing them to a blob: link sidesteps both problems.
  const handleDownloadGfa = useCallback(async () => {
    if (!currentGraph) return

    const filename = currentGraph.name.endsWith('.gfa')
      ? currentGraph.name
      : `${currentGraph.name}.gfa`

    if (currentGraphTicket) {
      try {
        setDownloadingGfa(true)
        // ?download=true: the backend (gfaidx 2.1.0+) now refuses results
        // over its display limit (200MB default) on a plain fetch, so the
        // frontend doesn't load something too large to render - but this
        // button's whole purpose is handing the user the raw file regardless
        // of size, which is exactly what that flag is for.
        const resultUrl = `${backendUrl}/api/result/gfaidx/${encodeURIComponent(
          currentGraphTicket,
        )}?download=true`
        const response = await fetch(resultUrl)
        if (!response.ok) {
          throw new Error(await readBackendError(response))
        }
        saveGfaTextAsFile(await response.text(), filename)
      } catch (error) {
        setLoadError(
          error instanceof Error
            ? error.message
            : 'Failed to download GFA from the backend',
        )
      } finally {
        setDownloadingGfa(false)
      }
      return
    }

    if (currentGraphGfaText !== null) {
      saveGfaTextAsFile(currentGraphGfaText, filename)
    }
  }, [
    backendUrl,
    currentGraph,
    currentGraphGfaText,
    currentGraphTicket,
    saveGfaTextAsFile,
  ])

  // Stop polling when this visualizer is unmounted. Clearing the ref first
  // also prevents the in-flight request from updating an unmounted component.
  useEffect(() => {
    return () => {
      const controller = gfaidxJobAbortController.current
      gfaidxJobAbortController.current = null
      controller?.abort()
    }
  }, [])

  // All gfaidx queries use the Go backend's existing queue contract: submit a
  // job, poll its ticket, then retrieve the completed GFA result.
  const runBackendExtraction = useCallback(
    async (submissionPath: string, payload: unknown) => {
      gfaidxJobAbortController.current?.abort()
      const controller = new AbortController()
      gfaidxJobAbortController.current = controller

      try {
        return await runGfaidxJob({
          backendUrl,
          submissionPath,
          payload,
          signal: controller.signal,
          onProgress: setGfaidxJobProgress,
        })
      } finally {
        if (gfaidxJobAbortController.current === controller) {
          gfaidxJobAbortController.current = null
          setGfaidxJobProgress(null)
        }
      }
    },
    [backendUrl],
  )

  // Handle loading from URL
  const handleLoadFromURL = useCallback(async () => {
    if (!urlInput.trim()) return

    try {
      setLoadingFile(true)
      setLoadError(null)

      const response = await fetch(urlInput)
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const text = await response.text()
      const filename = urlInput.split('/').pop() || 'URL Graph'
      loadGFAFromText(text, filename)
      setUrlDialogOpen(false)
      setUrlInput('')
    } catch (error) {
      console.error('Failed to load from URL:', error)
      setLoadError(
        error instanceof Error ? error.message : 'Failed to load from URL',
      )
    } finally {
      setLoadingFile(false)
    }
  }, [urlInput, loadGFAFromText])

  // Ask the backend to run gfaidx against a whitelisted indexed graph, then feed
  // the returned GFA text through the same parser used for uploaded files.
  const handleExtractSubgraph = useCallback(async () => {
    const startNode = subgraphStartNode.trim()
    const maxNodes = Number(subgraphMaxNodes)

    if (!selectedIndexedGraph || !selectedGraphSupportsExtraction) {
      setLoadError('Choose an indexed graph before extracting a subgraph')
      return
    }

    if (!startNode) {
      setLoadError('Enter a start node ID before extracting a subgraph')
      return
    }

    if (
      !Number.isInteger(maxNodes) ||
      maxNodes < 1 ||
      maxNodes > GFAIDX_MAX_NODES
    ) {
      setLoadError(
        `Neighborhood size must be between 1 and ${GFAIDX_MAX_NODES.toLocaleString()}`,
      )
      return
    }

    try {
      setLoadError(null)

      const { gfaText, ticket } = await runBackendExtraction(
        '/api/ticket/gfaidx/subgraph',
        {
          graph_id: selectedIndexedGraph,
          start_node: startNode,
          max_nodes: maxNodes,
          with_coords: extractionWithCoords,
        },
      )
      const coordinateSuffix = extractionWithCoords ? '_with_coords' : ''
      loadGFAFromText(
        gfaText,
        `${selectedIndexedGraph}_${startNode}_${maxNodes}_nodes${coordinateSuffix}.gfa`,
        'backend-extraction',
        ticket,
      )
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return

      const message =
        error instanceof Error ? error.message : 'Failed to extract subgraph'
      if (error instanceof GfaidxResultTooLargeError) {
        setOversizedResult({ message, downloadUrl: error.downloadUrl })
      }
      setLoadError(message)
    }
  }, [
    extractionWithCoords,
    loadGFAFromText,
    runBackendExtraction,
    selectedGraphSupportsExtraction,
    selectedIndexedGraph,
    subgraphMaxNodes,
    subgraphStartNode,
  ])

  const handleExtractRegion = useCallback(async () => {
    const selectedRegionPath = regionPaths[selectedRegionPathIndex]
    const reference = selectedRegionPath?.reference ?? manualRegionReference.trim()
    const sequence = selectedRegionPath?.sequence ?? manualRegionSequence.trim()
    const start = parseCoordinateInput(regionStart)
    const end = parseCoordinateInput(regionEnd)
    const maxNodes = Number(regionMaxNodes)

    if (!selectedIndexedGraph || !selectedGraphSupportsExtraction) {
      setLoadError('Choose an indexed graph before extracting a region')
      return
    }

    if (!sequence) {
      setLoadError('Enter a sequence before extracting a region')
      return
    }

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0) {
      setLoadError('Region start and end must be non-negative integers')
      return
    }

    if (end <= start) {
      setLoadError('Region end must be greater than start')
      return
    }

    if (
      selectedRegionPath &&
      (start < selectedRegionPath.start ||
        (selectedRegionPath.end !== null && end > selectedRegionPath.end))
    ) {
      setLoadError('Region must stay within the selected coordinate track bounds')
      return
    }

    if (
      !extractAllHaplotypes &&
      (!Number.isInteger(maxNodes) ||
        maxNodes < 1 ||
        maxNodes > GFAIDX_MAX_NODES)
    ) {
      setLoadError(
        `Neighborhood size must be between 1 and ${GFAIDX_MAX_NODES.toLocaleString()}`,
      )
      return
    }

    try {
      setLoadError(null)

      const { gfaText, ticket } = await runBackendExtraction(
        '/api/ticket/gfaidx/region',
        {
          graph_id: selectedIndexedGraph,
          reference,
          sequence,
          start,
          end,
          max_nodes: extractAllHaplotypes ? undefined : maxNodes,
          with_coords: extractionWithCoords,
          all_haplotypes: extractAllHaplotypes,
        },
      )
      const referencePrefix = reference
        ? `${reference}_`
        : ''
      const modeSuffix = extractAllHaplotypes ? '_all_haplotypes' : ''
      const coordinateSuffix = extractionWithCoords ? '_with_coords' : ''
      loadGFAFromText(
        gfaText,
        `${selectedIndexedGraph}_${referencePrefix}${sequence}_${start}_${end}${modeSuffix}${coordinateSuffix}.gfa`,
        'backend-extraction',
        ticket,
        { reference, sequence },
      )
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return

      const message =
        error instanceof Error ? error.message : 'Failed to extract region'
      if (error instanceof GfaidxResultTooLargeError) {
        setOversizedResult({ message, downloadUrl: error.downloadUrl })
      }
      setLoadError(message)
    }
  }, [
    extractAllHaplotypes,
    extractionWithCoords,
    loadGFAFromText,
    manualRegionReference,
    manualRegionSequence,
    regionEnd,
    regionMaxNodes,
    regionPaths,
    regionStart,
    runBackendExtraction,
    selectedGraphSupportsExtraction,
    selectedIndexedGraph,
    selectedRegionPathIndex,
  ])

  // Handle loading from local file
  const handleLoadFromFile = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (!file) return

      const reader = new FileReader()
      reader.onload = e => {
        const text = e.target?.result as string
        if (text) {
          loadGFAFromText(text, file.name)
        }
      }
      reader.onerror = () => {
        setLoadError('Failed to read file')
      }
      reader.readAsText(file)

      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    },
    [loadGFAFromText],
  )

  useEffect(() => {
    setNodeLocatorInput('')
    setNodeLocatorError(null)
    setFocusNodeId(null)
    setFilterToSelectedPaths(false)
    setLayoutOptions(currentOptions => {
      if (!currentOptions.referencePathName) return currentOptions

      const referencePath = currentGraph?.paths?.find(
        path => path.name === currentOptions.referencePathName,
      )
      const hasRepeatedSegment =
        referencePath && pathHasRepeatedSegments(referencePath.nodeIds)

      return referencePath && !hasRepeatedSegment
        ? currentOptions
        : { ...currentOptions, referencePathName: '' }
    })

    if (!currentGraph?.paths) {
      setSelectedPathNames([])
      setCopyNumberPathNames([])
      setNodeColorOverrides({})
      return
    }

    const availablePathNames = new Set(currentGraph.paths.map(path => path.name))
    setSelectedPathNames(currentSelected =>
      currentSelected.filter(pathName => availablePathNames.has(pathName)),
    )
    // Same reasoning as selectedPathNames above: a toggled-on copy-number
    // path name from a previous graph almost never matches a name in a new
    // one, so filtering by availability and blind-clearing come to nearly
    // the same result - filtering is just the one consistent pattern that's
    // also correct for the edge case of reloading the same graph.
    setCopyNumberPathNames(current =>
      current.filter(pathName => availablePathNames.has(pathName)),
    )
    setNodeColorOverrides({})
  }, [currentGraph])

  useEffect(() => {
    // Avoid an unexpectedly blank canvas if the final selected path is
    // deselected or the Paths panel is closed.
    if (!drawPaths || visiblePathNames.length === 0) {
      setFilterToSelectedPaths(false)
    }
  }, [drawPaths, visiblePathNames.length])

  const handleColorPathNodes = useCallback(
    (pathName: string, color: string): number => {
      const path = currentGraph?.paths?.find(candidate => candidate.name === pathName)
      if (!path || !currentGraph) return 0

      const normalizedColor = color.startsWith('#') ? color : `#${color}`
      const graphNodeIds = new Set(currentGraph.nodes.map(node => node.id))
      const graphNodeIdsByDisplayKey = new Map<string, string[]>()

      for (const node of currentGraph.nodes) {
        const displayKey = stripNodeOrientation(node.id)
        const existingIds = graphNodeIdsByDisplayKey.get(displayKey) ?? []
        existingIds.push(node.id)
        graphNodeIdsByDisplayKey.set(displayKey, existingIds)
      }

      const matchedNodeIds = new Set<string>()
      const matchedDisplayKeys = new Set<string>()

      path.nodeIds.forEach(pathNodeId => {
        const displayKey = stripNodeOrientation(pathNodeId)
        const candidateNodeIds = [
          pathNodeId,
          displayKey,
          ...(graphNodeIdsByDisplayKey.get(displayKey) ?? []),
        ]

        candidateNodeIds.forEach(candidateNodeId => {
          if (graphNodeIds.has(candidateNodeId)) {
            matchedNodeIds.add(candidateNodeId)
            matchedDisplayKeys.add(stripNodeOrientation(candidateNodeId))
          }
        })
      })

      if (matchedNodeIds.size === 0) {
        return 0
      }

      setNodeColorOverrides(currentOverrides => {
        const nextOverrides = { ...currentOverrides }

        matchedNodeIds.forEach(nodeId => {
          nextOverrides[nodeId] = normalizedColor
        })

        return nextOverrides
      })

      return matchedDisplayKeys.size
    },
    [currentGraph],
  )

  const handleClearPathNodeColors = useCallback(() => {
    setNodeColorOverrides({})
  }, [])

  // Feature C: toggles whether a path's copy-number track is shown under the
  // linear-layout ruler.
  const handleToggleCopyNumberPath = useCallback((pathName: string) => {
    setCopyNumberPathNames(current =>
      current.includes(pathName)
        ? current.filter(name => name !== pathName)
        : [...current, pathName],
    )
  }, [])

  // Feature A: parses a BandageNG-compatible node styling CSV/TSV and
  // applies it on top of the currently loaded graph. Throws (left for the
  // panel to catch and display) rather than swallowing errors, since a
  // silently-failed load is exactly the "coloured nothing" failure mode the
  // spec calls out.
  const handleLoadNodeStyleCsv = useCallback(
    (text: string) => {
      if (!currentGraph) {
        throw new Error('Load a graph before loading a node styling file.')
      }

      const csv = parseNodeStyleCsv(text)
      const result = applyNodeStyleCsv(csv, currentGraph.nodes)

      setCsvColorOverrides(result.colorOverrides)
      setCsvLabelOverrides(result.labelOverrides)
      setCsvNodeMetadata(result.metadata)
      setNodeStyleCsvInfo({
        headers: csv.headers,
        separator: csv.separator,
        matchedNodes: result.matchedNodes,
        unmatchedRows: result.unmatchedRows,
        categoryColours: csv.categoryColours,
      })
    },
    [currentGraph],
  )

  const handleClearNodeStyleCsv = useCallback(() => {
    setCsvColorOverrides({})
    setCsvLabelOverrides({})
    setCsvNodeMetadata({})
    setNodeStyleCsvInfo(null)
  }, [])

  // Feature B: parses a BED file for the gene track. Chrom-vs-reference
  // matching happens later in GraphCanvas (see geneTrackAnnotations' own
  // comment above), so this just needs valid BED syntax.
  const handleLoadGeneTrackBed = useCallback((text: string, fileName: string) => {
    const genes = parseGeneTrackBed(text)
    setGeneTrackAnnotations(genes)
    setGeneTrackFileName(fileName)
  }, [])

  const handleClearGeneTrack = useCallback(() => {
    setGeneTrackAnnotations([])
    setGeneTrackFileName(null)
  }, [])

  const effectiveLayoutOptions = useMemo(() => {
    if (!layoutOptions.linearLayout || !layoutOptions.referencePathName) {
      return layoutOptions
    }

    const referencePath = currentGraph?.paths?.find(
      path => path.name === layoutOptions.referencePathName,
    )
    const hasRepeatedSegment =
      referencePath && pathHasRepeatedSegments(referencePath.nodeIds)

    return referencePath && !hasRepeatedSegment
      ? layoutOptions
      : { ...layoutOptions, referencePathName: '' }
  }, [currentGraph?.paths, layoutOptions])

  // Matches the "Number of Nodes" count shown above the graph window, so the
  // warning threshold means the same thing to the user in both places.
  const graphNodeCount =
    currentGraph?.sourceRecordCounts?.segments ?? currentGraph?.nodes.length ?? 0
  const isLargeGraph = graphNodeCount > LARGE_GRAPH_NODE_WARNING_THRESHOLD
  const hasPathsInGraph = (currentGraph?.paths?.length ?? 0) > 0

  const graphSectionRef = useRef<HTMLElement>(null)
  const [graphSectionWidth, setGraphSectionWidth] = useState(1200)
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight)
  // The info panel can be dragged wider to read long path names. The chosen
  // width is remembered, and clamped so the canvas keeps its minimum width.
  const [infoPanelWidth, setInfoPanelWidth] = useState(() => {
    const saved = Number(localStorage.getItem('selectionInfoPanelWidth'))
    return saved > 0 ? saved : SELECTION_INFO_PANEL_DEFAULT_WIDTH
  })
  useEffect(() => {
    localStorage.setItem('selectionInfoPanelWidth', String(infoPanelWidth))
  }, [infoPanelWidth])
  useEffect(() => {
    const section = graphSectionRef.current
    if (!section) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setGraphSectionWidth(Math.floor(entry.contentRect.width))
    })
    observer.observe(section)
    const handleResize = () => setViewportHeight(window.innerHeight)
    window.addEventListener('resize', handleResize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [])
  const maxInfoPanelWidth = Math.max(
    SELECTION_INFO_PANEL_MIN_WIDTH,
    graphSectionWidth - MIN_CANVAS_WIDTH - SELECTION_INFO_PANEL_GAP,
  )
  const clampedInfoPanelWidth = Math.min(
    maxInfoPanelWidth,
    Math.max(SELECTION_INFO_PANEL_MIN_WIDTH, infoPanelWidth),
  )
  const canvasWidth = Math.max(
    MIN_CANVAS_WIDTH,
    graphSectionWidth - clampedInfoPanelWidth - SELECTION_INFO_PANEL_GAP,
  )
  const canvasHeight = Math.max(
    MIN_CANVAS_HEIGHT,
    viewportHeight - GRAPH_SECTION_CHROME_HEIGHT,
  )

  // Use a ref to track the current request ID, so a stale in-flight
  // computation (e.g. the user loaded a different graph, or hit Stop, while
  // one was still running) can't overwrite state after the fact.
  const requestIdRef = useRef(0)

  // Layout is user-triggered rather than automatic: loading a graph is
  // instant regardless of size, and a potentially slow/heavy layout only
  // starts when the user actually asks for it via the Compute
  // Layout/Redraw button - the same load-then-layout split BandageNG uses,
  // so a huge graph never makes the app look stuck the moment it's opened.
  const computeLayout = useCallback(async () => {
    if (!worker || !currentGraph) {
      console.warn('Worker not ready or no graph loaded')
      return
    }

    const currentRequestId = ++requestIdRef.current
    setIsComputing(true)
    try {
      const { result, duration } = await worker.computeLayout(
        currentGraph,
        effectiveLayoutOptions,
      )

      if (currentRequestId === requestIdRef.current) {
        setLayoutResult(result)
        setLayoutDuration(duration)
        setAppliedLayoutOptions(effectiveLayoutOptions)
      }
    } catch (error) {
      if (currentRequestId === requestIdRef.current) {
        console.error('Layout computation failed:', error)
      }
    } finally {
      if (currentRequestId === requestIdRef.current) {
        setIsComputing(false)
      }
    }
  }, [worker, currentGraph, effectiveLayoutOptions])

  // A newly loaded graph starts with no layout at all (see computeLayout
  // above) - this just makes sure a *previous* graph's stale layout/result
  // doesn't linger on screen while the new one waits for the user to
  // trigger a layout.
  useEffect(() => {
    requestIdRef.current++
    setLayoutResult(null)
    setAppliedLayoutOptions(null)
    setIsComputing(false)
  }, [currentGraph])

  useEffect(() => {
    if (!isComputing) {
      setLayoutElapsedMs(0)
      return
    }

    const startedAt = Date.now()
    setLayoutElapsedMs(0)
    const intervalId = window.setInterval(() => {
      setLayoutElapsedMs(Date.now() - startedAt)
    }, 250)

    return () => window.clearInterval(intervalId)
  }, [isComputing])

  // Cancels an in-progress layout computation. requestIdRef is bumped first
  // so the terminated worker's eventual rejection (see BandageLayoutWorker's
  // terminate()) is recognized as stale and ignored rather than clearing
  // isComputing a second time.
  const handleStopLayout = useCallback(async () => {
    requestIdRef.current++
    setIsComputing(false)
    await onStopLayout()
  }, [onStopLayout])

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!fileMenuOpen && !viewMenuOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (
        !(e.target as Element).closest('.menu-item') &&
        !(e.target as Element).closest('.dropdown-item')
      ) {
        setFileMenuOpen(false)
        setViewMenuOpen(false)
      }
    }

    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [fileMenuOpen, viewMenuOpen])

  // Close dialog with Escape key
  useEffect(() => {
    if (!statsDialogOpen) return

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setStatsDialogOpen(false)
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [statsDialogOpen])

  // Close URL dialog with Escape key
  useEffect(() => {
    if (!urlDialogOpen) return

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setUrlDialogOpen(false)
        setLoadError(null)
        setUrlInput('')
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [urlDialogOpen])

  // Save dark mode preference to localStorage
  useEffect(() => {
    localStorage.setItem('darkMode', JSON.stringify(isDarkMode))
  }, [isDarkMode])

  return (
    <div className={`app ${isDarkMode ? 'dark-mode' : ''}`}>
      {!betaBannerDismissed && (
        <div className="beta-banner" role="note">
          <span>
            <strong>Beta:</strong> this site is still in beta and only a
            handful of graphs are preset for testing - more will be added to
            the server over time. Subgraph extraction is currently slow
            because graphs are served from a spinning-disk HDD; this will
            move to NVMe storage soon, which should make extraction much
            faster. Suggestions and issues are welcome on{' '}
            <a
              href="https://github.com/fawaz-dabbaghieh/graphviz_wasm/issues"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
            .
          </span>
          <button
            type="button"
            className="beta-banner-dismiss"
            aria-label="Dismiss"
            onClick={() => {
              setBetaBannerDismissed(true)
              localStorage.setItem('betaBannerDismissed', BETA_BANNER_VERSION)
            }}
          >
            ×
          </button>
        </div>
      )}
      <header className="app-header">
        <div className="header-top">
          <h1>gfaidx-viz</h1>
          <div className="menu-bar">
            <div className="menu-item">
              <button
                className="menu-button"
                onClick={() => setFileMenuOpen(!fileMenuOpen)}
              >
                File
              </button>
              {fileMenuOpen && (
                <div className="dropdown-menu">
                  <button
                    className="dropdown-item"
                    onClick={() => {
                      setUrlDialogOpen(true)
                      setFileMenuOpen(false)
                    }}
                  >
                    <div className="dropdown-item-title">Open URL</div>
                    <div className="dropdown-item-desc">
                      Load GFA from a URL
                    </div>
                  </button>
                  <button
                    className="dropdown-item"
                    onClick={() => {
                      fileInputRef.current?.click()
                      setFileMenuOpen(false)
                    }}
                  >
                    <div className="dropdown-item-title">Open Local File</div>
                    <div className="dropdown-item-desc">
                      Load GFA from your computer
                    </div>
                  </button>
                </div>
              )}
            </div>

            <div className="menu-item">
              <button
                className="menu-button"
                onClick={() => setViewMenuOpen(!viewMenuOpen)}
              >
                View
              </button>
              {viewMenuOpen && (
                <div className="dropdown-menu">
                  <button
                    className="dropdown-item"
                    onClick={() => {
                      setStatsDialogOpen(true)
                      setViewMenuOpen(false)
                    }}
                    disabled={!currentGraph}
                  >
                    Statistics
                  </button>
                  <label className="dropdown-checkbox-item">
                    <input
                      type="checkbox"
                      checked={isDarkMode}
                      onChange={e => setIsDarkMode(e.target.checked)}
                    />
                    <span>Dark Mode</span>
                  </label>
                </div>
              )}
            </div>

            <button
              className="menu-button menu-button-accent"
              onClick={handleDownloadGfa}
              disabled={
                !currentGraph ||
                (currentGraphGfaText === null && currentGraphTicket === null) ||
                downloadingGfa
              }
              title="Save the currently loaded graph to a .gfa file"
            >
              {downloadingGfa ? 'Downloading...' : 'Download Current Graph'}
            </button>
          </div>
          {SHOW_BACKEND_URL_CONTROL && (
            <form
              className="backend-url-control"
              onSubmit={event => {
                event.preventDefault()
                handleApplyBackendUrl()
              }}
            >
              <label htmlFor="backend-url-input">Backend</label>
              <input
                id="backend-url-input"
                type="url"
                value={backendUrlInput}
                onChange={event =>
                  setBackendUrlInput(event.currentTarget.value)
                }
                placeholder="http://192.168.1.10:18081"
              />
              <button type="submit">Apply</button>
              <button type="button" onClick={handleResetBackendUrl}>
                Reset
              </button>
            </form>
          )}
        </div>
      </header>

      {/* Surface file/backend load failures outside modal dialogs. Without this
          banner, extraction errors are stored but easy for users to miss. */}
      {loadError && !urlDialogOpen && (
        <div className="load-error-banner" role="alert">
          <pre>{loadError}</pre>
          {oversizedResultUrl && (
            // A new tab keeps the viewer open if the backend shows the file
            // inline instead of saving it (backends before the attachment fix).
            <a href={oversizedResultUrl} target="_blank" rel="noopener noreferrer">
              Download GFA
            </a>
          )}
          <button type="button" onClick={() => setLoadError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <main className="app-main">
        {/* Everything that drives the graph lives in these tabs above it:
            the query that extracts a subgraph, then how it's drawn. */}
        <section className="visualization-section controls-section">
          <div
            className="view-switch"
            role="tablist"
            aria-label="Graph controls"
          >
            {CONTROL_TABS.map(tab => (
              <button
                key={tab.id}
                type="button"
                className={controlTab === tab.id ? 'active' : undefined}
                onClick={() => setControlTab(tab.id)}
                role="tab"
                aria-selected={controlTab === tab.id}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tabs stay mounted and are only hidden, so e.g. the path list
              keeps its search text and scroll position between visits. */}
          <div hidden={controlTab !== 'query'}>
            <GraphExtractionControls
              graphs={graphSelectionOptions}
              selectedGraphId={selectedIndexedGraph}
              onSelectedGraphIdChange={setSelectedIndexedGraph}
              supportsExtraction={selectedGraphSupportsExtraction}
              selectedGraphIsLocal={selectedGraphIsLocal}
              graphListError={indexedGraphError}
              isLoadingGraphs={isLoadingIndexedGraphs}
              nodeMaxNodes={subgraphMaxNodes}
              onNodeMaxNodesChange={setSubgraphMaxNodes}
              regionMaxNodes={regionMaxNodes}
              onRegionMaxNodesChange={setRegionMaxNodes}
              withCoords={extractionWithCoords}
              onWithCoordsChange={setExtractionWithCoords}
              nodeStart={subgraphStartNode}
              onNodeStartChange={setSubgraphStartNode}
              onExtractNode={handleExtractSubgraph}
              regionPaths={regionPaths}
              selectedRegionPathIndex={selectedRegionPathIndex}
              onSelectedRegionPathIndexChange={handleSelectedRegionPathChange}
              regionPathError={regionPathError}
              isLoadingRegionPaths={isLoadingRegionPaths}
              manualRegionReference={manualRegionReference}
              onManualRegionReferenceChange={setManualRegionReference}
              manualRegionSequence={manualRegionSequence}
              onManualRegionSequenceChange={setManualRegionSequence}
              regionStart={regionStart}
              onRegionStartChange={setRegionStart}
              regionEnd={regionEnd}
              onRegionEndChange={setRegionEnd}
              allHaplotypes={extractAllHaplotypes}
              onAllHaplotypesChange={setExtractAllHaplotypes}
              onExtractRegion={handleExtractRegion}
              isExtracting={isExtractingSubgraph}
              jobProgress={gfaidxJobProgress}
              extractionError={loadError}
              extractionDownloadUrl={oversizedResultUrl}
              bedAnnotations={bedAnnotations}
              selectedBedAnnotation={selectedBedAnnotation}
              onBedAnnotationsChange={handleBedAnnotationsChange}
              onSelectBedAnnotation={handleSelectBedAnnotation}
            />
          </div>
          <div hidden={controlTab !== 'display'}>
            <DisplayControls
              options={layoutOptions}
              onChange={setLayoutOptions}
              isComputing={isComputing}
              zoom={displayZoom}
              onZoomChange={handleControlZoomChange}
              hasPathsInGraph={hasPathsInGraph}
              paths={currentGraph?.paths ?? []}
              colorScheme={colorScheme}
              onColorSchemeChange={setColorScheme}
              drawLabels={drawLabels}
              onDrawLabelsChange={setDrawLabels}
              hasGeneTrack={geneTrackAnnotations.length > 0}
              showGeneTrack={showGeneTrack}
              onShowGeneTrackChange={setShowGeneTrack}
            />
          </div>
          <div hidden={controlTab !== 'paths'}>
            <div className="settings-tab-content">
              <div className="control-group">
                <label>
                  <input
                    type="checkbox"
                    checked={drawPaths}
                    onChange={e => setDrawPaths(e.target.checked)}
                    disabled={isComputing || !hasPathsInGraph}
                  />{' '}
                  List Paths{!hasPathsInGraph && ' (no paths present)'}
                </label>
                <div className="control-hint">
                  Show the path list. Select paths there to draw overlays.
                </div>
              </div>
            </div>
            {drawPaths &&
              currentGraph?.paths &&
              currentGraph.paths.length > 0 && (
                <PathsLegend
                  paths={currentGraph.paths}
                  isDarkMode={isDarkMode}
                  selectedPathNames={visiblePathNames}
                  onTogglePath={pathName =>
                    setSelectedPathNames(currentSelected =>
                      currentSelected.includes(pathName)
                        ? currentSelected.filter(name => name !== pathName)
                        : [...currentSelected, pathName],
                    )
                  }
                  onSelectAll={() =>
                    setSelectedPathNames(
                      currentGraph.paths?.map(path => path.name) ?? [],
                    )
                  }
                  onDeselectAll={() => setSelectedPathNames([])}
                  filterToSelectedPaths={filterToSelectedPaths}
                  onFilterToSelectedPathsChange={setFilterToSelectedPaths}
                  onColorPathNodes={handleColorPathNodes}
                  onClearNodeColors={handleClearPathNodeColors}
                  copyNumberPathNames={copyNumberPathNames}
                  onToggleCopyNumberPath={handleToggleCopyNumberPath}
                  hasCopyNumberTrack={
                    !!appliedLayoutOptions?.linearLayout &&
                    !!appliedLayoutOptions?.referencePathName
                  }
                />
              )}
          </div>
          <div hidden={controlTab !== 'advanced'}>
            <AdvancedControls
              options={layoutOptions}
              onChange={setLayoutOptions}
              isComputing={isComputing}
              contigThickness={contigThickness}
              onContigThicknessChange={setContigThickness}
              connectorThickness={connectorThickness}
              onConnectorThicknessChange={setConnectorThickness}
              labelLengthThreshold={labelLengthThreshold}
              onLabelLengthThresholdChange={setLabelLengthThreshold}
            />
          </div>
          <div hidden={controlTab !== 'styling'}>
            <NodeStyleCsvPanel
              hasGraph={!!currentGraph}
              onLoadCsv={handleLoadNodeStyleCsv}
              onClearCsv={handleClearNodeStyleCsv}
              csvInfo={nodeStyleCsvInfo}
              onLoadGeneTrackBed={handleLoadGeneTrackBed}
              onClearGeneTrack={handleClearGeneTrack}
              geneTrackFileName={geneTrackFileName}
              geneTrackCount={geneTrackAnnotations.length}
            />
          </div>
        </section>

        <section
          className="visualization-section graph-section"
          ref={graphSectionRef}
        >
          <div className="graph-layout-header">
            <div className="graph-layout-title">
              <h3>Graph Layout</h3>
              <button
                type="button"
                className="compute-button graph-layout-compute-button"
                onClick={computeLayout}
                disabled={!currentGraph || isComputing}
                title={
                  isLargeGraph
                    ? 'Large graph - layout may be slow or use a lot of memory.'
                    : undefined
                }
              >
                {isComputing
                  ? layoutResult
                    ? 'Redrawing...'
                    : 'Computing Layout...'
                  : layoutResult
                    ? 'Redraw'
                    : 'Compute Layout'}
              </button>
              {currentGraph?.sourceRecordCounts && (
                <div className="graph-layout-counts">
                  <span>
                    Number of Nodes:{' '}
                    {currentGraph.sourceRecordCounts.segments.toLocaleString()}
                  </span>
                  <span>
                    Number of Edges:{' '}
                    {currentGraph.sourceRecordCounts.links.toLocaleString()}
                  </span>
                  <span>
                    Paths/Walks:{' '}
                    {(currentGraph.paths?.length ?? 0).toLocaleString()}
                  </span>
                </div>
              )}
            </div>
            <form
              className="node-locator-form"
              onSubmit={event => {
                event.preventDefault()
                handleLocateNode()
              }}
            >
              <input
                className="control-input node-locator-input"
                type="search"
                value={nodeLocatorInput}
                onChange={event => {
                  setNodeLocatorInput(event.currentTarget.value)
                  setNodeLocatorError(null)
                }}
                placeholder="Node ID"
                aria-label="Node ID to locate"
                disabled={isComputing || !layoutResult}
              />
              <button
                className="node-locator-button"
                type="submit"
                disabled={
                  isComputing || !layoutResult || !nodeLocatorInput.trim()
                }
              >
                Go to Node
              </button>
            </form>
          </div>
          {nodeLocatorError && (
            <div className="node-locator-error" role="alert">
              {nodeLocatorError}
            </div>
          )}
          {linearLayoutFallbackWarning && (
            <div className="control-warning">{linearLayoutFallbackWarning}</div>
          )}
          {isComputing ? (
            <div className="loading" style={{ height: canvasHeight }}>
              <div className="spinner"></div>
              <p>Computing layout... ({formatElapsedSeconds(layoutElapsedMs)})</p>
              {layoutElapsedMs > 15000 && (
                <p className="loading-hint">
                  Still working - large graphs, or Linear Layout with a
                  reference path that only covers part of the graph, can
                  take a while.
                </p>
              )}
              <button
                type="button"
                className="stop-layout-button"
                onClick={handleStopLayout}
              >
                Stop Layout
              </button>
            </div>
          ) : layoutResult ? (
            <GraphCanvas
              layoutResult={layoutResult}
              graph={currentGraph}
              width={canvasWidth}
              height={canvasHeight}
              isDarkMode={isDarkMode}
              colorScheme={colorScheme}
              zoom={zoom}
              zoomRequestId={zoomRequestId}
              onInternalZoomChange={handleCanvasZoomChange}
              focusNodeId={focusNodeId}
              focusNodeRequestId={focusNodeRequestId}
              contigThickness={contigThickness}
              connectorThickness={connectorThickness}
              drawLabels={drawLabels}
              labelLengthThreshold={labelLengthThreshold}
              drawPaths={drawPaths}
              linearLayout={appliedLayoutOptions?.linearLayout ?? false}
              referencePathName={
                appliedLayoutOptions?.referencePathName ?? ''
              }
              visiblePathIds={visiblePathNameSet}
              filterToSelectedPaths={filterToSelectedPaths}
              nodeColorOverrides={nodeColorOverrides}
              csvColorOverrides={csvColorOverrides}
              nodeLabelOverrides={csvLabelOverrides}
              nodeCsvMetadata={csvNodeMetadata}
              geneTrackAnnotations={showGeneTrack ? geneTrackAnnotations : []}
              copyNumberPathNames={copyNumberPathNames}
              onUseAsStartNode={setSubgraphStartNode}
              infoPanelWidth={clampedInfoPanelWidth}
              infoPanelMaxWidth={maxInfoPanelWidth}
              onInfoPanelWidthChange={setInfoPanelWidth}
            />
          ) : currentGraph ? (
            <div className="placeholder" style={{ height: canvasHeight }}>
              <div className="placeholder-content">
                <p>Press Compute Layout above to visualize the graph</p>
                {isLargeGraph && (
                  <p className="placeholder-warning">
                    This graph has {graphNodeCount.toLocaleString()}{' '}
                    nodes, more than the{' '}
                    {LARGE_GRAPH_NODE_WARNING_THRESHOLD.toLocaleString()}{' '}
                    layout tends to stay comfortable at. Laying it out
                    may be slow or use a lot of memory - you can still
                    try it, or use "Download Current Graph" above and
                    process it with a desktop tool instead.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="placeholder" style={{ height: canvasHeight }}>
              <p>Load a GFA file from the File menu to get started</p>
            </div>
          )}
        </section>
      </main>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".gfa,.gfa1,.gfa2"
        style={{ display: 'none' }}
        onChange={handleLoadFromFile}
      />

      {/* URL Dialog */}
      {urlDialogOpen && (
        <div
          className="dialog-overlay"
          onClick={() => {
            setUrlDialogOpen(false)
            setLoadError(null)
            setUrlInput('')
          }}
        >
          <div className="dialog-content" onClick={e => e.stopPropagation()}>
            <div className="dialog-header">
              <h2>Open GFA from URL</h2>
              <button
                className="dialog-close"
                onClick={() => {
                  setUrlDialogOpen(false)
                  setLoadError(null)
                  setUrlInput('')
                }}
              >
                ×
              </button>
            </div>
            <div className="dialog-body">
              <div style={{ marginBottom: '15px' }}>
                <label
                  htmlFor="url-input"
                  style={{
                    display: 'block',
                    marginBottom: '8px',
                    fontWeight: 500,
                  }}
                >
                  GFA File URL:
                </label>
                <input
                  id="url-input"
                  type="text"
                  value={urlInput}
                  onChange={e => setUrlInput(e.target.value)}
                  placeholder="https://example.com/graph.gfa"
                  disabled={loadingFile}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !loadingFile) {
                      handleLoadFromURL()
                    }
                  }}
                  style={{
                    width: '100%',
                    padding: '8px',
                    fontSize: '14px',
                    border: isDarkMode ? '1px solid #444' : '1px solid #ddd',
                    borderRadius: '4px',
                    background: isDarkMode ? '#1a1a1a' : 'white',
                    color: isDarkMode ? '#e0e0e0' : '#333',
                  }}
                />
              </div>
              {loadError && (
                <div
                  style={{
                    padding: '10px',
                    marginBottom: '15px',
                    background: '#fee',
                    border: '1px solid #fcc',
                    borderRadius: '4px',
                    color: '#c33',
                    fontSize: '13px',
                  }}
                >
                  {loadError}
                </div>
              )}
              <div
                style={{
                  display: 'flex',
                  gap: '10px',
                  justifyContent: 'flex-end',
                }}
              >
                <button
                  onClick={() => {
                    setUrlDialogOpen(false)
                    setLoadError(null)
                    setUrlInput('')
                  }}
                  disabled={loadingFile}
                  style={{
                    padding: '8px 16px',
                    fontSize: '14px',
                    border: isDarkMode ? '1px solid #444' : '1px solid #ddd',
                    borderRadius: '4px',
                    background: isDarkMode ? '#2a2a2a' : '#f5f5f5',
                    color: isDarkMode ? '#e0e0e0' : '#333',
                    cursor: loadingFile ? 'not-allowed' : 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleLoadFromURL}
                  disabled={loadingFile || !urlInput.trim()}
                  style={{
                    padding: '8px 16px',
                    fontSize: '14px',
                    border: 'none',
                    borderRadius: '4px',
                    background:
                      loadingFile || !urlInput.trim() ? '#ccc' : '#0066cc',
                    color: 'white',
                    cursor:
                      loadingFile || !urlInput.trim()
                        ? 'not-allowed'
                        : 'pointer',
                  }}
                >
                  {loadingFile ? 'Loading...' : 'Load'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Statistics Dialog */}
      {statsDialogOpen && currentGraph && (
        <div
          className="dialog-overlay"
          onClick={() => setStatsDialogOpen(false)}
        >
          <div className="dialog-content" onClick={e => e.stopPropagation()}>
            <div className="dialog-header">
              <h2>Graph Statistics</h2>
              <button
                className="dialog-close"
                onClick={() => setStatsDialogOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="dialog-body">
              <StatsPanel
                graph={currentGraph}
                layoutDuration={layoutDuration}
              />
              <div className="stats-section">
                <h3>Length Distribution</h3>
                <LengthDistribution
                  graph={currentGraph}
                  isDarkMode={isDarkMode}
                  width={700}
                  height={220}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
