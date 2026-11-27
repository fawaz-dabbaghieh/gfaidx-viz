// minigraph-style rGFA graphs give each segment a rank (SR tag): 0 for the
// reference backbone, then 1, 2, ... in the order the other assemblies were
// added. They have no haplotype paths, only the reference, which
// gfaConverter rebuilds from the rank-0 segments' SN/SO tags.
import type { Graph, GraphNode } from '../types'
import { type Rgb, rampColor, rampGradient } from './colorRamp'

export function rgfaRank(node: GraphNode): number | null {
  const rank = node.tags?.SR
  return typeof rank === 'number' ? rank : null
}

const maxRankCache = new WeakMap<Graph, number | null>()

// The highest rank in the graph, or null when no segment has an SR tag (the
// graph isn't an rGFA).
export function getRGFAMaxRank(graph: Graph): number | null {
  if (maxRankCache.has(graph)) return maxRankCache.get(graph)!
  let maxRank: number | null = null
  for (const node of graph.nodes) {
    const rank = rgfaRank(node)
    if (rank !== null) maxRank = Math.max(maxRank ?? 0, rank)
  }
  maxRankCache.set(graph, maxRank)
  return maxRank
}

// The "rGFA Rank" node colors: the reference in the usual node blue, the
// other ranks on a ramp from the first assembly added to the last that
// changes hue as well as lightness, so the two ends are far apart. Each
// theme has its own ramp so every step stands out against the canvas.
export const RGFA_REFERENCE_COLOR: Rgb = [52, 152, 219]
const NO_RANK_COLOR: Rgb = [160, 160, 160]
const RANK_RAMPS: Record<'light' | 'dark', Rgb[]> = {
  // amber, crimson, dark magenta
  light: [
    [217, 119, 6],
    [190, 18, 60],
    [112, 26, 117],
  ],
  // pale yellow, orange, red
  dark: [
    [253, 230, 138],
    [251, 146, 60],
    [220, 38, 38],
  ],
}

export function rgfaRankColor(
  rank: number | null,
  maxRank: number,
  isDarkMode: boolean,
): Rgb {
  if (rank === null) return NO_RANK_COLOR
  if (rank === 0) return RGFA_REFERENCE_COLOR
  return rampColor(
    RANK_RAMPS[isDarkMode ? 'dark' : 'light'],
    maxRank > 1 ? (rank - 1) / (maxRank - 1) : 0,
  )
}

export function rgfaRankGradient(isDarkMode: boolean): string {
  return rampGradient(RANK_RAMPS[isDarkMode ? 'dark' : 'light'])
}
