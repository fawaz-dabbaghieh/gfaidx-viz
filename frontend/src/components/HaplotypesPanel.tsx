import { useMemo, useState } from 'react'
import type { Graph } from '../types'
import { haplotypesToFasta } from '../utils/fasta'
import {
  type Haplotype,
  compareToReference,
  getWalkIndex,
  haplotypeOnReference,
  haplotypesToTsv,
  noHaplotypesMessage,
  referenceCovered,
  resolveReferencePath,
} from '../utils/walkIndex'
import { HelpIcon } from './HelpIcon'
import { SearchSelect } from './SearchSelect'
import { useRowBatches } from './useRowBatches'

type SortKey =
  | 'name'
  | 'sequence'
  | 'shared'
  | 'offReference'
  | 'haplotypeOnReference'
  | 'referenceCovered'

interface HaplotypeRow {
  haplotype: Haplotype
  isReference: boolean
  // Null when there is no reference to compare with.
  sharedBp: number | null
  offReferenceBp: number | null
  haplotypeOnReference: number | null
  referenceCovered: number | null
}

const SORT_VALUES: Record<
  Exclude<SortKey, 'name'>,
  (row: HaplotypeRow) => number
> = {
  sequence: row => row.haplotype.seqLen,
  shared: row => row.sharedBp ?? 0,
  offReference: row => row.offReferenceBp ?? 0,
  haplotypeOnReference: row => row.haplotypeOnReference ?? 0,
  referenceCovered: row => row.referenceCovered ?? 0,
}

const COLUMNS: {
  key: SortKey | null
  label: string
  numeric?: boolean
  title?: string
}[] = [
  { key: 'name', label: 'Haplotype' },
  {
    key: null,
    label: 'Walks',
    numeric: true,
    title: 'More than one when the query split the haplotype',
  },
  {
    key: 'sequence',
    label: 'Sequence (bp)',
    numeric: true,
    title: 'Sequence the haplotype carries here: the sum of its node lengths',
  },
  {
    key: 'shared',
    label: 'On reference (bp)',
    numeric: true,
    title: "The haplotype's sequence on nodes the reference also passes",
  },
  {
    key: 'offReference',
    label: 'Off reference (bp)',
    numeric: true,
    title: "The haplotype's sequence on nodes the reference doesn't pass",
  },
  {
    key: 'haplotypeOnReference',
    label: 'Haplotype on reference',
    numeric: true,
    title:
      "Share of the haplotype's sequence on nodes the reference also " +
      'passes: On reference / Sequence',
  },
  {
    key: 'referenceCovered',
    label: 'Reference covered',
    numeric: true,
    title:
      "Share of the reference's sequence on nodes the haplotype also " +
      'passes, each node counted once',
  },
]

const pathLabel = (pathName: string) => pathName

const formatPercent = (fraction: number | null) =>
  fraction === null ? '–' : `${(fraction * 100).toFixed(1)}%`

interface HaplotypesPanelProps {
  graph: Graph | null
  // The walk index is only built once the tab is opened.
  isActive: boolean
  // The reference picked here, if any; otherwise preferredReferencePath (the
  // queried path) or a CHM13 / GRCh38 walk is used.
  referencePath: string | null
  preferredReferencePath: string
  onReferencePathChange: (pathName: string) => void
  onDownload: (content: string | string[], filename: string) => void
}

export function HaplotypesPanel({
  graph,
  isActive,
  referencePath,
  preferredReferencePath,
  onReferencePathChange,
  onDownload,
}: HaplotypesPanelProps) {
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: 'referenceCovered',
    descending: true,
  })
  // Walks left out of the last FASTA download for lack of sequence.
  const [fastaSkipped, setFastaSkipped] = useState(0)

  const walkIndex = useMemo(
    () => (isActive && graph ? getWalkIndex(graph) : null),
    [graph, isActive],
  )
  const walkNames = useMemo(
    () =>
      walkIndex?.haplotypes.flatMap(haplotype =>
        haplotype.walks.map(walk => walk.pathName),
      ) ?? [],
    [walkIndex],
  )
  const reference = walkIndex
    ? resolveReferencePath(walkIndex, referencePath, preferredReferencePath)
    : null
  const comparison =
    walkIndex && reference ? compareToReference(walkIndex, reference) : null

  const rows = useMemo(() => {
    if (!walkIndex) return []
    const allRows: HaplotypeRow[] = walkIndex.haplotypes.map((haplotype, i) => ({
      haplotype,
      isReference: comparison?.haplotypeKey === haplotype.key,
      sharedBp: comparison ? comparison.sharedBp[i]! : null,
      offReferenceBp: comparison ? comparison.offRefBp[i]! : null,
      haplotypeOnReference: comparison
        ? haplotypeOnReference(comparison, i, haplotype.seqLen)
        : null,
      referenceCovered: comparison ? referenceCovered(comparison, i) : null,
    }))
    const byName = (a: HaplotypeRow, b: HaplotypeRow) =>
      a.haplotype.key.localeCompare(b.haplotype.key, undefined, {
        numeric: true,
      })
    const direction = sort.descending ? -1 : 1
    // The reference stays on top whatever the sort.
    return allRows.sort(
      (a, b) =>
        Number(b.isReference) - Number(a.isReference) ||
        (sort.key === 'name'
          ? direction * byName(a, b)
          : direction *
              (SORT_VALUES[sort.key](a) - SORT_VALUES[sort.key](b)) ||
            byName(a, b)),
    )
  }, [comparison, sort, walkIndex])
  const { shownRows, hasMoreRows, listRef, moreRowRef } = useRowBatches(rows)

  if (!graph || !walkIndex) {
    return (
      <div className="settings-tab-content">
        <div className="control-hint">
          Load a graph to compare its haplotypes.
        </div>
      </div>
    )
  }
  const unavailable = noHaplotypesMessage(graph, walkIndex)
  if (unavailable) {
    return (
      <div className="settings-tab-content">
        <div className="control-hint">{unavailable}</div>
      </div>
    )
  }

  const splitCount = walkIndex.haplotypes.filter(h => h.clipped).length
  const baseName = graph.name.replace(/\.gfa[12]?(\.gz)?$/i, '')
  const sortBy = (key: SortKey) =>
    setSort(current =>
      current.key === key
        ? { key, descending: !current.descending }
        : { key, descending: key !== 'name' },
    )

  return (
    <div className="settings-tab-content haplotypes-panel">
      <div className="table-toolbar">
        <span>
          {walkIndex.haplotypes.length.toLocaleString()} haplotypes in{' '}
          {walkNames.length.toLocaleString()} walks
        </span>
        <label htmlFor="haplotype-reference-select">
          Reference
          <HelpIcon
            text={
              'The walk the haplotypes are compared with. By default the ' +
              'queried path, otherwise a CHM13 or GRCh38 walk.'
            }
          />
        </label>
        <div className="haplotypes-panel-reference">
          <SearchSelect
            id="haplotype-reference-select"
            items={walkNames}
            selectedIndex={reference ? walkNames.indexOf(reference) : -1}
            getLabel={pathLabel}
            onSelect={index => onReferencePathChange(walkNames[index]!)}
            placeholder="Choose a reference walk..."
          />
        </div>
        <button
          type="button"
          className="table-download-button"
          onClick={() =>
            onDownload(
              haplotypesToTsv(walkIndex, comparison, graph.name),
              `${baseName}.haplotypes.tsv`,
            )
          }
        >
          Download TSV
        </button>
        <button
          type="button"
          className="table-download-button"
          title="Every haplotype's sequence in this graph, one record per walk"
          onClick={() => {
            const fasta = haplotypesToFasta(graph, walkIndex)
            setFastaSkipped(fasta.skipped)
            if (fasta.records > 0) {
              onDownload(fasta.chunks, `${baseName}.haplotypes.fa`)
            }
          }}
        >
          Download FASTA
        </button>
      </div>
      {fastaSkipped > 0 && (
        <div className="control-warning">
          {fastaSkipped.toLocaleString()}{' '}
          {fastaSkipped === 1 ? 'walk was' : 'walks were'} left out of the
          FASTA: {fastaSkipped === 1 ? 'it runs' : 'they run'} through nodes
          with no sequence in this GFA ('*').
        </div>
      )}
      {splitCount > 0 && (
        <div className="control-warning">
          {splitCount.toLocaleString()}{' '}
          {splitCount === 1 ? 'haplotype is' : 'haplotypes are'} split into
          several walks, most likely by the query's Haplotype Gap, so the
          sequence between {splitCount === 1 ? 'its' : 'their'} walks is
          missing here. Query again with a larger Haplotype Gap to keep{' '}
          {splitCount === 1 ? 'it' : 'them'} whole.
        </div>
      )}
      {walkIndex.coordinateMismatches.length > 0 && (
        <div className="control-warning">
          {walkIndex.coordinateMismatches.length.toLocaleString()} walks don't
          add up to the length their coordinates give, so this GFA may not
          have been read correctly.
        </div>
      )}
      <div className="control-hint">
        Sequence counts as shared when it is on nodes the reference also
        passes. Sharing nodes is not sequence identity: a haplotype on other
        nodes can still be nearly identical there.
      </div>
      <div className="sortable-table" ref={listRef}>
        <table>
          <thead>
            <tr>
              {COLUMNS.map(column => (
                <th
                  key={column.label}
                  className={column.numeric ? 'numeric' : undefined}
                  title={column.title}
                  aria-sort={
                    column.key === sort.key
                      ? sort.descending
                        ? 'descending'
                        : 'ascending'
                      : undefined
                  }
                >
                  {column.key ? (
                    <button type="button" onClick={() => sortBy(column.key!)}>
                      {column.label}
                      {column.key === sort.key &&
                        (sort.descending ? ' ▼' : ' ▲')}
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shownRows.map(row => (
              <tr
                key={row.haplotype.key}
                className={row.isReference ? 'reference' : undefined}
              >
                <td>
                  {row.haplotype.key}
                  {row.isReference && ' (reference)'}
                </td>
                <td
                  className={`numeric${row.haplotype.clipped ? ' haplotypes-panel-split' : ''}`}
                >
                  {row.haplotype.walks.length}
                </td>
                <td className="numeric">
                  {row.haplotype.seqLen.toLocaleString()}
                </td>
                <td className="numeric">{row.sharedBp?.toLocaleString() ?? '–'}</td>
                <td className="numeric">
                  {row.offReferenceBp?.toLocaleString() ?? '–'}
                </td>
                <td className="numeric">
                  {formatPercent(row.haplotypeOnReference)}
                </td>
                <td className="numeric">
                  {formatPercent(row.referenceCovered)}
                </td>
              </tr>
            ))}
            {hasMoreRows && (
              <tr ref={moreRowRef}>
                <td colSpan={COLUMNS.length} className="sortable-table-more">
                  Loading more haplotypes...
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
