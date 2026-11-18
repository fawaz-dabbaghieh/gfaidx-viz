import { useMemo, useState } from 'react'
import {
  loadGeneIndex,
  searchGenes,
  type GeneAssembly,
  type GeneLocation,
} from '../utils/builtInGenes'

interface GeneSearchProps {
  id: string
  assembly: GeneAssembly | null
  query: string
  disabled: boolean
  onQueryChange: (query: string) => void
  onPick: (gene: GeneLocation) => void
}

// A gene-name box with suggestions from the built-in GRCh38/CHM13 gene list.
// The list (~250 KB) is only fetched once the box is first used.
export function GeneSearch({
  id,
  assembly,
  query,
  disabled,
  onQueryChange,
  onPick,
}: GeneSearchProps) {
  const [geneIndex, setGeneIndex] = useState<{
    assembly: GeneAssembly
    genes: GeneLocation[]
  } | null>(null)
  const [isLoadingIndex, setIsLoadingIndex] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(0)

  const suggestions = useMemo(
    () =>
      geneIndex && geneIndex.assembly === assembly
        ? searchGenes(geneIndex.genes, query)
        : [],
    [assembly, geneIndex, query],
  )

  const ensureGeneIndex = () => {
    if (!assembly || geneIndex?.assembly === assembly || isLoadingIndex) return
    setIsLoadingIndex(true)
    setLoadError(null)
    loadGeneIndex(assembly)
      .then(genes => setGeneIndex({ assembly, genes }))
      .catch(error =>
        setLoadError(error instanceof Error ? error.message : 'Failed to load genes'),
      )
      .finally(() => setIsLoadingIndex(false))
  }

  const pick = (gene: GeneLocation) => {
    setSuggestionsOpen(false)
    onPick(gene)
  }

  const showSuggestions = suggestionsOpen && query.trim() !== ''

  return (
    <div className="gene-search">
      <input
        id={id}
        className="control-input"
        type="search"
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={showSuggestions}
        aria-controls={`${id}-suggestions`}
        value={query}
        placeholder={assembly ? `${assembly} gene, e.g. AMY1C` : 'No GRCh38/CHM13 track'}
        disabled={disabled || !assembly}
        onFocus={() => {
          ensureGeneIndex()
          setSuggestionsOpen(true)
        }}
        onBlur={() => setSuggestionsOpen(false)}
        onChange={event => {
          onQueryChange(event.currentTarget.value)
          setActiveSuggestion(0)
          setSuggestionsOpen(true)
          ensureGeneIndex()
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (suggestions.length === 0) return
            const step = event.key === 'ArrowDown' ? 1 : -1
            setActiveSuggestion(
              (activeSuggestion + step + suggestions.length) %
                suggestions.length,
            )
          } else if (event.key === 'Enter') {
            // Inside the query form: Enter picks a gene, it doesn't submit.
            event.preventDefault()
            const gene = suggestions[activeSuggestion] ?? suggestions[0]
            if (gene) pick(gene)
          } else if (event.key === 'Escape') {
            setSuggestionsOpen(false)
          }
        }}
      />
      {showSuggestions && (
        <ul
          id={`${id}-suggestions`}
          className="gene-search-suggestions"
          role="listbox"
        >
          {isLoadingIndex ? (
            <li className="gene-search-empty">Loading genes...</li>
          ) : suggestions.length === 0 ? (
            <li className="gene-search-empty">No matching genes</li>
          ) : (
            suggestions.map((gene, index) => (
              <li
                key={`${gene.symbol}-${gene.chrom}-${gene.start}`}
                role="option"
                aria-selected={index === activeSuggestion}
                className={index === activeSuggestion ? 'active' : undefined}
                // mousedown, not click: it fires before the input's blur
                // closes the list.
                onMouseDown={event => {
                  event.preventDefault()
                  pick(gene)
                }}
                onMouseEnter={() => setActiveSuggestion(index)}
              >
                <strong>{gene.symbol}</strong>
                <span>
                  {gene.chrom}:{gene.start.toLocaleString()}-
                  {gene.end.toLocaleString()}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
      {loadError && <div className="control-error">{loadError}</div>}
    </div>
  )
}
