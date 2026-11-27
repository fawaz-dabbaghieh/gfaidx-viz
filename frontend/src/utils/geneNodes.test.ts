import { describe, expect, it } from 'vitest'
import type { GeneRecord } from './geneTrackBed'
import {
  NOT_IN_GENE_COLOR,
  describeGenesAtNode,
  geneColorAt,
  getGeneNodeMap,
} from './geneNodes'
import { FIXTURE, graphFrom, tsv } from './testFixtures'
import { getWalkIndex } from './walkIndex'

const gene = (fields: Partial<GeneRecord>): GeneRecord => ({
  chrom: 'chr1',
  start: 0,
  end: 0,
  name: 'G',
  score: '0',
  strand: '+',
  lineNumber: 1,
  ...fields,
})

const mapOf = (...args: Parameters<typeof getGeneNodeMap>) => {
  const result = getGeneNodeMap(...args)
  if (!('map' in result)) throw new Error(result.message)
  return result.map
}

describe('getGeneNodeMap', () => {
  // REF walks 1 (chr1:100-104), 2 (104-105), 4 (105-110); 3 is off it.
  const graph = graphFrom(FIXTURE)
  const node = (name: string) => getWalkIndex(graph).nodeIndex.get(name)!
  // A '-' strand gene, 101-109, with exons 101-103 and 106-109 around an
  // intron 103-106.
  const genes = [
    gene({
      name: 'G1',
      chrom: 'CHM13#0#chr1',
      start: 101,
      end: 109,
      strand: '-',
      exons: [
        { start: 101, end: 103 },
        { start: 106, end: 109 },
      ],
    }),
    gene({ name: 'Other', chrom: 'chr2', start: 100, end: 110 }),
  ]
  const map = mapOf(graph, genes, 'REF#0#chr1')

  it('places each node in the gene and its exons and introns, from 5′', () => {
    expect(map.referencePath).toBe('REF#0#chr1')
    expect(map.geneCount).toBe(1)
    const describe = (name: string) => describeGenesAtNode(map, node(name))
    // On the '-' strand base 1 is the rightmost (108) and the leftmost exon
    // is the last one. Nodes 1 and 4 cross the intron's ends and stick out
    // of the gene by a base.
    expect(describe('4')).toEqual([
      {
        heading: 'G1 (−) · gene bases 1–4 of 8 (+1 bp outside the gene)',
        parts: ['exon 1 of 2: bases 1–3 of 3', 'intron 1 of 1: base 1 of 3'],
      },
    ])
    expect(describe('2')).toEqual([
      {
        heading: 'G1 (−) · gene base 5 of 8',
        parts: ['intron 1 of 1: base 2 of 3'],
      },
    ])
    expect(describe('1')).toEqual([
      {
        heading: 'G1 (−) · gene bases 6–8 of 8 (+1 bp outside the gene)',
        parts: ['intron 1 of 1: base 3 of 3', 'exon 2 of 2: bases 1–2 of 2'],
      },
    ])
    expect(describe('3')).toEqual([])
  })

  it('colors along a node: 5′ blue, introns faded, grey outside genes', () => {
    const color = (name: string, fraction: number) =>
      geneColorAt(map, node(name), fraction, false)
    // Node 1's first base (100) is outside the gene; node 3 is off the
    // reference.
    expect(color('1', 0.1)).toEqual(NOT_IN_GENE_COLOR.light)
    expect(color('3', 0.5)).toEqual(NOT_IN_GENE_COLOR.light)
    // Base 108 of the '-' gene is next to its 5′ end: blue.
    const [r, , b] = color('4', 0.7)
    expect(r).toBeLessThan(80)
    expect(b).toBeGreaterThan(200)
    // The same spot of the gene in an exon and, faded, in the intron.
    const exon = color('4', 0.25) // base 106
    const intron = color('4', 0.15) // base 105
    expect(intron).not.toEqual(exon)
    expect(Math.min(...intron)).toBeGreaterThan(Math.min(...exon))
  })

  it('follows the reference reading a node backwards', () => {
    const reversed = graphFrom(
      tsv(['S 1 AAA', 'S 2 CCC', 'L 1 + 2 - 0M', 'W REF 0 chr1 0 6 >1<2']),
    )
    const reversedMap = mapOf(
      reversed,
      [gene({ start: 0, end: 6, strand: '+' })],
      'REF#0#chr1',
    )
    const two = getWalkIndex(reversed).nodeIndex.get('2')!
    // Node 2's forward start is the gene's 3′ end (red), its end the middle.
    const [startR, , startB] = geneColorAt(reversedMap, two, 0, false)
    const [endR, , endB] = geneColorAt(reversedMap, two, 1, false)
    expect(startR).toBeGreaterThan(endR)
    expect(startB).toBeLessThan(endB)
  })

  it("says why genes can't be placed", () => {
    expect(getGeneNodeMap(graph, [], 'REF#0#chr1')).toHaveProperty('message')
    const noCoordinates = graphFrom(tsv(['S 1 AAAA', 'P CHM13#0#chr1 1+ *']))
    expect(getGeneNodeMap(noCoordinates, genes, '')).toEqual({
      message: expect.stringContaining('has no coordinates'),
    })
    expect(
      getGeneNodeMap(graph, [gene({ start: 500, end: 600 })], 'REF#0#chr1'),
    ).toEqual({ message: 'No genes overlap REF#0#chr1 in this graph.' })
  })

  it('places rGFA nodes by their SO tag', () => {
    const rgfa = graphFrom(
      tsv([
        'S s1 AAAA SN:Z:chr1 SO:i:1000 SR:i:0',
        'S s2 CC SN:Z:HG1#1#c SO:i:0 SR:i:1',
        'S s3 GGGG SN:Z:chr1 SO:i:1004 SR:i:0',
        'L s1 + s2 + 0M',
        'L s2 + s3 + 0M',
        'L s1 + s3 + 0M',
      ]),
    )
    const rgfaMap = mapOf(rgfa, [gene({ name: 'R', start: 1005, end: 1010 })], '')
    const index = getWalkIndex(rgfa).nodeIndex
    // s3 is 1004-1008, the gene 1005-1010.
    expect(describeGenesAtNode(rgfaMap, index.get('s3')!)).toEqual([
      {
        heading: 'R (+) · gene bases 1–3 of 5 (+1 bp outside the gene)',
        parts: [],
      },
    ])
    expect(describeGenesAtNode(rgfaMap, index.get('s1')!)).toEqual([])
    expect(describeGenesAtNode(rgfaMap, index.get('s2')!)).toEqual([])
  })
})
