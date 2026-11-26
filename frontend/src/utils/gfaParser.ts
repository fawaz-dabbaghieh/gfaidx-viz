function parseTag(tag: string, tags: Record<string, string | number>) {
  // Tag values can themselves contain colons (B arrays, J json), so only the
  // name and type are split off the front; the rest is rejoined as the value.
  const [name, type, ...valueParts] = tag.split(':')
  const val = valueParts.join(':')
  if (!name || !type || !val) return

  switch (type) {
    case 'i':
    case 'f':
      // Both int and float tags (e.g. dp:f:12.5) are stored as numbers so
      // depth and other numeric tags parse correctly either way.
      tags[name] = Number(val)
      break
    default:
      // A, Z, H, B, and J tags are all kept as their raw string value so
      // nothing is silently dropped, even for tag types we don't interpret.
      tags[name] = val
  }
}

export interface GFANode {
  id: string
  length: number
  sequence: string
  tags: Record<string, string | number>
}

export interface GFALink {
  source: string
  target: string
  strand1?: string
  strand2?: string
  cigar: string
  tags: Record<string, string | number>
}

export interface GFAPath {
  name: string
  path: string
  rest: string[]
  recordType: 'P' | 'W'
  walk?: GFAWalkMetadata
}

export interface GFAWalkMetadata {
  sampleName: string
  haplotypeIndex: string
  sequenceName: string
  sequenceStart: string
  sequenceEnd: string
  tags: string[]
}

export interface GFAGraph {
  nodes: GFANode[]
  links: GFALink[]
  paths: GFAPath[]
  header: Record<string, string | number>[]
  id: string
}

export function parseGFA(file: string): GFAGraph {
  // The parser collects the small subset of GFA records the demo currently
  // needs: headers, segments, links/edges, and paths/walks.
  const graph: GFAGraph = {
    nodes: [],
    links: [],
    paths: [],
    header: [],
    id: '',
  }
  const walkNameCounts = new Map<string, number>()

  // \r too, so a CRLF file doesn't leave it on the last field (e.g. the
  // sequence of a segment with no tags, making it 1 bp too long).
  for (const line of file.split(/\r?\n/)) {
    if (line.startsWith('H')) {
      const headerLine = {} as Record<string, string | number>
      const [, ...rest] = line.split('\t')
      for (const tag of rest) {
        parseTag(tag, headerLine)
      }
      graph.header.push(headerLine)
    }
    if (line.startsWith('S')) {
      // Segment lines differ between GFA1 and GFA2, so we normalize both
      // formats into the same node structure here.
      const [, name, ...rest] = line.split('\t')
      let len = 0
      let seq = ''
      let tagfields
      let gfa1 = false
      if (+rest[0]) {
        len = +rest[0]
        seq = rest[1]
        tagfields = rest.slice(2)
      } else {
        gfa1 = true
        seq = rest[0]
        len = seq.length
        tagfields = rest.slice(1)
      }
      const tags = {} as Record<string, string | number>
      for (let i = 0; i < tagfields.length; i++) {
        parseTag(tagfields[i], tags)
      }
      if (gfa1 && tags.LN) {
        len = +tags.LN
      }
      graph.nodes.push({ id: name, length: len, sequence: seq, tags })
    } else if (line.startsWith('E')) {
      // GFA2 edge lines store orientation directly in the endpoint strings.
      // eslint-disable-next-line unicorn/no-unreadable-array-destructuring
      const [, , source, target, , , , , cigar, ...rest] = line.split('\t')
      const source1 = source.slice(0, -1)
      const target1 = target.slice(0, -1)
      const strand1 = source.at(-1)
      const strand2 = target.at(-1)
      const tags = {} as Record<string, string | number>
      for (const element of rest) {
        parseTag(element, tags)
      }

      graph.links.push({
        source: source1,
        target: target1,
        strand1,
        strand2,
        cigar,
        tags,
      })
    } else if (line.startsWith('L')) {
      // GFA1 link lines keep source/target names and orientations separate.
      const [, source, strand1, target, strand2, cigar, ...rest] =
        line.split('\t')
      const tags = {} as Record<string, string | number>
      for (const element of rest) {
        parseTag(element, tags)
      }
      graph.links.push({ source, target, strand1, strand2, cigar, tags })
    } else if (line.startsWith('P')) {
      // Paths are kept as raw ordered node strings here and converted later
      // into the app's oriented node ids.
      const [, name, path, ...rest] = line.split('\t')

      graph.paths.push({ name, path, rest, recordType: 'P' })
    } else if (line.startsWith('W')) {
      const [
        ,
        sampleName,
        haplotypeIndex,
        sequenceName,
        sequenceStart,
        sequenceEnd,
        walk,
        ...rest
      ] = line.split('\t')

      // Use sample/haplotype/sequence for stable selection identity while
      // preserving every W metadata field separately for richer display.
      const baseName = [sampleName, haplotypeIndex, sequenceName]
        .filter(Boolean)
        .join('#')
      const priorOccurrences = walkNameCounts.get(baseName) ?? 0
      walkNameCounts.set(baseName, priorOccurrences + 1)
      const name =
        priorOccurrences === 0 ? baseName : `${baseName} [${priorOccurrences + 1}]`
      const path = Array.from(
        walk.matchAll(/([<>])([^<>]+)/g),
        ([, orientation, nodeName]) =>
          `${nodeName}${orientation === '>' ? '+' : '-'}`,
      ).join(',')

      graph.paths.push({
        name,
        path,
        rest,
        recordType: 'W',
        walk: {
          sampleName,
          haplotypeIndex,
          sequenceName,
          sequenceStart,
          sequenceEnd,
          tags: rest,
        },
      })
    }
  }
  return graph
}
