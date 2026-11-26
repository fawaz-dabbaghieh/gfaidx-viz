import type { Graph } from '../types'

// One entry per GFA segment (graph.nodes has one node per orientation in
// use), numbered in order of first appearance. Bubble detection and the walk
// index both use it, so their node indices agree.
export interface SegmentIndex {
  names: string[]
  lengths: Int32Array
  indexByName: Map<string, number>
  // Oriented node id ("12+", as in edges and path nodeIds): the segment
  // index times two, plus one for '-'.
  orientedIndex: Map<string, number>
}

const segmentIndexCache = new WeakMap<Graph, SegmentIndex>()

export function getSegmentIndex(graph: Graph): SegmentIndex {
  const cached = segmentIndexCache.get(graph)
  if (cached) return cached

  const names: string[] = []
  const lengths: number[] = []
  const indexByName = new Map<string, number>()
  const orientedIndex = new Map<string, number>()
  for (const node of graph.nodes) {
    let index = indexByName.get(node.name)
    if (index === undefined) {
      index = names.length
      indexByName.set(node.name, index)
      names.push(node.name)
      lengths.push(node.length)
    }
    orientedIndex.set(node.id, index * 2 + (node.id.endsWith('-') ? 1 : 0))
  }

  const segmentIndex = {
    names,
    lengths: Int32Array.from(lengths),
    indexByName,
    orientedIndex,
  }
  segmentIndexCache.set(graph, segmentIndex)
  return segmentIndex
}
