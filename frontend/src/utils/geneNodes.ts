// Which genes each reference node sits in, for the Genes color scheme and the
// node hover. It works in any layout: a node's place on the reference comes
// from the reference walk (or, in an rGFA, the node's SO tag), not from the
// drawing. Only the reference is annotated, so nodes off it have no genes.

import type { Graph } from '../types'
import {
  type Rgb,
  desaturate,
  fadeToward,
  rampColor,
  rampGradient,
} from './colorRamp'
import { type GeneRecord, stripPanSNPrefix } from './geneTrackBed'
import { getSegmentIndex } from './segments'
import { getWalkIndex, resolveReferencePath } from './walkIndex'

// Bases within a gene, exon or intron are counted from its 5′ end (its
// start on '+', its end on '-'), from 1.
export interface GenePart {
  kind: 'exon' | 'intron'
  number: number
  // Exons (or introns) in the gene.
  count: number
  // The bases of it the node covers, and its length.
  from: number
  to: number
  length: number
}

export interface NodeGeneHit {
  gene: GeneRecord
  // The exons and introns the node overlaps, 5′ first; empty when the gene
  // has no exon blocks (BED6 and shorter).
  parts: GenePart[]
  // How much of the node is in the gene, and which of the gene's bases.
  bp: number
  from: number
  to: number
}

export interface GeneNodeMap {
  referencePath: string
  // Per segment index (see getSegmentIndex): the genes the node overlaps, in
  // start order, or undefined.
  hits: (NodeGeneHit[] | undefined)[]
  // Genes with at least one node.
  geneCount: number
  // Per segment index: where the node starts on the reference (-1 when off
  // it), whether the reference reads it forward, and its length; for
  // coloring along a node, which can cross exons, introns and gene ends.
  refStart: Float64Array
  refForward: Uint8Array
  nodeLength: Int32Array
  // The genes on the graph's stretch of the reference, by start.
  genes: GeneRecord[]
  // That stretch: from the first reference base in the graph to the last.
  span: { start: number; end: number }
}

// The map, or why there is none.
export type GeneNodeResult = { map: GeneNodeMap } | { message: string }

const cache = new WeakMap<
  Graph,
  WeakMap<GeneRecord[], Map<string, GeneNodeResult>>
>()

// preferredReferencePath is the Display tab's Reference Path; without it the
// queried path, else a CHM13 or GRCh38 walk, is used.
export function getGeneNodeMap(
  graph: Graph,
  genes: GeneRecord[],
  preferredReferencePath: string,
): GeneNodeResult {
  let byGenes = cache.get(graph)
  if (!byGenes) {
    byGenes = new WeakMap()
    cache.set(graph, byGenes)
  }
  let byReference = byGenes.get(genes)
  if (!byReference) {
    byReference = new Map()
    byGenes.set(genes, byReference)
  }
  let result = byReference.get(preferredReferencePath)
  if (!result) {
    result = buildGeneNodeMap(graph, genes, preferredReferencePath)
    byReference.set(preferredReferencePath, result)
  }
  return result
}

function buildGeneNodeMap(
  graph: Graph,
  genes: GeneRecord[],
  preferredReferencePath: string,
): GeneNodeResult {
  // The reference is checked first: without coordinates no genes can be
  // placed, and the built-in ones aren't even loaded.
  const walkIndex = getWalkIndex(graph)
  // Failing those, the graph's only path, e.g. an rGFA's reference rebuilt
  // from its SN/SO tags (named after its SN, e.g. "chr1").
  const onlyHaplotype =
    walkIndex.haplotypes.length === 1 ? walkIndex.haplotypes[0]! : null
  const referencePath =
    resolveReferencePath(walkIndex, null, preferredReferencePath || null) ??
    onlyHaplotype?.walks[0]?.pathName ??
    null
  if (!referencePath) {
    return {
      message:
        'This graph has no reference path (e.g. CHM13 or GRCh38) to place ' +
        'the genes on.',
    }
  }
  const walk = walkIndex.haplotypes
    .flatMap(haplotype => haplotype.walks)
    .find(candidate => candidate.pathName === referencePath)!
  const { nodeLen } = walkIndex

  // An rGFA's reference nodes carry their own offset (SO), which stays right
  // even where the extracted reference has gaps.
  const { indexByName } = getSegmentIndex(graph)
  const tagOffset = new Float64Array(nodeLen.length).fill(-1)
  let hasTagOffsets = false
  for (const node of graph.nodes) {
    const offset = node.tags?.SO
    if (typeof offset !== 'number' || node.tags?.SN !== referencePath) continue
    tagOffset[indexByName.get(node.name)!] = offset
    hasTagOffsets = true
  }
  if (walk.start === null && !hasTagOffsets) {
    return {
      message:
        `The reference path ${referencePath} has no coordinates, so the ` +
        "genes can't be placed on it. Coordinates come from a W-line's " +
        'start and end, or a P-line named "sample#hap#contig:start-end" ' +
        '(e.g. a gfaidx query With Coordinates).',
    }
  }
  if (genes.length === 0) {
    return {
      message:
        'No genes are available for this graph. Load a BED file in the ' +
        'Styling tab.',
    }
  }

  // A node the reference passes twice keeps its first place.
  const refStart = new Float64Array(nodeLen.length).fill(-1)
  const refForward = new Uint8Array(nodeLen.length)
  let offset = walk.start ?? 0
  walk.nodes.forEach((node, k) => {
    if (refStart[node]! < 0) {
      refStart[node] = tagOffset[node]! >= 0 ? tagOffset[node]! : offset
      refForward[node] = tagOffset[node]! >= 0 ? 1 : walk.fwd[k]!
    }
    offset += nodeLen[node]!
  })
  let firstBp = Infinity
  let lastBp = -Infinity
  for (let node = 0; node < nodeLen.length; node++) {
    if (refStart[node]! < 0) continue
    firstBp = Math.min(firstBp, refStart[node]!)
    lastBp = Math.max(lastBp, refStart[node]! + nodeLen[node]!)
  }
  const contig = stripPanSNPrefix(walk.contig)
  const nearbyGenes = genes
    .filter(
      gene =>
        stripPanSNPrefix(gene.chrom) === contig &&
        gene.end > firstBp &&
        gene.start < lastBp,
    )
    .sort((a, b) => a.start - b.start)

  const hits: GeneNodeMap['hits'] = new Array(nodeLen.length)
  const genesHit = new Set<GeneRecord>()
  for (let node = 0; node < nodeLen.length; node++) {
    if (refStart[node]! < 0) continue
    const start = refStart[node]!
    const end = start + nodeLen[node]!
    for (const gene of nearbyGenes) {
      if (gene.start >= end) break
      if (gene.end <= start) continue
      hits[node] ??= []
      hits[node]!.push({
        gene,
        parts: geneParts(gene, start, end),
        bp: Math.min(end, gene.end) - Math.max(start, gene.start),
        ...basesFrom5Prime(gene, gene.start, gene.end, start, end),
      })
      genesHit.add(gene)
    }
  }
  if (genesHit.size === 0) {
    return { message: `No genes overlap ${referencePath} in this graph.` }
  }
  return {
    map: {
      referencePath,
      hits,
      geneCount: genesHit.size,
      refStart,
      refForward,
      nodeLength: nodeLen,
      genes: nearbyGenes,
      span: { start: firstBp, end: lastBp },
    },
  }
}

// The bases of [regionStart, regionEnd) (a gene, exon or intron) that the
// node's [start, end) covers, counted from the gene's 5′ end.
function basesFrom5Prime(
  gene: GeneRecord,
  regionStart: number,
  regionEnd: number,
  start: number,
  end: number,
): { from: number; to: number } {
  const first = Math.max(start, regionStart)
  const last = Math.min(end, regionEnd)
  return gene.strand === '-'
    ? { from: regionEnd - last + 1, to: regionEnd - first }
    : { from: first - regionStart + 1, to: last - regionStart }
}

// The exons and introns [start, end) overlaps, 5′ first.
function geneParts(gene: GeneRecord, start: number, end: number): GenePart[] {
  const exons = gene.exons
  if (!exons?.length) return []
  // BED12 blocks run left to right; a '-' gene is numbered from the right.
  const number = (i: number, count: number) =>
    gene.strand === '-' ? count - i : i + 1
  const parts: GenePart[] = []
  const add = (
    kind: GenePart['kind'],
    i: number,
    count: number,
    partStart: number,
    partEnd: number,
  ) => {
    if (Math.min(end, partEnd) <= Math.max(start, partStart)) return
    parts.push({
      kind,
      number: number(i, count),
      count,
      length: partEnd - partStart,
      ...basesFrom5Prime(gene, partStart, partEnd, start, end),
    })
  }
  exons.forEach((exon, i) => {
    add('exon', i, exons.length, exon.start, exon.end)
    const next = exons[i + 1]
    if (next) add('intron', i, exons.length - 1, exon.end, next.start)
  })
  return gene.strand === '-' ? parts.reverse() : parts
}

export interface GeneDescription {
  gene: GeneRecord
  // "AMY1C (+) · gene bases 1,360–1,390 of 8,794", noting any of the node
  // outside the gene.
  heading: string
  // One per exon or intron, 5′ first: "exon 5 of 11: bases 350–380 of 1,024".
  parts: string[]
  // When the graph holds only part of the gene, which part.
  note: string | null
}

const bases = (from: number, to: number) =>
  from === to
    ? `base ${from.toLocaleString()}`
    : `bases ${from.toLocaleString()}–${to.toLocaleString()}`

// Where a node sits in a gene, for the hover and the info panel; positions
// help place a bubble in the gene.
export function describeGeneHit(
  hit: NodeGeneHit,
  nodeLength: number,
  map: GeneNodeMap,
): GeneDescription {
  const { gene } = hit
  const strand =
    gene.strand === '+' ? ' (+)' : gene.strand === '-' ? ' (−)' : ''
  const outside =
    hit.bp < nodeLength
      ? ` (+${(nodeLength - hit.bp).toLocaleString()} bp outside the gene)`
      : ''
  const partInGraph = geneInGraph(map, gene)
  return {
    gene,
    heading:
      `${gene.name}${strand} · gene ${bases(hit.from, hit.to)} of ` +
      `${(gene.end - gene.start).toLocaleString()}${outside}`,
    parts: hit.parts.map(
      part =>
        `${part.kind} ${part.number} of ${part.count}: ` +
        `${bases(part.from, part.to)} of ${part.length.toLocaleString()}`,
    ),
    note: partInGraph && describeGeneInGraph(partInGraph),
  }
}

// Every gene a node is in (see describeGeneHit).
export function describeGenesAtNode(
  map: GeneNodeMap,
  node: number,
): GeneDescription[] {
  return (map.hits[node] ?? []).map(hit =>
    describeGeneHit(hit, map.nodeLength[node]!, map),
  )
}

export interface GeneInGraph {
  // The gene's bases the graph holds, from its 5′ end, and its length.
  from: number
  to: number
  length: number
  // Which end lies outside the graph.
  missing: '5′' | '3′' | 'both'
}

// The part of a gene the graph's edge leaves in, or null when the graph
// holds all of it.
export function geneInGraph(
  map: GeneNodeMap,
  gene: GeneRecord,
): GeneInGraph | null {
  const { start, end } = map.span
  const cutLeft = gene.start < start
  const cutRight = gene.end > end
  if (!cutLeft && !cutRight) return null
  const left5Prime = gene.strand !== '-'
  return {
    ...basesFrom5Prime(gene, gene.start, gene.end, start, end),
    length: gene.end - gene.start,
    missing:
      cutLeft && cutRight
        ? 'both'
        : cutLeft === left5Prime
          ? '5′'
          : '3′',
  }
}

// "Only bases 1–11,802 of 52,017 (23%) are in this graph; its 3′ end is
// outside it."
export function describeGeneInGraph(part: GeneInGraph): string {
  const percent = Math.round(((part.to - part.from + 1) / part.length) * 100)
  const ends =
    part.missing === 'both'
      ? 'both its ends are'
      : `its ${part.missing} end is`
  return (
    `Only ${bases(part.from, part.to)} of ${part.length.toLocaleString()} ` +
    `(${percent}%) are in this graph; ${ends} outside it.`
  )
}

// A gene's exons and introns, 5′ first, for picking what to highlight. The
// key ('exon:3', 'intron:2') names it in a selection; 'gene' is the whole
// gene.
export interface GeneStructurePart {
  key: string
  kind: 'exon' | 'intron'
  number: number
  start: number
  end: number
}

export function geneStructure(gene: GeneRecord): GeneStructurePart[] {
  const exons = gene.exons ?? []
  const number = (i: number, count: number) =>
    gene.strand === '-' ? count - i : i + 1
  const parts: GeneStructurePart[] = []
  exons.forEach((exon, i) => {
    const exonNumber = number(i, exons.length)
    parts.push({
      key: `exon:${exonNumber}`,
      kind: 'exon',
      number: exonNumber,
      start: exon.start,
      end: exon.end,
    })
    const next = exons[i + 1]
    if (next) {
      const intronNumber = number(i, exons.length - 1)
      parts.push({
        key: `intron:${intronNumber}`,
        kind: 'intron',
        number: intronNumber,
        start: exon.end,
        end: next.start,
      })
    }
  })
  return gene.strand === '-' ? parts.reverse() : parts
}

// The reference intervals a selection of a gene's parts covers.
export function selectedGeneIntervals(
  gene: GeneRecord,
  keys: ReadonlySet<string>,
): [number, number][] {
  if (keys.has('gene')) return [[gene.start, gene.end]]
  return geneStructure(gene)
    .filter(part => keys.has(part.key))
    .map(part => [part.start, part.end])
}

// The Genes color scheme: position along the gene as a rainbow, from blue
// at its 5′ end through cyan, green, yellow and orange to red at its 3′ end.
// Introns are the same color faded toward the canvas; nodes outside genes or
// off the reference are grey. Mid tones on the light canvas so yellow and
// green stay visible, lighter ones on the dark canvas.
const GENE_STOPS: Record<'light' | 'dark', Rgb[]> = {
  light: [
    [37, 99, 235],
    [8, 145, 178],
    [22, 163, 74],
    [202, 138, 4],
    [234, 88, 12],
    [220, 38, 38],
  ],
  dark: [
    [96, 165, 250],
    [34, 211, 238],
    [74, 222, 128],
    [250, 204, 21],
    [251, 146, 60],
    [248, 113, 113],
  ],
}
const CANVAS = { light: [255, 255, 255] as Rgb }
const INTRON_FADE = 0.55
const INTRON_DESATURATION = 0.65
export const NOT_IN_GENE_COLOR: Record<'light' | 'dark', Rgb> = {
  light: [200, 200, 200],
  dark: [80, 80, 80],
}

// The color at a reference coordinate: where it sits along the first gene
// holding it, faded in an intron; grey outside genes.
function colorAtCoordinate(
  genes: GeneRecord[],
  coordinate: number,
  isDarkMode: boolean,
): Rgb {
  const theme = isDarkMode ? 'dark' : 'light'
  for (const gene of genes) {
    if (gene.start > coordinate) break
    if (gene.end <= coordinate) continue
    const along = (coordinate - gene.start) / (gene.end - gene.start)
    const color = rampColor(
      GENE_STOPS[theme],
      gene.strand === '-' ? 1 - along : along,
    )
    const inExon =
      !gene.exons?.length ||
      gene.exons.some(exon => exon.start <= coordinate && coordinate < exon.end)
    return inExon ? color : intronColor(color, theme)
  }
  return NOT_IN_GENE_COLOR[theme]
}

// The color of a node at a fraction (0 to 1) of its length, measured along
// its forward strand: drawing it piece by piece shows each long node's own
// stretch of its gene, with exon and intron parts apart.
export function geneColorAt(
  map: GeneNodeMap,
  node: number,
  forwardFraction: number,
  isDarkMode: boolean,
): Rgb {
  const coordinate = nodeCoordinate(map, node, forwardFraction)
  return coordinate === null
    ? NOT_IN_GENE_COLOR[isDarkMode ? 'dark' : 'light']
    : colorAtCoordinate(map.genes, coordinate, isDarkMode)
}

// The reference coordinate at a fraction (0 to 1) of a node's length along
// its forward strand, or null when the node is off the reference.
export function nodeCoordinate(
  map: GeneNodeMap,
  node: number,
  forwardFraction: number,
): number | null {
  const start = map.refStart[node]!
  if (start < 0) return null
  const length = map.nodeLength[node]!
  const along = Math.max(0, Math.min(1, forwardFraction)) * length
  const coordinate = map.refForward[node]
    ? start + along
    : start + length - along
  // Kept inside the node's own bases at both ends.
  return Math.min(start + length - 0.5, coordinate)
}

// Introns are faded toward the white canvas in light mode; in dark mode,
// fading toward the canvas darkened them into browns, so they are washed out
// toward grey at the same brightness instead.
function intronColor(color: Rgb, theme: 'light' | 'dark'): Rgb {
  return theme === 'light'
    ? fadeToward(color, CANVAS.light, INTRON_FADE)
    : desaturate(color, INTRON_DESATURATION)
}

export function geneGradient(isDarkMode: boolean, intron: boolean): string {
  const theme = isDarkMode ? 'dark' : 'light'
  const stops = GENE_STOPS[theme]
  return rampGradient(
    intron ? stops.map(stop => intronColor(stop, theme)) : stops,
  )
}
