import { useEffect, useRef, useState } from 'react'

interface LoadErrorBannerProps {
  message: string
  // For a result too large to show: a link to save it, when it finished...
  downloadUrl: string | null
  // ...and the gfaidx command that extracts it from the indexed graph.
  command: string | null
  onShowDownloadGraphs: () => void
  onDismiss: () => void
}

// The page's one place for file and extraction errors, above the tabs.
export function LoadErrorBanner({
  message,
  downloadUrl,
  command,
  onShowDownloadGraphs,
  onDismiss,
}: LoadErrorBannerProps) {
  const bannerRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  // A user scrolled down to the graph would otherwise miss a new error.
  useEffect(() => {
    bannerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [message])

  useEffect(() => {
    setCopied(false)
  }, [command])

  return (
    <div className="load-error-banner" role="alert" ref={bannerRef}>
      <div className="load-error-body">
        <div className="load-error-message">{message}</div>
        {downloadUrl && (
          <div>
            {/* A new tab keeps the viewer open if the backend shows the file
                inline instead of saving it (backends before the attachment fix). */}
            <a
              className="load-error-action"
              href={downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Download GFA
            </a>
          </div>
        )}
        {command && (
          <>
            <div className="load-error-local">
              Or extract it on your own machine: get the indexed graph
              <button
                type="button"
                className="load-error-action"
                onClick={onShowDownloadGraphs}
              >
                Download Indexed Graphs
              </button>
              then run
            </div>
            <div className="gfaidx-command-line">
              <code>{command}</code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard
                    .writeText(command)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false))
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </>
        )}
      </div>
      <button type="button" className="load-error-dismiss" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  )
}
