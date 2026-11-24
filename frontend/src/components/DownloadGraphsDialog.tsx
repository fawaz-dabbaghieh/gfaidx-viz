import { useEffect, useMemo, useRef, useState } from 'react'
import type { IndexedGraph } from '../types'
import {
  EXAMPLE_FLANK_BP,
  EXAMPLE_GENE,
  EXAMPLE_GENE_ASSEMBLY,
  EXAMPLE_GRAPH_ID,
} from '../utils/exampleQuery'
import { DEFAULT_HAPLOTYPE_GAP, gfaidxRegionCommand } from '../utils/gfaidxCommand'
import { BUCKET, BUCKET_PATH, BUCKET_URL, PREFIX } from '../utils/indexedGraphBucket'

interface GraphArchive {
  file: string
  graphId: string
  name: string
  size: number
}

interface ListedArchive {
  file: string
  size: number
}

// S3's ListObjectsV2, following continuation tokens past 1,000 keys.
async function listArchives() {
  const archives: ListedArchive[] = []
  let token = ''
  do {
    const params = new URLSearchParams({ 'list-type': '2', prefix: PREFIX })
    if (token) params.set('continuation-token', token)
    const response = await fetch(`${BUCKET_URL}/?${params}`)
    if (!response.ok) throw new Error(`S3 returned HTTP ${response.status}`)
    const xml = new DOMParser().parseFromString(
      await response.text(),
      'application/xml',
    )
    const text = (parent: Element | Document, tag: string) =>
      parent.getElementsByTagName(tag)[0]?.textContent ?? ''
    for (const item of xml.getElementsByTagName('Contents')) {
      const key = text(item, 'Key')
      if (key.endsWith('.tar')) {
        archives.push({ file: key.slice(PREFIX.length), size: Number(text(item, 'Size')) })
      }
    }
    token = text(xml, 'IsTruncated') === 'true' ? text(xml, 'NextContinuationToken') : ''
  } while (token)
  return archives
}

// The bucket is listed once per page load; a failed listing is retried the
// next time the dialog opens.
let cachedListing: ListedArchive[] | null = null
let pendingListing: Promise<ListedArchive[]> | null = null
function loadArchives() {
  pendingListing ??= listArchives().then(
    archives => (cachedListing = archives),
    error => {
      pendingListing = null
      throw error
    },
  )
  return pendingListing
}

const EXAMPLE_COMMAND = gfaidxRegionCommand({
  graphId: EXAMPLE_GRAPH_ID,
  reference: EXAMPLE_GENE_ASSEMBLY,
  sequence: EXAMPLE_GENE.chrom,
  start: EXAMPLE_GENE.start - EXAMPLE_FLANK_BP,
  end: EXAMPLE_GENE.end + EXAMPLE_FLANK_BP,
  allHaplotypes: true,
  haplotypeGap: DEFAULT_HAPLOTYPE_GAP,
  maxNodes: 0,
  withCoords: true,
})

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11" />
    </svg>
  )
}

interface DownloadGraphsDialogProps {
  graphs: IndexedGraph[]
  selectedGraphId: string
  onClose: () => void
}

export function DownloadGraphsDialog({
  graphs,
  selectedGraphId,
  onClose,
}: DownloadGraphsDialogProps) {
  const [listing, setListing] = useState(cachedListing)
  const [listError, setListError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [chosenFile, setChosenFile] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    if (cachedListing) return
    let open = true
    loadArchives()
      .then(archives => open && setListing(archives))
      .catch(error => {
        if (open) setListError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      open = false
    }
  }, [])

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  // Each archive is named after its graph ID, with .tar for .gfa.gz.
  const archives = useMemo<GraphArchive[]>(() => {
    const names = new Map(graphs.map(graph => [graph.id, graph.name]))
    return (listing ?? [])
      .map(({ file, size }) => {
        const graphId = file.replace(/\.tar$/, '.gfa.gz')
        return { file, graphId, name: names.get(graphId) ?? file, size }
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  }, [graphs, listing])

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return archives.filter(archive => {
      const text = `${archive.name} ${archive.file}`.toLowerCase()
      return words.every(word => text.includes(word))
    })
  }, [archives, query])

  const chosen =
    archives.find(archive => archive.file === chosenFile) ??
    archives.find(archive => archive.graphId === selectedGraphId) ??
    archives.find(archive => archive.graphId === EXAMPLE_GRAPH_ID) ??
    archives[0]

  // Once the list arrives, scroll it (not the dialog) to the chosen graph.
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>('li.selected')
    if (list && row) list.scrollTop = row.offsetTop - (list.clientHeight - row.offsetHeight) / 2
  }, [listing])

  const file = chosen?.file ?? 'GRAPH.indexed.tar'
  const steps = [
    {
      title: 'Download',
      commands: [
        { key: 'curl', text: `curl -O ${BUCKET_URL}/${PREFIX}${file}` },
        {
          key: 'aws',
          note: 'or with the AWS CLI, faster for large files:',
          text: `aws s3 cp --no-sign-request s3://${BUCKET}/${PREFIX}${file} .`,
        },
      ],
    },
    {
      title: 'Unpack',
      commands: [{ key: 'tar', text: `tar -xf ${file}` }],
      note:
        'This gives the graph and its index files. It needs about as much ' +
        'free space again; the .tar can be deleted afterwards.',
    },
    {
      title: 'Query',
      commands: [{ key: 'gfaidx', text: EXAMPLE_COMMAND }],
      note: `This region covers the ${EXAMPLE_GENE.symbol} gene.`,
    },
  ]

  const copy = (key: string, text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => setCopied(key))
      .catch(() => setCopied(null))
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog-content download-graphs-dialog"
        role="dialog"
        aria-labelledby="download-graphs-title"
        onClick={event => event.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 id="download-graphs-title">Download Indexed Graphs</h2>
          <button className="dialog-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="dialog-body">
          <p className="download-graphs-intro">
            Every graph on the server, already indexed, is in the public
            bucket <code>{BUCKET_PATH}</code>, one <code>.tar</code>{' '}
            per graph. Query them locally with{' '}
            <a
              href="https://github.com/fawaz-dabbaghieh/gfaidx"
              target="_blank"
              rel="noopener noreferrer"
            >
              gfaidx
            </a>
            . Pick a graph below to fill in the commands.
          </p>

          <ol className="download-graphs-steps">
            {steps.map(step => (
              <li key={step.title}>
                <strong>{step.title}</strong>
                {step.commands.map(command => (
                  <div key={command.key}>
                    {'note' in command && (
                      <div className="download-graphs-note">{command.note}</div>
                    )}
                    <div className="gfaidx-command-line">
                      <code>{command.text}</code>
                      <button type="button" onClick={() => copy(command.key, command.text)}>
                        {copied === command.key ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                ))}
                {'note' in step && (
                  <div className="download-graphs-note">{step.note}</div>
                )}
              </li>
            ))}
          </ol>

          <input
            className="control-input download-graphs-search"
            type="search"
            placeholder="Search graphs"
            aria-label="Search graphs"
            value={query}
            onChange={event => setQuery(event.currentTarget.value)}
          />
          {listError ? (
            <div className="control-error">
              Couldn't list the bucket ({listError}). It can also be listed
              with <code>aws s3 ls --no-sign-request {BUCKET_PATH}</code>.
            </div>
          ) : listing === null ? (
            <div className="download-graphs-empty">Loading the graph list...</div>
          ) : shown.length === 0 ? (
            <div className="download-graphs-empty">No matching graphs</div>
          ) : (
            <ul className="download-graphs-list" ref={listRef}>
              {shown.map(archive => (
                <li
                  key={archive.file}
                  className={archive === chosen ? 'selected' : undefined}
                >
                  <button
                    type="button"
                    className="download-graphs-pick"
                    aria-pressed={archive === chosen}
                    onClick={() => {
                      setChosenFile(archive.file)
                      setCopied(null)
                    }}
                  >
                    <span className="download-graphs-name">{archive.name}</span>
                    <span className="download-graphs-file">{archive.file}</span>
                  </button>
                  <span className="download-graphs-size">{formatSize(archive.size)}</span>
                  <a
                    className="download-graphs-link"
                    href={`${BUCKET_URL}/${PREFIX}${archive.file}`}
                    download
                    title={`Download ${archive.file} (${formatSize(archive.size)})`}
                    aria-label={`Download ${archive.file}`}
                  >
                    <DownloadIcon />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
