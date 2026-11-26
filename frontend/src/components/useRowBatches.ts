import { useCallback, useEffect, useRef, useState } from 'react'

const ROWS_PER_BATCH = 100

// Renders a long table in batches: the next batch is added once the "more"
// row (moreRowRef) scrolls near view in the scrolling list (listRef). A new
// items array starts again from the top. scrollToRow(item) renders the
// batches up to that item's row and scrolls it to the middle of the list.
export function useRowBatches<T>(items: T[]) {
  const [renderedRowCount, setRenderedRowCount] = useState(ROWS_PER_BATCH)
  const [batchedItems, setBatchedItems] = useState(items)
  const [pendingRow, setPendingRow] = useState<{ item: T } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const moreRowRef = useRef<HTMLTableRowElement>(null)

  // Reset while rendering, not in an effect, so a scrollToRow() made along
  // with the change (e.g. clearing a filter) isn't undone by it.
  if (items !== batchedItems) {
    setBatchedItems(items)
    setRenderedRowCount(ROWS_PER_BATCH)
  }
  const hasMoreRows = items.length > renderedRowCount

  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 })
  }, [items])

  useEffect(() => {
    if (!pendingRow) return
    const position = items.indexOf(pendingRow.item)
    if (position === -1) {
      setPendingRow(null)
      return
    }
    if (position >= renderedRowCount) {
      setRenderedRowCount(
        (Math.floor(position / ROWS_PER_BATCH) + 1) * ROWS_PER_BATCH,
      )
      return
    }
    const list = listRef.current
    const row = list?.querySelector('tbody')?.rows[position]
    if (list && row) {
      const offset =
        row.getBoundingClientRect().top - list.getBoundingClientRect().top
      list.scrollTop += offset - (list.clientHeight - row.offsetHeight) / 2
    }
    setPendingRow(null)
  }, [items, pendingRow, renderedRowCount])

  const scrollToRow = useCallback((item: T) => setPendingRow({ item }), [])

  // Observing again after each batch also catches a marker that's still in
  // view, e.g. after a fast scroll.
  useEffect(() => {
    const marker = moreRowRef.current
    if (!hasMoreRows || !marker) return
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setRenderedRowCount(count => count + ROWS_PER_BATCH)
        }
      },
      { root: listRef.current, rootMargin: '300px' },
    )
    observer.observe(marker)
    return () => observer.disconnect()
  }, [hasMoreRows, renderedRowCount])

  return {
    shownRows: items.slice(0, renderedRowCount),
    hasMoreRows,
    listRef,
    moreRowRef,
    scrollToRow,
  }
}
