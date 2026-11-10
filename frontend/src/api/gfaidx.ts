// Ticket states returned by the Go backend's shared asynchronous job API.
export type GfaidxTicketStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETE'
  | 'ERROR'

// UI-only phases cover the work immediately before and after backend polling.
export type GfaidxJobPhase =
  | 'SUBMITTING'
  | GfaidxTicketStatus
  | 'DOWNLOADING'

// GfaidxJobProgress is shown while the frontend waits for a queued extraction.
export interface GfaidxJobProgress {
  phase: GfaidxJobPhase
  ticket?: string
}

interface GfaidxTicket {
  id: string
  status: GfaidxTicketStatus
}

interface RunGfaidxJobOptions {
  backendUrl: string
  submissionPath: string
  payload: unknown
  signal?: AbortSignal
  onProgress?: (progress: GfaidxJobProgress) => void
  pollIntervalMs?: number
}

export interface GfaidxJobResult {
  gfaText: string
  ticket: string
}

// GfaidxResultTooLargeError means the job finished but the result is over the
// backend's display limit (HTTP 413); it can still be saved from downloadUrl.
export class GfaidxResultTooLargeError extends Error {
  downloadUrl: string

  constructor(message: string, downloadUrl: string) {
    super(message)
    this.name = 'GfaidxResultTooLargeError'
    this.downloadUrl = downloadUrl
  }
}

const ticketStatuses = new Set<GfaidxTicketStatus>([
  'PENDING',
  'RUNNING',
  'COMPLETE',
  'ERROR',
])

// readBackendError understands both the retained FastAPI error shape and the
// Go backend's plain-text and rate-limit responses.
export async function readBackendError(response: Response): Promise<string> {
  const responseText = await response.text()
  if (!responseText.trim()) {
    return `Backend returned HTTP ${response.status}`
  }

  try {
    const body = JSON.parse(responseText) as {
      detail?: unknown
      reason?: unknown
      message?: unknown
    }
    if (typeof body.detail === 'string') return body.detail
    if (body.detail !== undefined) return JSON.stringify(body.detail)
    if (typeof body.reason === 'string') return body.reason
    if (typeof body.message === 'string') return body.message
  } catch {
    // Plain-text errors are expected from Go's http.Error responses.
  }

  return responseText.trim()
}

// parseTicket validates the small JSON contract before polling with its ID.
async function parseTicket(response: Response): Promise<GfaidxTicket> {
  let body: unknown
  try {
    body = JSON.parse(await response.text())
  } catch {
    throw new Error('Backend returned an invalid job ticket')
  }

  if (!body || typeof body !== 'object') {
    throw new Error('Backend returned an invalid job ticket')
  }
  const candidate = body as { id?: unknown; status?: unknown }
  if (
    typeof candidate.id !== 'string' ||
    !candidate.id ||
    typeof candidate.status !== 'string' ||
    !ticketStatuses.has(candidate.status as GfaidxTicketStatus)
  ) {
    throw new Error('Backend returned an invalid job ticket')
  }

  return {
    id: candidate.id,
    status: candidate.status as GfaidxTicketStatus,
  }
}

// waitForNextPoll resolves after a delay and rejects promptly when the caller
// aborts because the component was unmounted or a request was replaced.
function waitForNextPoll(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The request was aborted', 'AbortError'))
      return
    }

    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort)
      resolve()
    }, milliseconds)
    const handleAbort = () => {
      window.clearTimeout(timer)
      reject(new DOMException('The request was aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', handleAbort, { once: true })
  })
}

// runGfaidxJob submits one extraction, follows the existing ticket endpoint to
// a terminal state, and downloads the GFA only after successful completion.
export async function runGfaidxJob({
  backendUrl,
  submissionPath,
  payload,
  signal,
  onProgress,
  pollIntervalMs = 1000,
}: RunGfaidxJobOptions): Promise<GfaidxJobResult> {
  onProgress?.({ phase: 'SUBMITTING' })
  const submissionResponse = await fetch(`${backendUrl}${submissionPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  if (!submissionResponse.ok) {
    throw new Error(await readBackendError(submissionResponse))
  }

  let ticket = await parseTicket(submissionResponse)
  onProgress?.({ phase: ticket.status, ticket: ticket.id })

  while (ticket.status === 'PENDING' || ticket.status === 'RUNNING') {
    await waitForNextPoll(pollIntervalMs, signal)
    const statusResponse = await fetch(
      `${backendUrl}/api/ticket/${encodeURIComponent(ticket.id)}`,
      { signal },
    )
    if (!statusResponse.ok) {
      throw new Error(await readBackendError(statusResponse))
    }
    ticket = await parseTicket(statusResponse)
    onProgress?.({ phase: ticket.status, ticket: ticket.id })
  }

  const resultUrl = `${backendUrl}/api/result/gfaidx/${encodeURIComponent(ticket.id)}`
  if (ticket.status === 'ERROR') {
    const errorResponse = await fetch(resultUrl, { signal })
    throw new Error(await readBackendError(errorResponse))
  }

  onProgress?.({ phase: 'DOWNLOADING', ticket: ticket.id })
  const resultResponse = await fetch(resultUrl, { signal })
  if (resultResponse.status === 413) {
    // The backend explains the sizes before ';' and how to fetch the file
    // after it; the UI offers that download itself, so only the sizes are kept.
    const reason = (await readBackendError(resultResponse)).split(';')[0]
    throw new GfaidxResultTooLargeError(
      `${reason}, so it cannot be displayed here. Use the download link to save it.`,
      `${resultUrl}?download=true`,
    )
  }
  if (!resultResponse.ok) {
    throw new Error(await readBackendError(resultResponse))
  }

  return { gfaText: await resultResponse.text(), ticket: ticket.id }
}
