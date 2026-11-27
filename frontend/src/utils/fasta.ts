// FASTA downloads spelled from the graph's node sequences: every haplotype
// walk, or every traversal through a bubble. A '-' step is the node's reverse
// complement, and a link's overlap is trimmed from the node after it. The
// result is a list of chunks for a Blob, since a whole region's haplotypes
// can run to hundreds of MB.

import type { Graph } from '../types'
import { type Bubble, bubbleId } from './bubbleGun'
import { getSegmentIndex } from './segments'
import type { BubbleTraversals } from './traversals'
import type { WalkIndex } from './walkIndex'

const LINE_LENGTH = 80

const COMPLEMENT: Record<string, string> = {
  A: 'T', C: 'G', G: 'C', T: 'A', U: 'A', N: 'N',
  R: 'Y', Y: 'R', K: 'M', M: 'K', S: 'S', W: 'W',
  B: 'V', V: 'B', D: 'H', H: 'D',
  a: 't', c: 'g', g: 'c', t: 'a', u: 'a', n: 'n',
  r: 'y', y: 'r', k: 'm', m: 'k', s: 's', w: 'w',
  b: 'v', v: 'b', d: 'h', h: 'd',
}

function reverseComplement(sequence: string): string {
  let result = ''
  for (let i = sequence.length - 1; i >= 0; i--) {
    result += COMPLEMENT[sequence[i]!] ?? sequence[i]
  }
  return result
}

interface Speller {
  // The sequence a run of steps spells, or null when a node has none (a '*'
  // in the GFA).
  spell: (nodes: Int32Array, fwd: Uint8Array) => string | null
}

const spellerCache = new WeakMap<Graph, Speller>()

function getSpeller(graph: Graph): Speller {
  const cached = spellerCache.get(graph)
  if (cached) return cached

  const { names, indexByName, orientedIndex } = getSegmentIndex(graph)
  // Both orientations of a node hold its forward sequence.
  const sequences: (string | undefined)[] = new Array(names.length)
  for (const node of graph.nodes) {
    const sequence = node.sequence
    if (sequence && sequence !== '*') {
      sequences[indexByName.get(node.name)!] = sequence
    }
  }
  // Only links with an overlap, keyed by the two oriented node indices.
  const overlaps = new Map<string, number>()
  for (const edge of graph.edges) {
    if (!(edge.overlap > 0)) continue
    const from = orientedIndex.get(edge.from)
    const to = orientedIndex.get(edge.to)
    if (from === undefined || to === undefined) continue
    overlaps.set(`${from},${to}`, edge.overlap)
    // The same link read backwards.
    overlaps.set(`${to ^ 1},${from ^ 1}`, edge.overlap)
  }

  const reversed = new Map<number, string>()
  const speller: Speller = {
    spell: (nodes, fwd) => {
      const pieces: string[] = []
      let previous = -1
      for (let k = 0; k < nodes.length; k++) {
        const node = nodes[k]!
        const forward = sequences[node]
        if (forward === undefined) return null
        let piece = forward
        if (!fwd[k]) {
          piece = reversed.get(node) ?? reverseComplement(forward)
          reversed.set(node, piece)
        }
        const oriented = node * 2 + (fwd[k] ? 0 : 1)
        const overlap =
          previous >= 0 ? (overlaps.get(`${previous},${oriented}`) ?? 0) : 0
        pieces.push(overlap > 0 ? piece.slice(overlap) : piece)
        previous = oriented
      }
      return pieces.join('')
    },
  }
  spellerCache.set(graph, speller)
  return speller
}

function pushRecord(chunks: string[], header: string, sequence: string) {
  chunks.push(`>${header}\n`)
  for (let i = 0; i < sequence.length; i += LINE_LENGTH) {
    chunks.push(sequence.slice(i, i + LINE_LENGTH) + '\n')
  }
}

export interface FastaResult {
  chunks: string[]
  records: number
  // Records left out because one of their nodes has no sequence.
  skipped: number
}

// One record per walk, named by its path with its coordinates when known,
// e.g. ">HG00438#1#JAHBCB010000040.1:12345-67890 haplotype=HG00438#1 bp=…".
export function haplotypesToFasta(
  graph: Graph,
  walkIndex: WalkIndex,
): FastaResult {
  const speller = getSpeller(graph)
  const chunks: string[] = []
  let records = 0
  let skipped = 0
  for (const haplotype of walkIndex.haplotypes) {
    for (const walk of haplotype.walks) {
      const sequence = speller.spell(walk.nodes, walk.fwd)
      if (sequence === null) {
        skipped++
        continue
      }
      let id = walk.pathName.replace(/ \[\d+\]$/, '')
      if (walk.start !== null && walk.end !== null && !/:\d+-\d+$/.test(id)) {
        id += `:${walk.start}-${walk.end}`
      }
      pushRecord(
        chunks,
        `${id.replace(/\s+/g, '_')} haplotype=${haplotype.key} bp=${sequence.length}`,
        sequence,
      )
      records++
    }
  }
  return { chunks, records, skipped }
}

// One record per traversal, the sequence between the bubble's two ends (as
// in the table), named by bubble and traversal with every haplotype taking
// it, e.g. ">bubble7495_T3 bp=99847 reference=no haplotype_count=2
// haplotypes=HG00438#1,HG00621#2". A traversal straight from one end to the
// other has an empty sequence.
export function traversalsToFasta(
  graph: Graph,
  walkIndex: WalkIndex,
  bubble: Bubble,
  result: BubbleTraversals,
): FastaResult {
  const speller = getSpeller(graph)
  const chunks: string[] = []
  let records = 0
  let skipped = 0
  for (const traversal of result.traversals) {
    const sequence = speller.spell(traversal.nodes, traversal.fwd)
    if (sequence === null) {
      skipped++
      continue
    }
    const names = traversal.haplotypes.map(h => walkIndex.haplotypes[h]!.key)
    pushRecord(
      chunks,
      `bubble${bubbleId(bubble)}_T${traversal.id} bp=${sequence.length}` +
        ` reference=${traversal.isReference ? 'yes' : 'no'}` +
        ` haplotype_count=${names.length} haplotypes=${names.join(',')}`,
      sequence,
    )
    records++
  }
  return { chunks, records, skipped }
}
