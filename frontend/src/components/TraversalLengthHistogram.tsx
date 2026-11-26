import { useMemo, useState } from 'react'

const WIDTH = 720
const HEIGHT = 150
const MARGIN = { top: 16, right: 16, bottom: 24, left: 40 }
const BIN_COUNT = 40
const MAX_BAR_WIDTH = 24

interface Bin {
  from: number
  to: number
  count: number
}

function binLengths(lengths: number[]): Bin[] {
  let min = Infinity
  let max = -Infinity
  for (const length of lengths) {
    min = Math.min(min, length)
    max = Math.max(max, length)
  }
  if (lengths.length === 0) return []
  const count = min === max ? 1 : BIN_COUNT
  const width = (max - min) / count
  const bins = Array.from({ length: count }, (_, i) => ({
    from: Math.round(min + i * width),
    to: i === count - 1 ? max : Math.round(min + (i + 1) * width),
    count: 0,
  }))
  for (const length of lengths) {
    const bin = width > 0 ? Math.floor((length - min) / width) : 0
    bins[Math.min(count - 1, bin)]!.count++
  }
  return bins
}

// A bar rounded at the top and square at the baseline.
function barPath(x: number, y: number, width: number, height: number) {
  const r = Math.min(4, width / 2, height)
  return (
    `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}` +
    `H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`
  )
}

const bp = (value: number) => `${value.toLocaleString()} bp`

interface TraversalLengthHistogramProps {
  // One length per pass through the bubble.
  lengths: number[]
  referenceBp: number | null
}

// How long the passes through a bubble are, for bubbles with too many
// traversals to read one by one.
export function TraversalLengthHistogram({
  lengths,
  referenceBp,
}: TraversalLengthHistogramProps) {
  const [hoveredBin, setHoveredBin] = useState<number | null>(null)
  const bins = useMemo(() => binLengths(lengths), [lengths])
  if (bins.length === 0) return null

  const min = bins[0]!.from
  const max = bins[bins.length - 1]!.to
  const maxCount = Math.max(...bins.map(bin => bin.count))
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom
  const baseline = MARGIN.top + plotHeight
  const band = plotWidth / bins.length
  const barWidth = Math.min(MAX_BAR_WIDTH, band - 2)
  const xOf = (length: number) =>
    MARGIN.left +
    (max > min ? ((length - min) / (max - min)) * plotWidth : plotWidth / 2)
  const hovered = hoveredBin === null ? null : bins[hoveredBin]!

  return (
    <div className="traversal-histogram">
      <div className="traversal-histogram-readout">
        {hovered
          ? `${hovered.count.toLocaleString()} ${hovered.count === 1 ? 'pass' : 'passes'} of ${hovered.from.toLocaleString()}–${bp(hovered.to)}`
          : `Length of each of the ${lengths.length.toLocaleString()} passes, ${bp(min)} to ${bp(max)}. Hover a bar for its count.`}
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Traversal lengths from ${bp(min)} to ${bp(max)}`}
      >
        <line
          className="traversal-histogram-axis"
          x1={MARGIN.left}
          x2={WIDTH - MARGIN.right}
          y1={baseline}
          y2={baseline}
        />
        <text
          className="traversal-histogram-label"
          x={MARGIN.left - 6}
          y={MARGIN.top + 4}
          textAnchor="end"
        >
          {maxCount.toLocaleString()}
        </text>
        <text
          className="traversal-histogram-label"
          x={MARGIN.left - 6}
          y={baseline}
          textAnchor="end"
        >
          0
        </text>
        <text
          className="traversal-histogram-label"
          x={MARGIN.left}
          y={HEIGHT - 6}
        >
          {bp(min)}
        </text>
        <text
          className="traversal-histogram-label"
          x={WIDTH - MARGIN.right}
          y={HEIGHT - 6}
          textAnchor="end"
        >
          {bp(max)}
        </text>
        {bins.map((bin, i) => {
          const height = (bin.count / maxCount) * plotHeight
          const x = MARGIN.left + i * band + (band - barWidth) / 2
          return (
            bin.count > 0 && (
              <path
                key={i}
                className={`traversal-histogram-bar${i === hoveredBin ? ' hovered' : ''}`}
                d={barPath(x, baseline - height, barWidth, height)}
              />
            )
          )
        })}
        {referenceBp !== null && (
          <g className="traversal-histogram-reference">
            <line
              x1={xOf(referenceBp)}
              x2={xOf(referenceBp)}
              y1={MARGIN.top}
              y2={baseline}
            />
            <text
              x={xOf(referenceBp)}
              y={MARGIN.top - 4}
              textAnchor={xOf(referenceBp) > WIDTH / 2 ? 'end' : 'start'}
            >
              reference ({bp(referenceBp)})
            </text>
          </g>
        )}
        {/* Hit targets: the whole band of each bin, not only its bar. */}
        {bins.map((bin, i) => (
          <rect
            key={i}
            className="traversal-histogram-hit"
            x={MARGIN.left + i * band}
            y={MARGIN.top}
            width={band}
            height={plotHeight}
            tabIndex={0}
            aria-label={`${bin.count} passes of ${bin.from}–${bin.to} bp`}
            onPointerEnter={() => setHoveredBin(i)}
            onPointerLeave={() => setHoveredBin(null)}
            onFocus={() => setHoveredBin(i)}
            onBlur={() => setHoveredBin(null)}
          />
        ))}
      </svg>
    </div>
  )
}
