import { useMemo, useState } from 'react'
import type { RegionPath } from '../types'
import {
  detectGeneAssembly,
  loadGeneIndex,
  searchGenes,
  type GeneAssembly,
  type GeneLocation,
} from '../utils/builtInGenes'
import { HelpIcon } from './HelpIcon'

interface GeneSearchProps {
  regionPaths: RegionPath[]
  selectedRegionPathIndex: number
  graphName: string
  disabled: boolean
  // Fills in the coordinate-region query; the user still runs it.
  onSelectRegion: (regionPathIndex: number, start: number, end: number) => void
}

// Finds a gene by name in the built-in GRCh38/CHM13 gene list and fills in a
// region query around it. Renders two cells of the query grid (the search box
// and the flank). The gene list (~250 KB) is only fetched once the search box
// is first used.
export function GeneSearch({
  regionPaths,
  selectedRegionPathIndex,
  graphName,
  disabled,
  onSelectRegion,
}: GeneSearchProps) {
  const [query, setQuery] = useState('')
  const [flankInput, setFlankInput] = useState('2000')
  const [geneIndex, setGeneIndex] = useState<{
    assembly: GeneAssembly
    genes: GeneLocation[]
  } | null>(null)
  const [isLoadingIndex, setIsLoadingIndex] = useState(false)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [message, setMessage] = useState<{
    text: string
    isError: boolean
  } | null>(null)

  // Search the selected track's assembly, or else the first GRCh38/CHM13
  // track's, so e.g. picking a haplotype track still searches the reference.
  const assembly = useMemo((): GeneAssembly | null => {
    const assemblyOf = (regionPath: RegionPath | undefined) =>
      regionPath
        ? (detectGeneAssembly(regionPath.reference, regionPath.sequence, graphName)
            ?.assembly ?? null)
        : null
    const selected = assemblyOf(regionPaths[selectedRegionPathIndex])
    if (selected) return selected
    for (const regionPath of regionPaths) {
      const found = assemblyOf(regionPath)
      if (found) return found
    }
    return null
  }, [graphName, regionPaths, selectedRegionPathIndex])

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
    loadGeneIndex(assembly)
      .then(genes => setGeneIndex({ assembly, genes }))
      .catch(error =>
        setMessage({
          text: error instanceof Error ? error.message : 'Failed to load genes',
          isError: true,
        }),
      )
      .finally(() => setIsLoadingIndex(false))
  }

  const selectGene = (gene: GeneLocation) => {
    const flankBp = Number(flankInput)
    if (!Number.isInteger(flankBp) || flankBp < 0) {
      setMessage({ text: 'Flank must be a whole number of bp.', isError: true })
      return
    }

    // The gene's chromosome in the same assembly. A W-line reference can be
    // split into several tracks, so prefer one that contains the whole gene.
    let trackIndex = -1
    let trackContainsGene = false
    regionPaths.forEach((regionPath, index) => {
      const match = detectGeneAssembly(
        regionPath.reference,
        regionPath.sequence,
        graphName,
      )
      if (match?.assembly !== assembly || match.chrom !== gene.chrom) return
      const containsGene =
        regionPath.start <= gene.start &&
        (regionPath.end === null || regionPath.end >= gene.end)
      if (trackIndex === -1 || (containsGene && !trackContainsGene)) {
        trackIndex = index
        trackContainsGene = containsGene
      }
    })

    setQuery(gene.symbol)
    setSuggestionsOpen(false)
    const track = regionPaths[trackIndex]
    if (!track) {
      setMessage({
        text: `${gene.symbol} is on ${gene.chrom}, which this graph has no ${assembly} track for.`,
        isError: true,
      })
      return
    }

    const start = Math.max(track.start, gene.start - flankBp)
    const end =
      track.end === null
        ? gene.end + flankBp
        : Math.min(track.end, gene.end + flankBp)
    onSelectRegion(trackIndex, start, end)
    setMessage({
      text:
        `Filled in ${assembly} ${gene.chrom}:${start.toLocaleString()}-` +
        `${end.toLocaleString()}. Run the query to load it.`,
      isError: false,
    })
  }

  const isDisabled = disabled || !assembly
  const showSuggestions = suggestionsOpen && query.trim() !== ''

  return (
    <>
      <div className="control-group gene-search">
        <label htmlFor="gene-search-input">
          Find Gene
          <HelpIcon
            text={
              'Search protein-coding genes (MANE Select) by name, then ' +
              'pick one to fill in its region, plus the flank, on the ' +
              'GRCh38 or CHM13 coordinate track.'
            }
          />
        </label>
        <input
          id="gene-search-input"
          className="control-input"
          type="search"
          autoComplete="off"
          role="combobox"
          aria-expanded={showSuggestions}
          aria-controls="gene-search-suggestions"
          value={query}
          placeholder={assembly ? `${assembly} gene, e.g. BRCA1` : 'No GRCh38/CHM13 track'}
          disabled={isDisabled}
          onFocus={() => {
            ensureGeneIndex()
            setSuggestionsOpen(true)
          }}
          onBlur={() => setSuggestionsOpen(false)}
          onChange={event => {
            setQuery(event.currentTarget.value)
            setActiveSuggestion(0)
            setSuggestionsOpen(true)
            setMessage(null)
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
              if (gene) selectGene(gene)
            } else if (event.key === 'Escape') {
              setSuggestionsOpen(false)
            }
          }}
        />
        {showSuggestions && (
          <ul
            id="gene-search-suggestions"
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
                    selectGene(gene)
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
        {message && (
          <div className={message.isError ? 'control-error' : 'control-hint'}>
            {message.text}
          </div>
        )}
      </div>

      <div className="control-group">
        <label htmlFor="gene-search-flank">Gene Flank (bp)</label>
        <input
          id="gene-search-flank"
          className="control-input"
          type="number"
          min="0"
          step="1000"
          value={flankInput}
          onChange={event => setFlankInput(event.currentTarget.value)}
          disabled={isDisabled}
        />
        <div className="control-hint">Added on both sides of the gene.</div>
      </div>
    </>
  )
}
