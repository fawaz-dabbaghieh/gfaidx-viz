import { type Rgb, rampColor, rampGradient } from './colorRamp'

// The "Haplotype Sharing" node colors: a heat map from red, for sequence only
// one haplotype carries, through yellow to blue, for sequence every
// haplotype carries (ColorBrewer RdYlBu).
const STOPS: Rgb[] = [
  [215, 48, 39],
  [252, 141, 89],
  [254, 224, 144],
  [145, 191, 219],
  [69, 117, 180],
]

// For nodes no haplotype passes.
export const NO_HAPLOTYPE_COLOR: Rgb = [160, 160, 160]

export const HAPLOTYPE_SHARING_GRADIENT = rampGradient(STOPS)

// haplotypeCount of totalHaplotypes carry the node; 1 is the red end and all
// of them the blue end.
export function haplotypeSharingColor(
  haplotypeCount: number,
  totalHaplotypes: number,
): Rgb {
  if (haplotypeCount <= 0) return NO_HAPLOTYPE_COLOR
  return rampColor(
    STOPS,
    totalHaplotypes > 1 ? (haplotypeCount - 1) / (totalHaplotypes - 1) : 1,
  )
}
