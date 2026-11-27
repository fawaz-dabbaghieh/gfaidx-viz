import { describe, expect, it } from 'vitest'
import type { PathNameCoordinates } from './gfaConverter'
import { graphFrom, tsv } from './testFixtures'

// Node 1 is 4 bp, node 2 is 6 bp.
const GFA = tsv([
  'S 1 AAAA',
  'S 2 CCCCCC',
  'L 1 + 2 + 0M',
  'P CHM13#0#chr6:100-110 1+,2+ *',
  // A range in steps (2 nodes), not bases (4 bp).
  'P HG1#1#chr6:5-7 1+ *',
  'P plain:100-104 1+ *',
  'P GRCh38#chr6:0-6 2+ *',
  'P CHM13#0#chr6 1+ *',
])

const coordinates = (accept: PathNameCoordinates) =>
  Object.fromEntries(
    graphFrom(GFA, accept).paths!.map(path => [
      path.name,
      path.walk
        ? [
            path.walk.sampleName,
            path.walk.haplotypeIndex,
            path.walk.sequenceName,
            path.walk.sequenceStart,
            path.walk.sequenceEnd,
          ]
        : null,
    ]),
  )

describe('coordinates from P-line names', () => {
  it('for an uploaded file, reads PanSN names whose range is the path length', () => {
    expect(coordinates('panSN')).toEqual({
      'CHM13#0#chr6:100-110': ['CHM13', '0', 'chr6', '100', '110'],
      'HG1#1#chr6:5-7': null,
      'plain:100-104': null,
      'GRCh38#chr6:0-6': ['GRCh38', '', 'chr6', '0', '6'],
      'CHM13#0#chr6': null,
    })
  })

  it('for a gfaidx "With Coordinates" result, reads any name', () => {
    expect(coordinates('any')['plain:100-104']).toEqual([
      '',
      '',
      'plain',
      '100',
      '104',
    ])
    expect(coordinates('any')['HG1#1#chr6:5-7']).toBeNull()
  })

  it('otherwise reads none', () => {
    expect(Object.values(coordinates('none')).every(walk => walk === null)).toBe(
      true,
    )
  })
})
