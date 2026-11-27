// The gfaidx command that reproduces a backend query locally, shown when the
// result is too large for the server or the browser. It mirrors the flags
// the backend adds (see gfaidxCommand in the MMseqs2-App backend).

// The app's default --haplotype_gap for all-haplotype queries (always sent,
// so the backend's own default doesn't apply), and the backend's cap on a
// chosen one (gfaidxMaxHaplotypeGapBases). 50kb rather than 10kb: at AMY1C
// it splits 15 of 464 haplotypes into several walks instead of 39.
export const DEFAULT_HAPLOTYPE_GAP = '50kb'
const MAX_HAPLOTYPE_GAP_BASES = 1_000_000
const HAPLOTYPE_GAP = /^(0|[1-9][0-9]*)(bp|kb|mb|gb)?$/i
const GAP_UNIT_BASES: Record<string, number> = { '': 1, bp: 1, kb: 1e3, mb: 1e6, gb: 1e9 }

// "10 kb" or "10,000" -> the form the backend accepts ("10kb", "10000");
// empty means the default.
export function normalizeHaplotypeGap(gap: string): string {
  return gap.replace(/[\s,]+/g, '') || DEFAULT_HAPLOTYPE_GAP
}

// A normalized gap ("50kb", "5000") in bases, or null when it isn't one.
export function haplotypeGapBases(gap: string): number | null {
  const match = HAPLOTYPE_GAP.exec(gap)
  if (!match) return null
  return Number(match[1]) * (GAP_UNIT_BASES[(match[2] ?? '').toLowerCase()] ?? 1)
}

export function haplotypeGapError(gap: string): string | null {
  const bases = haplotypeGapBases(gap)
  if (bases === null) {
    return 'Haplotype gap must be a number of bases, e.g. 10kb or 5000'
  }
  return bases > MAX_HAPLOTYPE_GAP_BASES
    ? 'Haplotype gap must be at most 1mb on the server'
    : null
}

// Quotes anything a shell could expand; "#" in PanSN names is a glob
// operator under zsh's extended_glob.
function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:,=+-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`
}

function outputName(...parts: (string | number)[]): string {
  return `${parts.join('_').replace(/[^A-Za-z0-9_.-]+/g, '_')}.gfa`
}

export function gfaidxRegionCommand(query: {
  graphId: string
  reference: string
  sequence: string
  start: number
  end: number
  allHaplotypes: boolean
  haplotypeGap: string
  maxNodes: number
  withCoords: boolean
}): string {
  const args = [
    'gfaidx',
    'get_region',
    query.graphId,
    `${query.sequence}:${query.start}-${query.end}`,
    outputName(query.sequence, query.start, query.end),
  ]
  if (query.allHaplotypes) {
    args.push('--mode', 'all', '--haplotype_gap', query.haplotypeGap)
  } else {
    args.push('--mode', 'bfs', '--max_nodes', String(query.maxNodes))
  }
  if (query.reference) args.push('--reference', query.reference)
  if (query.withCoords) args.push('--with_coords')
  return args.map(shellArg).join(' ')
}

export function gfaidxSubgraphCommand(query: {
  graphId: string
  startNode: string
  maxNodes: number
  withCoords: boolean
}): string {
  const args = [
    'gfaidx',
    'get_subgraph',
    query.graphId,
    query.startNode,
    outputName('node', query.startNode, query.maxNodes),
    '--max_nodes',
    String(query.maxNodes),
  ]
  if (query.withCoords) args.push('--with_coords')
  return args.map(shellArg).join(' ')
}

// The backend's error when gfaidx's output passes its size limit, reworded
// for the app (it suggests no_paths, which the app has no option for).
// Null for any other error.
export function serverSizeLimitMessage(message: string): string | null {
  const match = /exceeded the (\d+) MB server limit/.exec(message)
  return match
    ? `The subgraph is over the server's ${match[1]} MB limit. Try a ` +
        'smaller region, Max Nodes or Haplotype Gap.'
    : null
}
