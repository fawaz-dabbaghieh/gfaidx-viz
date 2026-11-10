// Shared frontend data model used across parsing, worker messaging, layout
// results, and the React UI.

export interface GraphNode {
  id: string
  name: string
  length: number
  depth: number
  // Sequence is optional because mock/example graphs only model summary fields,
  // while imported GFA segments can provide the full nucleotide string.
  sequence?: string
  // Raw GFA segment tags (dp, RC, KC, ...), kept for display even when a tag
  // isn't one of the ones the app interprets itself (e.g. depth).
  tags?: Record<string, string | number>
}

export interface GraphEdge {
  from: string
  to: string
  overlap: number
}

export interface GraphPath {
  name: string
  nodeIds: string[] // Ordered list of node IDs in the path
  color?: string // Optional color for this path
  recordType?: 'P' | 'W'
  walk?: GraphWalkMetadata
}

export interface GraphWalkMetadata {
  sampleName: string
  haplotypeIndex: string
  sequenceName: string
  sequenceStart: string
  sequenceEnd: string
  tags: string[]
}

export interface Graph {
  name: string
  description: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  // These counts reflect source GFA records before orientation expansion.
  sourceRecordCounts?: {
    segments: number
    links: number
  }
  // Paths can come from GFA P-lines or W-lines and are optional because not
  // every graph carries embedded traversal information.
  paths?: GraphPath[] // Optional paths/walks embedded in the source GFA
}

export interface IndexedGraph {
  id: string
  name: string
  description: string
}

export interface IndexedAnnotation {
  id: string
  name: string
  description: string
}

export interface RegionPath {
  source: string
  reference: string
  haplotype: string
  sequence: string
  start: number
  // null when gfaidx can't determine the path's length (e.g. a pggb P-line
  // with no .cdx coordinate index) - the backend still lists the path since
  // it's queryable on the fly, just without a known upper bound.
  end: number | null
  entries: number
  label: string
}

export interface BedAnnotation {
  id: string
  chromosome: string | null
  start: number | null
  end: number | null
  lineNumber: number
  columns: BedAnnotationColumn[]
}

export interface BedAnnotationColumn {
  index: number
  header: string
  value: string
}

export interface LayoutOptions {
  quality: number
  linearLayout: boolean
  referencePathName: string
  referencePathRelaxRounds: number
  componentSeparation: number
  aspectRatio: number
  nodeLengthPerMegabase: number
  minimumNodeLength: number
  nodeSegmentLength: number
  edgeLength: number
}

export interface NodeSegment {
  x: number
  y: number
}

export interface LayoutResult {
  nodePositions: Record<string, NodeSegment[]>
}

export interface LayoutComputation {
  result: LayoutResult
  duration: number
}

export interface GraphStats {
  nodeCount: number
  edgeCount: number
  totalLength: number
  minLength: number
  maxLength: number
  avgLength: number
  medianLength: number
  lengthRatio: string
  // Ascending; shared with the length histogram so it isn't re-sorted.
  sortedLengths: number[]
}

export interface Transform {
  scale: number
  // Rotation is stored in radians; positive values appear clockwise because
  // canvas screen coordinates increase downward.
  rotation: number
  translateX: number
  translateY: number
}

export interface ContextMenu {
  visible: boolean
  x: number
  y: number
  nodeId: string | null
}

export interface DetailsDialog {
  visible: boolean
  nodeId: string | null
}

export type ColorScheme = 'uniform' | 'random' | 'depth' | 'grey'
