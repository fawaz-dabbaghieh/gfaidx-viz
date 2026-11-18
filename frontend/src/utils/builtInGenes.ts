import type { Graph, RegionPath } from '../types'
import { parseGeneTrackBed, type GeneRecord } from './geneTrackBed'

// Gene annotations shipped with the app, built by
// scripts/build_gene_annotations.py into public/annotations/: one BED12 file
// per assembly and chromosome, plus a gene-name index per assembly for gene
// search. Everything is fetched on demand and cached for the session.
export type GeneAssembly = 'GRCh38' | 'CHM13'

export const BUILT_IN_GENE_SOURCE = 'MANE Select v1.5 (protein-coding)'

export interface GeneLocation {
  symbol: string
  // Upper-cased symbol, precomputed so searching doesn't re-case 19k names
  // on every keystroke.
  key: string
  chrom: string
  start: number
  end: number
  strand: string
}

const PRIMARY_CHROMOSOME = /^chr([1-9]|1[0-9]|2[0-2]|X|Y)$/

function assemblyFromName(name: string): GeneAssembly | null {
  const lower = name.toLowerCase()
  const isGRCh38 = lower.includes('grch38') || lower.includes('hg38')
  const isCHM13 = lower.includes('chm13') || lower.includes('t2t')
  if (isGRCh38 === isCHM13) return null
  return isGRCh38 ? 'GRCh38' : 'CHM13'
}

// Works out which assembly and chromosome a reference sequence belongs to,
// from the forms the indexed graphs use: a W-line sample ("CHM13" + "chr1"),
// a PanSN name ("GRCh38#0#chr1", "grch38#chr1"), or a bare "chr1" (minigraph
// rGFA), where only the graph's own name says which assembly it is. A named
// sample that isn't a reference (e.g. "HG00438") never falls back to the
// graph name.
export function detectGeneAssembly(
  sampleName: string,
  sequenceName: string,
  graphName: string,
): { assembly: GeneAssembly; chrom: string } | null {
  const parts = sequenceName.split('#')
  const chrom = parts[parts.length - 1]!
  if (!PRIMARY_CHROMOSOME.test(chrom)) return null

  const sample = sampleName || (parts.length > 1 ? parts[0]! : '')
  const assembly = assemblyFromName(sample || graphName)
  return assembly ? { assembly, chrom } : null
}

// The track to select when a graph's tracks load: the first one on the
// graph's own reference, going by its name, since a GRCh38-based graph can
// list its CHM13 tracks first. Otherwise the first track.
export function defaultTrackIndex(
  regionPaths: RegionPath[],
  graphName: string,
): number {
  const assembly = assemblyFromName(graphName)
  if (!assembly) return 0
  const index = regionPaths.findIndex(
    regionPath =>
      detectGeneAssembly(regionPath.reference, regionPath.sequence, graphName)
        ?.assembly === assembly,
  )
  return Math.max(index, 0)
}

// The assembly gene search uses for a graph's coordinate tracks: the selected
// track's, or else the first GRCh38/CHM13 track's, so e.g. a haplotype track
// being selected still searches the reference.
export function geneAssemblyForTracks(
  regionPaths: RegionPath[],
  selectedIndex: number,
  graphName: string,
): GeneAssembly | null {
  const assemblyOf = (regionPath: RegionPath | undefined) =>
    regionPath
      ? (detectGeneAssembly(regionPath.reference, regionPath.sequence, graphName)
          ?.assembly ?? null)
      : null
  const selected = assemblyOf(regionPaths[selectedIndex])
  if (selected) return selected
  for (const regionPath of regionPaths) {
    const found = assemblyOf(regionPath)
    if (found) return found
  }
  return null
}

// The region query for a gene plus flankBp on each side: the gene's
// chromosome in the same assembly, clamped to the track. A W-line reference
// can be split into several tracks, so one containing the whole gene wins.
export function geneRegion(
  gene: GeneLocation,
  flankBp: number,
  assembly: GeneAssembly,
  regionPaths: RegionPath[],
  graphName: string,
): { trackIndex: number; start: number; end: number } | { error: string } {
  let trackIndex = -1
  let trackContainsGene = false
  regionPaths.forEach((regionPath, index) => {
    const match = detectGeneAssembly(
      regionPath.reference,
      regionPath.sequence,
      graphName,
    )
    if (match?.assembly !== assembly || match.chrom !== gene.chrom) return
    const containsGene =
      regionPath.start <= gene.start &&
      (regionPath.end === null || regionPath.end >= gene.end)
    if (trackIndex === -1 || (containsGene && !trackContainsGene)) {
      trackIndex = index
      trackContainsGene = containsGene
    }
  })

  const track = regionPaths[trackIndex]
  if (!track) {
    return {
      error: `${gene.symbol} is on ${gene.chrom}, which this graph has no ${assembly} track for.`,
    }
  }
  return {
    trackIndex,
    start: Math.max(track.start, gene.start - flankBp),
    end:
      track.end === null
        ? gene.end + flankBp
        : Math.min(track.end, gene.end + flankBp),
  }
}

// Files are gzipped to keep them small (chr1 is ~160 KB) and inflated with
// the browser's own DecompressionStream. A server may also have decoded them
// already, and a dev server answers a missing file with index.html, so the
// bytes are checked rather than trusted.
async function fetchGzippedText(url: string): Promise<string | null> {
  const response = await fetch(url)
  if (!response.ok) return null
  const buffer = await response.arrayBuffer()
  const magic = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength))
  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    const stream = new Blob([buffer])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'))
    return new Response(stream).text()
  }
  const text = new TextDecoder().decode(buffer)
  return text.trimStart().startsWith('<') ? null : text
}

// Failed loads are dropped from the cache so a later attempt can retry.
function cached<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  let promise = cache.get(key)
  if (!promise) {
    promise = load()
    promise.catch(() => cache.delete(key))
    cache.set(key, promise)
  }
  return promise
}

const geneCache = new Map<string, Promise<GeneRecord[]>>()
const indexCache = new Map<string, Promise<GeneLocation[]>>()

export function loadBuiltInGenes(
  assembly: GeneAssembly,
  chrom: string,
): Promise<GeneRecord[]> {
  return cached(geneCache, `${assembly}/${chrom}`, async () => {
    const text = await fetchGzippedText(
      `./annotations/${assembly}/${chrom}.bed.gz`,
    )
    return text ? parseGeneTrackBed(text) : []
  })
}

export function loadGeneIndex(assembly: GeneAssembly): Promise<GeneLocation[]> {
  return cached(indexCache, assembly, async () => {
    const text = await fetchGzippedText(`./annotations/${assembly}/genes.tsv.gz`)
    if (!text) throw new Error(`No gene list found for ${assembly}`)

    const genes: GeneLocation[] = []
    for (const line of text.split('\n')) {
      const [symbol, chrom, start, end, strand] = line.split('\t')
      if (!symbol || !chrom) continue
      genes.push({
        symbol,
        key: symbol.toUpperCase(),
        chrom,
        start: Number(start),
        end: Number(end),
        strand: strand ?? '',
      })
    }
    return genes
  })
}

// Exact matches first, then prefix matches, then (for 3+ characters) any
// symbol containing the query.
export function searchGenes(
  genes: GeneLocation[],
  query: string,
  limit = 8,
): GeneLocation[] {
  const key = query.trim().toUpperCase()
  if (!key) return []

  const exact: GeneLocation[] = []
  const prefix: GeneLocation[] = []
  const contains: GeneLocation[] = []
  for (const gene of genes) {
    if (gene.key === key) exact.push(gene)
    else if (gene.key.startsWith(key)) {
      if (prefix.length < limit) prefix.push(gene)
    } else if (key.length >= 3 && contains.length < limit && gene.key.includes(key)) {
      contains.push(gene)
    }
  }
  return [...exact, ...prefix, ...contains].slice(0, limit)
}

// The built-in gene set for a linear layout's reference path, if there is
// one. The path needs real genomic coordinates: a W-line, or a path built
// from rGFA tags. P-lines only give a distance from the start of the path.
export function builtInGeneSetForPath(
  graph: Graph,
  referencePathName: string,
): { assembly: GeneAssembly; chrom: string } | null {
  const walk = graph.paths?.find(path => path.name === referencePathName)?.walk
  if (!walk || !Number.isFinite(Number(walk.sequenceStart))) return null
  return detectGeneAssembly(walk.sampleName, walk.sequenceName, graph.name)
}
