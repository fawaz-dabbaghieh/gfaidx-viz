import { useEffect, useMemo, useRef, useState } from 'react'
import type { Graph } from '../types'
import { getGraphStats } from '../utils/graphStats'

interface LengthDistributionProps {
  graph: Graph
  isDarkMode: boolean
  width?: number
  height?: number
}

interface Histogram {
  counts: number[]
  // edges[i]..edges[i + 1] is bin i, in bp
  edges: number[]
  logScale: boolean
}

const MAX_BINS = 40
// Above this max/min ratio a linear axis crams nearly every node into the
// first bin, so bins are spaced logarithmically instead.
const LOG_SCALE_RATIO = 100

const PAD = { top: 12, right: 16, bottom: 42, left: 56 }

function formatBp(value: number): string {
  const trim = (n: number) => n.toFixed(1).replace(/\.0$/, '')
  if (value >= 1e6) return `${trim(value / 1e6)}Mb`
  if (value >= 1e3) return `${trim(value / 1e3)}kb`
  return `${Math.round(value)}bp`
}

function buildHistogram(sortedLengths: number[]): Histogram | null {
  if (sortedLengths.length === 0) return null
  const min = sortedLengths[0]!
  const max = sortedLengths[sortedLengths.length - 1]!
  const logScale = min > 0 && max / min >= LOG_SCALE_RATIO

  let binCount = Math.min(
    MAX_BINS,
    Math.max(1, Math.ceil(Math.sqrt(sortedLengths.length))),
  )
  // Lengths are whole bp; don't split a small linear range into fractional bins.
  if (!logScale) binCount = Math.min(binCount, max - min + 1)

  const toAxis = logScale ? Math.log10 : (v: number) => v
  const fromAxis = logScale ? (v: number) => 10 ** v : (v: number) => v
  const lo = toAxis(min)
  const hi = toAxis(max)
  const span = hi - lo || 1

  const edges = Array.from({ length: binCount + 1 }, (_, i) =>
    fromAxis(lo + (span * i) / binCount),
  )
  const counts = new Array<number>(binCount).fill(0)
  for (const length of sortedLengths) {
    const bin = Math.floor(((toAxis(length) - lo) / span) * binCount)
    counts[Math.min(binCount - 1, Math.max(0, bin))]!++
  }
  return { counts, edges, logScale }
}

// Up to ~4 round tick values between 0 and max.
function countTicks(max: number): number[] {
  const rough = max / 4
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rough, 1)))
  const step =
    [1, 2, 5, 10].map(m => m * magnitude).find(s => s >= rough) ??
    10 * magnitude
  const ticks: number[] = []
  for (let v = 0; v <= max; v += step) ticks.push(v)
  return ticks
}

function lengthTicks(histogram: Histogram): number[] {
  const min = histogram.edges[0]!
  const max = histogram.edges[histogram.edges.length - 1]!
  if (histogram.logScale) {
    const ticks: number[] = []
    for (
      let exp = Math.ceil(Math.log10(min));
      10 ** exp <= max;
      exp++
    ) {
      ticks.push(10 ** exp)
    }
    return ticks
  }
  // Whole bp, deduped so a narrow range doesn't repeat the same label.
  return [
    ...new Set(
      Array.from({ length: 5 }, (_, i) =>
        Math.round(min + ((max - min) * i) / 4),
      ),
    ),
  ]
}

export function LengthDistribution({
  graph,
  isDarkMode,
  width = 800,
  height = 220,
}: LengthDistributionProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hoveredBin, setHoveredBin] = useState<number | null>(null)

  const histogram = useMemo(
    () => buildHistogram(getGraphStats(graph).sortedLengths),
    [graph],
  )

  const chartWidth = width - PAD.left - PAD.right
  const chartHeight = height - PAD.top - PAD.bottom

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || !histogram) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = width + 'px'
    canvas.style.height = height + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const colors = isDarkMode
      ? { bg: '#1a1a1a', axis: '#666', text: '#aaa', bar: '#3498db' }
      : { bg: '#fafafa', axis: '#bbb', text: '#555', bar: '#2980b9' }

    ctx.fillStyle = colors.bg
    ctx.fillRect(0, 0, width, height)

    const { counts, edges, logScale } = histogram
    const maxCount = Math.max(...counts)
    const yTicks = countTicks(maxCount)
    const yMax = Math.max(maxCount, yTicks[yTicks.length - 1]!)
    const binWidth = chartWidth / counts.length
    const toAxis = logScale ? Math.log10 : (v: number) => v
    const xLo = toAxis(edges[0]!)
    const xSpan = toAxis(edges[edges.length - 1]!) - xLo || 1
    const xFor = (length: number) =>
      PAD.left + ((toAxis(length) - xLo) / xSpan) * chartWidth
    const yFor = (count: number) =>
      PAD.top + chartHeight - (count / yMax) * chartHeight

    // Horizontal gridlines + count labels
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (const tick of yTicks) {
      const y = yFor(tick)
      ctx.strokeStyle = colors.axis
      ctx.globalAlpha = tick === 0 ? 1 : 0.3
      ctx.beginPath()
      ctx.moveTo(PAD.left, y)
      ctx.lineTo(PAD.left + chartWidth, y)
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.fillStyle = colors.text
      ctx.fillText(tick.toLocaleString(), PAD.left - 6, y)
    }

    counts.forEach((count, i) => {
      if (count === 0) return
      const y = yFor(count)
      ctx.fillStyle = colors.bar
      ctx.globalAlpha = hoveredBin === null || hoveredBin === i ? 0.9 : 0.5
      ctx.fillRect(
        PAD.left + i * binWidth + 0.5,
        y,
        Math.max(1, binWidth - 1),
        PAD.top + chartHeight - y,
      )
    })
    ctx.globalAlpha = 1

    // Length axis
    ctx.fillStyle = colors.text
    ctx.strokeStyle = colors.axis
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const tick of lengthTicks(histogram)) {
      const x = xFor(tick)
      ctx.beginPath()
      ctx.moveTo(x, PAD.top + chartHeight)
      ctx.lineTo(x, PAD.top + chartHeight + 4)
      ctx.stroke()
      ctx.fillText(formatBp(tick), x, PAD.top + chartHeight + 6)
    }
    ctx.fillText(
      logScale ? 'Node length (log scale)' : 'Node length',
      PAD.left + chartWidth / 2,
      height - 14,
    )

    ctx.save()
    ctx.translate(14, PAD.top + chartHeight / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.textBaseline = 'middle'
    ctx.fillText('Nodes', 0, 0)
    ctx.restore()
  }, [histogram, hoveredBin, isDarkMode, width, height, chartWidth, chartHeight])

  if (!histogram) return null

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left - PAD.left
    const bin = Math.floor((x / chartWidth) * histogram.counts.length)
    setHoveredBin(bin >= 0 && bin < histogram.counts.length ? bin : null)
  }

  return (
    <div className="length-distribution">
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredBin(null)}
      />
      <div className="length-distribution-readout">
        {hoveredBin === null
          ? 'Hover a bar to see its length range'
          : `${formatBp(histogram.edges[hoveredBin]!)} – ${formatBp(
              histogram.edges[hoveredBin + 1]!,
            )}: ${histogram.counts[hoveredBin]!.toLocaleString()} nodes`}
      </div>
    </div>
  )
}
