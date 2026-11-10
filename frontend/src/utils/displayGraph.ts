import type {
  Graph,
  GraphEdge,
  GraphNode,
  GraphPath,
  NodeSegment,
} from '../types'

export interface DisplayNode {
  key: string
  representativeId: string
  node: GraphNode
  nodeIds: string[]
  segments: NodeSegment[]
}

// Each traversal only ever needs two things: which path it belongs to, and
// whether it runs the same direction as the edge's representativeEdge or its
// reverse-complement (a path can traverse either side of a stored L-line -
// see resolveTraversalEdge). Packing both into one signed integer - the path
// index for a forward traversal, -(index + 1) for a reverse-complement one -
// avoids a per-traversal object allocation entirely. On a real ~54k-node,
// 470-haplotype pangenome graph this array held ~15 million entries; the
// previous {edge, pathId} object-per-entry representation measured at ~600MB
// for that alone, versus a few dozen MB as plain Int32Arrays here.
export type EncodedTraversal = number

export function decodeTraversalPathIndex(encoded: EncodedTraversal): number {
  return encoded >= 0 ? encoded : -encoded - 1
}

export function decodeTraversalIsForward(encoded: EncodedTraversal): boolean {
  return encoded >= 0
}

function encodeTraversal(pathIndex: number, isForward: boolean): EncodedTraversal {
  return isForward ? pathIndex : -pathIndex - 1
}

// Reconstructs the {from, to} a traversal actually runs, without needing to
// have stored a whole edge object for it. A forward traversal is exactly
// representativeEdge; a reverse-complement one swaps and flips both ends.
// overlap is never read off a per-traversal edge anywhere in the app (only
// off the canonical GraphEdge), so reusing representativeEdge's value for
// both directions is safe.
export function resolveTraversalEdge(
  encoded: EncodedTraversal,
  representativeEdge: GraphEdge,
): GraphEdge {
  if (decodeTraversalIsForward(encoded)) return representativeEdge
  return {
    from: getReverseComplementNodeId(representativeEdge.to),
    to: getReverseComplementNodeId(representativeEdge.from),
    overlap: representativeEdge.overlap,
  }
}

export function resolveTraversalPathName(
  encoded: EncodedTraversal,
  paths: GraphPath[],
): string {
  return paths[decodeTraversalPathIndex(encoded)]!.name
}

export interface DisplayEdge {
  key: string
  representativeEdge: GraphEdge
  edges: GraphEdge[]
  fromNodeKey: string
  toNodeKey: string
  pathIds: string[]
  // One entry per (path, direction), even when a path loops through this
  // edge several times (e.g. a repeat in a pggb graph); the canvas caps how
  // many parallel lines it draws for such repeats.
  pathTraversals: Int32Array
  // Parallel to pathTraversals: how many times that path crossed the edge in
  // that direction.
  traversalCounts: Uint32Array
}

export interface DisplayGraph {
  nodes: DisplayNode[]
  nodesByKey: Map<string, DisplayNode>
  edges: DisplayEdge[]
}

function getCanonicalEdgeKeyForPair(fromNodeId: string, toNodeId: string): string {
  const forwardKey = `${fromNodeId}->${toNodeId}`
  const reverseComplementKey = `${getReverseComplementNodeId(toNodeId)}->${getReverseComplementNodeId(fromNodeId)}`
  return forwardKey < reverseComplementKey ? forwardKey : reverseComplementKey
}

export function stripNodeOrientation(nodeId: string): string {
  return nodeId.endsWith('+') || nodeId.endsWith('-')
    ? nodeId.slice(0, -1)
    : nodeId
}

export function pathHasRepeatedSegments(nodeIds: string[]): boolean {
  const visitedSegments = new Set<string>()
  return nodeIds.some(nodeId => {
    const segmentId = stripNodeOrientation(nodeId)
    if (visitedSegments.has(segmentId)) return true
    visitedSegments.add(segmentId)
    return false
  })
}

export function getReverseComplementNodeId(nodeId: string): string {
  if (nodeId.endsWith('+')) return `${nodeId.slice(0, -1)}-`
  if (nodeId.endsWith('-')) return `${nodeId.slice(0, -1)}+`
  return nodeId
}

export function reverseSegments(segments: NodeSegment[]): NodeSegment[] {
  // Reverse-complement nodes reuse the same visible contig geometry, but the
  // segment traversal order must flip so edge attachment points stay correct.
  return [...segments].reverse().map(segment => ({ ...segment }))
}

function chooseRepresentativeNodeId(nodeIds: string[]): string {
  // Single-mode Bandage prefers positive nodes when they exist, but still
  // falls back to the only available orientation for one-sided graphs.
  return (
    nodeIds.find(nodeId => nodeId.endsWith('+')) ??
    [...nodeIds].sort()[0] ??
    nodeIds[0]!
  )
}

function getCanonicalEdgeKey(edge: GraphEdge): string {
  return getCanonicalEdgeKeyForPair(edge.from, edge.to)
}

function chooseRepresentativeEdge(
  edges: GraphEdge[],
  nodesByKey: Map<string, DisplayNode>,
): GraphEdge {
  return (
    edges.find(edge => {
      const fromNode = nodesByKey.get(stripNodeOrientation(edge.from))
      const toNode = nodesByKey.get(stripNodeOrientation(edge.to))

      return (
        edge.from === fromNode?.representativeId &&
        edge.to === toNode?.representativeId
      )
    }) ??
    edges[0]!
  )
}

// Deliberately takes only the graph, not node positions: grouping nodes and
// walking every path to build pathTraversals (the expensive part - tens of
// millions of entries on a large multi-haplotype pangenome graph) depends
// only on topology, never on where anything is drawn. Segments start empty
// and are always filled in afterward by updateDisplayGraphNodePositions, so
// coupling this to a specific layout result would only force the whole
// traversal walk to redo itself on every redraw for no benefit - which is
// exactly what used to happen when nodePositions was a dependency here.
export function buildDisplayGraph(graph: Graph): DisplayGraph {
  const nodeGroups = new Map<string, GraphNode[]>()
  for (const node of graph.nodes) {
    const key = stripNodeOrientation(node.id)
    if (!nodeGroups.has(key)) {
      nodeGroups.set(key, [])
    }
    nodeGroups.get(key)!.push(node)
  }

  const nodes = Array.from(nodeGroups.entries(), ([key, groupedNodes]) => {
    const representativeId = chooseRepresentativeNodeId(
      groupedNodes.map(node => node.id),
    )
    const representativeNode =
      groupedNodes.find(node => node.id === representativeId) ?? groupedNodes[0]!

    return {
      key,
      representativeId,
      node: representativeNode,
      nodeIds: groupedNodes.map(node => node.id),
      segments: [] as NodeSegment[],
    }
  })

  const nodesByKey = new Map(nodes.map(node => [node.key, node]))

  const edgeGroups = new Map<string, GraphEdge[]>()
  for (const edge of graph.edges) {
    const key = getCanonicalEdgeKey(edge)
    if (!edgeGroups.has(key)) {
      edgeGroups.set(key, [])
    }
    edgeGroups.get(key)!.push(edge)
  }

  // representativeEdge has to be chosen before traversals can be encoded
  // relative to it (forward vs. reverse-complement), so this builds the edge
  // shells first and fills in pathTraversals/pathIds in a second pass below.
  const edgeShells = new Map<
    string,
    {
      representativeEdge: GraphEdge
      groupedEdges: GraphEdge[]
      traversals: number[]
      counts: number[]
      // A path's crossings of an edge all happen while that one path is
      // being walked below, so remembering where the current path's forward
      // and reverse entries sit is enough to dedupe without a per-edge map.
      currentPathIndex: number
      forwardSlot: number
      reverseSlot: number
    }
  >()
  for (const [key, groupedEdges] of edgeGroups) {
    edgeShells.set(key, {
      representativeEdge: chooseRepresentativeEdge(groupedEdges, nodesByKey),
      groupedEdges,
      traversals: [],
      counts: [],
      currentPathIndex: -1,
      forwardSlot: -1,
      reverseSlot: -1,
    })
  }

  const paths = graph.paths ?? []
  const pathIndexByName = new Map(paths.map((path, index) => [path.name, index]))

  for (const path of paths) {
    const pathIndex = pathIndexByName.get(path.name)!
    for (let i = 0; i < path.nodeIds.length - 1; i++) {
      const from = path.nodeIds[i]!
      const to = path.nodeIds[i + 1]!
      const edgeKey = getCanonicalEdgeKeyForPair(from, to)
      const shell = edgeShells.get(edgeKey)
      if (!shell) continue

      // A path can traverse either this edge's stored direction or its
      // reverse-complement (see resolveTraversalEdge) - which is which can
      // only be decided once representativeEdge exists, unlike the
      // direction-agnostic canonical key used to find it above.
      const isForward =
        from === shell.representativeEdge.from &&
        to === shell.representativeEdge.to

      if (shell.currentPathIndex !== pathIndex) {
        shell.currentPathIndex = pathIndex
        shell.forwardSlot = -1
        shell.reverseSlot = -1
      }
      const slot = isForward ? shell.forwardSlot : shell.reverseSlot
      if (slot >= 0) {
        shell.counts[slot]!++
        continue
      }
      if (isForward) shell.forwardSlot = shell.traversals.length
      else shell.reverseSlot = shell.traversals.length
      shell.traversals.push(encodeTraversal(pathIndex, isForward))
      shell.counts.push(1)
    }
  }

  const edges = Array.from(edgeShells.entries(), ([key, shell]) => {
    const { representativeEdge, groupedEdges, traversals, counts } = shell
    const pathTraversals = Int32Array.from(traversals)

    const pathIndexSet = new Set<number>()
    for (const encoded of pathTraversals) {
      pathIndexSet.add(decodeTraversalPathIndex(encoded))
    }
    const pathIds = Array.from(pathIndexSet, index => paths[index]!.name)

    return {
      key,
      representativeEdge,
      edges: groupedEdges,
      fromNodeKey: stripNodeOrientation(representativeEdge.from),
      toNodeKey: stripNodeOrientation(representativeEdge.to),
      pathIds,
      pathTraversals,
      traversalCounts: Uint32Array.from(counts),
    }
  })

  return { nodes, nodesByKey, edges }
}

export interface EdgePathGroup {
  from: string
  to: string
  // count = how many times the path crossed the edge in this direction
  paths: { name: string; count: number }[]
}

// Groups an edge's traversals by the direction they actually run, for the
// "which paths cross this connection" lists in the tooltip and info panel.
export function groupEdgeTraversalsByDirection(
  edge: DisplayEdge,
  paths: GraphPath[],
): EdgePathGroup[] {
  const groups = new Map<
    string,
    { from: string; to: string; counts: Map<string, number> }
  >()
  edge.pathTraversals.forEach((encoded, i) => {
    const { from, to } = resolveTraversalEdge(encoded, edge.representativeEdge)
    const directionKey = `${from}->${to}`
    let group = groups.get(directionKey)
    if (!group) {
      group = { from, to, counts: new Map() }
      groups.set(directionKey, group)
    }
    // Keyed by name so two paths sharing a name still list once.
    const name = resolveTraversalPathName(encoded, paths)
    group.counts.set(
      name,
      (group.counts.get(name) ?? 0) + edge.traversalCounts[i]!,
    )
  })
  return Array.from(groups.values(), ({ from, to, counts }) => ({
    from,
    to,
    paths: Array.from(counts, ([name, count]) => ({ name, count })),
  }))
}

// Counts how many times each path visits a node, in either orientation.
export function countPathVisitsToNode(
  displayNode: DisplayNode,
  paths: GraphPath[],
): { name: string; count: number }[] {
  const nodeIds = new Set(displayNode.nodeIds)
  // Path steps carry an orientation even when the graph only stores one.
  nodeIds.add(`${displayNode.key}+`)
  nodeIds.add(`${displayNode.key}-`)

  const visits = new Map<string, number>()
  for (const path of paths) {
    let count = 0
    for (const nodeId of path.nodeIds) {
      if (nodeIds.has(nodeId)) count++
    }
    if (count > 0) visits.set(path.name, (visits.get(path.name) ?? 0) + count)
  }
  return Array.from(visits, ([name, count]) => ({ name, count }))
}

export function updateDisplayGraphNodePositions(
  displayGraph: DisplayGraph,
  nodePositions: Record<string, NodeSegment[]>,
): DisplayGraph {
  const nodes = displayGraph.nodes.map(displayNode => ({
    ...displayNode,
    segments: nodePositions[displayNode.representativeId] ?? [],
  }))

  return {
    nodes,
    nodesByKey: new Map(nodes.map(node => [node.key, node])),
    edges: displayGraph.edges,
  }
}

export function filterDisplayGraphByPaths(
  displayGraph: DisplayGraph,
  paths: GraphPath[],
  selectedPathIds: Set<string>,
): DisplayGraph {
  const selectedNodeKeys = new Set<string>()

  // Path node IDs include orientation, while the display graph collapses both
  // orientations into one visible node.
  for (const path of paths) {
    if (!selectedPathIds.has(path.name)) continue

    for (const nodeId of path.nodeIds) {
      selectedNodeKeys.add(stripNodeOrientation(nodeId))
    }
  }

  const nodes = displayGraph.nodes.filter(node => selectedNodeKeys.has(node.key))
  const edges = displayGraph.edges.filter(edge =>
    edge.pathTraversals.some(encoded =>
      selectedPathIds.has(resolveTraversalPathName(encoded, paths)),
    ),
  )

  return {
    nodes,
    nodesByKey: new Map(nodes.map(node => [node.key, node])),
    edges,
  }
}

export function resolveDisplaySegments(
  nodeId: string,
  displayGraph: DisplayGraph,
): NodeSegment[] | null {
  const displayNode = displayGraph.nodesByKey.get(stripNodeOrientation(nodeId))
  if (!displayNode) return null

  if (nodeId === displayNode.representativeId) {
    return displayNode.segments
  }

  return reverseSegments(displayNode.segments)
}

export function getDisplayNodes(graph: Graph): GraphNode[] {
  const nodeGroups = new Map<string, GraphNode[]>()
  for (const node of graph.nodes) {
    const key = stripNodeOrientation(node.id)
    if (!nodeGroups.has(key)) {
      nodeGroups.set(key, [])
    }
    nodeGroups.get(key)!.push(node)
  }

  return Array.from(nodeGroups.values(), groupedNodes => {
    return (
      groupedNodes.find(node => node.id.endsWith('+')) ??
      [...groupedNodes].sort((a, b) => a.id.localeCompare(b.id))[0]!
    )
  })
}
