// Small hand-built graphs shared by the unit tests.
import { type PathNameCoordinates, convertGFAToGraph } from './gfaConverter'
import { parseGFA } from './gfaParser'

export const graphFrom = (
  gfa: string,
  pathNameCoordinates: PathNameCoordinates = 'none',
) => convertGFAToGraph(parseGFA(gfa), 'test.gfa', pathNameCoordinates)

export const tsv = (lines: string[]) =>
  lines.map(line => line.replace(/ +/g, '\t')).join('\n')

// A simple bubble 1 -> {2, 3} -> 4. REF takes 2, HG1#1 takes 3, HG1#2 is
// HG1#1 reversed, HG2#1 is cut into two walks (as the haplotype gap does),
// and HG3#1 passes the bubble twice.
export const FIXTURE = tsv([
  'H VN:Z:1.0',
  'S 1 AAAA',
  'S 2 C',
  'S 3 GG',
  'S 4 TTTTT',
  'L 1 + 2 + 0M',
  'L 1 + 3 + 0M',
  'L 2 + 4 + 0M',
  'L 3 + 4 + 0M',
  'L 4 + 1 + 0M',
  'W REF 0 chr1 100 110 >1>2>4',
  'W HG1 1 chr1 0 11 >1>3>4',
  'W HG1 2 chr1 0 11 <4<3<1',
  'W HG2 1 chr1 0 5 >1>2',
  'W HG2 1 chr1 20 25 >4',
  'W HG3 1 chr1 0 21 >1>2>4>1>3>4',
])
