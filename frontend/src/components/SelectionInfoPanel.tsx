import { useRef } from 'react'
import type { GraphNode } from '../types'
import { BUBBLE_TYPE_LABELS, type Bubble, bubbleId } from '../utils/bubbleGun'
import type { EdgePathGroup } from '../utils/displayGraph'
import type { GeneDescription, GeneStructurePart } from '../utils/geneNodes'
import type { GeneRecord } from '../utils/geneTrackBed'

export type SelectionInfo =
  | {
      kind: 'node'
      node: GraphNode
      sequencePreview: string | null
      csvMetadata?: Record<string, string>
      paths: { name: string; count: number }[]
      // How many of the graph's haplotypes pass the node, and how often;
      // null when the graph has no paths.
      haplotypes: { count: number; total: number; visits: number } | null
      // Where the node sits in each gene it is in, and in their exons and
      // introns (only reference nodes are annotated).
      genes: GeneDescription[]
      // Null until bubble detection has finished on this graph.
      bubbles: { nesting: Bubble[]; endOf: Bubble[] } | null
    }
  | {
      kind: 'edge'
      fromName: string
      toName: string
      groups: EdgePathGroup[]
      totalPathCount: number
      visiblePathCount: number
    }
  | {
      kind: 'gene'
      gene: GeneRecord
      source: string | null
      referencePathName: string
      // Bare names of the reference path's nodes the gene overlaps, in path
      // order.
      referenceNodeNames: string[]
      // When the graph holds only part of the gene, which part.
      inGraph: string | null
      // Its exons and introns, 5′ first, and which are outlined in the graph
      // ('gene' for all of it).
      parts: (GeneStructurePart & { inGraph: boolean })[]
      selectedParts: ReadonlySet<string>
    }

// Exported so App can size the canvas to the space the panel leaves. The gap
// between canvas and panel doubles as the drag handle for resizing it.
export const SELECTION_INFO_PANEL_DEFAULT_WIDTH = 280
export const SELECTION_INFO_PANEL_MIN_WIDTH = 200
export const SELECTION_INFO_PANEL_GAP = 12

interface SelectionInfoPanelProps {
  selection: SelectionInfo | null
  width: number
  maxWidth: number
  onWidthChange?: (width: number) => void
  height: number
  getPathColor: (pathName: string) => string
  isPathVisible: (pathName: string) => boolean
  onUseAsStartNode?: (nodeName: string) => void
  highlightedBubble?: number | null
  onHighlightBubble?: (bubbleIndex: number | null) => void
  // Opens a gene from a node's gene line.
  onSelectGene?: (gene: GeneRecord) => void
  onGenePartsChange?: (parts: ReadonlySet<string>) => void
  // Undefined when nothing of the gene is outlined.
  onZoomToGenePick?: () => void
}

// One row per path; the "(N×)" suffix only appears for paths that cross the
// edge / visit the node more than once, e.g. through a collapsed repeat.
function PathRow({
  name,
  count,
  color,
  visible,
}: {
  name: string
  count: number
  color: string
  visible: boolean
}) {
  return (
    <div className={`selection-path-row${visible ? '' : ' dimmed'}`}>
      <span className="selection-path-swatch" style={{ background: color }} />
      <span className="selection-path-name" title={name}>
        {name}
      </span>
      {count > 1 && <span className="selection-path-count">({count}×)</span>}
    </div>
  )
}

export function SelectionInfoPanel({
  selection,
  width,
  maxWidth,
  onWidthChange,
  height,
  getPathColor,
  isPathVisible,
  onUseAsStartNode,
  highlightedBubble = null,
  onHighlightBubble,
  onSelectGene,
  onGenePartsChange,
  onZoomToGenePick,
}: SelectionInfoPanelProps) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  // The panel sits right of the canvas, so dragging the handle left widens it.
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || !onWidthChange) return
    const nextWidth = drag.startWidth + drag.startX - event.clientX
    onWidthChange(
      Math.round(
        Math.min(maxWidth, Math.max(SELECTION_INFO_PANEL_MIN_WIDTH, nextWidth)),
      ),
    )
  }

  const endDrag = () => {
    dragRef.current = null
  }

  return (
    <>
      <div
        className="selection-info-resizer"
        style={{ width: SELECTION_INFO_PANEL_GAP, height }}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize info panel"
        title="Drag to resize, double-click to reset"
        onPointerDown={event => {
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          dragRef.current = { startX: event.clientX, startWidth: width }
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() =>
          onWidthChange?.(
            Math.min(maxWidth, SELECTION_INFO_PANEL_DEFAULT_WIDTH),
          )
        }
      />
      <aside className="selection-info-panel" style={{ width, height }}>
        {!selection && (
          <div className="selection-info-empty">
            Click a node, connection, or gene to see its details here.
          </div>
        )}

        {selection?.kind === 'node' && (
          <>
            <h4 title={selection.node.name}>{selection.node.name}</h4>
            <dl className="selection-info-fields">
              <dt>Length</dt>
              <dd>{selection.node.length.toLocaleString()} bp</dd>
              <dt>Depth</dt>
              <dd>{selection.node.depth.toFixed(2)}×</dd>
              {selection.haplotypes && (
                <>
                  <dt>Haplotypes</dt>
                  <dd>
                    {selection.haplotypes.count.toLocaleString()} of{' '}
                    {selection.haplotypes.total.toLocaleString()}
                    {selection.haplotypes.visits > selection.haplotypes.count &&
                      ` (${selection.haplotypes.visits.toLocaleString()} passes)`}
                  </dd>
                </>
              )}
              {selection.genes.length > 0 && (
                <>
                  <dt>{selection.genes.length === 1 ? 'Gene' : 'Genes'}</dt>
                  <dd>
                    {selection.genes.map(gene => (
                      <div key={gene.heading}>
                        <div>
                          {onSelectGene ? (
                            <button
                              type="button"
                              className="selection-gene-link"
                              title={`Show ${gene.gene.name}: its exons and introns, to highlight`}
                              onClick={() => onSelectGene(gene.gene)}
                            >
                              {gene.heading}
                            </button>
                          ) : (
                            gene.heading
                          )}
                        </div>
                        {gene.parts.map(part => (
                          <div key={part} className="selection-gene-part">
                            {part}
                          </div>
                        ))}
                        {gene.note && (
                          <div className="selection-gene-part selection-info-subtitle">
                            {gene.note}
                          </div>
                        )}
                      </div>
                    ))}
                  </dd>
                </>
              )}
              <dt>Sequence</dt>
              <dd className="selection-info-mono">
                {selection.sequencePreview ?? 'Not available'}
              </dd>
              {Object.entries(selection.node.tags ?? {}).map(([tag, value]) => (
                <SelectionField key={`tag:${tag}`} label={tag} value={value} />
              ))}
              {Object.entries(selection.csvMetadata ?? {}).map(
                ([column, value]) => (
                  <SelectionField
                    key={`csv:${column}`}
                    label={column}
                    value={value}
                  />
                ),
              )}
            </dl>
            {onUseAsStartNode && (
              <button
                type="button"
                className="selection-info-action"
                onClick={() => onUseAsStartNode(selection.node.name)}
              >
                Use as Start Node
              </button>
            )}
            {selection.bubbles && (
              <BubbleDetails
                {...selection.bubbles}
                highlightedBubble={highlightedBubble}
                onHighlightBubble={onHighlightBubble}
              />
            )}
            {selection.paths.length > 0 && (
              <div className="selection-info-section">
                <h5>Paths ({selection.paths.length})</h5>
                {selection.paths.map(path => (
                  <PathRow
                    key={path.name}
                    name={path.name}
                    count={path.count}
                    color={getPathColor(path.name)}
                    visible={isPathVisible(path.name)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {selection?.kind === 'gene' && (
          <GeneDetails
            selection={selection}
            onPartsChange={onGenePartsChange}
            onZoom={onZoomToGenePick}
          />
        )}

        {selection?.kind === 'edge' && (
          <>
            <h4>Connection</h4>
            <div className="selection-info-subtitle">
              {selection.fromName} — {selection.toName}
            </div>
            {selection.totalPathCount > 0 && (
              <div className="selection-info-section">
                <h5>
                  Paths ({selection.visiblePathCount} visible /{' '}
                  {selection.totalPathCount} total)
                </h5>
                {selection.groups.map(group => (
                  <div
                    key={`${group.from}->${group.to}`}
                    className="selection-info-direction"
                  >
                    <div className="selection-info-direction-title">
                      {group.from} → {group.to}
                    </div>
                    {group.paths.map(path => (
                      <PathRow
                        key={path.name}
                        name={path.name}
                        count={path.count}
                        color={getPathColor(path.name)}
                        visible={isPathVisible(path.name)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </aside>
    </>
  )
}

// One row per bubble; clicking it highlights (or un-highlights) the bubble's
// nodes in the graph.
function BubbleRow({
  bubble,
  highlighted,
  onHighlightBubble,
}: {
  bubble: Bubble
  highlighted: boolean
  onHighlightBubble?: (bubbleIndex: number | null) => void
}) {
  return (
    <button
      type="button"
      className={`selection-bubble-row${highlighted ? ' highlighted' : ''}`}
      aria-pressed={highlighted}
      onClick={() => onHighlightBubble?.(highlighted ? null : bubble.index)}
      title={highlighted ? 'Remove the highlight' : 'Highlight this bubble in the graph'}
    >
      <span className="selection-bubble-type">
        {BUBBLE_TYPE_LABELS[bubble.type]} #{bubbleId(bubble)}
      </span>
      <span className="selection-bubble-ends">
        {bubble.source} – {bubble.sink}
      </span>
      <span className="selection-bubble-size">
        {bubble.inside.length.toLocaleString()} node
        {bubble.inside.length === 1 ? '' : 's'} inside,{' '}
        {bubble.insideBp.toLocaleString()} bp
      </span>
    </button>
  )
}

function BubbleDetails({
  nesting,
  endOf,
  highlightedBubble,
  onHighlightBubble,
}: {
  nesting: Bubble[]
  endOf: Bubble[]
  highlightedBubble: number | null
  onHighlightBubble?: (bubbleIndex: number | null) => void
}) {
  const row = (bubble: Bubble) => (
    <BubbleRow
      key={bubble.index}
      bubble={bubble}
      highlighted={bubble.index === highlightedBubble}
      onHighlightBubble={onHighlightBubble}
    />
  )
  return (
    <div className="selection-info-section">
      <h5>Bubbles</h5>
      {nesting.length === 0 && endOf.length === 0 && (
        <div className="selection-info-subtitle">Not in any bubble</div>
      )}
      {nesting.length > 0 && (
        <>
          <div className="selection-info-subtitle">
            Inside {nesting.length}, innermost first
          </div>
          {nesting.map(row)}
        </>
      )}
      {endOf.length > 0 && (
        <>
          <div className="selection-info-subtitle">End of {endOf.length}</div>
          {endOf.map(row)}
        </>
      )}
    </div>
  )
}

function SelectionField({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}

// Links the transcript IDs the built-in genes carry (RefSeq, then Ensembl,
// after the BED12 columns); other extra BED columns are shown as they are.
function transcriptLink(value: string): { label: string; href: string } | null {
  const id = value.split(' ')[0]!
  if (/^[NX][MR]_\d+/.test(id)) {
    return { label: 'RefSeq', href: `https://www.ncbi.nlm.nih.gov/nuccore/${id}` }
  }
  if (/^ENST\d+/.test(id)) {
    return {
      label: 'Ensembl',
      href: `https://www.ensembl.org/Homo_sapiens/Transcript/Summary?t=${id.split('.')[0]}`,
    }
  }
  return null
}

// Coding bases: exon bases inside the thickStart-thickEnd span.
function codingLength(gene: GeneRecord): number | null {
  const { exons, thickStart, thickEnd } = gene
  if (!exons || thickStart === undefined || thickEnd === undefined) return null
  return exons.reduce(
    (sum, exon) =>
      sum +
      Math.max(0, Math.min(exon.end, thickEnd) - Math.max(exon.start, thickStart)),
    0,
  )
}

function GeneDetails({
  selection,
  onPartsChange,
  onZoom,
}: {
  selection: Extract<SelectionInfo, { kind: 'gene' }>
  onPartsChange?: (parts: ReadonlySet<string>) => void
  onZoom?: () => void
}) {
  const {
    gene,
    source,
    referencePathName,
    referenceNodeNames,
    inGraph,
    parts,
    selectedParts,
  } = selection
  const coding = codingLength(gene)
  const firstNode = referenceNodeNames[0]
  const lastNode = referenceNodeNames[referenceNodeNames.length - 1]

  return (
    <>
      <h4 title={gene.name}>{gene.name}</h4>
      {source && <div className="selection-info-subtitle">{source}</div>}
      <dl className="selection-info-fields">
        <dt>Location</dt>
        <dd>
          {gene.chrom}:{gene.start.toLocaleString()}-{gene.end.toLocaleString()}
        </dd>
        <dt>Length</dt>
        <dd>{(gene.end - gene.start).toLocaleString()} bp</dd>
        {gene.strand && (
          <>
            <dt>Strand</dt>
            <dd>{gene.strand}</dd>
          </>
        )}
        {gene.exons && (
          <>
            <dt>Exons</dt>
            <dd>{gene.exons.length}</dd>
          </>
        )}
        {coding !== null && coding > 0 && (
          <>
            <dt>Coding</dt>
            <dd>{coding.toLocaleString()} bp</dd>
          </>
        )}
        {(gene.extraColumns ?? []).map((value, index) => {
          const link = transcriptLink(value)
          return link ? (
            <SelectionField
              key={`extra:${index}`}
              label={link.label}
              value={
                <a href={link.href} target="_blank" rel="noreferrer">
                  {value}
                </a>
              }
            />
          ) : (
            <SelectionField
              key={`extra:${index}`}
              label={`Column ${13 + index}`}
              value={value}
            />
          )
        })}
      </dl>
      {referencePathName && (
        <div className="selection-info-section">
          <h5>Reference nodes ({referenceNodeNames.length.toLocaleString()})</h5>
          <div className="selection-info-subtitle" title={referencePathName}>
            {referenceNodeNames.length === 0
              ? `None of ${referencePathName} is drawn here.`
              : referenceNodeNames.length === 1
                ? `Node ${firstNode} on ${referencePathName}`
                : `Nodes ${firstNode} to ${lastNode} on ${referencePathName}`}
          </div>
          {inGraph && <div className="control-warning">{inGraph}</div>}
        </div>
      )}
      {onPartsChange && referenceNodeNames.length > 0 && (
        <GenePartPicker
          parts={parts}
          selected={selectedParts}
          onChange={onPartsChange}
          onZoom={onZoom}
        />
      )}
    </>
  )
}

// Ticks for the whole gene or any of its exons and introns; the ticked ones
// are outlined in the graph over exactly their bases.
function GenePartPicker({
  parts,
  selected,
  onChange,
  onZoom,
}: {
  parts: (GeneStructurePart & { inGraph: boolean })[]
  selected: ReadonlySet<string>
  onChange: (parts: ReadonlySet<string>) => void
  onZoom?: () => void
}) {
  // The whole gene and single parts are alternatives.
  const toggle = (key: string) => {
    if (key === 'gene') {
      onChange(new Set(selected.has('gene') ? [] : ['gene']))
      return
    }
    const next = new Set(selected)
    next.delete('gene')
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(next)
  }
  const pickAll = (kind: GeneStructurePart['kind']) =>
    onChange(
      new Set(
        parts.filter(part => part.kind === kind && part.inGraph).map(part => part.key),
      ),
    )

  return (
    <div className="selection-info-section">
      <h5>Highlight in the graph</h5>
      <label className="gene-part-row">
        <input
          type="checkbox"
          checked={selected.has('gene')}
          onChange={() => toggle('gene')}
        />
        Whole gene
      </label>
      {parts.length > 0 && (
        <>
          <div className="gene-part-actions">
            <button type="button" onClick={() => pickAll('exon')}>
              All exons
            </button>
            <button type="button" onClick={() => pickAll('intron')}>
              All introns
            </button>
            <button type="button" onClick={() => onChange(new Set())}>
              Clear
            </button>
          </div>
          <div className="gene-part-list">
            {parts.map(part => (
              <label
                key={part.key}
                className={`gene-part-row${part.inGraph ? '' : ' dimmed'}`}
                title={part.inGraph ? undefined : 'Outside this graph'}
              >
                <input
                  type="checkbox"
                  checked={selected.has(part.key)}
                  disabled={!part.inGraph}
                  onChange={() => toggle(part.key)}
                />
                <span className="gene-part-name">
                  {part.kind === 'exon' ? 'Exon' : 'Intron'} {part.number}
                </span>
                <span className="gene-part-length">
                  {(part.end - part.start).toLocaleString()} bp
                </span>
              </label>
            ))}
          </div>
        </>
      )}
      <button
        type="button"
        className="gene-part-zoom"
        onClick={onZoom}
        disabled={!onZoom}
      >
        Zoom to highlighted
      </button>
    </div>
  )
}
