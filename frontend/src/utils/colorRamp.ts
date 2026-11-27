// Shared by the gradient color schemes (Haplotype Sharing, rGFA Rank, Genes).
export type Rgb = [number, number, number]

// The color at t (0 to 1) along evenly spaced stops.
export function rampColor(stops: Rgb[], t: number): Rgb {
  const position = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const lower = Math.min(Math.floor(position), stops.length - 2)
  const s = position - lower
  const from = stops[lower]!
  const to = stops[lower + 1]!
  return [0, 1, 2].map(i =>
    Math.round(from[i]! + (to[i]! - from[i]!) * s),
  ) as Rgb
}

// The same stops as a CSS gradient, for legends.
export function rampGradient(stops: Rgb[]): string {
  return `linear-gradient(to right, ${stops
    .map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`)
    .join(', ')})`
}

// `color` mixed toward `background` by `amount` (0 keeps it, 1 is the
// background).
export function fadeToward(color: Rgb, background: Rgb, amount: number): Rgb {
  return [0, 1, 2].map(i =>
    Math.round(color[i]! + (background[i]! - color[i]!) * amount),
  ) as Rgb
}

// `color` mixed toward the grey of its own brightness by `amount`: washed
// out but as bright as before, where fading toward a dark canvas would
// darken it.
export function desaturate(color: Rgb, amount: number): Rgb {
  const grey = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2]
  return fadeToward(color, [grey, grey, grey], amount)
}
