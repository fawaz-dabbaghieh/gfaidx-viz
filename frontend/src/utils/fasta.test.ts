import { describe, expect, it } from 'vitest'
import type { Bubble } from './bubbleGun'
import { haplotypesToFasta, traversalsToFasta } from './fasta'
import { FIXTURE, graphFrom, tsv } from './testFixtures'
import { findTraversals } from './traversals'
import { getWalkIndex } from './walkIndex'

const records = (chunks: string[]) =>
  chunks
    .join('')
    .split('>')
    .slice(1)
    .map(record => {
      const [header, ...lines] = record.trim().split('\n')
      return [header, lines.join('')]
    })

describe('FASTA', () => {
  const graph = graphFrom(FIXTURE)
  const walkIndex = getWalkIndex(graph)

  it('spells every walk, reverse-complementing "-" steps', () => {
    const result = haplotypesToFasta(graph, walkIndex)
    expect(result.records).toBe(6)
    expect(result.skipped).toBe(0)
    expect(records(result.chunks)).toEqual([
      ['REF#0#chr1:100-110 haplotype=REF#0 bp=10', 'AAAACTTTTT'],
      ['HG1#1#chr1:0-11 haplotype=HG1#1 bp=11', 'AAAAGGTTTTT'],
      // <4<3<1
      ['HG1#2#chr1:0-11 haplotype=HG1#2 bp=11', 'AAAAACCTTTT'],
      ['HG2#1#chr1:0-5 haplotype=HG2#1 bp=5', 'AAAAC'],
      ['HG2#1#chr1:20-25 haplotype=HG2#1 bp=5', 'TTTTT'],
      ['HG3#1#chr1:0-21 haplotype=HG3#1 bp=21', 'AAAACTTTTTAAAAGGTTTTT'],
    ])
  })

  it('writes one record per traversal, naming every haplotype', () => {
    const bubble: Bubble = {
      index: 6,
      type: 'simple',
      source: '1',
      sink: '4',
      inside: ['2', '3'],
      insideBp: 3,
      parent: null,
      outermost: null,
      nestedness: 0,
    }
    const traversals = findTraversals(graph, bubble, 'REF#0#chr1')!
    const result = traversalsToFasta(graph, walkIndex, bubble, traversals)
    expect(records(result.chunks)).toEqual([
      [
        'bubble7_T1 bp=2 reference=no haplotype_count=3 haplotypes=HG1#1,HG1#2,HG3#1',
        'GG',
      ],
      [
        'bubble7_T2 bp=1 reference=yes haplotype_count=2 haplotypes=REF#0,HG3#1',
        'C',
      ],
    ])
  })

  it('trims link overlaps and skips walks with a missing sequence', () => {
    const overlapping = graphFrom(
      tsv([
        'S 1 ACGTA',
        'S 2 TACCC',
        'S 3 *',
        'L 1 + 2 + 2M',
        'L 2 + 3 + 0M',
        'P x 1+,2+ *',
        'P y 2-,1- *',
        'P z 1+,2+,3+ *',
      ]),
    )
    const result = haplotypesToFasta(overlapping, getWalkIndex(overlapping))
    // 2- then 1- uses the same link read backwards.
    expect(records(result.chunks)).toEqual([
      ['x haplotype=x bp=8', 'ACGTACCC'],
      ['y haplotype=y bp=8', 'GGGTACGT'],
    ])
    expect(result.skipped).toBe(1)
  })

  it('wraps sequences at 80 bases', () => {
    const long = graphFrom(tsv([`S 1 ${'A'.repeat(170)}`, 'P x 1+ *']))
    const lines = haplotypesToFasta(long, getWalkIndex(long))
      .chunks.join('')
      .trim()
      .split('\n')
    expect(lines.map(line => line.length)).toEqual([21, 80, 80, 10])
  })
})
