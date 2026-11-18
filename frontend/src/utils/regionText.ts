import type { RegionPath } from '../types'

// The region field takes one "name:start-end" string, e.g.
// "chr1:103642902-103751695" for a W-line track (its sequence name) or
// "CHM13#0#chr1:103642902-103751695" for a P-line track (its path name).
// A W-line track also answers to its PanSN name ("CHM13#0#chr1").

export interface ParsedRegion {
  // null when the graph has no coordinate tracks and the name is sent as is.
  trackIndex: number | null
  sequence: string
  start: number
  end: number
}

export const REGION_EXAMPLE = 'chr1:103642902-103751695'

export function formatRegion(
  sequence: string,
  start: number | string,
  end: number | string,
): string {
  if (start === '' || end === '') return ''
  return `${sequence}:${start}-${end}`
}

function trackNames(track: RegionPath): string[] {
  if (!track.reference) return [track.sequence]
  return [
    track.sequence,
    `${track.reference}#${track.haplotype}#${track.sequence}`,
    `${track.reference}#${track.sequence}`,
  ]
}

function trackContains(track: RegionPath, start: number, end: number): boolean {
  return start >= track.start && (track.end === null || end <= track.end)
}

// Coordinates are whole bp, so "," "." and "_" are thousands separators.
const RANGE = /^\s*([\d,._]+)\s*-\s*([\d,._]+)\s*$/

export function parseRegion(
  text: string,
  tracks: RegionPath[],
  selectedIndex: number,
): ParsedRegion | { error: string } {
  const value = text.trim()
  if (!value) return { error: `Enter a region, e.g. ${REGION_EXAMPLE}` }

  const colon = value.lastIndexOf(':')
  const name = colon >= 0 ? value.slice(0, colon).trim() : ''
  const range = RANGE.exec(colon >= 0 ? value.slice(colon + 1) : value)
  if (!range) return { error: `Use name:start-end, e.g. ${REGION_EXAMPLE}` }
  const start = Number(range[1]!.replace(/[,._]/g, ''))
  const end = Number(range[2]!.replace(/[,._]/g, ''))
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    return { error: `Use name:start-end, e.g. ${REGION_EXAMPLE}` }
  }
  if (end <= start) return { error: 'The end must be greater than the start.' }

  if (tracks.length === 0) {
    if (!name) return { error: `Add the sequence name, e.g. ${REGION_EXAMPLE}` }
    return { trackIndex: null, sequence: name, start, end }
  }

  // No name keeps the selected track.
  let candidates: number[]
  if (!name) {
    candidates = tracks[selectedIndex] ? [selectedIndex] : []
  } else {
    candidates = []
    tracks.forEach((track, index) => {
      if (trackNames(track).includes(name)) candidates.push(index)
    })
    if (candidates.length === 0) {
      const lowerName = name.toLowerCase()
      tracks.forEach((track, index) => {
        if (trackNames(track).some(n => n.toLowerCase() === lowerName)) {
          candidates.push(index)
        }
      })
    }
  }
  if (candidates.length === 0) {
    return { error: `No coordinate track is named "${name}".` }
  }

  const containing = candidates.filter(index =>
    trackContains(tracks[index]!, start, end),
  )
  if (containing.length === 0) {
    const track = tracks[candidates[0]!]!
    const span =
      candidates.length === 1
        ? ` (${track.start}-${track.end ?? '?'})`
        : ''
    return { error: `The region is outside ${track.sequence}${span}.` }
  }
  // An ambiguous name (e.g. "chr1" on both CHM13 and GRCh38) keeps the
  // selected track if it fits.
  const trackIndex = containing.includes(selectedIndex)
    ? selectedIndex
    : containing[0]!
  return { trackIndex, sequence: tracks[trackIndex]!.sequence, start, end }
}
