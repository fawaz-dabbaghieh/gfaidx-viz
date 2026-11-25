import { getGraphStats } from '../utils/graphStats'
import type { BubbleSet } from '../utils/bubbleGun'
import type { Graph } from '../types'

interface StatsPanelProps {
  graph: Graph
  layoutDuration: number | null
  // Null while bubble detection is still running.
  bubbles: BubbleSet | null
}

export function StatsPanel({
  graph,
  layoutDuration,
  bubbles,
}: StatsPanelProps) {
  // Cached per graph in getGraphStats, so reopening the dialog is cheap.
  const stats = getGraphStats(graph)

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`
    if (num >= 1000) return `${(num / 1000).toFixed(1)}k`
    return num.toFixed(0)
  }

  return (
    <div className="stats-panel">
      <h3>Graph Statistics</h3>

      <div className="stats-grid">
        <div className="stat-item">
          <div className="stat-label">Contigs</div>
          <div className="stat-value">{stats.nodeCount}</div>
        </div>

        <div className="stat-item">
          <div className="stat-label">Edges</div>
          <div className="stat-value">{stats.edgeCount}</div>
        </div>

        <div className="stat-item">
          <div className="stat-label">Total Length</div>
          <div className="stat-value">{formatNumber(stats.totalLength)}bp</div>
        </div>

        <div className="stat-item">
          <div className="stat-label">Length Range</div>
          <div className="stat-value">
            {formatNumber(stats.minLength)} - {formatNumber(stats.maxLength)}bp
          </div>
        </div>

        <div className="stat-item">
          <div className="stat-label">Length Ratio</div>
          <div className="stat-value">{stats.lengthRatio}:1</div>
        </div>

        <div className="stat-item">
          <div className="stat-label">Avg Length</div>
          <div className="stat-value">{formatNumber(stats.avgLength)}bp</div>
        </div>

        <div className="stat-item">
          <div className="stat-label">Median Length</div>
          <div className="stat-value">{formatNumber(stats.medianLength)}bp</div>
        </div>

        {layoutDuration && (
          <div className="stat-item highlight">
            <div className="stat-label">Layout Time</div>
            <div className="stat-value">{layoutDuration.toFixed(1)}ms</div>
          </div>
        )}
      </div>

      <h3>Bubbles</h3>
      {bubbles ? (
        <div className="stats-grid">
          <div className="stat-item">
            <div className="stat-label">Bubbles</div>
            <div className="stat-value">
              {bubbles.bubbles.length.toLocaleString()}
            </div>
          </div>

          <div className="stat-item">
            <div className="stat-label">Simple Bubbles</div>
            <div className="stat-value">
              {bubbles.counts.simple.toLocaleString()}
            </div>
          </div>

          <div className="stat-item">
            <div className="stat-label">Superbubbles</div>
            <div className="stat-value">
              {bubbles.counts.super.toLocaleString()}
            </div>
          </div>

          <div className="stat-item">
            <div className="stat-label">Insertions</div>
            <div className="stat-value">
              {bubbles.counts.insertion.toLocaleString()}
            </div>
          </div>

          <div className="stat-item">
            <div className="stat-label">Nodes in Bubbles</div>
            <div className="stat-value">
              {formatPercent(bubbles.coveredNodes, bubbles.totalNodes)}
            </div>
          </div>

          <div className="stat-item">
            <div className="stat-label">Sequence in Bubbles</div>
            <div className="stat-value">
              {formatPercent(bubbles.coveredBp, bubbles.totalBp)}
            </div>
          </div>

          <div className="stat-item">
            <div className="stat-label">Max Nestedness</div>
            <div className="stat-value">{bubbles.maxNestedness}</div>
          </div>

          <div className="stat-item">
            <div className="stat-label">Detection Time</div>
            <div className="stat-value">{bubbles.totalMs.toFixed(1)}ms</div>
          </div>
        </div>
      ) : (
        <div className="control-hint">Finding bubbles...</div>
      )}
    </div>
  )
}

// Nodes or sequence that are an end or inside of any bubble.
function formatPercent(part: number, total: number): string {
  if (total === 0) return '0%'
  return `${((part / total) * 100).toFixed(1)}%`
}
