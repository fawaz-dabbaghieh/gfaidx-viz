// Traversals through a bubble: the routes the haplotypes take from one end of
// the bubble to the other, grouped by their exact node sequence.
//
// Each bubble is read between its own two ends, so a superbubble's traversal
// runs through all of its nested bubbles. A walk can enter at either end; one
// entering at the sink is read backwards, so every traversal reads source to
// sink. A walk only enters through an end's side facing the bubble: passing
// an end the other way (e.g. a loop back from the sink to the source outside
// the bubble) isn't a traversal.

import type { Graph } from '../types'
import type { Bubble } from './bubbleGun'
import { getSegmentIndex } from './segments'
import { getWalkIndex, type WalkIndex } from './walkIndex'

export interface Traversal {
  // 1-based, in the order of `traversals` (most haplotypes first).
  id: number
  // The nodes between the two ends (the ends themselves excluded), source to
  // sink, with their orientation along that direction (1 for '+'). Empty when
  // the walk goes straight from one end to the other.
  nodes: Int32Array
  fwd: Uint8Array
  // Sequence between the two ends.
  bp: number
  // Indices into WalkIndex.haplotypes, each once, in that order.
  haplotypes: number[]
  // Times it is taken; more than haplotypes.length when a haplotype takes it
  // more than once.
  passes: number
  isReference: boolean
}

export interface BubbleTraversals {
  traversals: Traversal[]
  // The reference haplotype's traversal length (its first pass), null when
  // there is no reference or it doesn't pass the bubble.
  referenceBp: number | null
  // Every haplotype is in exactly one of these: one complete pass, several,
  // none but a walk that starts or ends inside the bubble (cut there, e.g. by
  // the query's window or haplotype gap), or none at all.
  passOnce: number
  passMoreThanOnce: number
  cutInside: number
  dontPass: number
  // Length of every complete pass, for the length distribution.
  passLengths: number[]
}

// The orientation (1 for '+') a walk leaving each end has when it goes into
// the bubble, from the edges between the ends and the nodes inside. null when
// no such edge is found, and then either orientation is accepted.
function bubbleSides(
  graph: Graph,
  source: number,
  sink: number,
  inside: Uint8Array,
): { source: number | null; sink: number | null } {
  const { orientedIndex } = getSegmentIndex(graph)
  const sides: { source: number | null; sink: number | null } = {
    source: null,
    sink: null,
  }
  for (const edge of graph.edges) {
    const from = orientedIndex.get(edge.from)
    const to = orientedIndex.get(edge.to)
    if (from === undefined || to === undefined) continue
    // Leaving `from` in its orientation enters `to`; read backwards, leaving
    // `to` in the opposite orientation enters `from`.
    const [a, aFwd, b, bFwd] = [
      from >> 1,
      1 - (from & 1),
      to >> 1,
      1 - (to & 1),
    ]
    for (const end of ['source', 'sink'] as const) {
      const node = end === 'source' ? source : sink
      if (a === node && inside[b]) sides[end] = aFwd
      else if (b === node && inside[a]) sides[end] = 1 - bFwd
    }
  }
  return sides
}

export function findTraversals(
  graph: Graph,
  bubble: Bubble,
  referencePathName: string | null,
): BubbleTraversals | null {
  const walkIndex = getWalkIndex(graph)
  const { haplotypes, nodeIndex, nodeLen } = walkIndex
  const source = nodeIndex.get(bubble.source)
  const sink = nodeIndex.get(bubble.sink)
  if (source === undefined || sink === undefined) return null
  const inside = new Uint8Array(nodeLen.length)
  for (const name of bubble.inside) {
    const node = nodeIndex.get(name)
    if (node !== undefined) inside[node] = 1
  }
  const sides = bubbleSides(graph, source, sink, inside)
  // Whether a walk passing an end in orientation fwd leaves it into the
  // bubble, or comes out of the bubble into it.
  const leavesInto = (end: number, fwd: number) => {
    const side = end === source ? sides.source : sides.sink
    return side === null || fwd === side
  }
  const comesOutOf = (end: number, fwd: number) => {
    const side = end === source ? sides.source : sides.sink
    return side === null || fwd !== side
  }
  const referenceHaplotype = referencePathName
    ? haplotypes.findIndex(haplotype =>
        haplotype.walks.some(walk => walk.pathName === referencePathName),
      )
    : -1

  const byRoute = new Map<string, Omit<Traversal, 'id'>>()
  const passLengths: number[] = []
  let referenceBp: number | null = null
  let passOnce = 0
  let passMoreThanOnce = 0
  let cutInside = 0
  let dontPass = 0

  haplotypes.forEach((haplotype, h) => {
    let complete = 0
    let cut = 0
    for (const { nodes, fwd } of haplotype.walks) {
      const n = nodes.length
      if (n > 0 && inside[nodes[0]!]) cut++
      for (let i = 0; i < n; i++) {
        const end = nodes[i]!
        if ((end !== source && end !== sink) || !leavesInto(end, fwd[i]!)) {
          continue
        }
        let j = i + 1
        while (j < n && inside[nodes[j]!]) j++
        if (j === n) {
          // The walk ends inside the bubble.
          if (j > i + 1) cut++
          break
        }
        const otherEnd = end === source ? sink : source
        if (nodes[j] !== otherEnd || !comesOutOf(otherEnd, fwd[j]!)) continue

        const fromSource = end === source
        const length = j - i - 1
        const routeNodes = new Int32Array(length)
        const routeFwd = new Uint8Array(length)
        let bp = 0
        for (let k = 0; k < length; k++) {
          const at = fromSource ? i + 1 + k : j - 1 - k
          routeNodes[k] = nodes[at]!
          routeFwd[k] = fromSource ? fwd[at]! : 1 - fwd[at]!
          bp += nodeLen[nodes[at]!]!
        }
        const route = Array.from(routeNodes, (node, k) =>
          routeFwd[k] ? node : -node - 1,
        ).join(',')

        let traversal = byRoute.get(route)
        if (!traversal) {
          traversal = {
            nodes: routeNodes,
            fwd: routeFwd,
            bp,
            haplotypes: [],
            passes: 0,
            isReference: false,
          }
          byRoute.set(route, traversal)
        }
        const seen = traversal.haplotypes
        if (seen[seen.length - 1] !== h) seen.push(h)
        traversal.passes++
        if (h === referenceHaplotype) {
          traversal.isReference = true
          referenceBp ??= bp
        }
        passLengths.push(bp)
        complete++
        // The far end can start the next pass, e.g. a walk turning back.
        i = j - 1
      }
    }
    if (complete === 1) passOnce++
    else if (complete > 1) passMoreThanOnce++
    else if (cut > 0) cutInside++
    else dontPass++
  })

  const traversals = [...byRoute.values()]
    .sort(
      (a, b) =>
        b.haplotypes.length - a.haplotypes.length ||
        b.passes - a.passes ||
        b.bp - a.bp,
    )
    .map((traversal, i) => ({ id: i + 1, ...traversal }))
  return {
    traversals,
    referenceBp,
    passOnce,
    passMoreThanOnce,
    cutInside,
    dontPass,
    passLengths,
  }
}

// A traversal as GFA-style oriented node names, e.g. ">12<13>14".
export function traversalRoute(
  walkIndex: WalkIndex,
  traversal: Traversal,
): string {
  let route = ''
  traversal.nodes.forEach((node, k) => {
    route += (traversal.fwd[k] ? '>' : '<') + walkIndex.nodeNames[node]
  })
  return route
}

export function traversalsToTsv(
  walkIndex: WalkIndex,
  bubble: Bubble,
  result: BubbleTraversals,
  graphName: string,
  referencePathName: string | null,
): string {
  const lines = [
    `# Traversals through bubble ${bubble.index + 1} ` +
      `(${bubble.source} to ${bubble.sink}) in ${graphName}` +
      (referencePathName ? `, reference ${referencePathName}` : ''),
    [
      'traversal',
      'haplotypes',
      'passes',
      'length_bp',
      'nodes',
      'vs_reference_bp',
      'reference',
      'route',
      'haplotype_names',
    ].join('\t'),
  ]
  for (const traversal of result.traversals) {
    lines.push(
      [
        `T${traversal.id}`,
        traversal.haplotypes.length,
        traversal.passes,
        traversal.bp,
        traversal.nodes.length,
        result.referenceBp === null ? '' : traversal.bp - result.referenceBp,
        traversal.isReference ? 'yes' : 'no',
        traversalRoute(walkIndex, traversal),
        traversal.haplotypes.map(h => walkIndex.haplotypes[h]!.key).join(','),
      ].join('\t'),
    )
  }
  return lines.join('\n') + '\n'
}
