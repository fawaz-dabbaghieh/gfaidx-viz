import { describe, expect, it, vi } from 'vitest'
import { runGfaidxJob } from '../api/gfaidx'
import {
  NO_HAPLOTYPE_COLOR,
  haplotypeSharingColor,
} from './haplotypeSharingColor'
import {
  compareToReference,
  getWalkIndex,
  haplotypesToTsv,
  pickReferencePath,
  haplotypeOnReference,
  referenceCovered,
  splitCauses,
} from './walkIndex'
import { FIXTURE, graphFrom, tsv } from './testFixtures'

describe('getWalkIndex', () => {
  const walkIndex = getWalkIndex(graphFrom(FIXTURE))
  const haplotype = (key: string) =>
    walkIndex.haplotypes.find(candidate => candidate.key === key)!
  const node = (name: string) => walkIndex.nodeIndex.get(name)!

  it('groups walks into haplotypes by sample and haplotype', () => {
    expect(walkIndex.haplotypes.map(h => h.key)).toEqual([
      'REF#0',
      'HG1#1',
      'HG1#2',
      'HG2#1',
      'HG3#1',
    ])
    expect(haplotype('HG2#1').walks).toHaveLength(2)
    expect(haplotype('HG2#1').clipped).toBe(true)
    expect(haplotype('HG2#1').gapBp).toBe(15)
    expect(haplotype('REF#0').clipped).toBe(false)
  })

  it('stores node lengths and walks as compact node indices', () => {
    expect(Array.from(walkIndex.nodeLen)).toEqual([4, 1, 2, 5])
    expect(walkIndex.visitCount).toBe(18)

    const reversed = haplotype('HG1#2').walks[0]!
    expect(Array.from(reversed.nodes)).toEqual([node('4'), node('3'), node('1')])
    expect(Array.from(reversed.fwd)).toEqual([0, 0, 0])
    expect(Array.from(haplotype('HG1#1').walks[0]!.fwd)).toEqual([1, 1, 1])
  })

  it('counts haplotypes and visits per node separately', () => {
    // HG3#1 passes nodes 1 and 4 twice: two visits, one haplotype.
    expect(Array.from(walkIndex.haplotypesVisiting)).toEqual([5, 3, 3, 5])
    expect(Array.from(walkIndex.totalVisits)).toEqual([6, 3, 3, 6])
  })

  it('sums node lengths per haplotype, matching the walk coordinates', () => {
    expect(walkIndex.haplotypes.map(h => h.seqLen)).toEqual([10, 11, 11, 10, 21])
    expect(walkIndex.coordinateMismatches).toEqual([])
  })

  it('reports walks whose coordinates disagree with their node lengths', () => {
    const broken = getWalkIndex(
      graphFrom(FIXTURE.replace('W\tREF\t0\tchr1\t100\t110', 'W\tREF\t0\tchr1\t100\t111')),
    )
    expect(broken.coordinateMismatches).toEqual([
      { pathName: 'REF#0#chr1', seqLen: 10, span: 11 },
    ])
  })

  it('compares every haplotype with the reference walk', () => {
    const comparison = compareToReference(walkIndex, 'REF#0#chr1')!
    expect(comparison.haplotypeKey).toBe('REF#0')
    expect(Array.from(comparison.onRef)).toEqual([1, 1, 0, 1])
    expect(Array.from(comparison.refOffset)).toEqual([100, 104, -1, 105])
    expect(comparison.refBp).toBe(10)
    expect(Array.from(comparison.sharedBp)).toEqual([10, 9, 9, 10, 19])
    expect(Array.from(comparison.offRefBp)).toEqual([0, 2, 2, 0, 2])
    walkIndex.haplotypes.forEach((h, i) =>
      expect(comparison.sharedBp[i]! + comparison.offRefBp[i]!).toBe(h.seqLen),
    )
    expect(compareToReference(walkIndex, 'no such path')).toBeNull()
  })

  it('measures sequence shared with the reference', () => {
    const comparison = compareToReference(walkIndex, 'REF#0#chr1')!
    // HG1#1: 9 of its 11 bp are on the reference, covering 9 of its 10 bp.
    // HG3#1 passes nodes 1 and 4 twice: 19 of its 21 bp are on the
    // reference, and it covers all of the reference.
    expect(
      walkIndex.haplotypes.map((h, i) =>
        haplotypeOnReference(comparison, i, h.seqLen),
      ),
    ).toEqual([1, 9 / 11, 9 / 11, 1, 19 / 21])
    expect(
      walkIndex.haplotypes.map((_, i) => referenceCovered(comparison, i)),
    ).toEqual([1, 0.9, 0.9, 1, 1])
    expect(Array.from(comparison.sharedNodeBp)).toEqual([10, 9, 9, 10, 10])

    const lines = haplotypesToTsv(walkIndex, comparison, 'test.gfa').split('\n')
    expect(lines[0]).toBe('# Haplotypes in test.gfa, compared with the reference REF#0#chr1')
    expect(lines[3]).toBe('HG1#1\tHG1\t1\t1\t11\t9\t2\t0.8182\t0.9000')
  })

  it('picks the preferred reference, else a CHM13 or GRCh38 walk', () => {
    expect(pickReferencePath(walkIndex, 'HG1#1#chr1')).toBe('HG1#1#chr1')
    expect(pickReferencePath(walkIndex, 'missing')).toBeNull()
    const human = getWalkIndex(
      graphFrom(FIXTURE.replace('W\tHG1\t1', 'W\tCHM13\t0')),
    )
    expect(pickReferencePath(human)).toBe('CHM13#0#chr1')
  })

  it('groups PanSN P lines, with coordinates only when asked', () => {
    const pLines = tsv([
      'S 1 AAAA',
      'S 2 C',
      'L 1 + 2 + 0M',
      'P HG4#1#chr1:0-4 1+ *',
      'P HG4#1#chr1:20-21 2+ *',
      'P plain 1+,2+ *',
    ])
    const withCoordinates = getWalkIndex(graphFrom(pLines, 'any'))
    expect(withCoordinates.haplotypes.map(h => h.key)).toEqual(['HG4#1', 'plain'])
    const hg4 = withCoordinates.haplotypes[0]!
    expect(hg4.walks.map(w => [w.contig, w.start, w.end])).toEqual([
      ['chr1', 0, 4],
      ['chr1', 20, 21],
    ])
    expect(hg4.gapBp).toBe(16)

    const without = getWalkIndex(graphFrom(pLines)).haplotypes[0]!
    expect(without.key).toBe('HG4#1')
    expect(without.walks[0]!.start).toBeNull()
    expect(without.gapBp).toBeNull()
  })

  it('tells why haplotypes are split into several walks', () => {
    // HG2#1 misses 15 bp between its two chr1 walks; HG5#1 lies on two
    // contigs.
    const split = getWalkIndex(
      graphFrom(FIXTURE + '\n' + tsv(['W HG5 1 chr2 0 5 >1>2', 'W HG5 1 chr3 0 5 >4'])),
    )
    const hg2 = split.haplotypes.find(h => h.key === 'HG2#1')!
    expect([hg2.contigs, hg2.largestGapBp]).toEqual([1, 15])
    expect(split.haplotypes.find(h => h.key === 'HG5#1')!.contigs).toBe(2)
    // A 10 bp query gap split HG2#1; with 20 bp the graph itself did.
    expect(splitCauses(split, 10)).toEqual({ gap: 1, contigs: 1, graph: 0, unknown: 0 })
    expect(splitCauses(split, 20)).toEqual({ gap: 0, contigs: 1, graph: 1, unknown: 0 })
    // Not from an all-haplotypes query: only the contigs can be told.
    expect(splitCauses(split, null)).toEqual({ gap: 0, contigs: 1, graph: 0, unknown: 1 })
  })

  it('handles a graph without paths', () => {
    const noPaths = getWalkIndex(graphFrom(tsv(['S 1 A', 'S 2 C', 'L 1 + 2 + 0M'])))
    expect(noPaths.haplotypes).toEqual([])
    expect(noPaths.visitCount).toBe(0)
  })
})

describe('haplotypeSharingColor', () => {
  it('runs from red (one haplotype) to blue (all), grey for none', () => {
    expect(haplotypeSharingColor(1, 464)).toEqual([215, 48, 39])
    expect(haplotypeSharingColor(464, 464)).toEqual([69, 117, 180])
    expect(haplotypeSharingColor(0, 464)).toEqual(NO_HAPLOTYPE_COLOR)
    expect(haplotypeSharingColor(1, 1)).toEqual([69, 117, 180])
  })
})

// The LPA region of the HPRC v2.1 Minigraph-Cactus CHM13 graph, with the
// values measured for the implementation brief. It downloads a 78 MB GFA, so
// it only runs with GFAIDX_INTEGRATION=1.
const env =
  (globalThis as { process?: { env: Record<string, string | undefined> } })
    .process?.env ?? {}

describe.runIf(env.GFAIDX_INTEGRATION)('getWalkIndex on LPA', () => {
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = sorted.length / 2
    return Number.isInteger(middle)
      ? (sorted[middle - 1]! + sorted[middle]!) / 2
      : sorted[Math.floor(middle)]!
  }

  it('matches the measured values', { timeout: 600_000 }, async () => {
    // runGfaidxJob polls with window.setTimeout.
    vi.stubGlobal('window', globalThis)
    const { gfaText } = await runGfaidxJob({
      backendUrl: env.GFAIDX_BACKEND_URL ?? 'https://search.foldseek.com',
      submissionPath: '/api/ticket/gfaidx/region',
      payload: {
        graph_id: 'hprc-v2.1-mc-chm13.indexed.gfa.gz',
        reference: 'CHM13',
        sequence: 'chr6',
        start: 161_733_171,
        end: 162_061_762,
        all_haplotypes: true,
        haplotype_gap: '100kb',
        with_coords: true,
      },
    })
    const graph = graphFrom(gfaText)

    const startTime = performance.now()
    const walkIndex = getWalkIndex(graph)
    const comparison = compareToReference(walkIndex, 'CHM13#0#chr6')!
    const buildMs = performance.now() - startTime
    console.log(`WalkIndex + reference comparison: ${buildMs.toFixed(0)} ms`)

    const { haplotypes, nodeLen, haplotypesVisiting } = walkIndex
    expect(graph.paths).toHaveLength(465)
    expect(haplotypes).toHaveLength(464)
    expect(haplotypes.filter(h => h.clipped)).toHaveLength(1)
    expect(nodeLen).toHaveLength(32_194)
    expect(nodeLen.reduce((sum, length) => sum + length, 0)).toBe(394_093)
    expect(walkIndex.visitCount).toBe(7_534_464)
    expect(walkIndex.coordinateMismatches).toEqual([])

    // The brief rounds the median down to 311,391.
    const seqLens = haplotypes.map(h => h.seqLen)
    expect([Math.min(...seqLens), median(seqLens), Math.max(...seqLens)]).toEqual([
      206_051, 311_391.5, 401_520,
    ])

    const visiting = Array.from(haplotypesVisiting)
    expect(visiting.filter(count => count === 464)).toHaveLength(3_411)
    expect(visiting.filter(count => count === 1)).toHaveLength(3_502)
    expect(median(visiting)).toBe(201)
    let inAllHaplotypes = 0
    visiting.forEach((count, node) => {
      if (count === 464) inAllHaplotypes += nodeLen[node]!
    })
    expect(inAllHaplotypes).toBe(189_804)

    expect(comparison.haplotypeKey).toBe('CHM13#0')
    const offRef = haplotypes
      .map((h, i) => ({ key: h.key, offRef: comparison.offRefBp[i]! }))
      .filter(({ key }) => key !== comparison.haplotypeKey)
      .map(({ offRef }) => offRef)
    expect([Math.min(...offRef), median(offRef), Math.max(...offRef)]).toEqual([
      57, 23_051, 51_665,
    ])
    haplotypes.forEach((h, i) =>
      expect(comparison.sharedBp[i]! + comparison.offRefBp[i]!).toBe(h.seqLen),
    )
    expect(buildMs).toBeLessThan(2000)
  })
})
