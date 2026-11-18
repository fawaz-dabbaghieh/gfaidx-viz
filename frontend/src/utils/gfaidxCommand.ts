// The gfaidx command that reproduces a backend query locally, shown when the
// result is too large for the server or the browser. It mirrors the flags
// the backend adds (see gfaidxCommand in the MMseqs2-App backend).

// The backend's default --haplotype_gap for all-haplotype queries.
const BACKEND_HAPLOTYPE_GAP = '10kb'

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
    args.push('--mode', 'all', '--haplotype_gap', BACKEND_HAPLOTYPE_GAP)
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

// The backend's error when gfaidx's output passes its size limit.
export function isServerSizeLimitError(message: string): boolean {
  return /exceeded the \d+ MB server limit/.test(message)
}
