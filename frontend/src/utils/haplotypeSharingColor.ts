// The "Haplotype Sharing" node colors: a heat map from red, for sequence only
// one haplotype carries, through yellow to blue, for sequence every
// haplotype carries (ColorBrewer RdYlBu).
const STOPS: [number, number, number][] = [
  [215, 48, 39],
  [252, 141, 89],
  [254, 224, 144],
  [145, 191, 219],
  [69, 117, 180],
]

// For nodes no haplotype passes.
export const NO_HAPLOTYPE_COLOR: [number, number, number] = [160, 160, 160]

export const HAPLOTYPE_SHARING_GRADIENT = `linear-gradient(to right, ${STOPS.map(
  ([r, g, b]) => `rgb(${r}, ${g}, ${b})`,
).join(', ')})`

// haplotypeCount of totalHaplotypes carry the node; 1 is the red end and all
// of them the blue end.
export function haplotypeSharingColor(
  haplotypeCount: number,
  totalHaplotypes: number,
): [number, number, number] {
  if (haplotypeCount <= 0) return NO_HAPLOTYPE_COLOR
  const t =
    totalHaplotypes > 1
      ? Math.min(1, (haplotypeCount - 1) / (totalHaplotypes - 1))
      : 1
  const position = t * (STOPS.length - 1)
  const lower = Math.min(Math.floor(position), STOPS.length - 2)
  const s = position - lower
  const from = STOPS[lower]!
  const to = STOPS[lower + 1]!
  return [0, 1, 2].map(i => Math.round(from[i]! + (to[i]! - from[i]!) * s)) as [
    number,
    number,
    number,
  ]
}
