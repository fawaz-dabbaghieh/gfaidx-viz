import type {
  Graph,
  GraphNode,
  GraphEdge,
  GraphPath,
  GraphWalkMetadata,
} from '../types'
import type { GFAGraph, GFANode } from './gfaParser'

/**
 * Parse CIGAR string to extract overlap information
 * CIGAR format: [0-9]+[MIDNSHPX=]
 * For overlap, we typically care about M (match/mismatch)
 */
function parseCigarOverlap(cigar: string): number {
  if (!cigar || cigar === '*') return 0

  // Extract all match operations and sum them
  const matches = cigar.match(/(\d+)M/g)
  if (!matches) return 0

  return matches.reduce((sum, match) => {
    const num = parseInt(match.slice(0, -1))
    return sum + num
  }, 0)
}

// Splits a PanSN-style "sample#haplotype#sequence" name into its parts,
// matching the convention W-lines already use, so rGFA-derived paths display
// the same way. Falls back to putting the whole name in sequenceName.
function parsePanSNName(name: string): {
  sampleName: string
  haplotypeIndex: string
  sequenceName: string
} {
  const parts = name.split('#')
  if (parts.length === 3) {
    return {
      sampleName: parts[0]!,
      haplotypeIndex: parts[1]!,
      sequenceName: parts[2]!,
    }
  }
  return { sampleName: '', haplotypeIndex: '', sequenceName: name }
}

// minigraph-style rGFA graphs tag each backbone segment with SN (reference
// sequence name), SO (0-based offset on that sequence), and SR (rank; 0 means
// the segment is on the reference backbone itself) instead of encoding an
// explicit P/W path. Rank-0 segments for a given SN, sorted by SO, are
// exactly the reference path - synthesizing a GraphPath from them lets linear
// layout and the coordinate ruler work the same way they already do for real
// P/W paths, with neither needing to know the difference.
function synthesizeRGFAReferencePaths(
  gfaNodes: GFANode[],
  existingNodeIds: Set<string>,
): GraphPath[] {
  const bySequence = new Map<string, GFANode[]>()

  for (const node of gfaNodes) {
    if (node.tags.SR !== 0) continue
    const sequenceName = node.tags.SN
    if (typeof sequenceName !== 'string' || !sequenceName) continue
    if (typeof node.tags.SO !== 'number') continue

    const group = bySequence.get(sequenceName)
    if (group) {
      group.push(node)
    } else {
      bySequence.set(sequenceName, [node])
    }
  }

  const paths: GraphPath[] = []
  for (const [sequenceName, segments] of bySequence) {
    segments.sort((a, b) => (a.tags.SO as number) - (b.tags.SO as number))

    // Filter the segments themselves (not just the derived ids) so the
    // coordinate span below is always computed from the same segments that
    // actually end up in nodeIds - otherwise a segment dropped here (its "+"
    // orientation never used in an edge) would leave sequenceEnd covering
    // more than the path it actually describes.
    const usableSegments = segments.filter(segment =>
      existingNodeIds.has(`${segment.id}+`),
    )
    if (usableSegments.length === 0) continue

    const nodeIds = usableSegments.map(segment => `${segment.id}+`)
    const firstSegment = usableSegments[0]!
    const lastSegment = usableSegments[usableSegments.length - 1]!
    const lastLength =
      typeof lastSegment.tags.LN === 'number'
        ? lastSegment.tags.LN
        : lastSegment.length

    const walk: GraphWalkMetadata = {
      ...parsePanSNName(sequenceName),
      sequenceStart: String(firstSegment.tags.SO),
      sequenceEnd: String((lastSegment.tags.SO as number) + lastLength),
      tags: [],
    }

    paths.push({ name: sequenceName, nodeIds, recordType: 'W', walk })
  }

  return paths
}

/**
 * Convert GFA graph to Bandage app Graph format
 */
export function convertGFAToGraph(
  gfaGraph: GFAGraph,
  name: string = 'Imported GFA',
): Graph {
  // The app renders oriented nodes explicitly, so the converter expands each
  // GFA segment into + / - strand-specific node ids as needed by the links.
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  // First pass: determine which strand nodes are actually used
  const usedStrands = new Set<string>()
  for (const link of gfaGraph.links) {
    const sourceStrand = link.strand1 || '+'
    const targetStrand = link.strand2 || '+'
    usedStrands.add(`${link.source}${sourceStrand}`)
    usedStrands.add(`${link.target}${targetStrand}`)
  }
  for (const gfaPath of gfaGraph.paths) {
    // Both P-lines and normalized W-lines use the same internal
    // "node+,node-,..." representation here.
    for (const segment of gfaPath.path.split(',')) {
      if (segment) {
        usedStrands.add(segment)
      }
    }
  }

  // Convert nodes - only create strand versions that are actually used
  for (const gfaNode of gfaGraph.nodes) {
    // Extract depth from tags (common tags: dp, RC, FC, KC)
    const depth =
      (gfaNode.tags.dp as number) ||
      (gfaNode.tags.RC as number) ||
      (gfaNode.tags.FC as number) ||
      (gfaNode.tags.KC as number) ||
      1.0

    // Create positive strand node only if it's used in edges, or if neither
    // strand is - a segment with no links or paths (e.g. a one-node region
    // query) would otherwise vanish from the graph entirely.
    if (
      usedStrands.has(`${gfaNode.id}+`) ||
      !usedStrands.has(`${gfaNode.id}-`)
    ) {
      nodes.push({
        id: `${gfaNode.id}+`,
        name: gfaNode.id,
        length: gfaNode.length,
        depth: typeof depth === 'number' ? depth : 1.0,
        sequence: gfaNode.sequence,
        tags: gfaNode.tags,
      })
    }

    // Create negative strand node only if it's used in edges
    if (usedStrands.has(`${gfaNode.id}-`)) {
      nodes.push({
        id: `${gfaNode.id}-`,
        name: gfaNode.id,
        length: gfaNode.length,
        depth: typeof depth === 'number' ? depth : 1.0,
        sequence: gfaNode.sequence,
        tags: gfaNode.tags,
      })
    }
  }

  // Every path traversal re-mints a node id string for each node it passes
  // through (hundreds of haplotype paths commonly share most of the same
  // backbone nodes), which without interning meant, for a real 470-haplotype
  // pangenome graph, ~15 million separate string objects for what are really
  // only ~85,000 distinct ids - measured to add several hundred MB on its
  // own. Interning against the canonical id already sitting on each node
  // means every edge endpoint and path entry reuses that same string
  // instance instead of allocating a new one.
  const nodeIdIntern = new Map<string, string>()
  for (const node of nodes) nodeIdIntern.set(node.id, node.id)
  const internNodeId = (id: string): string => nodeIdIntern.get(id) ?? id

  // Convert links to edges
  for (const link of gfaGraph.links) {
    const overlap = parseCigarOverlap(link.cigar)

    // Determine the strand orientation
    const sourceStrand = link.strand1 || '+'
    const targetStrand = link.strand2 || '+'

    // Create edge with proper strand notation
    const from = internNodeId(`${link.source}${sourceStrand}`)
    const to = internNodeId(`${link.target}${targetStrand}`)

    edges.push({
      from,
      to,
      overlap,
    })
  }

  // Process paths
  const paths: GraphPath[] = []

  for (const gfaPath of gfaGraph.paths) {
    // Parse path string (format: node1+,node2-,node3+,...)
    const pathSegments = gfaPath.path.split(',')
    const nodeIds: string[] = []

    for (const segment of pathSegments) {
      const strand = segment.slice(-1) // Last character is the strand
      const nodeName = segment.slice(0, -1) // Everything except last character
      nodeIds.push(internNodeId(`${nodeName}${strand}`))
    }

    paths.push({
      name: gfaPath.name,
      nodeIds,
      recordType: gfaPath.recordType,
      walk: gfaPath.walk,
    })
  }

  // minigraph-style rGFA graphs have no P/W lines at all; synthesize the
  // reference path(s) from segment SN/SO/SR tags instead so linear layout
  // and the coordinate ruler still have a path to work with.
  const existingNodeIds = new Set(nodes.map(node => node.id))
  for (const rgfaPath of synthesizeRGFAReferencePaths(
    gfaGraph.nodes,
    existingNodeIds,
  )) {
    rgfaPath.nodeIds = rgfaPath.nodeIds.map(internNodeId)
    paths.push(rgfaPath)
  }

  return {
    name,
    description: `Imported from GFA file with ${nodes.length} nodes and ${edges.length} links${paths.length > 0 ? ` and ${paths.length} paths` : ''}`,
    nodes,
    edges,
    sourceRecordCounts: {
      segments: gfaGraph.nodes.length,
      links: gfaGraph.links.length,
    },
    paths: paths.length > 0 ? paths : undefined,
  }
}
