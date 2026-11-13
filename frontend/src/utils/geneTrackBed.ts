// Parses a (strict, standard) BED file for the gene track drawn above the
// linear-layout ruler. Deliberately separate from bedAnnotations.ts, which
// parses a much more permissive "pick your own id/chrom/start/end columns"
// annotation format for an unrelated feature (coordinate-region lookup, not
// canvas rendering) - see the spec's note that the two must not be conflated.
export interface GeneRecord {
  chrom: string
  start: number // 0-based, inclusive (BED convention)
  end: number // 0-based, exclusive (BED convention)
  name: string
  score: string
  strand: '+' | '-' | null
  lineNumber: number
  // BED12 columns 7-12, when present: the coding span and the exons, in
  // absolute coordinates. Rows with fewer columns are drawn as a plain box.
  thickStart?: number
  thickEnd?: number
  exons?: { start: number; end: number }[]
  // Anything after column 12 (the built-in genes keep the RefSeq and Ensembl
  // transcript IDs there), shown in the tooltip.
  extraColumns?: string[]
}

function parseStrand(value: string | undefined): '+' | '-' | null {
  if (value === '+' || value === '-') return value
  return null
}

// Malformed block columns are ignored rather than rejected, so the row still
// draws as a box.
function parseExons(
  fields: string[],
  start: number,
): { start: number; end: number }[] | undefined {
  const blockCount = Number(fields[9])
  if (!Number.isInteger(blockCount) || blockCount < 1) return undefined
  const sizes = fields[10]!.split(',').filter(Boolean).map(Number)
  const offsets = fields[11]!.split(',').filter(Boolean).map(Number)
  if (sizes.length !== blockCount || offsets.length !== blockCount) {
    return undefined
  }

  const exons: { start: number; end: number }[] = []
  for (let i = 0; i < blockCount; i++) {
    const size = sizes[i]!
    const offset = offsets[i]!
    if (!Number.isFinite(size) || !Number.isFinite(offset)) return undefined
    exons.push({ start: start + offset, end: start + offset + size })
  }
  return exons
}

export function parseGeneTrackBed(text: string): GeneRecord[] {
  const rawLines = text.split(/\r?\n/)
  const genes: GeneRecord[] = []

  rawLines.forEach((rawLine, index) => {
    const lineNumber = index + 1
    const line = rawLine.trim()
    if (!line) return
    const lower = line.toLowerCase()
    if (lower.startsWith('track ') || lower.startsWith('browser ')) return
    if (line.startsWith('#')) return

    const fields = rawLine.split('\t')
    if (fields.length < 3) {
      throw new Error(
        `Line ${lineNumber}: a BED row needs at least chrom, start, and end (tab-separated).`,
      )
    }

    const chrom = fields[0]!.trim()
    const start = Number(fields[1])
    const end = Number(fields[2])
    if (!chrom || !Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(
        `Line ${lineNumber}: chrom/start/end could not be parsed.`,
      )
    }

    const gene: GeneRecord = {
      chrom,
      start,
      end,
      name: fields[3]?.trim() || `line-${lineNumber}`,
      score: fields[4]?.trim() ?? '0',
      strand: parseStrand(fields[5]?.trim()),
      lineNumber,
    }
    if (fields.length >= 12) {
      const thickStart = Number(fields[6])
      const thickEnd = Number(fields[7])
      if (Number.isFinite(thickStart) && Number.isFinite(thickEnd)) {
        gene.thickStart = thickStart
        gene.thickEnd = thickEnd
      }
      gene.exons = parseExons(fields, start)
      if (fields.length > 12) {
        gene.extraColumns = fields.slice(12).map(field => field.trim())
      }
    }
    genes.push(gene)
  })

  if (genes.length === 0) {
    throw new Error('BED file has no data rows.')
  }

  return genes
}

// The ruler's sequenceName comes from path.walk.sequenceName (e.g. "chr1"),
// but a BED's chrom column may carry a PanSN prefix (e.g. "CHM13#0#chr1") if
// it was generated against a haplotype-qualified reference name. Comparing
// on just the part after the last '#' lets both spellings match the same
// reference without guessing at a specific naming convention.
export function stripPanSNPrefix(sequenceName: string): string {
  const lastHashIndex = sequenceName.lastIndexOf('#')
  return lastHashIndex === -1
    ? sequenceName
    : sequenceName.slice(lastHashIndex + 1)
}
