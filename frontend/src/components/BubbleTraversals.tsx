import { useMemo, useState } from 'react'
import type { Graph } from '../types'
import {
  BUBBLE_HIGHLIGHT_COLORS,
  BUBBLE_TYPE_LABELS,
  type Bubble,
  bubbleId,
} from '../utils/bubbleGun'
import {
  type Traversal,
  findTraversals,
  traversalsToTsv,
} from '../utils/traversals'
import { getWalkIndex, resolveReferencePath } from '../utils/walkIndex'
import { TraversalLengthHistogram } from './TraversalLengthHistogram'
import { useRowBatches } from './useRowBatches'

// Past this many traversals, telling them apart one by one says little, so
// the length distribution is shown above the list.
const HISTOGRAM_MIN_TRAVERSALS = 10

type SortKey = 'haplotypes' | 'bp' | 'nodes'

const SORT_VALUES: Record<SortKey, (traversal: Traversal) => number> = {
  haplotypes: traversal => traversal.haplotypes.length,
  bp: traversal => traversal.bp,
  nodes: traversal => traversal.nodes.length,
}

const COLUMNS: {
  key: SortKey | null
  label: string
  numeric?: boolean
  title?: string
}[] = [
  { key: null, label: 'Traversal' },
  {
    key: 'haplotypes',
    label: 'Haplotypes',
    numeric: true,
    title: 'Haplotypes taking this route, and their share of those passing',
  },
  {
    key: 'bp',
    label: 'Length (bp)',
    numeric: true,
    title: 'Sequence between the two ends',
  },
  {
    key: 'nodes',
    label: 'Nodes',
    numeric: true,
    title: 'Nodes between the two ends',
  },
  {
    key: null,
    label: 'vs reference (bp)',
    numeric: true,
    title: "Length difference from the reference's traversal",
  },
]

const signed = (value: number) =>
  value > 0
    ? `+${value.toLocaleString()}`
    : value < 0
      ? `−${(-value).toLocaleString()}`
      : '0'

// A traversal picked to show its route: its id and the names of its nodes.
export interface PickedTraversal {
  id: number
  nodes: string[]
}

interface BubbleTraversalsProps {
  graph: Graph
  bubble: Bubble
  // As for the Haplotypes tab: the reference picked there, else the queried
  // path, else a CHM13 / GRCh38 walk.
  pickedReferencePath: string | null
  preferredReferencePath: string
  isDarkMode: boolean
  pickedTraversalId: number | null
  onPickTraversal: (traversal: PickedTraversal | null) => void
  onDownload: (text: string, filename: string) => void
}

export function BubbleTraversals({
  graph,
  bubble,
  pickedReferencePath,
  preferredReferencePath,
  isDarkMode,
  pickedTraversalId,
  onPickTraversal,
  onDownload,
}: BubbleTraversalsProps) {
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: 'haplotypes',
    descending: true,
  })

  const walkIndex = getWalkIndex(graph)
  const referencePath = resolveReferencePath(
    walkIndex,
    pickedReferencePath,
    preferredReferencePath,
  )
  const result = useMemo(
    () => findTraversals(graph, bubble, referencePath),
    [bubble, graph, referencePath],
  )
  const rows = useMemo(() => {
    if (!result) return []
    const value = SORT_VALUES[sort.key]
    const direction = sort.descending ? -1 : 1
    return [...result.traversals].sort(
      (a, b) => direction * (value(a) - value(b)) || a.id - b.id,
    )
  }, [result, sort])
  const { shownRows, hasMoreRows, listRef, moreRowRef } = useRowBatches(rows)

  if (walkIndex.haplotypes.length === 0) {
    return (
      <div className="bubble-traversals control-hint">
        This graph has no paths or walks, so no traversals through the bubble.
      </div>
    )
  }
  if (!result) return null

  const passing = result.passOnce + result.passMoreThanOnce
  const singletons = result.traversals.filter(
    t => t.haplotypes.length === 1,
  ).length
  const picked = result.traversals.find(t => t.id === pickedTraversalId) ?? null
  const pick = (traversal: Traversal) =>
    onPickTraversal(
      traversal.id === pickedTraversalId
        ? null
        : {
            id: traversal.id,
            nodes: Array.from(
              traversal.nodes,
              node => walkIndex.nodeNames[node]!,
            ),
          },
    )
  const sortBy = (key: SortKey) =>
    setSort(current =>
      current.key === key
        ? { key, descending: !current.descending }
        : { key, descending: true },
    )
  const baseName = graph.name.replace(/\.gfa[12]?(\.gz)?$/i, '')
  const passCounts = [
    `${result.passOnce.toLocaleString()} pass once`,
    result.passMoreThanOnce > 0 &&
      `${result.passMoreThanOnce.toLocaleString()} pass more than once`,
    result.cutInside > 0 &&
      `${result.cutInside.toLocaleString()} cut inside it (a walk starts or ends inside)`,
    result.dontPass > 0 && `${result.dontPass.toLocaleString()} don't pass it`,
  ].filter(Boolean)

  return (
    <div className="bubble-traversals">
      <div className="table-toolbar">
        <h4>
          Traversals through {BUBBLE_TYPE_LABELS[bubble.type].toLowerCase()} #
          {bubbleId(bubble)} ({bubble.source} – {bubble.sink})
        </h4>
        <button
          type="button"
          className="table-download-button"
          onClick={() =>
            onDownload(
              traversalsToTsv(
                walkIndex,
                bubble,
                result,
                graph.name,
                referencePath,
              ),
              `${baseName}.bubble${bubbleId(bubble)}.traversals.tsv`,
            )
          }
        >
          Download TSV
        </button>
      </div>
      <div className="control-hint">
        {result.traversals.length.toLocaleString()}{' '}
        {result.traversals.length === 1 ? 'traversal' : 'traversals'}
        {singletons > 0 &&
          result.traversals.length > 1 &&
          ` (${singletons.toLocaleString()} taken by one haplotype only)`}{' '}
        among {walkIndex.haplotypes.length.toLocaleString()} haplotypes:{' '}
        {passCounts.join(' · ')}.{' '}
        {referencePath
          ? result.referenceBp === null
            ? `The reference (${referencePath}) doesn't pass this bubble.`
            : `Reference: ${referencePath}, set in the Haplotypes tab.`
          : 'No reference walk, so no lengths are compared.'}
      </div>
      {result.cutInside > 0 && (
        <div className="control-warning">
          {result.cutInside.toLocaleString()}{' '}
          {result.cutInside === 1 ? 'haplotype has' : 'haplotypes have'} a walk
          that starts or ends inside this bubble, so{' '}
          {result.cutInside === 1 ? 'its traversal is' : 'their traversals are'}{' '}
          missing. Query a wider region or with a larger Haplotype Gap to
          include {result.cutInside === 1 ? 'it' : 'them'}.
        </div>
      )}
      {result.traversals.length >= HISTOGRAM_MIN_TRAVERSALS && (
        <TraversalLengthHistogram
          lengths={result.passLengths}
          referenceBp={result.referenceBp}
        />
      )}
      <div className="control-hint">
        A traversal is one route between the two ends: haplotypes through the
        same nodes in the same order share it. Different routes can still have
        nearly the same sequence. Click one to show its route{' '}
        <span
          className="bubbles-panel-swatch"
          style={{
            background:
              BUBBLE_HIGHLIGHT_COLORS.route[isDarkMode ? 'dark' : 'light'],
          }}
        />{' '}
        in the graph and list its haplotypes.
      </div>
      {result.traversals.length > 0 && (
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
              {shownRows.map(traversal => (
                <tr
                  key={traversal.id}
                  className={
                    [
                      traversal.id === pickedTraversalId && 'highlighted',
                      traversal.isReference && 'reference',
                    ]
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                  tabIndex={0}
                  onClick={() => pick(traversal)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') pick(traversal)
                  }}
                >
                  <td>
                    T{traversal.id}
                    {traversal.isReference && ' (reference)'}
                  </td>
                  <td className="numeric">
                    {traversal.haplotypes.length.toLocaleString()} (
                    {((traversal.haplotypes.length / passing) * 100).toFixed(1)}
                    %)
                  </td>
                  <td className="numeric">{traversal.bp.toLocaleString()}</td>
                  <td className="numeric">
                    {traversal.nodes.length.toLocaleString()}
                  </td>
                  <td className="numeric">
                    {result.referenceBp === null
                      ? '–'
                      : signed(traversal.bp - result.referenceBp)}
                  </td>
                </tr>
              ))}
              {hasMoreRows && (
                <tr ref={moreRowRef}>
                  <td colSpan={COLUMNS.length} className="sortable-table-more">
                    Loading more traversals...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {picked && (
        <div className="bubble-traversals-haplotypes">
          <strong>
            T{picked.id}: {picked.haplotypes.length.toLocaleString()}{' '}
            {picked.haplotypes.length === 1 ? 'haplotype' : 'haplotypes'}
            {picked.passes > picked.haplotypes.length &&
              `, ${picked.passes.toLocaleString()} passes`}
          </strong>{' '}
          {picked.haplotypes.map(h => walkIndex.haplotypes[h]!.key).join(', ')}
        </div>
      )}
    </div>
  )
}
