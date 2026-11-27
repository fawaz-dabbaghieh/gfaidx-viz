import { describe, expect, it } from 'vitest'
import type { Bubble } from './bubbleGun'
import { FIXTURE, graphFrom, tsv } from './testFixtures'
import { findTraversals, traversalRoute, traversalsToTsv } from './traversals'
import { getWalkIndex } from './walkIndex'

// The fixture's bubble 1 -> {2, 3} -> 4.
const BUBBLE: Bubble = {
  index: 0,
  type: 'simple',
  source: '1',
  sink: '4',
  inside: ['2', '3'],
  insideBp: 3,
  parent: null,
  outermost: null,
  nestedness: 0,
}

describe('findTraversals', () => {
  const graph = graphFrom(FIXTURE)
  const walkIndex = getWalkIndex(graph)
  const keys = (haplotypes: number[]) =>
    haplotypes.map(h => walkIndex.haplotypes[h]!.key)

  it('groups passes by route, reading reversed walks source to sink', () => {
    // HG1#2 walks <4<3<1, the same route as HG1#1's >1>3>4; HG3#1 takes
    // both routes, and its step from 4 back to 1 is the loop outside the
    // bubble, not a pass straight through it.
    const result = findTraversals(graph, BUBBLE, 'REF#0#chr1')!
    expect(result.traversals.map(t => traversalRoute(walkIndex, t))).toEqual([
      '>3',
      '>2',
    ])
    const [viaThree, viaTwo] = result.traversals
    expect(keys(viaThree!.haplotypes)).toEqual(['HG1#1', 'HG1#2', 'HG3#1'])
    expect(keys(viaTwo!.haplotypes)).toEqual(['REF#0', 'HG3#1'])
    expect(
      result.traversals.map(t => [t.id, t.bp, t.passes, t.isReference]),
    ).toEqual([
      [1, 2, 3, false],
      [2, 1, 2, true],
    ])
    expect(result.referenceBp).toBe(1)
    expect(result.passLengths).toEqual([1, 2, 2, 1, 2])
  })

  it('sorts every haplotype into how it passes the bubble', () => {
    // REF, HG1#1, HG1#2 once; HG3#1 twice; HG2#1's first walk ends inside.
    // HG4#1 only touches the sink, which isn't passing the bubble.
    const result = findTraversals(
      graphFrom(FIXTURE + '\n' + tsv(['W HG4 1 chr1 0 5 >4'])),
      BUBBLE,
      null,
    )!
    expect(result).toMatchObject({
      passOnce: 3,
      passMoreThanOnce: 1,
      cutInside: 1,
      dontPass: 1,
      referenceBp: null,
    })
    expect(result.traversals.some(t => t.isReference)).toBe(false)
  })

  it('counts a walk going straight from one end to the other', () => {
    const insertion = graphFrom(
      tsv([
        'S 1 A',
        'S 2 CC',
        'S 3 G',
        'L 1 + 2 + 0M',
        'L 1 + 3 + 0M',
        'L 2 + 3 + 0M',
        'W A 1 c 0 4 >1>2>3',
        'W B 1 c 0 2 <3<1',
      ]),
    )
    const result = findTraversals(
      insertion,
      { ...BUBBLE, type: 'insertion', source: '1', sink: '3', inside: ['2'] },
      null,
    )!
    expect(
      result.traversals.map(t => [
        traversalRoute(getWalkIndex(insertion), t),
        t.bp,
      ]),
    ).toEqual([
      ['>2', 2],
      ['', 0],
    ])
  })

  it('writes one TSV row per traversal', () => {
    const result = findTraversals(graph, BUBBLE, 'REF#0#chr1')!
    const lines = traversalsToTsv(
      walkIndex,
      BUBBLE,
      result,
      'test.gfa',
      'REF#0#chr1',
    ).split('\n')
    expect(lines[0]).toBe(
      '# Traversals through bubble 1 (1 to 4) in test.gfa, reference REF#0#chr1',
    )
    expect(lines[2]).toBe('T1\t3\t3\t2\t1\t1\tno\t>3\tHG1#1,HG1#2,HG3#1')
    expect(lines[3]).toBe('T2\t2\t2\t1\t1\t0\tyes\t>2\tREF#0,HG3#1')
  })

  it('writes where the graph came from under the title', () => {
    const result = findTraversals(graph, BUBBLE, null)!
    const lines = traversalsToTsv(walkIndex, BUBBLE, result, 'test.gfa', null, [
      'graph: hprc.gfa.gz',
      'region: CHM13 chr1:100-200',
    ]).split('\n')
    expect(lines.slice(0, 4)).toEqual([
      '# Traversals through bubble 1 (1 to 4) in test.gfa',
      '# graph: hprc.gfa.gz',
      '# region: CHM13 chr1:100-200',
      'traversal\thaplotypes\tpasses\tlength_bp\tnodes\tvs_reference_bp\treference\troute\thaplotype_names',
    ])
  })
})
