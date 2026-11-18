import type { GeneAssembly, GeneLocation } from './builtInGenes'

// The query the app opens with, ready to run: the amylase locus (the AMY1C
// copy at chr1:103,692,902 on CHM13) with 50 kb either side, on the HPRC
// release 2 Minigraph-Cactus CHM13 graph.
export const EXAMPLE_GRAPH_ID = 'hprc-v2.1-mc-chm13.indexed.gfa.gz'
export const EXAMPLE_GENE_ASSEMBLY: GeneAssembly = 'CHM13'
export const EXAMPLE_GENE: GeneLocation = {
  symbol: 'AMY1C',
  key: 'AMY1C',
  chrom: 'chr1',
  start: 103692902,
  end: 103701695,
  strand: '+',
}
export const EXAMPLE_FLANK_BP = 50000
