import { memo, useEffect, useRef, useState, useCallback, useMemo } from 'react'
import {
  useFloating,
  offset,
  flip,
  shift,
  autoUpdate,
} from '@floating-ui/react'
import type {
  LayoutResult,
  Graph,
  Transform,
  GraphNode,
  ColorScheme,
} from '../types'
import {
  buildDisplayGraph,
  filterDisplayGraphByPaths,
  updateDisplayGraphNodePositions,
  resolveDisplaySegments,
  stripNodeOrientation,
  resolveTraversalEdge,
  resolveTraversalPathName,
  groupEdgeTraversalsByDirection,
  countPathVisitsToNode,
} from '../utils/displayGraph'
import {
  SelectionInfoPanel,
  SELECTION_INFO_PANEL_DEFAULT_WIDTH,
  type SelectionInfo,
} from './SelectionInfoPanel'
import { clampZoom } from '../utils/zoom'
import { type GeneRecord, stripPanSNPrefix } from '../utils/geneTrackBed'

// A point in the reference-path coordinate ruler's piecewise-linear mapping
// between a node's world-space x position and its base-pair offset along the
// path. Two per node (its start and end) rather than one per node boundary,
// so the small world-space gap the layouter leaves between consecutive nodes
// maps to a flat (zero bp-per-pixel) span instead of diluting a real node's
// bp-per-pixel ratio.
interface PathCoordinateBreakpoint {
  worldX: number
  bp: number
}

// Caps how tall the gene track above the ruler can grow: beyond this many
// overlapping genes at one screen position, the extras collapse into a
// "+N more" indicator rather than the reserved band growing without bound.
const MAX_GENE_TRACK_LANES = 3
const GENE_LANE_HEIGHT = 16
const GENE_LANE_GAP = 3

// One backbone (reference/linear-layout path) node's position in the ruler's
// bp coordinate system, plus its bare segment name - the join key used to
// look up how many times some *other* path revisits this same node (see the
// copy-number track below).
interface BackboneNodeSpan {
  bareName: string
  bpStart: number
  bpEnd: number
}

// Feature C: a "copy number" track showing, for a user-chosen path, how many
// times it revisits each part of the backbone's own coordinate space -
// local amplification (a path visiting a backbone node repeatedly, e.g. a
// tandem duplication collapsed onto one shared node by graph construction)
// shows up as a plateau above 1 right where it happens on the ruler.
//
// The bin width is a fixed fraction of the backbone's total bp span, not a
// fixed bp size - so resolution (always ~100 points) scales automatically
// with whatever region is loaded, rather than needing a per-graph bp window
// the user would otherwise have to tune by hand.
const COPY_NUMBER_BIN_FRACTION = 0.01
const COPY_NUMBER_BIN_COUNT = Math.round(1 / COPY_NUMBER_BIN_FRACTION)
const COPY_NUMBER_TRACK_HEIGHT = 60
// Vertical gap between adjacent bands in the reserved bottom strip (e.g.
// between the gene track and the copy-number chart, when both are present).
const BAND_GAP = 8

function worldXToBp(
  breakpoints: PathCoordinateBreakpoint[],
  worldX: number,
): number {
  const first = breakpoints[0]!
  const last = breakpoints[breakpoints.length - 1]!
  if (worldX <= first.worldX) return first.bp
  if (worldX >= last.worldX) return last.bp

  for (let i = 0; i + 1 < breakpoints.length; i++) {
    const a = breakpoints[i]!
    const b = breakpoints[i + 1]!
    if (worldX >= a.worldX && worldX <= b.worldX) {
      if (b.worldX === a.worldX) return a.bp
      const t = (worldX - a.worldX) / (b.worldX - a.worldX)
      return a.bp + t * (b.bp - a.bp)
    }
  }
  return last.bp
}

// The inverse of worldXToBp, for placing gene-track boxes (which come in bp
// coordinates) onto the screen. Unlike worldXToBp this returns null outside
// the path's bp range rather than clamping - an off-screen gene should be
// skipped entirely, not drawn squashed onto the end of the axis.
//
// Mirrors worldXToBp's structure exactly, including the b.bp === a.bp guard:
// breakpoints come in pairs per node (see PathCoordinateBreakpoint above),
// and the pair spanning the gap between one node's end and the next node's
// start shares the same bp (nothing was added to cumulativeBp between them)
// while still covering a real worldX range - a query bp landing exactly on
// that shared value must resolve to a worldX, not divide by zero.
function bpToWorldX(
  breakpoints: PathCoordinateBreakpoint[],
  bp: number,
): number | null {
  const first = breakpoints[0]!
  const last = breakpoints[breakpoints.length - 1]!
  if (bp < first.bp || bp > last.bp) return null

  for (let i = 0; i + 1 < breakpoints.length; i++) {
    const a = breakpoints[i]!
    const b = breakpoints[i + 1]!
    if (bp >= a.bp && bp <= b.bp) {
      if (b.bp === a.bp) return a.worldX
      const t = (bp - a.bp) / (b.bp - a.bp)
      return a.worldX + t * (b.worldX - a.worldX)
    }
  }
  return last.worldX
}

export interface CopyNumberTrackData {
  firstBp: number
  binSizeBp: number
  binCount: number
  // null = no backbone coverage landed in this bin at all (shouldn't happen
  // in practice since backbone nodes tile the bp range with no gaps, but
  // guarded rather than assumed).
  tracks: Map<string, (number | null)[]>
}

// Bins a path's per-node occurrence counts (relative to the backbone node
// they share a bare segment name with) into COPY_NUMBER_BIN_COUNT equal-bp-
// width bins across the backbone's full span - a length-weighted pileup,
// the same technique used to turn a set of (possibly node-length-mismatched)
// intervals into a fixed-resolution coverage/bedgraph-style track. Weighting
// by the overlap length between each backbone node and each bin it touches
// (rather than one count per bin naively) keeps the result correct when a
// single long node spans multiple bins, or many short nodes share one bin.
function computeCopyNumberBins(
  backboneNodeSpans: BackboneNodeSpan[],
  queryNodeCounts: Map<string, number>,
  binCount: number,
): (number | null)[] | null {
  if (backboneNodeSpans.length === 0) return null

  const firstBp = backboneNodeSpans[0]!.bpStart
  const lastBp = backboneNodeSpans[backboneNodeSpans.length - 1]!.bpEnd
  const totalSpan = lastBp - firstBp
  if (totalSpan <= 0) return null

  const binSize = totalSpan / binCount
  const weightedSums = new Array<number>(binCount).fill(0)
  const coveredLengths = new Array<number>(binCount).fill(0)

  for (const span of backboneNodeSpans) {
    if (span.bpEnd <= span.bpStart) continue
    // A node absent from the query path entirely (e.g. a true deletion, or
    // just a different allele through an ordinary SNP/indel bubble at this
    // position) contributes 0, not "no data" - 0 is itself informative here.
    const count = queryNodeCounts.get(span.bareName) ?? 0

    let binIndex = Math.max(
      0,
      Math.floor((span.bpStart - firstBp) / binSize),
    )
    while (binIndex < binCount) {
      const binStart = firstBp + binIndex * binSize
      const binEnd = binStart + binSize
      const overlapStart = Math.max(span.bpStart, binStart)
      const overlapEnd = Math.min(span.bpEnd, binEnd)
      if (overlapEnd <= overlapStart) break

      const overlapLength = overlapEnd - overlapStart
      weightedSums[binIndex]! += count * overlapLength
      coveredLengths[binIndex]! += overlapLength

      if (overlapEnd >= span.bpEnd) break
      binIndex++
    }
  }

  return weightedSums.map((sum, i) =>
    coveredLengths[i]! > 0 ? sum / coveredLengths[i]! : null,
  )
}

// "Nice numbers" axis ticking (Heckbert): picks a human-friendly step (1, 2,
// or 5 times a power of ten) so tick density stays readable at any zoom
// level instead of e.g. landing on every 137 bp.
function niceNumber(value: number, round: boolean): number {
  if (value <= 0) return 1
  const exponent = Math.floor(Math.log10(value))
  const fraction = value / Math.pow(10, exponent)
  let niceFraction: number
  if (round) {
    if (fraction < 1.5) niceFraction = 1
    else if (fraction < 3) niceFraction = 2
    else if (fraction < 7) niceFraction = 5
    else niceFraction = 10
  } else {
    if (fraction <= 1) niceFraction = 1
    else if (fraction <= 2) niceFraction = 2
    else if (fraction <= 5) niceFraction = 5
    else niceFraction = 10
  }
  return niceFraction * Math.pow(10, exponent)
}

function formatCoordinateLabel(bp: number, sequenceName: string | null): string {
  const formatted = Math.round(bp).toLocaleString()
  return sequenceName ? `${sequenceName}:${formatted}` : formatted
}

interface GraphCanvasProps {
  layoutResult: LayoutResult
  graph: Graph
  width?: number
  height?: number
  isDarkMode?: boolean
  colorScheme?: ColorScheme
  zoom?: number
  zoomRequestId?: number
  onInternalZoomChange?: (zoom: number) => void
  focusNodeId?: string | null
  focusNodeRequestId?: number
  contigThickness?: number
  connectorThickness?: number
  drawLabels?: boolean
  labelLengthThreshold?: number
  drawPaths?: boolean
  // Drives the reference-path coordinate ruler: only a straightened path has
  // a single meaningful coordinate axis to draw ticks along.
  linearLayout?: boolean
  referencePathName?: string
  // The selector hands the canvas the exact set of path IDs that should remain
  // visible without changing the underlying graph model.
  visiblePathIds?: Set<string>
  filterToSelectedPaths?: boolean
  nodeColorOverrides?: Record<string, string>
  // Feature A (CSV node styling). Kept as separate props from
  // nodeColorOverrides (path-coloring) rather than pre-merged by the caller,
  // so each source's precedence is decided in one place (see
  // nodeColorsById below) and clearing one can never clobber the other.
  csvColorOverrides?: Record<string, string>
  nodeLabelOverrides?: Record<string, string>
  nodeCsvMetadata?: Record<string, Record<string, string>>
  // Feature B (gene track). Unfiltered - matching against the active
  // reference path's sequence name happens inside this component, where
  // referencePathCoordinates is already computed.
  geneTrackAnnotations?: GeneRecord[]
  // Feature C (copy-number track): names of paths the user has toggled on in
  // the Paths legend, each drawn as its own colored line.
  copyNumberPathNames?: string[]
  onUseAsStartNode?: (nodeId: string) => void
  // Sized by App, which also fits the canvas into whatever width is left.
  infoPanelWidth?: number
  infoPanelMaxWidth?: number
  onInfoPanelWidthChange?: (width: number) => void
  debugHitboxes?: boolean // Hidden flag to visualize edge hit areas
}

const SEQUENCE_PREVIEW_CUTOFF = 100
const SEQUENCE_PREVIEW_PREFIX_LENGTH = Math.ceil(SEQUENCE_PREVIEW_CUTOFF / 2)
const SEQUENCE_PREVIEW_SUFFIX_LENGTH = Math.floor(SEQUENCE_PREVIEW_CUTOFF / 2)
// Rows shown in the edge hover tooltip before it defers to the info panel.
const EDGE_TOOLTIP_MAX_PATHS = 10
// Pointer travel (px) between mousedown and mouseup still treated as a click.
const CLICK_MOVE_TOLERANCE_PX = 4
// A path crossing an edge several times (e.g. a repeat) is drawn as one
// parallel line per crossing up to this cap, so repeats stand out without a
// heavily looping path fanning out; the exact count is in the tooltip/panel.
const MAX_DRAWN_REPEATS_PER_PATH = 5
// Wheel devices report very different delta sizes, so cap each rotation update
// while retaining small trackpad deltas for continuous motion.
const ROTATION_RADIANS_PER_PIXEL = 0.002
const MAX_ROTATION_STEP = Math.PI / 15
const NO_PATH_TRAVERSALS: Int32Array = new Int32Array(0)

// Keep accumulated angles bounded so trigonometric calculations remain stable
// after long rotation sessions.
function normalizeRotation(rotation: number): number {
  return Math.atan2(Math.sin(rotation), Math.cos(rotation))
}

// Normalize line/page wheel units to approximate CSS pixels before converting
// the movement to radians.
function getWheelDeltaPixels(event: WheelEvent, pageHeight: number): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * 16
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * pageHeight
  }
  return event.deltaY
}

function getNodeSequence(node: GraphNode): string | null {
  if (!node.sequence || node.sequence === '*') return null

  // The single-mode display treats the contig itself as the primary entity, so
  // the details dialog shows the stored segment sequence rather than a strand-
  // specific reverse complement of whichever internal node was displayed.
  return node.sequence
}

function formatSequencePreview(sequence: string): string {
  if (sequence.length <= SEQUENCE_PREVIEW_CUTOFF) return sequence

  return `${sequence.slice(0, SEQUENCE_PREVIEW_PREFIX_LENGTH)}.........${sequence.slice(-SEQUENCE_PREVIEW_SUFFIX_LENGTH)}`
}

function GraphCanvasComponent({
  layoutResult,
  graph,
  width = 800,
  height = 600,
  isDarkMode = true,
  colorScheme = 'uniform',
  zoom,
  zoomRequestId = 0,
  onInternalZoomChange,
  focusNodeId,
  focusNodeRequestId = 0,
  contigThickness = 6,
  connectorThickness = 3,
  drawLabels = true,
  labelLengthThreshold = 0,
  drawPaths = true,
  linearLayout = false,
  referencePathName = '',
  visiblePathIds,
  filterToSelectedPaths = false,
  nodeColorOverrides,
  csvColorOverrides,
  nodeLabelOverrides,
  nodeCsvMetadata,
  geneTrackAnnotations,
  copyNumberPathNames,
  onUseAsStartNode,
  infoPanelWidth = SELECTION_INFO_PANEL_DEFAULT_WIDTH,
  infoPanelMaxWidth = infoPanelWidth,
  onInfoPanelWidthChange,
  debugHitboxes = false,
}: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [transform, setTransform] = useState<Transform>({
    scale: 1,
    rotation: 0,
    translateX: 0,
    translateY: 0,
  })
  const transformRef = useRef<Transform>({
    scale: 1,
    rotation: 0,
    translateX: 0,
    translateY: 0,
  })
  const handledZoomRequestIdRef = useRef(zoomRequestId)
  const handledFocusRequestIdRef = useRef(focusNodeRequestId)
  const zoomReportFrameRef = useRef<number | null>(null)
  const pendingZoomReportRef = useRef<number | null>(null)
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null)
  // Feature B (gene track) hover/tooltip state. The hit rects and the band's
  // screen-Y range are recomputed every draw() (screen-fixed, like the ruler
  // itself) and stashed in refs rather than state, since they're consumed
  // only by the mousemove handler below, not rendered directly.
  const [hoveredGene, setHoveredGene] = useState<{
    gene: GeneRecord
    screenX: number
    screenY: number
  } | null>(null)
  const geneHitRectsRef = useRef<
    { gene: GeneRecord; x: number; y: number; width: number; height: number }[]
  >([])
  const geneTrackBandRef = useRef<{ top: number; bottom: number } | null>(null)
  // Feature C (copy-number track) hover state. Like the gene track's refs
  // above, the band's screen-space extent and each bin's screen-x position
  // are recomputed every draw() and stashed here so handleMouseMove can do a
  // cheap nearest-bin lookup without redoing any bp->world->screen math of
  // its own.
  const [hoveredCopyNumberBin, setHoveredCopyNumberBin] = useState<{
    binIndex: number
    screenX: number
    screenY: number
  } | null>(null)
  const copyNumberBandRef = useRef<{ top: number; bottom: number } | null>(
    null,
  )
  const copyNumberBinPositionsRef = useRef<
    { binIndex: number; screenX: number }[]
  >([])
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 })

  // Floating UI for tooltip
  const { refs, floatingStyles } = useFloating({
    placement: 'top',
    middleware: [offset(10), flip(), shift({ padding: 5 })],
    whileElementsMounted: autoUpdate,
  })
  const [isDraggingNode, setIsDraggingNode] = useState(false)
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null)
  const [modifiedNodePositions, setModifiedNodePositions] = useState<Record<
    string,
    { x: number; y: number }[]
  > | null>(null)
  // The clicked connection shown in the info panel, by DisplayEdge.key
  // (stable across path filtering, unlike an index); a clicked node uses
  // selectedNode.
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null)
  // Where the left button went down, to tell a click from a pan.
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null)
  const activeNodePositions = useMemo(
    () => modifiedNodePositions || layoutResult.nodePositions,
    [layoutResult.nodePositions, modifiedNodePositions],
  )
  // Piecewise-linear world-x <-> bp mapping for the reference-path coordinate
  // ruler, built by walking the straightened path's nodes in order. Genomic
  // coordinates come from GFA W-line walk metadata when present (sequenceStart
  // anchors the first node); otherwise this falls back to a 0-based distance
  // from the path's start.
  const referencePathCoordinates = useMemo(() => {
    if (!linearLayout || !referencePathName) return null

    const path = graph.paths?.find(p => p.name === referencePathName)
    if (!path || path.nodeIds.length === 0) return null

    const nodeById = new Map(graph.nodes.map(node => [node.id, node]))

    const rawStart = path.walk?.sequenceStart
    const parsedStart = rawStart !== undefined ? Number(rawStart) : NaN
    let cumulativeBp = Number.isFinite(parsedStart) ? parsedStart : 0

    const breakpoints: PathCoordinateBreakpoint[] = []
    // Feature C (copy-number track): one entry per backbone node, carrying
    // its bare (orientation-stripped) segment name alongside the same bp
    // span used above. A repeat-free reference path (the only kind allowed
    // as a linear-layout backbone - see pathHasRepeatedSegments) visits each
    // bare name at most once, so this is an unambiguous node -> bp-position
    // lookup table for projecting any other path's node-occurrence counts
    // onto the ruler's coordinate system.
    const backboneNodeSpans: BackboneNodeSpan[] = []

    for (const nodeId of path.nodeIds) {
      const segments = activeNodePositions[nodeId]
      const node = nodeById.get(nodeId)
      if (!segments || segments.length === 0 || !node) continue

      let segMinX = Infinity
      let segMaxX = -Infinity
      for (const segment of segments) {
        segMinX = Math.min(segMinX, segment.x)
        segMaxX = Math.max(segMaxX, segment.x)
      }

      const bpStart = cumulativeBp
      breakpoints.push({ worldX: segMinX, bp: cumulativeBp })
      cumulativeBp += node.length
      breakpoints.push({ worldX: segMaxX, bp: cumulativeBp })
      backboneNodeSpans.push({
        bareName: stripNodeOrientation(nodeId),
        bpStart,
        bpEnd: cumulativeBp,
      })
    }

    if (breakpoints.length < 2) return null

    return {
      sequenceName: path.walk?.sequenceName ?? null,
      minWorldX: breakpoints[0]!.worldX,
      maxWorldX: breakpoints[breakpoints.length - 1]!.worldX,
      breakpoints,
      backboneNodeSpans,
    }
  }, [graph, activeNodePositions, linearLayout, referencePathName])

  // Feature B: assigns each gene BED record on the active reference sequence
  // to a display lane, greedily by start coordinate (a gene goes in the
  // first lane whose last occupant ends before this gene starts). This is a
  // property of the *data* (which gene overlaps which), not the viewport, so
  // it deliberately doesn't depend on scale/pan/zoom - only on which genes
  // and which reference are active - and so doesn't get recomputed on every
  // redraw while panning.
  const geneTrackLanes = useMemo(() => {
    if (!referencePathCoordinates || !geneTrackAnnotations?.length) {
      return null
    }

    const sequenceName = referencePathCoordinates.sequenceName
    if (!sequenceName) return null
    const targetSequenceName = stripPanSNPrefix(sequenceName)

    const matchingGenes = geneTrackAnnotations
      .filter(
        gene => stripPanSNPrefix(gene.chrom) === targetSequenceName,
      )
      .sort((a, b) => a.start - b.start)

    if (matchingGenes.length === 0) return null

    // A small fixed bp padding (rather than a pixel padding) keeps lane
    // *assignment* independent of zoom level - which lane a gene lands in
    // shouldn't change as the user zooms, only how wide it's drawn.
    const LANE_PADDING_BP = 50
    const laneEndBp: number[] = []
    const positioned: { gene: GeneRecord; lane: number }[] = []
    let overflowCount = 0

    for (const gene of matchingGenes) {
      let assignedLane = laneEndBp.findIndex(
        endBp => endBp + LANE_PADDING_BP <= gene.start,
      )
      if (assignedLane === -1) {
        if (laneEndBp.length < MAX_GENE_TRACK_LANES) {
          assignedLane = laneEndBp.length
          laneEndBp.push(gene.end)
        } else {
          overflowCount += 1
          continue
        }
      } else {
        laneEndBp[assignedLane] = gene.end
      }
      positioned.push({ gene, lane: assignedLane })
    }

    return {
      genes: positioned,
      laneCount: laneEndBp.length,
      overflowCount,
    }
  }, [geneTrackAnnotations, referencePathCoordinates])

  // Feature C: for each path the user has toggled on in the Paths legend,
  // counts how many times it visits each backbone node (by bare segment
  // name, so an inverted repeat copy still counts), then bins those counts
  // across the backbone's bp span. Deliberately independent of pan/zoom/
  // transform - like geneTrackLanes above, this is a property of the graph
  // and the current toggle selection, not the viewport, so it doesn't
  // recompute on every redraw while panning.
  const copyNumberTracks = useMemo((): CopyNumberTrackData | null => {
    if (!referencePathCoordinates || !copyNumberPathNames?.length) return null

    const { backboneNodeSpans } = referencePathCoordinates
    if (backboneNodeSpans.length === 0) return null

    const tracks = new Map<string, (number | null)[]>()

    for (const pathName of copyNumberPathNames) {
      const queryPath = graph.paths?.find(p => p.name === pathName)
      if (!queryPath) continue

      const queryNodeCounts = new Map<string, number>()
      for (const nodeId of queryPath.nodeIds) {
        const bareName = stripNodeOrientation(nodeId)
        queryNodeCounts.set(bareName, (queryNodeCounts.get(bareName) ?? 0) + 1)
      }

      const bins = computeCopyNumberBins(
        backboneNodeSpans,
        queryNodeCounts,
        COPY_NUMBER_BIN_COUNT,
      )
      if (bins) tracks.set(pathName, bins)
    }

    if (tracks.size === 0) return null

    const firstBp = backboneNodeSpans[0]!.bpStart
    const lastBp = backboneNodeSpans[backboneNodeSpans.length - 1]!.bpEnd

    return {
      firstBp,
      binSizeBp: (lastBp - firstBp) / COPY_NUMBER_BIN_COUNT,
      binCount: COPY_NUMBER_BIN_COUNT,
      tracks,
    }
  }, [graph.paths, referencePathCoordinates, copyNumberPathNames])

  // Topology (including the expensive per-path traversal walk) only depends
  // on the graph itself, never on a specific layout's node positions - see
  // buildDisplayGraph's own comment. Positions are layered on separately
  // below via updateDisplayGraphNodePositions, so this memo now only
  // recomputes when a new graph is loaded instead of on every redraw.
  const displayGraphTopology = useMemo(() => buildDisplayGraph(graph), [graph])
  const visibleDisplayGraphTopology = useMemo(() => {
    if (!filterToSelectedPaths || !visiblePathIds) {
      return displayGraphTopology
    }

    return filterDisplayGraphByPaths(
      displayGraphTopology,
      graph.paths ?? [],
      visiblePathIds,
    )
  }, [
    displayGraphTopology,
    filterToSelectedPaths,
    graph.paths,
    visiblePathIds,
  ])
  const displayGraph = useMemo(
    () =>
      updateDisplayGraphNodePositions(
        visibleDisplayGraphTopology,
        activeNodePositions,
      ),
    [activeNodePositions, visibleDisplayGraphTopology],
  )
  // Hover hit-testing walks every node's segments on every mouse move, which
  // gets expensive on large graphs. A cached bounding box per node lets that
  // loop skip straight past nodes nowhere near the pointer.
  const nodeBoundsByKey = useMemo(() => {
    const bounds = new Map<
      string,
      { minX: number; maxX: number; minY: number; maxY: number }
    >()

    for (const displayNode of displayGraph.nodes) {
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity

      for (const segment of displayNode.segments) {
        minX = Math.min(minX, segment.x)
        maxX = Math.max(maxX, segment.x)
        minY = Math.min(minY, segment.y)
        maxY = Math.max(maxY, segment.y)
      }

      bounds.set(displayNode.key, { minX, maxX, minY, maxY })
    }

    return bounds
  }, [displayGraph])
  const boundsRef = useRef<{
    minX: number
    maxX: number
    minY: number
    maxY: number
    fitScale: number
    offsetX: number
    offsetY: number
  } | null>(null)
  // Resizing the canvas element clears its backing buffer and resets all
  // context state, which is expensive and unnecessary on redraws that only
  // change hover/selection. Track the last-applied size so draw() only
  // touches canvas.width/height when it actually needs to.
  const canvasSizeRef = useRef<{
    width: number
    height: number
    dpr: number
  } | null>(null)
  // Always holds the most recently created draw() closure, so the rAF
  // callback below can call the version with up-to-date transform/hover/etc.
  // state even if it was scheduled by an earlier, now-stale render.
  const drawRef = useRef<(() => void) | null>(null)
  // Tracks whether a repaint is already queued for the next animation frame,
  // so several redraw requests landing in the same frame (e.g. a burst of
  // mousemove events while panning, each updating transform state) collapse
  // into a single canvas repaint instead of one full repaint per event.
  const pendingDrawFrameRef = useRef<number | null>(null)

  const reportInternalZoom = useCallback(
    (nextZoom: number) => {
      if (!onInternalZoomChange) return

      pendingZoomReportRef.current = nextZoom
      if (zoomReportFrameRef.current !== null) return

      zoomReportFrameRef.current = window.requestAnimationFrame(() => {
        zoomReportFrameRef.current = null
        const zoomToReport = pendingZoomReportRef.current
        pendingZoomReportRef.current = null
        if (zoomToReport !== null) {
          onInternalZoomChange(zoomToReport)
        }
      })
    },
    [onInternalZoomChange],
  )

  useEffect(
    () => () => {
      if (zoomReportFrameRef.current !== null) {
        window.cancelAnimationFrame(zoomReportFrameRef.current)
      }
    },
    [],
  )

  // Fit the view once per new layout. The canvas now follows the window size,
  // so a resize alone must not refit (that would also drop dragged nodes);
  // the effect below keeps the view centred instead.
  const fittedLayoutRef = useRef<LayoutResult | null>(null)
  const lastCanvasSizeRef = useRef({ width, height })
  useEffect(() => {
    if (!layoutResult || fittedLayoutRef.current === layoutResult) return
    fittedLayoutRef.current = layoutResult
    lastCanvasSizeRef.current = { width, height }

    const { nodePositions } = layoutResult
    let minX = Infinity,
      maxX = -Infinity
    let minY = Infinity,
      maxY = -Infinity

    Object.values(nodePositions).forEach(segments => {
      segments.forEach(({ x, y }) => {
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      })
    })

    const graphWidth = maxX - minX
    const graphHeight = maxY - minY
    const padding = 40
    const fitScale = Math.min(
      (width - 2 * padding) / graphWidth,
      (height - 2 * padding) / graphHeight,
    )
    const offsetX = (width - graphWidth * fitScale) / 2 - minX * fitScale
    const offsetY = (height - graphHeight * fitScale) / 2 - minY * fitScale

    const nextTransform = {
      scale: fitScale,
      // A newly computed layout starts in its original OGDF orientation.
      rotation: 0,
      translateX: offsetX,
      translateY: offsetY,
    }

    boundsRef.current = { minX, maxX, minY, maxY, fitScale, offsetX, offsetY }
    transformRef.current = nextTransform
    setTransform(nextTransform)

    reportInternalZoom(fitScale)

    // Reset modified positions when layout changes
    setModifiedNodePositions(null)
  }, [layoutResult, width, height, reportInternalZoom])

  useEffect(() => {
    const lastSize = lastCanvasSizeRef.current
    if (lastSize.width === width && lastSize.height === height) return
    lastCanvasSizeRef.current = { width, height }

    const prev = transformRef.current
    const nextTransform = {
      ...prev,
      translateX: prev.translateX + (width - lastSize.width) / 2,
      translateY: prev.translateY + (height - lastSize.height) / 2,
    }
    transformRef.current = nextTransform
    setTransform(nextTransform)
  }, [width, height])

  // Sync zoom prop to transform when the sidebar slider sends an explicit
  // command. Wheel zoom intentionally does not update this prop.
  useEffect(() => {
    if (zoom === undefined) return
    if (handledZoomRequestIdRef.current === zoomRequestId) return

    handledZoomRequestIdRef.current = zoomRequestId

    const prev = transformRef.current
    if (Math.abs(zoom - prev.scale) < 0.0001) return

    const scaleFactor = zoom / prev.scale
    const centerX = width / 2
    const centerY = height / 2

    const nextTransform = {
      // Slider zoom changes only scale/translation and preserves rotation.
      ...prev,
      scale: zoom,
      translateX: centerX - (centerX - prev.translateX) * scaleFactor,
      translateY: centerY - (centerY - prev.translateY) * scaleFactor,
    }

    transformRef.current = nextTransform
    setTransform(nextTransform)
  }, [zoom, zoomRequestId, width, height])

  useEffect(() => {
    if (!focusNodeId) return
    if (handledFocusRequestIdRef.current === focusNodeRequestId) return

    handledFocusRequestIdRef.current = focusNodeRequestId

    const targetNode = displayGraph.nodes.find(
      node =>
        node.representativeId === focusNodeId ||
        node.nodeIds.includes(focusNodeId) ||
        node.node.name === focusNodeId ||
        node.key === stripNodeOrientation(focusNodeId),
    )
    if (!targetNode || targetNode.segments.length === 0) return

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity

    targetNode.segments.forEach(segment => {
      minX = Math.min(minX, segment.x)
      maxX = Math.max(maxX, segment.x)
      minY = Math.min(minY, segment.y)
      maxY = Math.max(maxY, segment.y)
    })

    const nodeWidth = maxX - minX
    const nodeHeight = maxY - minY
    const rotation = transformRef.current.rotation
    const rotationCosine = Math.cos(rotation)
    const rotationSine = Math.sin(rotation)
    // Project the node's bounding box through the current rotation so focus
    // scaling leaves similar surrounding context at every angle.
    const rotatedNodeWidth =
      Math.abs(nodeWidth * rotationCosine) +
      Math.abs(nodeHeight * rotationSine)
    const rotatedNodeHeight =
      Math.abs(nodeWidth * rotationSine) +
      Math.abs(nodeHeight * rotationCosine)
    const focusWidth = Math.max(rotatedNodeWidth * 4, 80)
    const focusHeight = Math.max(rotatedNodeHeight * 4, 80)
    const availableWidth = Math.max(width - 160, width * 0.5)
    const availableHeight = Math.max(height - 160, height * 0.5)
    const focusScale = Math.min(
      availableWidth / focusWidth,
      availableHeight / focusHeight,
    )
    const nextScale = clampZoom(
      Math.max(boundsRef.current?.fitScale ?? 0, focusScale),
    )
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2
    // Rotate the graph-space node center before solving the translation that
    // places it at the center of the canvas.
    const rotatedCenterX =
      (centerX * rotationCosine - centerY * rotationSine) * nextScale
    const rotatedCenterY =
      (centerX * rotationSine + centerY * rotationCosine) * nextScale
    const nextTransform = {
      scale: nextScale,
      rotation,
      translateX: width / 2 - rotatedCenterX,
      translateY: height / 2 - rotatedCenterY,
    }

    transformRef.current = nextTransform
    setTransform(nextTransform)
    setSelectedNode(targetNode.representativeId)
    setSelectedEdgeKey(null)
    setHoveredNode(null)
    setHoveredEdge(null)
    reportInternalZoom(nextScale)
  }, [
    displayGraph.nodes,
    focusNodeId,
    focusNodeRequestId,
    height,
    reportInternalZoom,
    width,
  ])

  const pathColors = useMemo(() => {
    const colors = new Map<string, string>()
    const paths = graph.paths ?? []
    const hueStep = paths.length > 0 ? 360 / paths.length : 0

    paths.forEach((path, pathIndex) => {
      colors.set(path.name, `hsl(${pathIndex * hueStep}, 70%, 50%)`)
    })
    return colors
  }, [graph.paths])

  const getPathColor = useCallback(
    (pathName: string): string => pathColors.get(pathName) ?? '#888',
    [pathColors],
  )

  // One entry per line to draw: each visible traversal, repeated (adjacent,
  // so it reads as a same-coloured band) once per crossing up to
  // MAX_DRAWN_REPEATS_PER_PATH.
  const visiblePathTraversalsByList = useMemo(() => {
    const visibleTraversals = new Map<Int32Array, Int32Array>()
    const paths = graph.paths ?? []

    for (const edge of displayGraphTopology.edges) {
      if (
        !drawPaths ||
        edge.pathTraversals.length === 0 ||
        visiblePathIds?.size === 0
      ) {
        visibleTraversals.set(edge.pathTraversals, NO_PATH_TRAVERSALS)
      } else if (
        !visiblePathIds &&
        edge.traversalCounts.every(count => count === 1)
      ) {
        visibleTraversals.set(edge.pathTraversals, edge.pathTraversals)
      } else {
        const lines: number[] = []
        edge.pathTraversals.forEach((encoded, i) => {
          if (
            visiblePathIds &&
            !visiblePathIds.has(resolveTraversalPathName(encoded, paths))
          ) {
            return
          }
          const repeats = Math.min(
            edge.traversalCounts[i]!,
            MAX_DRAWN_REPEATS_PER_PATH,
          )
          for (let repeat = 0; repeat < repeats; repeat++) lines.push(encoded)
        })
        visibleTraversals.set(edge.pathTraversals, Int32Array.from(lines))
      }
    }

    return visibleTraversals
  }, [displayGraphTopology.edges, drawPaths, visiblePathIds, graph.paths])

  const getVisiblePathTraversals = useCallback(
    (pathTraversals: Int32Array) =>
      visiblePathTraversalsByList.get(pathTraversals) ?? NO_PATH_TRAVERSALS,
    [visiblePathTraversalsByList],
  )

  useEffect(() => {
    // Filtering can invalidate array-based edge hover state and hide a
    // selected node, so discard transient interactions when its inputs change.
    setHoveredNode(null)
    setHoveredEdge(null)
    setSelectedNode(null)
    setSelectedEdgeKey(null)
  }, [visibleDisplayGraphTopology])

  // Colors depend on graph data and user settings, not the viewport. Cache
  // them so wheel/pan redraws only perform a map lookup per visible node.
  const nodeColorsById = useMemo(() => {
    const colors = new Map<string, [number, number, number]>()
    let minDepth = Infinity
    let maxDepth = -Infinity

    if (colorScheme === 'depth') {
      graph.nodes.forEach(node => {
        if (!Number.isFinite(node.depth)) return
        minDepth = Math.min(minDepth, node.depth)
        maxDepth = Math.max(maxDepth, node.depth)
      })
    }

    const computeNodeColor = (
      node: GraphNode,
    ): [number, number, number] => {
      // CSV styling wins over path-coloring on any node both cover, since
      // loading a CSV is a deliberate, specific action on that node, versus
      // the broader-brush "paint every node on this path" path-coloring.
      const overrideColor =
        csvColorOverrides?.[node.id] ?? nodeColorOverrides?.[node.id]
      if (overrideColor) {
        const normalizedColor = overrideColor.replace(/^#/, '')
        const parsedColor = Number.parseInt(normalizedColor, 16)

        if (normalizedColor.length === 6 && Number.isFinite(parsedColor)) {
          return [
            (parsedColor >> 16) & 255,
            (parsedColor >> 8) & 255,
            parsedColor & 255,
          ]
        }
      }

      switch (colorScheme) {
        case 'uniform':
          // Bandage default: rgb(178, 34, 34) - firebrick red
          return [52, 152, 219]

        case 'random': {
          // Use node ID to generate consistent random color
          let hash = 0
          for (let i = 0; i < node.id.length; i++) {
            hash = node.id.charCodeAt(i) + ((hash << 5) - hash)
          }
          const hue = Math.abs(hash % 360)
          // Convert HSL to RGB
          const s = 0.7
          const l = 0.5
          const c = (1 - Math.abs(2 * l - 1)) * s
          const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
          const m = l - c / 2
          let r = 0,
            g = 0,
            b = 0
          if (hue < 60) {
            r = c
            g = x
            b = 0
          } else if (hue < 120) {
            r = x
            g = c
            b = 0
          } else if (hue < 180) {
            r = 0
            g = c
            b = x
          } else if (hue < 240) {
            r = 0
            g = x
            b = c
          } else if (hue < 300) {
            r = x
            g = 0
            b = c
          } else {
            r = c
            g = 0
            b = x
          }
          return [
            Math.round((r + m) * 255),
            Math.round((g + m) * 255),
            Math.round((b + m) * 255),
          ]
        }

        case 'depth': {
          // Color based on depth - use viridis-like color map
          const normalizedDepth =
            Number.isFinite(node.depth) && maxDepth > minDepth
              ? (node.depth - minDepth) / (maxDepth - minDepth)
              : 0.5

          // Simple viridis-like gradient
          const t = Math.max(0, Math.min(1, normalizedDepth))
          if (t < 0.25) {
            const s = t / 0.25
            return [
              Math.round(68 + (59 - 68) * s),
              Math.round(1 + (82 - 1) * s),
              Math.round(84 + (139 - 84) * s),
            ]
          } else if (t < 0.5) {
            const s = (t - 0.25) / 0.25
            return [
              Math.round(59 + (33 - 59) * s),
              Math.round(82 + (145 - 82) * s),
              Math.round(139 + (140 - 139) * s),
            ]
          } else if (t < 0.75) {
            const s = (t - 0.5) / 0.25
            return [
              Math.round(33 + (94 - 33) * s),
              Math.round(145 + (201 - 145) * s),
              Math.round(140 + (98 - 140) * s),
            ]
          } else {
            const s = (t - 0.75) / 0.25
            return [
              Math.round(94 + (253 - 94) * s),
              Math.round(201 + (231 - 201) * s),
              Math.round(98 + (37 - 98) * s),
            ]
          }
        }

        case 'grey':
          // Medium grey color
          return [160, 160, 160]

        default:
          return [52, 152, 219]
      }
    }

    graph.nodes.forEach(node => {
      colors.set(node.id, computeNodeColor(node))
    })

    return colors
  }, [colorScheme, graph.nodes, nodeColorOverrides, csvColorOverrides])

  const getNodeColor = useCallback(
    (node: GraphNode): [number, number, number] =>
      nodeColorsById.get(node.id) ?? [52, 152, 219],
    [nodeColorsById],
  )

  const getDisplayNodeSegments = useCallback(
    (nodeId: string) => resolveDisplaySegments(nodeId, displayGraph),
    [displayGraph],
  )

  const getEdgeOffset = useCallback(
    (pathIdx: number, numPaths: number, scale: number) => {
      const offsetDist = 3 / scale
      return (pathIdx - (numPaths - 1) / 2) * offsetDist
    },
    [],
  )

  const buildEdgeGeometry = useCallback(
    (edge: Graph['edges'][number], offsetX: number, offsetY: number, scale: number) => {
      const fromSegments = getDisplayNodeSegments(edge.from)
      const toSegments = getDisplayNodeSegments(edge.to)

      if (!fromSegments || !toSegments || fromSegments.length === 0 || toSegments.length === 0) {
        return null
      }

      const fromEnd = fromSegments[fromSegments.length - 1]
      const toStart = toSegments[0]
      if (!fromEnd || !toStart) return null

      const fromBase = stripNodeOrientation(edge.from)
      const toBase = stripNodeOrientation(edge.to)
      const isSelfLoop = edge.from === edge.to
      const isReverseComplementLoop = fromBase === toBase && edge.from !== edge.to

      let segmentDirX = 1
      let segmentDirY = 0
      if (fromSegments.length >= 2) {
        const prevSeg = fromSegments[fromSegments.length - 2]!
        const dx = fromEnd.x - prevSeg.x
        const dy = fromEnd.y - prevSeg.y
        const len = Math.hypot(dx, dy)
        if (len > 0) {
          segmentDirX = dx / len
          segmentDirY = dy / len
        }
      }

      if (isSelfLoop) {
        const extensionLength = 50 / scale
        const cp1x = fromEnd.x + offsetX + segmentDirX * extensionLength
        const cp1y = fromEnd.y + offsetY + segmentDirY * extensionLength
        const cp2x = toStart.x + offsetX - segmentDirX * extensionLength
        const cp2y = toStart.y + offsetY - segmentDirY * extensionLength

        const perpX = -segmentDirY
        const perpY = segmentDirX
        const perpShift = extensionLength

        const nodeMidX = (fromEnd.x + toStart.x) / 2 + offsetX
        const nodeMidY = (fromEnd.y + toStart.y) / 2 + offsetY

        return {
          kind: 'self-loop' as const,
          start: { x: fromEnd.x + offsetX, y: fromEnd.y + offsetY },
          end: { x: toStart.x + offsetX, y: toStart.y + offsetY },
          controlPoint1: { x: cp1x, y: cp1y },
          controlPoint2: { x: cp2x, y: cp2y },
          cp1Shifted: {
            x: cp1x + perpX * perpShift,
            y: cp1y + perpY * perpShift,
          },
          nodeMidShifted: {
            x: nodeMidX + perpX * perpShift,
            y: nodeMidY + perpY * perpShift,
          },
          cp2Shifted: {
            x: cp2x + perpX * perpShift,
            y: cp2y + perpY * perpShift,
          },
        }
      }

      if (isReverseComplementLoop) {
        const startX = fromEnd.x + offsetX
        const startY = fromEnd.y + offsetY
        const extensionLength = 25 / scale
        const cpX = startX + segmentDirX * extensionLength
        const cpY = startY + segmentDirY * extensionLength
        const pathMidX = startX + (cpX - startX) * 3
        const pathMidY = startY + (cpY - startY) * 3
        const perpX = -segmentDirY
        const perpY = segmentDirX
        const perpendicularShift = extensionLength * 1.5

        return {
          kind: 'reverse-complement-loop' as const,
          start: { x: startX, y: startY },
          end: { x: startX, y: startY },
          controlPoint1: { x: cpX, y: cpY },
          controlPoint2: { x: cpX, y: cpY },
          pathMidPoint: { x: pathMidX, y: pathMidY },
          pathMidShifted: {
            x: pathMidX + perpX * perpendicularShift,
            y: pathMidY + perpY * perpendicularShift,
          },
          pathMidShiftedOpposite: {
            x: pathMidX - perpX * perpendicularShift,
            y: pathMidY - perpY * perpendicularShift,
          },
        }
      }

      let fromPrev = fromSegments[fromSegments.length - 2]
      if (!fromPrev) {
        fromPrev = fromSegments[0]
      }

      let toNext = toSegments[1]
      if (!toNext) {
        toNext = toSegments[0]
      }

      const distance = Math.hypot(toStart.x - fromEnd.x, toStart.y - fromEnd.y)
      const projectionDistance = Math.min(distance * 0.5, 80 / scale)

      const projectLine = (
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        distance: number,
      ): [number, number] => {
        const d = Math.hypot(y2 - y1, x2 - x1)
        if (d === 0) return [x2, y2]
        const vx = (x2 - x1) / d
        const vy = (y2 - y1) / d
        return [x2 + distance * vx, y2 + distance * vy]
      }

      const [cp1x, cp1y] = projectLine(
        fromPrev.x,
        fromPrev.y,
        fromEnd.x,
        fromEnd.y,
        projectionDistance,
      )
      const [cp2x, cp2y] = projectLine(
        toNext.x,
        toNext.y,
        toStart.x,
        toStart.y,
        projectionDistance,
      )

      return {
        kind: 'regular' as const,
        start: { x: fromEnd.x + offsetX, y: fromEnd.y + offsetY },
        end: { x: toStart.x + offsetX, y: toStart.y + offsetY },
        controlPoint1: { x: cp1x + offsetX, y: cp1y + offsetY },
        controlPoint2: { x: cp2x + offsetX, y: cp2y + offsetY },
      }
    },
    [getDisplayNodeSegments],
  )

  const getEdgeOffsetNormal = useCallback((edge: Graph['edges'][number]) => {
    const fromSegments = getDisplayNodeSegments(edge.from)
    const toSegments = getDisplayNodeSegments(edge.to)

    if (!fromSegments || !toSegments || fromSegments.length === 0 || toSegments.length === 0) {
      return null
    }

    const fromEnd = fromSegments[fromSegments.length - 1]
    const toStart = toSegments[0]
    if (!fromEnd || !toStart) return null

    let dx = toStart.x - fromEnd.x
    let dy = toStart.y - fromEnd.y
    let len = Math.hypot(dx, dy)

    if (len === 0 && fromSegments.length >= 2) {
      const prevSeg = fromSegments[fromSegments.length - 2]!
      dx = fromEnd.x - prevSeg.x
      dy = fromEnd.y - prevSeg.y
      len = Math.hypot(dx, dy)
    }

    if (len === 0) return null

    return {
      x: -dy / len,
      y: dx / len,
    }
  }, [getDisplayNodeSegments])

  // Drawing function
  const draw = useCallback(() => {
    if (!layoutResult || !canvasRef.current || !boundsRef.current) return

    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Only touch canvas.width/height (which clears the backing buffer) when
    // the resolved size actually changed; every other redraw just repaints.
    const dpr = window.devicePixelRatio || 1
    const lastSize = canvasSizeRef.current
    if (
      !lastSize ||
      lastSize.width !== width ||
      lastSize.height !== height ||
      lastSize.dpr !== dpr
    ) {
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = width + 'px'
      canvas.style.height = height + 'px'
      canvasSizeRef.current = { width, height, dpr }
    }
    // setTransform (rather than scale) is used so the dpr scale is always
    // exactly reapplied, regardless of whether the buffer was just reset.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Clear canvas with theme-appropriate background
    ctx.fillStyle = isDarkMode ? '#1a1a1a' : '#ffffff'
    ctx.fillRect(0, 0, width, height)

    const { scale, rotation, translateX, translateY } = transform
    // Cache the trigonometric values once per redraw instead of recomputing
    // them for every node segment and edge control point.
    const rotationCosine = Math.cos(rotation)
    const rotationSine = Math.sin(rotation)

    // Apply uniform scale, viewport rotation, and screen translation to each
    // graph-space point.
    const transformPoint = (x: number, y: number) => {
      const scaledX = x * scale
      const scaledY = y * scale
      return {
        x:
          scaledX * rotationCosine -
          scaledY * rotationSine +
          translateX,
        y:
          scaledX * rotationSine +
          scaledY * rotationCosine +
          translateY,
      }
    }

    // Inverse of transformPoint - used to approximate which part of the
    // reference path (a fixed world-space line) is currently visible.
    const screenToWorld = (screenX: number, screenY: number) => {
      const sx = screenX - translateX
      const sy = screenY - translateY
      return {
        x: (sx * rotationCosine + sy * rotationSine) / scale,
        y: (-sx * rotationSine + sy * rotationCosine) / scale,
      }
    }

    // Viewport culling: everything below skips both the per-point coordinate
    // transforms and the ctx path/stroke calls for nodes and edges that have
    // no chance of touching the visible canvas rectangle. This is what keeps
    // pan/zoom responsive on graphs with tens of thousands of nodes - once
    // zoomed into a handful of them, draw() cost scales with what's on
    // screen instead of with the size of the whole graph.
    //
    // The four inverse-transformed canvas corners bound the visible world-
    // space region. Under rotation this axis-aligned box is a slight over-
    // estimate of the (rotated) visible area - the same accepted trade-off
    // already used below for the reference-path ruler - so a few extra
    // off-screen items may still get drawn near a rotated view's corners,
    // but nothing visible is ever skipped.
    const viewportCorners = [
      screenToWorld(0, 0),
      screenToWorld(width, 0),
      screenToWorld(width, height),
      screenToWorld(0, height),
    ]
    let viewMinX = Infinity
    let viewMaxX = -Infinity
    let viewMinY = Infinity
    let viewMaxY = -Infinity
    for (const corner of viewportCorners) {
      viewMinX = Math.min(viewMinX, corner.x)
      viewMaxX = Math.max(viewMaxX, corner.x)
      viewMinY = Math.min(viewMinY, corner.y)
      viewMaxY = Math.max(viewMaxY, corner.y)
    }
    // A fixed-screen-pixel margin (converted to world units, so it stays a
    // constant number of pixels regardless of zoom) absorbs everything that
    // can make something visible slightly outside its own bounding box:
    // stroke width, a node label drawn above its contig, and the self-loop /
    // reverse-complement-loop curves' fixed-screen-size extensions.
    const cullMarginWorld = 100 / scale
    const isBoundsVisible = (bounds: {
      minX: number
      maxX: number
      minY: number
      maxY: number
    }) =>
      bounds.maxX >= viewMinX - cullMarginWorld &&
      bounds.minX <= viewMaxX + cullMarginWorld &&
      bounds.maxY >= viewMinY - cullMarginWorld &&
      bounds.minY <= viewMaxY + cullMarginWorld

    // Helper function to draw an arrowhead at a point
    const drawArrowhead = (
      ctx: CanvasRenderingContext2D,
      x: number,
      y: number,
      angle: number,
      color: string,
      size: number = 12,
    ) => {
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(angle)
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(-size, -size / 2)
      ctx.lineTo(-size, size / 2)
      ctx.closePath()
      ctx.fill()
      ctx.restore()
    }

    const addAlphaToColor = (color: string, alpha: number): string => {
      if (color.startsWith('#')) {
        const alphaHex = Math.round(alpha * 255)
          .toString(16)
          .padStart(2, '0')
        if (color.length === 4) {
          const r = color[1]
          const g = color[2]
          const b = color[3]
          return `#${r}${r}${g}${g}${b}${b}${alphaHex}`
        }
        return `${color}${alphaHex}`
      }

      if (color.startsWith('rgb(')) {
        return color.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`)
      }

      if (color.startsWith('hsl(')) {
        return color.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`)
      }

      return color
    }

    // Base graph edges are drawn without arrowheads, but path traversals still
    // keep them so directionality is visible only in the path overlay layer.
    const drawEdge = (
      edge: (typeof graph.edges)[0],
      offsetX: number,
      offsetY: number,
      color: string,
      lineWidth: number,
      showArrowhead: boolean,
    ) => {
      const geometry = buildEdgeGeometry(edge, offsetX, offsetY, scale)
      if (!geometry) return

      ctx.strokeStyle = addAlphaToColor(color, 0.85)
      ctx.lineWidth = lineWidth
      const strokeColor = addAlphaToColor(color, 0.85)

      if (geometry.kind === 'self-loop') {
        const startLocation = transformPoint(geometry.start.x, geometry.start.y)
        const endLocation = transformPoint(geometry.end.x, geometry.end.y)
        const controlPoint1 = transformPoint(
          geometry.controlPoint1.x,
          geometry.controlPoint1.y,
        )
        const controlPoint2 = transformPoint(
          geometry.controlPoint2.x,
          geometry.controlPoint2.y,
        )
        const cp1Shifted = transformPoint(
          geometry.cp1Shifted.x,
          geometry.cp1Shifted.y,
        )
        const nodeMidShifted = transformPoint(
          geometry.nodeMidShifted.x,
          geometry.nodeMidShifted.y,
        )
        const cp2Shifted = transformPoint(
          geometry.cp2Shifted.x,
          geometry.cp2Shifted.y,
        )

        ctx.beginPath()
        ctx.moveTo(startLocation.x, startLocation.y)
        ctx.bezierCurveTo(
          controlPoint1.x,
          controlPoint1.y,
          cp1Shifted.x,
          cp1Shifted.y,
          nodeMidShifted.x,
          nodeMidShifted.y,
        )
        ctx.bezierCurveTo(
          cp2Shifted.x,
          cp2Shifted.y,
          controlPoint2.x,
          controlPoint2.y,
          endLocation.x,
          endLocation.y,
        )
        ctx.stroke()

        if (showArrowhead) {
          const angle = Math.atan2(
            endLocation.y - controlPoint2.y,
            endLocation.x - controlPoint2.x,
          )
          drawArrowhead(ctx, endLocation.x, endLocation.y, angle, strokeColor)
        }
      } else if (geometry.kind === 'reverse-complement-loop') {
        const startLocation = transformPoint(geometry.start.x, geometry.start.y)
        const endLocation = transformPoint(geometry.end.x, geometry.end.y)
        const controlPoint1 = transformPoint(
          geometry.controlPoint1.x,
          geometry.controlPoint1.y,
        )
        const controlPoint2 = transformPoint(
          geometry.controlPoint2.x,
          geometry.controlPoint2.y,
        )
        const pathMidPoint = transformPoint(
          geometry.pathMidPoint.x,
          geometry.pathMidPoint.y,
        )
        const pathMidShifted = transformPoint(
          geometry.pathMidShifted.x,
          geometry.pathMidShifted.y,
        )
        const pathMidShiftedOpposite = transformPoint(
          geometry.pathMidShiftedOpposite.x,
          geometry.pathMidShiftedOpposite.y,
        )

        ctx.beginPath()
        ctx.moveTo(startLocation.x, startLocation.y)
        ctx.bezierCurveTo(
          controlPoint1.x,
          controlPoint1.y,
          pathMidShifted.x,
          pathMidShifted.y,
          pathMidPoint.x,
          pathMidPoint.y,
        )
        ctx.bezierCurveTo(
          pathMidShiftedOpposite.x,
          pathMidShiftedOpposite.y,
          controlPoint2.x,
          controlPoint2.y,
          endLocation.x,
          endLocation.y,
        )
        ctx.stroke()

        if (showArrowhead) {
          const angle = Math.atan2(
            endLocation.y - pathMidShiftedOpposite.y,
            endLocation.x - pathMidShiftedOpposite.x,
          )
          drawArrowhead(ctx, endLocation.x, endLocation.y, angle, strokeColor)
        }
      } else {
        const p1 = transformPoint(geometry.start.x, geometry.start.y)
        const p2 = transformPoint(geometry.end.x, geometry.end.y)
        const cp1 = transformPoint(
          geometry.controlPoint1.x,
          geometry.controlPoint1.y,
        )
        const cp2 = transformPoint(
          geometry.controlPoint2.x,
          geometry.controlPoint2.y,
        )

        ctx.beginPath()
        ctx.moveTo(p1.x, p1.y)
        ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, p2.x, p2.y)
        ctx.stroke()

        if (showArrowhead) {
          const angle = Math.atan2(p2.y - cp2.y, p2.x - cp2.x)
          drawArrowhead(ctx, p2.x, p2.y, angle, strokeColor)
        }
      }
    }

    // A cubic Bezier curve always lies within the convex hull of its control
    // points, so the bounding box of those points is a safe (if slightly
    // generous) box for the whole curve - cheap to compute for every edge
    // every frame since it's just a handful of min/max comparisons over
    // points buildEdgeGeometry already produced.
    const edgeGeometryBounds = (
      geometry: NonNullable<ReturnType<typeof buildEdgeGeometry>>,
    ) => {
      const points =
        geometry.kind === 'self-loop'
          ? [
              geometry.start,
              geometry.end,
              geometry.controlPoint1,
              geometry.controlPoint2,
              geometry.cp1Shifted,
              geometry.nodeMidShifted,
              geometry.cp2Shifted,
            ]
          : geometry.kind === 'reverse-complement-loop'
            ? [
                geometry.start,
                geometry.end,
                geometry.controlPoint1,
                geometry.controlPoint2,
                geometry.pathMidPoint,
                geometry.pathMidShifted,
                geometry.pathMidShiftedOpposite,
              ]
            : [
                geometry.start,
                geometry.end,
                geometry.controlPoint1,
                geometry.controlPoint2,
              ]

      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const point of points) {
        minX = Math.min(minX, point.x)
        maxX = Math.max(maxX, point.x)
        minY = Math.min(minY, point.y)
        maxY = Math.max(maxY, point.y)
      }
      return { minX, maxX, minY, maxY }
    }

    // Draw single-mode base edges and then directional path overlays on top of
    // the same canonical geometry.
    displayGraph.edges.forEach((displayEdge, edgeIdx) => {
      // Cull using the offset-free base geometry rather than re-checking each
      // path-overlay traversal separately: the per-traversal offset (a few
      // world-space units) can never be enough on its own to move a curve
      // in or out of a viewport whose margin is already ~100 screen pixels,
      // so one bounds check here safely stands in for all of an edge's
      // traversal variants and its no-path fallback alike.
      const cullGeometry = buildEdgeGeometry(
        displayEdge.representativeEdge,
        0,
        0,
        scale,
      )
      if (!cullGeometry || !isBoundsVisible(edgeGeometryBounds(cullGeometry))) {
        return
      }

      const isHovered =
        hoveredEdge === edgeIdx || displayEdge.key === selectedEdgeKey
      const visiblePathTraversals = getVisiblePathTraversals(
        displayEdge.pathTraversals,
      )
      const numPaths = visiblePathTraversals.length

      if (!drawPaths || numPaths === 0) {
        const edgeColor = isHovered ? '#aaa' : '#777'
        const lineWidth = isHovered
          ? connectorThickness + 1
          : connectorThickness
        drawEdge(
          displayEdge.representativeEdge,
          0,
          0,
          edgeColor,
          lineWidth,
          false,
        )
      } else {
        const offsetNormal = getEdgeOffsetNormal(displayEdge.representativeEdge)

        visiblePathTraversals.forEach((encoded, pathIdx) => {
          const offset = getEdgeOffset(pathIdx, numPaths, scale)
          const offsetX = (offsetNormal?.x ?? 0) * offset
          const offsetY = (offsetNormal?.y ?? 0) * offset
          const pathName = resolveTraversalPathName(encoded, graph.paths ?? [])
          const color = pathColors.get(pathName) ?? '#888'
          const lineWidth = isHovered
            ? connectorThickness + 1
            : connectorThickness
          const traversalEdge = resolveTraversalEdge(
            encoded,
            displayEdge.representativeEdge,
          )

          drawEdge(
            traversalEdge,
            offsetX,
            offsetY,
            color,
            lineWidth,
            true,
          )
        })
      }
    })

    // DEBUG: Draw edge hit areas in transparent pink
    if (debugHitboxes) {
      const edgeThreshold = 10 / scale

      displayGraph.edges.forEach(displayEdge => {
        const visiblePathTraversals = getVisiblePathTraversals(
          displayEdge.pathTraversals,
        )
        const numPaths = visiblePathTraversals.length

        // Helper to draw hit area for edge with offset
        const drawHitArea = (
          edge: (typeof graph.edges)[0],
          offsetX: number,
          offsetY: number,
        ) => {
          const geometry = buildEdgeGeometry(edge, offsetX, offsetY, scale)
          if (!geometry) return

          ctx.strokeStyle = 'rgba(255, 105, 180, 0.3)'
          ctx.lineWidth = edgeThreshold * scale
          ctx.beginPath()

          if (geometry.kind === 'self-loop') {
            const p1 = transformPoint(geometry.start.x, geometry.start.y)
            const cp1 = transformPoint(
              geometry.controlPoint1.x,
              geometry.controlPoint1.y,
            )
            const cp1s = transformPoint(
              geometry.cp1Shifted.x,
              geometry.cp1Shifted.y,
            )
            const mid = transformPoint(
              geometry.nodeMidShifted.x,
              geometry.nodeMidShifted.y,
            )
            const cp2s = transformPoint(
              geometry.cp2Shifted.x,
              geometry.cp2Shifted.y,
            )
            const cp2 = transformPoint(
              geometry.controlPoint2.x,
              geometry.controlPoint2.y,
            )
            const p2 = transformPoint(geometry.end.x, geometry.end.y)
            ctx.moveTo(p1.x, p1.y)
            ctx.bezierCurveTo(cp1.x, cp1.y, cp1s.x, cp1s.y, mid.x, mid.y)
            ctx.bezierCurveTo(cp2s.x, cp2s.y, cp2.x, cp2.y, p2.x, p2.y)
          } else if (geometry.kind === 'reverse-complement-loop') {
            const p1 = transformPoint(geometry.start.x, geometry.start.y)
            const cp1 = transformPoint(
              geometry.controlPoint1.x,
              geometry.controlPoint1.y,
            )
            const cp2 = transformPoint(
              geometry.controlPoint2.x,
              geometry.controlPoint2.y,
            )
            const mid = transformPoint(
              geometry.pathMidPoint.x,
              geometry.pathMidPoint.y,
            )
            const mids = transformPoint(
              geometry.pathMidShifted.x,
              geometry.pathMidShifted.y,
            )
            const midsOpposite = transformPoint(
              geometry.pathMidShiftedOpposite.x,
              geometry.pathMidShiftedOpposite.y,
            )
            const p2 = transformPoint(geometry.end.x, geometry.end.y)
            ctx.moveTo(p1.x, p1.y)
            ctx.bezierCurveTo(cp1.x, cp1.y, mids.x, mids.y, mid.x, mid.y)
            ctx.bezierCurveTo(
              midsOpposite.x,
              midsOpposite.y,
              cp2.x,
              cp2.y,
              p2.x,
              p2.y,
            )
          } else {
            const p1 = transformPoint(geometry.start.x, geometry.start.y)
            const cp1 = transformPoint(
              geometry.controlPoint1.x,
              geometry.controlPoint1.y,
            )
            const cp2 = transformPoint(
              geometry.controlPoint2.x,
              geometry.controlPoint2.y,
            )
            const p2 = transformPoint(geometry.end.x, geometry.end.y)
            ctx.moveTo(p1.x, p1.y)
            ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, p2.x, p2.y)
          }

          ctx.stroke()
        }

        if (!drawPaths || numPaths === 0) {
          drawHitArea(displayEdge.representativeEdge, 0, 0)
        } else {
          const offsetNormal = getEdgeOffsetNormal(displayEdge.representativeEdge)

          visiblePathTraversals.forEach((encoded, pathIdx) => {
            const offset = getEdgeOffset(pathIdx, numPaths, scale)
            const offsetX = (offsetNormal?.x ?? 0) * offset
            const offsetY = (offsetNormal?.y ?? 0) * offset
            const traversalEdge = resolveTraversalEdge(
              encoded,
              displayEdge.representativeEdge,
            )
            drawHitArea(traversalEdge, offsetX, offsetY)
          })
        }
      })
    }

    // Draw one visible node per contig rather than one node per orientation.
    displayGraph.nodes.forEach(displayNode => {
      const { representativeId, node, segments } = displayNode
      if (segments.length === 0) return

      // Skip nodes entirely outside the current view - both their canvas
      // path construction and (if enabled) their label text, which is the
      // bulk of what this loop spends time on for graphs with tens of
      // thousands of nodes. The bounds map is already built for hover hit-
      // testing, so this reuses it rather than computing anything new.
      const bounds = nodeBoundsByKey.get(displayNode.key)
      if (bounds && !isBoundsVisible(bounds)) return

      // Get color based on selected scheme
      const color = getNodeColor(node)

      const isHovered = hoveredNode === representativeId
      const isSelected = selectedNode === representativeId

      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      ctx.beginPath()
      segments.forEach((segment, i) => {
        const p = transformPoint(segment.x, segment.y)
        if (i === 0) {
          ctx.moveTo(p.x, p.y)
        } else {
          ctx.lineTo(p.x, p.y)
        }
      })

      if (isSelected) {
        ctx.strokeStyle = isDarkMode ? '#ffd54f' : '#b45309'
        ctx.lineWidth = contigThickness + 8
        ctx.stroke()
      }

      ctx.strokeStyle = `rgb(${color.join(',')})`
      ctx.lineWidth = isHovered ? contigThickness + 1 : contigThickness
      ctx.stroke()

      // Draw node label if labels are enabled and node is long enough - or,
      // regardless of length, if a CSV gave this node an explicit label
      // override: the user asked for that label by name, so the length
      // threshold (which exists only to stop auto-labels cluttering short
      // nodes) shouldn't suppress it.
      const csvLabel = nodeLabelOverrides?.[node.id]
      if (
        drawLabels &&
        (csvLabel !== undefined || node.length >= labelLengthThreshold) &&
        segments.length > 0
      ) {
        const midIdx = Math.floor(segments.length / 2)
        const midPoint = transformPoint(
          segments[midIdx]!.x,
          segments[midIdx]!.y,
        )

        ctx.fillStyle = isDarkMode ? '#fff' : '#000'
        ctx.font = '10px monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'bottom'
        ctx.fillText(csvLabel ?? node.name, midPoint.x, midPoint.y - 5)
      }
    })

    // Reference-path coordinate ruler: only a straightened path has a single
    // meaningful coordinate axis, so this is skipped otherwise. The ruler is
    // pinned to a fixed row at the bottom of the canvas (screen space) so it
    // stays visible while zooming/panning instead of scrolling off-screen
    // along with wherever the path currently sits; only the tick x-positions
    // still track the current pan/zoom. Under heavy view rotation the ticks
    // can bunch up since the path's screen-x spread shrinks as it turns
    // vertical - an accepted trade-off for always staying on screen.
    if (referencePathCoordinates) {
      const { breakpoints, minWorldX, maxWorldX, sequenceName } =
        referencePathCoordinates

      // The bounding box of the inverse-transformed canvas corners over-
      // estimates the visible range when the view is rotated, but that just
      // means a few extra tick candidates get computed - each is still
      // individually clipped to the canvas below before it's drawn.
      const corners = [
        screenToWorld(0, 0),
        screenToWorld(width, 0),
        screenToWorld(width, height),
        screenToWorld(0, height),
      ]
      let visibleMinX = Infinity
      let visibleMaxX = -Infinity
      for (const corner of corners) {
        visibleMinX = Math.min(visibleMinX, corner.x)
        visibleMaxX = Math.max(visibleMaxX, corner.x)
      }
      visibleMinX = Math.max(visibleMinX, minWorldX)
      visibleMaxX = Math.min(visibleMaxX, maxWorldX)

      if (visibleMinX < visibleMaxX) {
        const desiredTickCount = Math.max(2, Math.floor(width / 150))

        // Node lengths below the minimum drawn length are clamped, so bp per
        // world-x pixel isn't uniform along the path: a run of short nodes
        // is visually stretched relative to its real length, a run of long
        // ones compressed. Ticks are placed at fixed, evenly-spaced world-x
        // positions (never moved afterward) so they can never bunch up or
        // leave gaps regardless of that distortion. Each tick's *label* is
        // still rounded to a nice-looking number, but the rounding step is
        // chosen locally (from how much bp changes between this tick and its
        // neighbor) rather than one global step - a global step could still
        // be far coarser than a stretched region's whole bp span, collapsing
        // several evenly-spaced ticks onto the same displayed number.
        // Sized so a full-length rotated label (see RULER_LABEL_ANGLE below)
        // always fits above the canvas bottom edge instead of clipping off.
        const rulerY = height - 80
        const tickLength = 6
        const clipMargin = 24
        // A shallower angle than the old 45 degrees keeps each label's
        // vertical footprint small enough to stay fully on screen, while
        // still angling labels enough that closely-spaced ticks don't
        // overlap the way upright text would.
        const RULER_LABEL_ANGLE = -Math.PI / 6

        // Feature B: the gene track sits directly above the ruler baseline,
        // in the same fixed screen-space block, so it pans/zooms in lockstep
        // with the ticks instead of needing its own positioning logic.
        const laneCount = geneTrackLanes?.laneCount ?? 0
        const geneTrackHeight =
          laneCount > 0
            ? laneCount * GENE_LANE_HEIGHT +
              (laneCount - 1) * GENE_LANE_GAP +
              10
            : 0
        const geneTrackBottom = rulerY - 6
        const geneTrackTop = geneTrackBottom - geneTrackHeight

        // Feature C: the copy-number chart stacks above the gene track (or
        // directly above the ruler if there's no gene track), in the same
        // screen-fixed band, for the same reason - it pans/zooms with the
        // ticks instead of needing independent positioning.
        const copyNumberHeight =
          copyNumberTracks && copyNumberTracks.tracks.size > 0
            ? COPY_NUMBER_TRACK_HEIGHT
            : 0
        const copyNumberBottom =
          copyNumberHeight > 0
            ? geneTrackHeight > 0
              ? geneTrackTop - BAND_GAP
              : geneTrackBottom
            : geneTrackTop
        const copyNumberTop = copyNumberBottom - copyNumberHeight
        const reservedBandTop = copyNumberHeight > 0 ? copyNumberTop : geneTrackTop

        ctx.save()

        // Opaque backdrop keeps labels legible over whatever graph content
        // ends up underneath now that the ruler doesn't move with it. Grown
        // upward to cover the gene track and/or copy-number chart whenever
        // either is present.
        ctx.fillStyle = isDarkMode ? '#1a1a1a' : '#ffffff'
        ctx.fillRect(
          0,
          reservedBandTop - 4,
          width,
          height - (reservedBandTop - 4),
        )

        if (geneTrackLanes) {
          geneHitRectsRef.current = []
          geneTrackBandRef.current = { top: geneTrackTop, bottom: geneTrackBottom }

          for (const { gene, lane } of geneTrackLanes.genes) {
            const startX = bpToWorldX(breakpoints, gene.start)
            const endX = bpToWorldX(breakpoints, gene.end)
            if (startX === null || endX === null) continue

            const screenStart = transformPoint(startX, 0).x
            const screenEnd = transformPoint(endX, 0).x
            const left = Math.min(screenStart, screenEnd)
            const right = Math.max(screenStart, screenEnd)
            // Clip to the visible canvas, same as tick labels below, so an
            // enormous gene spanning off both edges doesn't waste a draw
            // call on a box the user can't fully see anyway.
            if (right < -clipMargin || left > width + clipMargin) continue

            // Lane 0 sits closest to the ruler baseline.
            const boxTop =
              geneTrackBottom -
              (lane + 1) * GENE_LANE_HEIGHT -
              lane * GENE_LANE_GAP
            const boxWidth = Math.max(right - left, 1)
            const isHoveredGene = hoveredGene?.gene === gene

            ctx.fillStyle = isHoveredGene
              ? '#f0a500'
              : gene.strand === '-'
                ? '#c2554d'
                : '#3f7fbf'
            ctx.beginPath()
            if (typeof ctx.roundRect === 'function') {
              ctx.roundRect(left, boxTop, boxWidth, GENE_LANE_HEIGHT, 3)
            } else {
              ctx.rect(left, boxTop, boxWidth, GENE_LANE_HEIGHT)
            }
            ctx.fill()

            geneHitRectsRef.current.push({
              gene,
              x: left,
              y: boxTop,
              width: boxWidth,
              height: GENE_LANE_HEIGHT,
            })

            // Below ~12px there's no room for a legible arrowhead; below
            // ~3px the box itself collapses to a bare tick so it doesn't
            // disappear into sub-pixel rounding.
            if (boxWidth < 3) {
              ctx.fillRect(left, boxTop, 1, GENE_LANE_HEIGHT)
            } else if (gene.strand && boxWidth >= 12) {
              const arrowSize = 4
              const arrowX = gene.strand === '+' ? right - 3 : left + 3
              const direction = gene.strand === '+' ? 1 : -1
              ctx.fillStyle = isDarkMode ? '#1a1a1a' : '#ffffff'
              ctx.beginPath()
              ctx.moveTo(arrowX - direction * arrowSize, boxTop + 2)
              ctx.lineTo(arrowX + direction * arrowSize * 0.4, boxTop + GENE_LANE_HEIGHT / 2)
              ctx.lineTo(arrowX - direction * arrowSize, boxTop + GENE_LANE_HEIGHT - 2)
              ctx.closePath()
              ctx.fill()
            }

            if (boxWidth >= 24) {
              ctx.fillStyle = '#fff'
              ctx.font = '10px monospace'
              ctx.textAlign = 'center'
              ctx.textBaseline = 'middle'
              const label =
                gene.name.length > 20
                  ? `${gene.name.slice(0, 18)}…`
                  : gene.name
              // Only draw the name inside the box when it actually fits;
              // otherwise it would overflow the box and overlap neighbors.
              const textWidth = ctx.measureText(label).width
              if (textWidth + 6 <= boxWidth) {
                ctx.fillText(label, (left + right) / 2, boxTop + GENE_LANE_HEIGHT / 2)
              } else {
                ctx.fillStyle = isDarkMode ? '#ccc' : '#333'
                ctx.textAlign = 'left'
                ctx.fillText(label, right + 3, boxTop + GENE_LANE_HEIGHT / 2)
              }
            }
          }

          if (geneTrackLanes.overflowCount > 0) {
            ctx.fillStyle = isDarkMode ? '#ccc' : '#333'
            ctx.font = '10px monospace'
            ctx.textAlign = 'left'
            ctx.textBaseline = 'top'
            ctx.fillText(
              `+${geneTrackLanes.overflowCount} more`,
              6,
              geneTrackTop,
            )
          }
        } else {
          geneHitRectsRef.current = []
          geneTrackBandRef.current = null
        }

        // Feature C: one colored line per toggled path, sharing a single
        // y-scale so amplification in one haplotype is visually comparable
        // to another, not just internally consistent on its own axis.
        if (copyNumberTracks && copyNumberTracks.tracks.size > 0) {
          copyNumberBandRef.current = { top: copyNumberTop, bottom: copyNumberBottom }

          // Bin -> screen-x only depends on the backbone's coordinate space
          // and the current pan/zoom, not on which path's value is being
          // plotted - computed once and shared by every path's line below,
          // and stashed in a ref so handleMouseMove can do a cheap nearest-
          // bin lookup without redoing this bp->world->screen conversion
          // itself (mirrors how geneHitRectsRef avoids re-deriving screen
          // positions outside of draw()).
          const binScreenPositions: { binIndex: number; screenX: number }[] =
            []
          for (let i = 0; i < copyNumberTracks.binCount; i++) {
            const binCenterBp =
              copyNumberTracks.firstBp +
              (i + 0.5) * copyNumberTracks.binSizeBp
            const worldX = bpToWorldX(breakpoints, binCenterBp)
            if (worldX === null) continue
            binScreenPositions.push({
              binIndex: i,
              screenX: transformPoint(worldX, 0).x,
            })
          }
          copyNumberBinPositionsRef.current = binScreenPositions

          let maxValue = 1
          for (const bins of copyNumberTracks.tracks.values()) {
            for (const value of bins) {
              if (value !== null) maxValue = Math.max(maxValue, value)
            }
          }
          maxValue = Math.ceil(maxValue)

          const valueToScreenY = (value: number) =>
            copyNumberBottom -
            (value / maxValue) * (copyNumberBottom - copyNumberTop)

          // A dashed reference line at copy number 1 - the backbone's own
          // implicit baseline, since a repeat-free reference trivially
          // visits every one of its own nodes exactly once - makes it easy
          // to see at a glance which bins are amplified relative to normal
          // rather than having to read the axis labels for every point.
          const baselineY = valueToScreenY(1)
          ctx.save()
          ctx.strokeStyle = isDarkMode ? '#555' : '#ccc'
          ctx.lineWidth = 1
          ctx.setLineDash([3, 3])
          ctx.beginPath()
          ctx.moveTo(0, baselineY)
          ctx.lineTo(width, baselineY)
          ctx.stroke()
          ctx.restore()

          ctx.fillStyle = isDarkMode ? '#888' : '#666'
          ctx.font = '10px monospace'
          ctx.textAlign = 'right'
          ctx.textBaseline = 'middle'
          ctx.fillText('0', 26, copyNumberBottom)
          ctx.fillText('1', 26, baselineY)
          if (maxValue > 1) {
            ctx.fillText(String(maxValue), 26, copyNumberTop + 5)
          }

          for (const [pathName, bins] of copyNumberTracks.tracks) {
            ctx.strokeStyle = getPathColor(pathName)
            ctx.lineWidth = 2
            ctx.beginPath()
            // A null bin (no backbone coverage - shouldn't normally happen,
            // but guarded in computeCopyNumberBins) breaks the line rather
            // than interpolating through a gap with no real data.
            let penDown = false

            for (const { binIndex, screenX } of binScreenPositions) {
              const value = bins[binIndex]
              if (value === null) {
                penDown = false
                continue
              }

              const screenY = valueToScreenY(value)
              if (!penDown) {
                ctx.moveTo(screenX, screenY)
                penDown = true
              } else {
                ctx.lineTo(screenX, screenY)
              }
            }
            ctx.stroke()
          }
        } else {
          copyNumberBandRef.current = null
          copyNumberBinPositionsRef.current = []
        }

        ctx.strokeStyle = isDarkMode ? '#888' : '#555'
        ctx.fillStyle = isDarkMode ? '#ccc' : '#333'
        ctx.font = '13px monospace'
        ctx.lineWidth = 1

        const baselineStartX = transformPoint(minWorldX, 0).x
        const baselineEndX = transformPoint(maxWorldX, 0).x
        ctx.beginPath()
        ctx.moveTo(baselineStartX, rulerY)
        ctx.lineTo(baselineEndX, rulerY)
        ctx.stroke()

        const worldStep = (visibleMaxX - visibleMinX) / desiredTickCount
        const sampleBps: number[] = []
        for (let i = 0; i <= desiredTickCount; i++) {
          sampleBps.push(worldXToBp(breakpoints, visibleMinX + i * worldStep))
        }

        let lastLabel: string | null = null

        for (let i = 0; i < sampleBps.length; i++) {
          const worldX = visibleMinX + i * worldStep
          const screenX = transformPoint(worldX, 0).x
          if (screenX < -clipMargin || screenX > width + clipMargin) continue

          // The smaller of the two neighboring gaps, not just the next one:
          // at a density transition (e.g. a stretched region followed by a
          // compressed one), sizing the step from whichever side is finer
          // avoids rounding so coarsely that a tick's label ends up lower
          // than the previous tick's, even though position-wise it's later
          // along the path.
          const neighborDeltas: number[] = []
          if (i > 0) neighborDeltas.push(Math.abs(sampleBps[i]! - sampleBps[i - 1]!))
          if (i + 1 < sampleBps.length) {
            neighborDeltas.push(Math.abs(sampleBps[i + 1]! - sampleBps[i]!))
          }
          const localDelta = Math.max(
            1,
            neighborDeltas.length > 0 ? Math.min(...neighborDeltas) : 1,
          )
          const localStep = Math.max(1, niceNumber(localDelta, true))
          const roundedBp = Math.round(sampleBps[i]! / localStep) * localStep

          ctx.beginPath()
          ctx.moveTo(screenX, rulerY)
          ctx.lineTo(screenX, rulerY + tickLength)
          ctx.stroke()

          // A tick still gets drawn even when its rounded value repeats the
          // previous tick's (possible in a very stretched region), but the
          // label is skipped rather than printing the same text twice.
          const label = formatCoordinateLabel(roundedBp, sequenceName)
          if (label !== lastLabel) {
            // Angled so labels for closely-spaced ticks overlap far less
            // than upright text would.
            ctx.save()
            ctx.translate(screenX, rulerY + tickLength + 4)
            ctx.rotate(RULER_LABEL_ANGLE)
            ctx.textAlign = 'right'
            ctx.textBaseline = 'middle'
            ctx.fillText(label, 0, 0)
            ctx.restore()
            lastLabel = label
          }
        }

        ctx.restore()
      }
    } else {
      // No reference path selected (or linear layout off) - nothing is
      // drawn in the bottom band this frame, so any hit-test region left
      // over from an earlier frame that did have one must be cleared too,
      // otherwise handleMouseMove could keep intercepting hover in empty
      // space as if the gene/copy-number bands were still there.
      geneTrackBandRef.current = null
      geneHitRectsRef.current = []
      copyNumberBandRef.current = null
      copyNumberBinPositionsRef.current = []
    }
  }, [
    layoutResult,
    graph,
    width,
    height,
    transform,
    hoveredNode,
    hoveredEdge,
    selectedNode,
    selectedEdgeKey,
    isDarkMode,
    getNodeColor,
    displayGraph,
    nodeBoundsByKey,
    pathColors,
    getVisiblePathTraversals,
    buildEdgeGeometry,
    getEdgeOffset,
    getEdgeOffsetNormal,
    contigThickness,
    connectorThickness,
    drawLabels,
    labelLengthThreshold,
    nodeLabelOverrides,
    drawPaths,
    visiblePathIds,
    referencePathCoordinates,
    geneTrackLanes,
    hoveredGene,
    copyNumberTracks,
    getPathColor,
  ])

  // Keep the latest draw() closure available to the rAF callback below,
  // regardless of whether that callback was queued by this render or an
  // earlier one.
  drawRef.current = draw

  // Redraw when any state changes, coalesced to at most one repaint per
  // animation frame. Without this, dragging to pan fires a full graph
  // repaint on every single mousemove event - often several per frame on a
  // fast mouse - which is what made panning feel laggy on large graphs even
  // after viewport culling cut the cost of each individual repaint.
  useEffect(() => {
    if (pendingDrawFrameRef.current !== null) return

    pendingDrawFrameRef.current = window.requestAnimationFrame(() => {
      pendingDrawFrameRef.current = null
      drawRef.current?.()
    })
  }, [draw])

  // Cancel any repaint still queued when the component unmounts.
  useEffect(
    () => () => {
      if (pendingDrawFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingDrawFrameRef.current)
        pendingDrawFrameRef.current = null
      }
    },
    [],
  )

  // Add wheel event listener with passive: false to prevent page scroll
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const wheelHandler = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()

      const prev = transformRef.current

      if (e.altKey) {
        // Alt+wheel rotates around the canvas center, keeping the view stable
        // instead of orbiting around a changing pointer location.
        const wheelDeltaPixels = getWheelDeltaPixels(e, height)
        const rotationDelta = Math.max(
          -MAX_ROTATION_STEP,
          Math.min(
            MAX_ROTATION_STEP,
            wheelDeltaPixels * ROTATION_RADIANS_PER_PIXEL,
          ),
        )
        if (Math.abs(rotationDelta) < 0.0001) return

        const pivotX = width / 2
        const pivotY = height / 2
        const deltaCosine = Math.cos(rotationDelta)
        const deltaSine = Math.sin(rotationDelta)
        const translationFromPivotX = prev.translateX - pivotX
        const translationFromPivotY = prev.translateY - pivotY
        const nextTransform = {
          ...prev,
          rotation: normalizeRotation(prev.rotation + rotationDelta),
          // Rotate the existing screen translation around the same pivot so
          // graph content does not jump while the angle changes.
          translateX:
            pivotX +
            translationFromPivotX * deltaCosine -
            translationFromPivotY * deltaSine,
          translateY:
            pivotY +
            translationFromPivotX * deltaSine +
            translationFromPivotY * deltaCosine,
        }

        transformRef.current = nextTransform
        setTransform(nextTransform)
        // Hover geometry moves during rotation, so discard stale tooltips
        // until the pointer moves and hit-testing runs again.
        setHoveredNode(null)
        setHoveredEdge(null)
        return
      }

      const rect = canvas.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top

      const delta = -e.deltaY * 0.001
      const scaleFactor = Math.exp(delta)

      const newScale = clampZoom(prev.scale * scaleFactor)
      if (Math.abs(newScale - prev.scale) < 0.0001) return

      const actualFactor = newScale / prev.scale

      const nextTransform = {
        // Ordinary wheel zoom keeps the current viewport rotation.
        ...prev,
        scale: newScale,
        translateX: mouseX - (mouseX - prev.translateX) * actualFactor,
        translateY: mouseY - (mouseY - prev.translateY) * actualFactor,
      }

      transformRef.current = nextTransform
      setTransform(nextTransform)
      reportInternalZoom(newScale)
    }

    canvas.addEventListener('wheel', wheelHandler, { passive: false })
    return () => canvas.removeEventListener('wheel', wheelHandler)
  }, [height, reportInternalZoom, width])

  // Hit detection helper - distance from point to line segment
  const distanceToSegment = (
    px: number,
    py: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): number => {
    const dx = x2 - x1
    const dy = y2 - y1
    const lenSq = dx * dx + dy * dy

    if (lenSq === 0) return Math.hypot(px - x1, py - y1)

    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq
    t = Math.max(0, Math.min(1, t))

    const closestX = x1 + t * dx
    const closestY = y1 + t * dy

    return Math.hypot(px - closestX, py - closestY)
  }

  // Hit detection helper - distance from point to cubic bezier curve
  const distanceToCubicBezier = (
    px: number,
    py: number,
    x1: number,
    y1: number,
    cx1: number,
    cy1: number,
    cx2: number,
    cy2: number,
    x2: number,
    y2: number,
    maxSampleSpacing: number,
  ): number => {
    // Sample points along the bezier curve and find minimum distance. A
    // fixed sample count leaves gaps between samples that grow with the
    // curve's length, so long edges could have dead zones in the middle
    // where hovering directly over the drawn line didn't register as a hit.
    // The control polygon length is a cheap upper bound on the curve's
    // actual arc length; sizing the sample count from it keeps consecutive
    // samples closer together than the hit threshold at any edge length.
    const controlPolygonLength =
      Math.hypot(cx1 - x1, cy1 - y1) +
      Math.hypot(cx2 - cx1, cy2 - cy1) +
      Math.hypot(x2 - cx2, y2 - cy2)
    const samples = Math.min(
      400,
      Math.max(20, Math.ceil(controlPolygonLength / maxSampleSpacing)),
    )

    let minDist = Infinity

    for (let i = 0; i <= samples; i++) {
      const t = i / samples
      const oneMinusT = 1 - t

      // Cubic bezier formula: B(t) = (1-t)^3 * P0 + 3(1-t)^2*t * P1 + 3(1-t)*t^2 * P2 + t^3 * P3
      const bx =
        oneMinusT * oneMinusT * oneMinusT * x1 +
        3 * oneMinusT * oneMinusT * t * cx1 +
        3 * oneMinusT * t * t * cx2 +
        t * t * t * x2
      const by =
        oneMinusT * oneMinusT * oneMinusT * y1 +
        3 * oneMinusT * oneMinusT * t * cy1 +
        3 * oneMinusT * t * t * cy2 +
        t * t * t * y2

      const dist = Math.hypot(px - bx, py - by)
      minDist = Math.min(minDist, dist)
    }

    return minDist
  }

  // Handle mouse down
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (e.button === 0) {
        // Left click
        setDragStart({ x: e.clientX, y: e.clientY })

        // Gene track click: "select" per the spec is deliberately minimal
        // for now (logging), since this is explicitly a secondary feature
        // on top of the static track ("do this only after the static track
        // renders correctly"). Returning early also keeps a gene click from
        // also starting a pan, since the track sits over the same canvas.
        if (hoveredGene) {
          console.log('Gene selected:', hoveredGene.gene)
          return
        }

        pointerDownRef.current = { x: e.clientX, y: e.clientY }
        if (hoveredNode) {
          // Prepare for node dragging
          setDraggingNodeId(hoveredNode)
          setSelectedNode(hoveredNode)
          setSelectedEdgeKey(null)
        } else {
          // Prepare for view panning. Selection only changes on mouseup, and
          // only if the pointer didn't move, so panning keeps the panel.
          setIsDragging(true)
        }
      }
    },
    [hoveredNode, hoveredGene],
  )

  // Handle mouse move
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!layoutResult || !canvasRef.current) return

      const rect = canvasRef.current.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top

      if (draggingNodeId) {
        // Node dragging - start dragging on first movement
        if (!isDraggingNode) {
          setIsDraggingNode(true)
          // Initialize modified positions if not already done
          if (!modifiedNodePositions) {
            setModifiedNodePositions({ ...layoutResult.nodePositions })
          }
        }

        const screenDeltaX = e.clientX - dragStart.x
        const screenDeltaY = e.clientY - dragStart.y
        const inverseRotationCosine = Math.cos(transform.rotation)
        const inverseRotationSine = Math.sin(transform.rotation)
        // Undo viewport rotation and scale so dragging follows the pointer in
        // graph coordinates at every displayed angle.
        const dx =
          (screenDeltaX * inverseRotationCosine +
            screenDeltaY * inverseRotationSine) /
          transform.scale
        const dy =
          (-screenDeltaX * inverseRotationSine +
            screenDeltaY * inverseRotationCosine) /
          transform.scale

        setModifiedNodePositions(prev => {
          const current = prev || layoutResult.nodePositions
          const nodeSegments = current[draggingNodeId]
          if (!nodeSegments) return current

          // Translate all segments of this node
          const updatedSegments = nodeSegments.map(seg => ({
            x: seg.x + dx,
            y: seg.y + dy,
          }))

          return {
            ...current,
            [draggingNodeId]: updatedSegments,
          }
        })

        setDragStart({ x: e.clientX, y: e.clientY })
      } else if (isDragging) {
        // View panning
        const dx = e.clientX - dragStart.x
        const dy = e.clientY - dragStart.y

        const prev = transformRef.current
        const nextTransform = {
          ...prev,
          translateX: prev.translateX + dx,
          translateY: prev.translateY + dy,
        }

        transformRef.current = nextTransform
        setTransform(nextTransform)

        setDragStart({ x: e.clientX, y: e.clientY })
      } else {
        // Copy-number band hit-testing: like the gene track below, this is a
        // fixed screen-space overlay, so mouseY alone decides whether the
        // pointer is even in the band before finding the nearest bin by x.
        const copyNumberBand = copyNumberBandRef.current
        if (
          copyNumberBand &&
          mouseY >= copyNumberBand.top &&
          mouseY <= copyNumberBand.bottom
        ) {
          const positions = copyNumberBinPositionsRef.current
          let nearest: { binIndex: number; screenX: number } | null = null
          let nearestDistance = Infinity
          for (const position of positions) {
            const distance = Math.abs(position.screenX - mouseX)
            if (distance < nearestDistance) {
              nearestDistance = distance
              nearest = position
            }
          }
          // A generous threshold (half the nominal bin width in a typical
          // 1200px-wide canvas) avoids a tooltip appearing far from any
          // actual plotted point when the cursor is over the band but not
          // near a line.
          const hit = nearest && nearestDistance < width / COPY_NUMBER_BIN_COUNT
          setHoveredCopyNumberBin(
            hit
              ? {
                  binIndex: nearest!.binIndex,
                  screenX: e.clientX,
                  screenY: e.clientY,
                }
              : null,
          )
          if (hoveredNode) setHoveredNode(null)
          if (hoveredEdge !== null) setHoveredEdge(null)
          return
        }
        if (hoveredCopyNumberBin) setHoveredCopyNumberBin(null)

        // Gene track hit-testing happens first and in plain screen space
        // (the track is a fixed overlay, not part of the rotated/zoomed
        // graph) - mouseY alone decides whether the pointer is even in that
        // band before scanning the handful of rects drawn there this frame.
        const geneBand = geneTrackBandRef.current
        if (geneBand && mouseY >= geneBand.top && mouseY <= geneBand.bottom) {
          const hit = geneHitRectsRef.current.find(
            rect =>
              mouseX >= rect.x &&
              mouseX <= rect.x + rect.width &&
              mouseY >= rect.y &&
              mouseY <= rect.y + rect.height,
          )
          setHoveredGene(
            hit ? { gene: hit.gene, screenX: e.clientX, screenY: e.clientY } : null,
          )
          if (hoveredNode) setHoveredNode(null)
          if (hoveredEdge !== null) setHoveredEdge(null)
          return
        }
        if (hoveredGene) setHoveredGene(null)

        // Hit detection for hover
        const { scale, rotation, translateX, translateY } = transform
        const translatedMouseX = mouseX - translateX
        const translatedMouseY = mouseY - translateY
        const inverseRotationCosine = Math.cos(rotation)
        const inverseRotationSine = Math.sin(rotation)
        // Invert translation, rotation, and scale so hover hit-testing remains
        // aligned with the rotated graph.
        const graphX =
          (translatedMouseX * inverseRotationCosine +
            translatedMouseY * inverseRotationSine) /
          scale
        const graphY =
          (-translatedMouseX * inverseRotationSine +
            translatedMouseY * inverseRotationCosine) /
          scale

        // Check nodes
        let foundNode: string | null = null
        const nodeThreshold = 5 / scale // Adjust with zoom

        for (const displayNode of displayGraph.nodes) {
          const { key, representativeId, segments } = displayNode
          const bounds = nodeBoundsByKey.get(key)
          if (
            bounds &&
            (graphX < bounds.minX - nodeThreshold ||
              graphX > bounds.maxX + nodeThreshold ||
              graphY < bounds.minY - nodeThreshold ||
              graphY > bounds.maxY + nodeThreshold)
          ) {
            continue
          }

          for (let i = 0; i < segments.length - 1; i++) {
            const dist = distanceToSegment(
              graphX,
              graphY,
              segments[i]!.x,
              segments[i]!.y,
              segments[i + 1]!.x,
              segments[i + 1]!.y,
            )

            if (dist < nodeThreshold) {
              foundNode = representativeId
              break
            }
          }
          if (foundNode) break
        }

        setHoveredNode(foundNode)

        // Update tooltip position
        if (foundNode) {
          setTooltipPosition({ x: e.clientX, y: e.clientY })
          // Update virtual reference element for floating-ui
          refs.setPositionReference({
            getBoundingClientRect: () => ({
              width: 0,
              height: 0,
              x: e.clientX,
              y: e.clientY,
              top: e.clientY,
              left: e.clientX,
              right: e.clientX,
              bottom: e.clientY,
            }),
          })
        }

        // Check edges
        let foundEdge: number | null = null
        const edgeThreshold = 10 / scale

        for (let edgeIdx = 0; edgeIdx < displayGraph.edges.length; edgeIdx++) {
          const displayEdge = displayGraph.edges[edgeIdx]!
          const visiblePathTraversals = getVisiblePathTraversals(
            displayEdge.pathTraversals,
          )
          const numPaths = visiblePathTraversals.length

          let dist: number

          // Hit testing mirrors the exact Bezier geometry used in drawEdge()
          // so the collapsed single-mode display stays clickable.
          const checkEdgeDistance = (
            edge: (typeof graph.edges)[0],
            offsetX: number,
            offsetY: number,
          ): number => {
            const geometry = buildEdgeGeometry(edge, offsetX, offsetY, scale)
            if (!geometry) return Infinity

            // A cubic Bezier curve always lies within the bounding box of its
            // control points, so this is a cheap, exact-safe way to skip the
            // 20-sample distance calculation below for edges nowhere near the
            // pointer.
            const boundaryPoints =
              geometry.kind === 'self-loop'
                ? [
                    geometry.start,
                    geometry.controlPoint1,
                    geometry.cp1Shifted,
                    geometry.nodeMidShifted,
                    geometry.cp2Shifted,
                    geometry.controlPoint2,
                    geometry.end,
                  ]
                : geometry.kind === 'reverse-complement-loop'
                  ? [
                      geometry.start,
                      geometry.controlPoint1,
                      geometry.pathMidShifted,
                      geometry.pathMidPoint,
                      geometry.pathMidShiftedOpposite,
                      geometry.controlPoint2,
                      geometry.end,
                    ]
                  : [
                      geometry.start,
                      geometry.controlPoint1,
                      geometry.controlPoint2,
                      geometry.end,
                    ]

            let boundsMinX = Infinity
            let boundsMaxX = -Infinity
            let boundsMinY = Infinity
            let boundsMaxY = -Infinity
            for (const point of boundaryPoints) {
              boundsMinX = Math.min(boundsMinX, point.x)
              boundsMaxX = Math.max(boundsMaxX, point.x)
              boundsMinY = Math.min(boundsMinY, point.y)
              boundsMaxY = Math.max(boundsMaxY, point.y)
            }
            if (
              graphX < boundsMinX - edgeThreshold ||
              graphX > boundsMaxX + edgeThreshold ||
              graphY < boundsMinY - edgeThreshold ||
              graphY > boundsMaxY + edgeThreshold
            ) {
              return Infinity
            }

            if (geometry.kind === 'self-loop') {
              const dist1 = distanceToCubicBezier(
                graphX,
                graphY,
                geometry.start.x,
                geometry.start.y,
                geometry.controlPoint1.x,
                geometry.controlPoint1.y,
                geometry.cp1Shifted.x,
                geometry.cp1Shifted.y,
                geometry.nodeMidShifted.x,
                geometry.nodeMidShifted.y,
                edgeThreshold,
              )

              const dist2 = distanceToCubicBezier(
                graphX,
                graphY,
                geometry.nodeMidShifted.x,
                geometry.nodeMidShifted.y,
                geometry.cp2Shifted.x,
                geometry.cp2Shifted.y,
                geometry.controlPoint2.x,
                geometry.controlPoint2.y,
                geometry.end.x,
                geometry.end.y,
                edgeThreshold,
              )

              return Math.min(dist1, dist2)
            }

            if (geometry.kind === 'reverse-complement-loop') {
              const dist1 = distanceToCubicBezier(
                graphX,
                graphY,
                geometry.start.x,
                geometry.start.y,
                geometry.controlPoint1.x,
                geometry.controlPoint1.y,
                geometry.pathMidShifted.x,
                geometry.pathMidShifted.y,
                geometry.pathMidPoint.x,
                geometry.pathMidPoint.y,
                edgeThreshold,
              )
              const dist2 = distanceToCubicBezier(
                graphX,
                graphY,
                geometry.pathMidPoint.x,
                geometry.pathMidPoint.y,
                geometry.pathMidShiftedOpposite.x,
                geometry.pathMidShiftedOpposite.y,
                geometry.controlPoint2.x,
                geometry.controlPoint2.y,
                geometry.end.x,
                geometry.end.y,
                edgeThreshold,
              )
              return Math.min(dist1, dist2)
            }

            return distanceToCubicBezier(
              graphX,
              graphY,
              geometry.start.x,
              geometry.start.y,
              geometry.controlPoint1.x,
              geometry.controlPoint1.y,
              geometry.controlPoint2.x,
              geometry.controlPoint2.y,
              geometry.end.x,
              geometry.end.y,
              edgeThreshold,
            )
          }

          if (!drawPaths || numPaths === 0) {
            dist = checkEdgeDistance(displayEdge.representativeEdge, 0, 0)
          } else {
            const offsetNormal = getEdgeOffsetNormal(displayEdge.representativeEdge)
            let minDist = Infinity

            visiblePathTraversals.forEach((encoded, pathIdx) => {
              const offset = getEdgeOffset(pathIdx, numPaths, scale)
              const offsetX = (offsetNormal?.x ?? 0) * offset
              const offsetY = (offsetNormal?.y ?? 0) * offset
              const traversalEdge = resolveTraversalEdge(
                encoded,
                displayEdge.representativeEdge,
              )
              const d = checkEdgeDistance(traversalEdge, offsetX, offsetY)
              minDist = Math.min(minDist, d)
            })
            dist = minDist
          }

          if (dist < edgeThreshold) {
            foundEdge = edgeIdx
            break
          }
        }

        setHoveredEdge(foundEdge)

        // Update tooltip position for edges
        if (foundEdge !== null && !foundNode) {
          setTooltipPosition({ x: e.clientX, y: e.clientY })
          // Update virtual reference element for floating-ui
          refs.setPositionReference({
            getBoundingClientRect: () => ({
              width: 0,
              height: 0,
              x: e.clientX,
              y: e.clientY,
              top: e.clientY,
              left: e.clientX,
              right: e.clientX,
              bottom: e.clientY,
            }),
          })
        }

        // Update cursor
        canvasRef.current.style.cursor =
          foundNode || foundEdge
            ? 'pointer'
            : isDragging || isDraggingNode
              ? 'grabbing'
              : 'default'
      }
    },
    [
      layoutResult,
      isDragging,
      isDraggingNode,
      draggingNodeId,
      dragStart,
      transform,
      graph,
      modifiedNodePositions,
      refs,
      displayGraph,
      nodeBoundsByKey,
      buildEdgeGeometry,
      getVisiblePathTraversals,
      getEdgeOffsetNormal,
      getEdgeOffset,
      hoveredGene,
      hoveredNode,
      hoveredEdge,
      hoveredCopyNumberBin,
    ],
  )

  // Handle mouse up
  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      // A click (not a pan) on a connection selects it for the info panel;
      // on empty space it clears the panel. Nodes are selected on mousedown.
      const pointerDown = pointerDownRef.current
      pointerDownRef.current = null
      if (
        pointerDown &&
        !draggingNodeId &&
        Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) <=
          CLICK_MOVE_TOLERANCE_PX
      ) {
        const clickedEdge =
          hoveredEdge !== null ? displayGraph.edges[hoveredEdge] : undefined
        setSelectedEdgeKey(clickedEdge?.key ?? null)
        setSelectedNode(null)
      }

      setIsDragging(false)
      setIsDraggingNode(false)
      setDraggingNodeId(null)
    },
    [draggingNodeId, hoveredEdge, displayGraph.edges],
  )

  const isPathVisible = useCallback(
    (pathName: string) =>
      drawPaths && (!visiblePathIds || visiblePathIds.has(pathName)),
    [drawPaths, visiblePathIds],
  )

  // Built from the topology rather than the positioned displayGraph so
  // dragging the selected node doesn't recount path visits every frame.
  const selectedNodeInfo = useMemo((): SelectionInfo | null => {
    if (!selectedNode) return null
    const displayNode = visibleDisplayGraphTopology.nodesByKey.get(
      stripNodeOrientation(selectedNode),
    )
    if (!displayNode) return null
    const sequence = getNodeSequence(displayNode.node)
    return {
      kind: 'node',
      node: displayNode.node,
      sequencePreview: sequence ? formatSequencePreview(sequence) : null,
      csvMetadata: nodeCsvMetadata?.[displayNode.node.id],
      paths: countPathVisitsToNode(displayNode, graph.paths ?? []),
    }
  }, [selectedNode, visibleDisplayGraphTopology, nodeCsvMetadata, graph.paths])

  const selectedEdgeInfo = useMemo((): SelectionInfo | null => {
    if (!selectedEdgeKey) return null
    const edge = visibleDisplayGraphTopology.edges.find(
      candidate => candidate.key === selectedEdgeKey,
    )
    if (!edge) return null
    const { nodesByKey } = visibleDisplayGraphTopology
    const fromNode = nodesByKey.get(edge.fromNodeKey)?.node
    const toNode = nodesByKey.get(edge.toNodeKey)?.node
    if (!fromNode || !toNode) return null
    return {
      kind: 'edge',
      fromName: fromNode.name,
      toName: toNode.name,
      groups: groupEdgeTraversalsByDirection(edge, graph.paths ?? []),
      totalPathCount: edge.pathIds.length,
      visiblePathCount: edge.pathIds.filter(isPathVisible).length,
    }
  }, [selectedEdgeKey, visibleDisplayGraphTopology, graph.paths, isPathVisible])

  return (
    <div className="graph-canvas-with-info">
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{
            border: isDarkMode ? '1px solid #333' : '1px solid #ddd',
            borderRadius: '8px',
            backgroundColor: isDarkMode ? '#1a1a1a' : '#ffffff',
            cursor: 'default',
            display: 'block',
          }}
        />

        {/* Tooltip for nodes */}
        {hoveredNode &&
          !isDragging &&
          !isDraggingNode &&
          (() => {
            const node = graph.nodes.find(n => n.id === hoveredNode)
            if (!node) return null

            return (
              <div
                ref={refs.setFloating}
                style={{
                  ...floatingStyles,
                  position: 'absolute',
                  background: isDarkMode ? '#2a2a2a' : 'white',
                  border: isDarkMode ? '1px solid #555' : '1px solid #ccc',
                  borderRadius: '6px',
                  padding: '8px 12px',
                  fontSize: '13px',
                  boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
                  zIndex: 1000,
                  pointerEvents: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                <div style={{ color: isDarkMode ? '#fff' : '#000' }}>
                  <div>
                    <strong>{node.name}</strong>
                  </div>
                  <div
                    style={{ fontSize: '11px', marginTop: '4px', opacity: 0.8 }}
                  >
                    {node.length.toLocaleString()} bp • {node.depth.toFixed(2)}×
                    depth
                  </div>
                </div>
              </div>
            )
          })()}

        {/* Tooltip for edges. The path list is capped so it stays on screen;
            clicking the connection lists every path in the info panel. */}
        {hoveredEdge !== null &&
          !hoveredNode &&
          !isDragging &&
          !isDraggingNode &&
          (() => {
            const edge = displayGraph.edges[hoveredEdge]
            if (!edge) return null

            const fromNode = displayGraph.nodesByKey.get(edge.fromNodeKey)?.node
            const toNode = displayGraph.nodesByKey.get(edge.toNodeKey)?.node
            if (!fromNode || !toNode) return null

            // Path overlays are directional even though the base graph edge is
            // drawn as one collapsed connection. Always group every traversal
            // for the tooltip; path visibility affects only the status/count.
            const pathDirectionGroups = groupEdgeTraversalsByDirection(
              edge,
              graph.paths ?? [],
            )
            const totalRows = pathDirectionGroups.reduce(
              (sum, group) => sum + group.paths.length,
              0,
            )
            let remainingRows = EDGE_TOOLTIP_MAX_PATHS
            const shownGroups = pathDirectionGroups.flatMap(group => {
              const paths = group.paths.slice(0, remainingRows)
              remainingRows -= paths.length
              return paths.length > 0 ? [{ ...group, paths }] : []
            })
            const hiddenRows = totalRows - (EDGE_TOOLTIP_MAX_PATHS - remainingRows)

            return (
              <div
                ref={refs.setFloating}
                style={{
                  ...floatingStyles,
                  position: 'absolute',
                  background: isDarkMode ? '#2a2a2a' : 'white',
                  border: isDarkMode ? '1px solid #555' : '1px solid #ccc',
                  borderRadius: '6px',
                  padding: '8px 12px',
                  fontSize: '13px',
                  boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
                  zIndex: 1000,
                  pointerEvents: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                <div style={{ color: isDarkMode ? '#fff' : '#000' }}>
                  <div>
                    <strong>Connection</strong>
                  </div>
                  <div
                    style={{ fontSize: '11px', marginTop: '4px', opacity: 0.8 }}
                  >
                    {fromNode.name} — {toNode.name}
                  </div>
                  {edge.pathIds.length > 0 && (
                    <div
                      style={{
                        fontSize: '11px',
                        marginTop: '6px',
                        paddingTop: '6px',
                        borderTop: isDarkMode
                          ? '1px solid #444'
                          : '1px solid #ddd',
                      }}
                    >
                      <div style={{ marginBottom: '3px', opacity: 0.9 }}>
                        <strong>
                          Paths ({edge.pathIds.filter(isPathVisible).length}{' '}
                          visible / {edge.pathIds.length} total):
                        </strong>
                      </div>
                      {shownGroups.map(group => (
                        <div
                          key={`${group.from}->${group.to}`}
                          style={{ marginTop: '5px' }}
                        >
                          <div style={{ marginLeft: '8px', opacity: 0.9 }}>
                            <strong>
                              {group.from} → {group.to}
                            </strong>
                          </div>
                          {group.paths.map(({ name, count }) => (
                            <div
                              key={`${group.from}->${group.to}:${name}`}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                marginLeft: '18px',
                                opacity: isPathVisible(name) ? 0.9 : 0.55,
                              }}
                            >
                              <div
                                style={{
                                  width: '12px',
                                  height: '12px',
                                  backgroundColor: getPathColor(name),
                                  borderRadius: '2px',
                                  flexShrink: 0,
                                }}
                              />
                              {name}
                              {count > 1 && ` (${count}×)`}
                            </div>
                          ))}
                        </div>
                      ))}
                      {hiddenRows > 0 && (
                        <div style={{ marginTop: '6px', opacity: 0.7 }}>
                          +{hiddenRows} more, click the connection to see all
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })()}

        {/* Tooltip for the gene track (Feature B). A plain fixed-position div
            rather than the shared floating-ui instance above: the track only
            ever occupies the bottom screen-space band, so there's no need for
            floating-ui's flip/shift collision handling to keep it on screen -
            placing it just above the cursor is always safe here. */}
        {hoveredGene && (
          <div
            style={{
              position: 'fixed',
              left: hoveredGene.screenX,
              top: hoveredGene.screenY,
              transform: 'translate(-50%, -100%)',
              marginTop: -10,
              background: isDarkMode ? '#2a2a2a' : 'white',
              border: isDarkMode ? '1px solid #555' : '1px solid #ccc',
              borderRadius: '6px',
              padding: '8px 12px',
              fontSize: '13px',
              boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
              zIndex: 1000,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              color: isDarkMode ? '#fff' : '#000',
            }}
          >
            <div>
              <strong>{hoveredGene.gene.name}</strong>
            </div>
            <div style={{ fontSize: '11px', opacity: 0.8 }}>
              {hoveredGene.gene.chrom}:{hoveredGene.gene.start.toLocaleString()}-
              {hoveredGene.gene.end.toLocaleString()} (
              {(hoveredGene.gene.end - hoveredGene.gene.start).toLocaleString()}{' '}
              bp)
              {hoveredGene.gene.strand && ` - strand ${hoveredGene.gene.strand}`}
            </div>
          </div>
        )}

        {/* Tooltip for the copy-number track (Feature C). Lists every currently
            toggled path's value at the hovered bin, not just whichever line
            happens to be closest in y - with several paths potentially
            overlapping at the same bin, showing all of them is more useful
            than guessing which one the user meant to hover. */}
        {hoveredCopyNumberBin && copyNumberTracks && (
          <div
            style={{
              position: 'fixed',
              left: hoveredCopyNumberBin.screenX,
              top: hoveredCopyNumberBin.screenY,
              transform: 'translate(-50%, -100%)',
              marginTop: -10,
              background: isDarkMode ? '#2a2a2a' : 'white',
              border: isDarkMode ? '1px solid #555' : '1px solid #ccc',
              borderRadius: '6px',
              padding: '8px 12px',
              fontSize: '13px',
              boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
              zIndex: 1000,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              color: isDarkMode ? '#fff' : '#000',
            }}
          >
            <div style={{ fontSize: '11px', opacity: 0.8, marginBottom: 4 }}>
              {Math.round(
                copyNumberTracks.firstBp +
                  hoveredCopyNumberBin.binIndex * copyNumberTracks.binSizeBp,
              ).toLocaleString()}
              {' - '}
              {Math.round(
                copyNumberTracks.firstBp +
                  (hoveredCopyNumberBin.binIndex + 1) *
                    copyNumberTracks.binSizeBp,
              ).toLocaleString()}
            </div>
            {Array.from(copyNumberTracks.tracks, ([pathName, bins]) => {
              const value = bins[hoveredCopyNumberBin.binIndex]
              if (value === null) return null
              return (
                <div
                  key={pathName}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      background: getPathColor(pathName),
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {pathName}
                  </span>
                  <strong style={{ marginLeft: 'auto' }}>
                    {value.toFixed(1)}×
                  </strong>
                </div>
              )
            })}
          </div>
        )}
      </div>
      <SelectionInfoPanel
        selection={selectedEdgeInfo ?? selectedNodeInfo}
        width={infoPanelWidth}
        maxWidth={infoPanelMaxWidth}
        onWidthChange={onInfoPanelWidthChange}
        height={height}
        getPathColor={getPathColor}
        isPathVisible={isPathVisible}
        onUseAsStartNode={onUseAsStartNode}
      />
    </div>
  )
}

export const GraphCanvas = memo(GraphCanvasComponent)
