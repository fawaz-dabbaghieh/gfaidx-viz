import type { Graph, GraphStats } from '../types'
import { buildDisplayGraph, getDisplayNodes } from './displayGraph'

// Keyed by graph object identity, so reopening the statistics dialog on the
// same graph is free, and a new graph (or restyled copy) is computed once.
const statsCache = new WeakMap<Graph, GraphStats>()

export function getGraphStats(graph: Graph): GraphStats {
  const cached = statsCache.get(graph)
  if (cached) return cached

  // Stats are derived from the same single-mode display abstraction as the
  // canvas so counts stay correct even when only one orientation is present.
  const lengths = getDisplayNodes(graph)
    .map(n => n.length)
    .sort((a, b) => a - b)
  const displayGraph = buildDisplayGraph(graph)

  const totalLength = lengths.reduce((sum, l) => sum + l, 0)
  const minLength = lengths[0] ?? 0
  const maxLength = lengths[lengths.length - 1] ?? 0

  const stats: GraphStats = {
    nodeCount: lengths.length,
    edgeCount: displayGraph.edges.length,
    totalLength,
    minLength,
    maxLength,
    avgLength: lengths.length ? totalLength / lengths.length : 0,
    medianLength: lengths[Math.floor(lengths.length / 2)] ?? 0,
    lengthRatio: minLength > 0 ? (maxLength / minLength).toFixed(1) : '-',
    sortedLengths: lengths,
  }
  statsCache.set(graph, stats)
  return stats
}
