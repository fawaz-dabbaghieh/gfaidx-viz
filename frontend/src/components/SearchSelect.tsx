import { useEffect, useMemo, useRef, useState } from 'react'

// Rows are added as the list scrolls: a graph can have 60k coordinate tracks.
const ROWS_PER_BATCH = 100
// Opening the list scrolls to the selected row only if it's this near the
// top, so opening never renders thousands of rows at once.
const MAX_SCROLL_TO_ROW = 500

interface SearchSelectProps<T> {
  id: string
  items: readonly T[]
  selectedIndex: number
  // Both should be stable (e.g. module-level): the search text of every item
  // is recomputed when they change.
  getLabel: (item: T) => string
  getSearchText?: (item: T) => string
  // Disabled items are listed but can't be picked.
  isDisabled?: (item: T) => boolean
  onSelect: (index: number) => void
  placeholder?: string
  disabled?: boolean
}

// A dropdown that can also be typed into: focusing it lists every item, and
// typing narrows the list.
export function SearchSelect<T>({
  id,
  items,
  selectedIndex,
  getLabel,
  getSearchText,
  isDisabled,
  onSelect,
  placeholder,
  disabled,
}: SearchSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeRow, setActiveRow] = useState(0)
  const [renderedCount, setRenderedCount] = useState(ROWS_PER_BATCH)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const searchTexts = useMemo(
    () => items.map(item => (getSearchText ?? getLabel)(item).toLowerCase()),
    [getLabel, getSearchText, items],
  )
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const result: number[] = []
    searchTexts.forEach((text, index) => {
      if (!needle || text.includes(needle)) result.push(index)
    })
    return result
  }, [query, searchTexts])

  const selectedItem = items[selectedIndex]
  const selectedLabel = selectedItem === undefined ? '' : getLabel(selectedItem)

  useEffect(() => {
    if (!isOpen) return
    const row = listRef.current?.children[activeRow]
    row?.scrollIntoView({ block: 'nearest' })
  }, [activeRow, isOpen])

  const open = () => {
    if (isOpen) return
    const row = selectedIndex < MAX_SCROLL_TO_ROW ? Math.max(0, selectedIndex) : 0
    setIsOpen(true)
    setQuery('')
    setActiveRow(row)
    setRenderedCount(Math.max(ROWS_PER_BATCH, row + ROWS_PER_BATCH))
  }

  const choose = (index: number | undefined) => {
    if (index === undefined || isDisabled?.(items[index]!)) return
    setIsOpen(false)
    // Unfocused, the box shows the choice; focusing it again starts a new search.
    inputRef.current?.blur()
    onSelect(index)
  }

  const isRowDisabled = (row: number) =>
    !!isDisabled && isDisabled(items[matches[row]!]!)

  // The nearest enabled row from `row` in direction `step` (+1 or -1).
  const enabledRowFrom = (row: number, step: number): number | null => {
    for (let r = row; r >= 0 && r < matches.length; r += step) {
      if (!isRowDisabled(r)) return r
    }
    return null
  }

  const moveActiveRow = (step: number) => {
    if (matches.length === 0) return
    const target = Math.min(matches.length - 1, Math.max(0, activeRow + step))
    const row =
      enabledRowFrom(target, Math.sign(step)) ??
      enabledRowFrom(target, -Math.sign(step))
    if (row === null) return
    setActiveRow(row)
    if (row >= renderedCount) setRenderedCount(row + ROWS_PER_BATCH)
  }

  return (
    <div className="search-select">
      <input
        ref={inputRef}
        id={id}
        className="control-input"
        type="text"
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={isOpen}
        aria-controls={`${id}-list`}
        value={isOpen ? query : selectedLabel}
        placeholder={isOpen ? selectedLabel || placeholder : placeholder}
        disabled={disabled}
        onFocus={open}
        onClick={open}
        onBlur={() => setIsOpen(false)}
        onChange={event => {
          setIsOpen(true)
          setQuery(event.currentTarget.value)
          setActiveRow(0)
          setRenderedCount(ROWS_PER_BATCH)
          if (listRef.current) listRef.current.scrollTop = 0
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!isOpen) open()
            else moveActiveRow(event.key === 'ArrowDown' ? 1 : -1)
          } else if (event.key === 'PageDown' || event.key === 'PageUp') {
            if (!isOpen) return
            event.preventDefault()
            moveActiveRow(event.key === 'PageDown' ? 10 : -10)
          } else if (event.key === 'Enter') {
            // Inside the query form: Enter picks a row, it doesn't submit.
            // On a disabled row it takes the next enabled one.
            event.preventDefault()
            if (!isOpen) return
            const row = enabledRowFrom(activeRow, 1)
            if (row !== null) choose(matches[row])
          } else if (event.key === 'Escape') {
            setIsOpen(false)
          }
        }}
      />
      <span className="search-select-arrow" aria-hidden="true">
        ▾
      </span>
      {isOpen && (
        <ul
          id={`${id}-list`}
          ref={listRef}
          className="search-select-list"
          role="listbox"
          onScroll={event => {
            const list = event.currentTarget
            if (
              renderedCount < matches.length &&
              list.scrollTop + list.clientHeight > list.scrollHeight - 200
            ) {
              setRenderedCount(count => count + ROWS_PER_BATCH)
            }
          }}
        >
          {matches.length === 0 ? (
            <li className="search-select-empty">No matches</li>
          ) : (
            matches.slice(0, renderedCount).map((itemIndex, row) => (
              <li
                key={itemIndex}
                role="option"
                aria-selected={itemIndex === selectedIndex}
                aria-disabled={isDisabled?.(items[itemIndex]!) || undefined}
                className={[
                  row === activeRow && 'active',
                  itemIndex === selectedIndex && 'selected',
                  isDisabled?.(items[itemIndex]!) && 'disabled',
                ]
                  .filter(Boolean)
                  .join(' ')}
                // mousedown, not click: it fires before the input's blur
                // closes the list.
                onMouseDown={event => {
                  event.preventDefault()
                  choose(itemIndex)
                }}
                onMouseEnter={() => setActiveRow(row)}
              >
                {getLabel(items[itemIndex]!)}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
