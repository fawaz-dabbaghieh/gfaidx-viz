// The graph's haplotype walks in one compact, shared form, built once per
// graph, so the haplotype features (gene coverage, sequence shared with the
// reference, walk rows, traversals through bubbles) don't each re-walk
// millions of node visits.
//
// Walks are grouped into haplotypes by sample and haplotype (PanSN
// "sample#hap"), never by path name: one haplotype can be split into several
// walks, e.g. by the backend's haplotype gap. That split says more about the
// query than about the assembly, so no statistic is taken from walk counts.

import type { Graph, GraphPath } from '../types'
import { getSegmentIndex } from './segments'

export interface HaploWalk {
  pathName: string
  contig: string
  // From the W line, or from a P line's name for a "With Coordinates"
  // result (see gfaConverter); null when the walk has no coordinates.
  start: number | null
  end: number | null
  // Segment indices (see getSegmentIndex) and their orientation, 1 for '+'.
  nodes: Int32Array
  fwd: Uint8Array
  // Sum of the walk's node lengths, i.e. the sequence it spells.
  seqLen: number
}

export interface Haplotype {
  key: string
  sample: string
  hap: string
  walks: HaploWalk[]
  seqLen: number
  // More than one walk, e.g. cut by the query's haplotype gap.
  clipped: boolean
  // Sequence between consecutive walks on the same contig, or null when a
  // walk has no coordinates.
  gapBp: number | null
}

export interface WalkIndex {
  haplotypes: Haplotype[]
  nodeNames: string[]
  nodeIndex: Map<string, number>
  nodeLen: Int32Array
  // Per node: how many haplotypes pass it, and how many passes there are in
  // total. They differ where a haplotype passes a node more than once.
  haplotypesVisiting: Int32Array
  totalVisits: Int32Array
  visitCount: number
  // Walks whose node lengths don't add up to end - start. The two always
  // agree, so any entry here means the GFA was parsed wrongly.
  coordinateMismatches: { pathName: string; seqLen: number; span: number }[]
}

export interface ReferenceComparison {
  pathName: string
  haplotypeKey: string
  // Per node: on the reference walk, and its offset along it (from the
  // walk's start coordinate, or 0), -1 when off it.
  onRef: Uint8Array
  refOffset: Float64Array
  // Sequence of the reference walk's distinct nodes.
  refBp: number
  // Per haplotype (same order as WalkIndex.haplotypes): sequence on nodes
  // the reference also carries, and the rest. They add up to its seqLen.
  sharedBp: Float64Array
  offRefBp: Float64Array
  // Per haplotype: sequence of the distinct nodes both it and the reference
  // pass, each counted once.
  sharedNodeBp: Float64Array
}

const walkIndexCache = new WeakMap<Graph, WalkIndex>()
const referenceCache = new WeakMap<
  WalkIndex,
  Map<string, ReferenceComparison | null>
>()

export function getWalkIndex(graph: Graph): WalkIndex {
  const cached = walkIndexCache.get(graph)
  if (cached) return cached
  const walkIndex = buildWalkIndex(graph)
  walkIndexCache.set(graph, walkIndex)
  return walkIndex
}

// A W line (or a P line given coordinates) carries its sample, haplotype and
// contig; other P lines are read as PanSN "sample#hap#contig", possibly with
// a ":start-end" or "#subpath_..." suffix. Names that aren't PanSN are a
// haplotype of their own.
function walkIdentity(path: GraphPath): {
  sample: string
  hap: string
  contig: string
} {
  if (path.walk) {
    return {
      sample: path.walk.sampleName,
      hap: path.walk.haplotypeIndex,
      contig: path.walk.sequenceName,
    }
  }
  const parts = path.name.split('#')
  const stripRange = (contig: string) => contig.replace(/:\d+-\d+$/, '')
  if (parts.length >= 3) {
    return { sample: parts[0]!, hap: parts[1]!, contig: stripRange(parts[2]!) }
  }
  if (parts.length === 2) {
    return { sample: parts[0]!, hap: '', contig: stripRange(parts[1]!) }
  }
  return { sample: path.name, hap: '', contig: path.name }
}

function coordinate(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function buildWalkIndex(graph: Graph): WalkIndex {
  const { names, lengths, indexByName, orientedIndex } = getSegmentIndex(graph)
  const nodeCount = names.length
  const haplotypesVisiting = new Int32Array(nodeCount)
  const totalVisits = new Int32Array(nodeCount)
  // The last haplotype counted for each node, so a haplotype passing a node
  // again doesn't count twice. A haplotype's walks are all walked together.
  const lastHaplotype = new Int32Array(nodeCount).fill(-1)

  const groups = new Map<
    string,
    { sample: string; hap: string; paths: { path: GraphPath; contig: string }[] }
  >()
  for (const path of graph.paths ?? []) {
    const { sample, hap, contig } = walkIdentity(path)
    const key = hap ? `${sample}#${hap}` : sample
    const group = groups.get(key)
    if (group) group.paths.push({ path, contig })
    else groups.set(key, { sample, hap, paths: [{ path, contig }] })
  }

  const haplotypes: Haplotype[] = []
  const coordinateMismatches: WalkIndex['coordinateMismatches'] = []
  let visitCount = 0

  for (const [key, group] of groups) {
    const haplotype = haplotypes.length
    const walks: HaploWalk[] = []

    for (const { path, contig } of group.paths) {
      const nodes = new Int32Array(path.nodeIds.length)
      const fwd = new Uint8Array(path.nodeIds.length)
      let count = 0
      let seqLen = 0
      for (const nodeId of path.nodeIds) {
        const oriented = orientedIndex.get(nodeId)
        if (oriented === undefined) continue
        const node = oriented >> 1
        nodes[count] = node
        fwd[count] = oriented & 1 ? 0 : 1
        count++
        seqLen += lengths[node]!
        totalVisits[node]!++
        if (lastHaplotype[node] !== haplotype) {
          lastHaplotype[node] = haplotype
          haplotypesVisiting[node]!++
        }
      }
      visitCount += count

      const start = coordinate(path.walk?.sequenceStart)
      const end = coordinate(path.walk?.sequenceEnd)
      if (start !== null && end !== null && end - start !== seqLen) {
        coordinateMismatches.push({
          pathName: path.name,
          seqLen,
          span: end - start,
        })
      }
      walks.push({
        pathName: path.name,
        contig,
        start,
        end,
        nodes: count === nodes.length ? nodes : nodes.slice(0, count),
        fwd: count === fwd.length ? fwd : fwd.slice(0, count),
        seqLen,
      })
    }

    walks.sort(
      (a, b) =>
        a.contig.localeCompare(b.contig, undefined, { numeric: true }) ||
        (a.start ?? 0) - (b.start ?? 0),
    )
    let gapBp: number | null = 0
    for (let i = 1; i < walks.length; i++) {
      const previous = walks[i - 1]!
      const walk = walks[i]!
      if (previous.end === null || walk.start === null) {
        gapBp = null
        break
      }
      if (walk.contig === previous.contig) {
        gapBp += Math.max(0, walk.start - previous.end)
      }
    }

    haplotypes.push({
      key,
      sample: group.sample,
      hap: group.hap,
      walks,
      seqLen: walks.reduce((sum, walk) => sum + walk.seqLen, 0),
      clipped: walks.length > 1,
      gapBp,
    })
  }

  return {
    haplotypes,
    nodeNames: names,
    nodeIndex: indexByName,
    nodeLen: lengths,
    haplotypesVisiting,
    totalVisits,
    visitCount,
    coordinateMismatches,
  }
}

// The preferred path (the queried or linear-layout reference) when it is one
// of the walks here, otherwise the first CHM13 walk, then the first GRCh38
// one, otherwise none.
export function pickReferencePath(
  walkIndex: WalkIndex,
  preferredPathName?: string | null,
): string | null {
  const walks = walkIndex.haplotypes.flatMap(haplotype =>
    haplotype.walks.map(walk => ({ haplotype, walk })),
  )
  if (
    preferredPathName &&
    walks.some(({ walk }) => walk.pathName === preferredPathName)
  ) {
    return preferredPathName
  }
  for (const sample of [/chm13/i, /grch38/i]) {
    const found = walks.find(({ haplotype }) => sample.test(haplotype.sample))
    if (found) return found.walk.pathName
  }
  return null
}

// The reference picked in the Haplotypes tab when it is one of the walks
// here, otherwise pickReferencePath's choice.
export function resolveReferencePath(
  walkIndex: WalkIndex,
  pickedPathName: string | null,
  preferredPathName?: string | null,
): string | null {
  if (
    pickedPathName &&
    walkIndex.haplotypes.some(haplotype =>
      haplotype.walks.some(walk => walk.pathName === pickedPathName),
    )
  ) {
    return pickedPathName
  }
  return pickReferencePath(walkIndex, preferredPathName)
}

export function compareToReference(
  walkIndex: WalkIndex,
  referencePathName: string,
): ReferenceComparison | null {
  let cache = referenceCache.get(walkIndex)
  if (!cache) {
    cache = new Map()
    referenceCache.set(walkIndex, cache)
  }
  if (cache.has(referencePathName)) return cache.get(referencePathName)!

  const comparison = buildReferenceComparison(walkIndex, referencePathName)
  cache.set(referencePathName, comparison)
  return comparison
}

function buildReferenceComparison(
  walkIndex: WalkIndex,
  referencePathName: string,
): ReferenceComparison | null {
  const { haplotypes, nodeLen } = walkIndex
  const referenceHaplotype = haplotypes.find(haplotype =>
    haplotype.walks.some(walk => walk.pathName === referencePathName),
  )
  const referenceWalk = referenceHaplotype?.walks.find(
    walk => walk.pathName === referencePathName,
  )
  if (!referenceHaplotype || !referenceWalk) return null

  const onRef = new Uint8Array(nodeLen.length)
  const refOffset = new Float64Array(nodeLen.length).fill(-1)
  let offset = referenceWalk.start ?? 0
  let refBp = 0
  // A node the reference passes twice keeps its first offset.
  for (const node of referenceWalk.nodes) {
    if (!onRef[node]) {
      onRef[node] = 1
      refOffset[node] = offset
      refBp += nodeLen[node]!
    }
    offset += nodeLen[node]!
  }

  const sharedBp = new Float64Array(haplotypes.length)
  const offRefBp = new Float64Array(haplotypes.length)
  const sharedNodeBp = new Float64Array(haplotypes.length)
  const lastHaplotype = new Int32Array(nodeLen.length).fill(-1)
  haplotypes.forEach((haplotype, h) => {
    let shared = 0
    let sharedNodes = 0
    for (const walk of haplotype.walks) {
      for (const node of walk.nodes) {
        if (!onRef[node]) continue
        shared += nodeLen[node]!
        if (lastHaplotype[node] !== h) {
          lastHaplotype[node] = h
          sharedNodes += nodeLen[node]!
        }
      }
    }
    sharedBp[h] = shared
    offRefBp[h] = haplotype.seqLen - shared
    sharedNodeBp[h] = sharedNodes
  })

  return {
    pathName: referencePathName,
    haplotypeKey: referenceHaplotype.key,
    onRef,
    refOffset,
    refBp,
    sharedBp,
    offRefBp,
    sharedNodeBp,
  }
}

// Fraction of a haplotype's sequence on nodes the reference also passes,
// every pass counted (sharedBp / seqLen).
export function haplotypeOnReference(
  comparison: ReferenceComparison,
  haplotypeIndex: number,
  seqLen: number,
): number {
  return seqLen > 0 ? comparison.sharedBp[haplotypeIndex]! / seqLen : 0
}

// Fraction of the reference's sequence (its distinct nodes) the haplotype
// also passes, each node counted once.
export function referenceCovered(
  comparison: ReferenceComparison,
  haplotypeIndex: number,
): number {
  return comparison.refBp > 0
    ? comparison.sharedNodeBp[haplotypeIndex]! / comparison.refBp
    : 0
}

export function haplotypesToTsv(
  walkIndex: WalkIndex,
  comparison: ReferenceComparison | null,
  graphName: string,
): string {
  const lines = [
    `# Haplotypes in ${graphName}` +
      (comparison ? `, compared with the reference ${comparison.pathName}` : ''),
    [
      'haplotype',
      'sample',
      'haplotype_index',
      'walks',
      'sequence_bp',
      'shared_bp',
      'off_reference_bp',
      'haplotype_on_reference',
      'reference_covered',
    ].join('\t'),
  ]
  walkIndex.haplotypes.forEach((haplotype, i) => {
    lines.push(
      [
        haplotype.key,
        haplotype.sample,
        haplotype.hap,
        haplotype.walks.length,
        haplotype.seqLen,
        comparison ? comparison.sharedBp[i] : '',
        comparison ? comparison.offRefBp[i] : '',
        comparison
          ? haplotypeOnReference(comparison, i, haplotype.seqLen).toFixed(4)
          : '',
        comparison ? referenceCovered(comparison, i).toFixed(4) : '',
      ].join('\t'),
    )
  })
  return lines.join('\n') + '\n'
}
