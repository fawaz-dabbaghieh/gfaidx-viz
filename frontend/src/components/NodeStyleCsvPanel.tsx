import { useRef, useState } from 'react'

interface NodeStyleCsvInfo {
  headers: string[]
  separator: '\t' | ','
  matchedNodes: number
  unmatchedRows: number[]
  categoryColours: Record<string, string>
}

interface NodeStyleCsvPanelProps {
  hasGraph: boolean
  // Both loaders throw on parse/match failure (see nodeStyleCsv.ts /
  // geneTrackBed.ts) rather than reporting errors themselves, so this panel
  // owns its own error state the same way BedAnnotationPanel does.
  onLoadCsv: (text: string) => void
  onClearCsv: () => void
  csvInfo: NodeStyleCsvInfo | null
  onLoadGeneTrackBed: (text: string, fileName: string) => void
  onClearGeneTrack: () => void
  geneTrackFileName: string | null
  geneTrackCount: number
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('Failed to read file as text'))
      }
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsText(file)
  })
}

export function NodeStyleCsvPanel({
  hasGraph,
  onLoadCsv,
  onClearCsv,
  csvInfo,
  onLoadGeneTrackBed,
  onClearGeneTrack,
  geneTrackFileName,
  geneTrackCount,
}: NodeStyleCsvPanelProps) {
  const csvFileInputRef = useRef<HTMLInputElement>(null)
  const bedFileInputRef = useRef<HTMLInputElement>(null)
  const [csvFileName, setCsvFileName] = useState<string | null>(null)
  const [csvError, setCsvError] = useState<string | null>(null)
  const [bedError, setBedError] = useState<string | null>(null)

  const handleCsvFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0]
    if (csvFileInputRef.current) csvFileInputRef.current.value = ''
    if (!file) return

    try {
      const text = await readFileAsText(file)
      onLoadCsv(text)
      setCsvFileName(file.name)
      setCsvError(null)
    } catch (error) {
      setCsvError(
        error instanceof Error ? error.message : 'Failed to load CSV file',
      )
    }
  }

  const handleBedFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0]
    if (bedFileInputRef.current) bedFileInputRef.current.value = ''
    if (!file) return

    try {
      const text = await readFileAsText(file)
      onLoadGeneTrackBed(text, file.name)
      setBedError(null)
    } catch (error) {
      setBedError(
        error instanceof Error ? error.message : 'Failed to load BED file',
      )
    }
  }

  const categoryEntries = csvInfo
    ? Object.entries(csvInfo.categoryColours)
    : []

  return (
    <div className="annotation-panel">
      {/* Feature A: per-node CSV/TSV colour + label styling. */}
      <div className="annotation-toolbar">
        <div>
          <h3>Node Styling (CSV)</h3>
          <div className="annotation-summary">
            {csvFileName
              ? `${csvFileName} - ${csvInfo?.matchedNodes.toLocaleString() ?? 0} nodes styled`
              : 'Load a BandageNG-style node colour/label CSV or TSV.'}
          </div>
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={() => csvFileInputRef.current?.click()}
          disabled={!hasGraph}
          title={hasGraph ? undefined : 'Load a graph first'}
        >
          Load CSV
        </button>
      </div>

      <input
        ref={csvFileInputRef}
        type="file"
        accept=".csv,.tsv,.txt"
        className="hidden-file-input"
        onChange={handleCsvFileChange}
      />

      {csvError && <div className="control-error">{csvError}</div>}

      {csvInfo && (
        <>
          <div className="control-hint">
            Separator: {csvInfo.separator === '\t' ? 'tab' : 'comma'}. Columns:{' '}
            {csvInfo.headers.join(', ')}.
          </div>

          {/* The likeliest real-world failure is a CSV from a different
              subgraph than the one loaded, which would otherwise silently
              colour nothing - so an unmatched count is always shown, not
              just logged. */}
          <div
            className={
              csvInfo.unmatchedRows.length > 0
                ? 'control-warning'
                : 'control-hint'
            }
          >
            {csvInfo.matchedNodes.toLocaleString()} node
            {csvInfo.matchedNodes === 1 ? '' : 's'} styled,{' '}
            {csvInfo.unmatchedRows.length.toLocaleString()} row
            {csvInfo.unmatchedRows.length === 1 ? '' : 's'} unmatched
            {csvInfo.unmatchedRows.length > 0 &&
              ` (lines ${csvInfo.unmatchedRows.slice(0, 10).join(', ')}${
                csvInfo.unmatchedRows.length > 10 ? ', ...' : ''
              })`}
          </div>

          {categoryEntries.length > 0 && (
            <div className="category-legend">
              <strong>Category colours</strong>
              <div className="category-legend-swatches">
                {categoryEntries.map(([category, colour]) => (
                  <span key={category} className="category-legend-item">
                    <span
                      className="category-swatch"
                      style={{ background: colour }}
                    />
                    {category}
                  </span>
                ))}
              </div>
            </div>
          )}

          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              onClearCsv()
              setCsvFileName(null)
              setCsvError(null)
            }}
          >
            Clear CSV Styling
          </button>
        </>
      )}

      {/* Feature B: reference-coordinate gene track drawn above the ruler. */}
      <div className="annotation-toolbar gene-track-toolbar">
        <div>
          <h3>Gene Track (BED)</h3>
          <div className="annotation-summary">
            {geneTrackFileName
              ? `${geneTrackFileName} - ${geneTrackCount.toLocaleString()} genes loaded`
              : 'Load a BED file (chrom, start, end, name, score, strand; BED12 adds exons).'}
          </div>
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={() => bedFileInputRef.current?.click()}
        >
          Load BED
        </button>
      </div>

      <input
        ref={bedFileInputRef}
        type="file"
        accept=".bed,.txt"
        className="hidden-file-input"
        onChange={handleBedFileChange}
      />

      {bedError && <div className="control-error">{bedError}</div>}

      <div className="control-hint">
        Shown above the ruler only with Linear Layout and a reference path
        selected, and only for genes on that reference's sequence. Replaces
        the built-in GRCh38/CHM13 genes until cleared or a new graph loads.
      </div>

      {geneTrackFileName && (
        <button
          className="secondary-button"
          type="button"
          onClick={() => {
            onClearGeneTrack()
            setBedError(null)
          }}
        >
          Clear Gene Track
        </button>
      )}
    </div>
  )
}
