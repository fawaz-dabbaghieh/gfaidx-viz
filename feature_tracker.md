# Feature Tracker

Haplotype and bubble features, from the implementation brief plus our notes.
Tick each item once it is done and verified.

## BubbleGun2 (bubbles and nesting)

- [x] Native baseline: time `bubblegun_cpp bchains` on the LPA region and
      check 9,203 simple / 637 super / 486 insertion (all match; detection
      9 ms, whole run incl. reading the 78 MB GFA 60 ms)
- [x] bubblegun2 as a library: `find_bubbles()` returning every bubble with
      its type, ends, inside nodes and parent (no chaining needed)
- [x] `PackedGraph::from_edges()`: build the graph from memory instead of a
      GFA file
- [x] CMake: `bubblegun` library target, CLI optional, zlib optional
- [x] Refactor finds exactly the same bubbles as the baseline (identical
      JSON on LPA and three PGGB subgraphs)
- [x] bubblegun2 added to gfaidx-viz as a git submodule
      (`bubbles_wasm/bubblegun2`)
- [x] WASM build script and worker in gfaidx-viz; time it in the browser
      (LPA: 23-34 ms in WASM, 36-78 ms in total, 192 KB .wasm)
- [x] Bubbles found automatically for every loaded graph (no button), with
      counts and time taken next to the node/edge counts
- [x] Click a node: its nesting stack (innermost first) in the info panel,
      with type, ends, node count and bp per bubble
- [x] Highlight a selected bubble in the current layout; clicking empty
      canvas clears it
- [x] Highlight the two ends (green) apart from the inside nodes (purple)
- [x] Bubble statistics in the Statistics dialog: counts per type, % of
      nodes and sequence in bubbles, max nestedness, detection time
- [x] Bubbles tab: every bubble, biggest first (nodes inside), sortable,
      filter by type; clicking a row highlights and zooms to it
- [x] Download bubbles as TSV and JSON (flat list with parent and
      outermost ids)
- [x] Bubbles tab: Parent and Outermost columns; clicking either ID goes to
      that bubble's row and highlights it
- [ ] "Show only this bubble" as its own small graph with a back button
- [ ] Traversals through a bubble (to discuss): group the haplotypes
      passing through it by traversal, and mark which traversal is the
      reference's (see F7 below)

## Haplotype features

- [x] Task 0: `WalkIndex` (haplotypes, compact node indices, reference
      offsets, haplotypes/visits per node); Σ node length = end − start per
      walk is checked. `utils/walkIndex.ts`, tested with Vitest (LPA: all
      brief values match, built in 164 ms)
- [x] Reference walk selector in the UI (Haplotypes tab): default from
      `pickReferencePath` (queried / linear-layout path, else CHM13, else
      GRCh38); PGGB P-lines grouped by `sample#hap` from the name
- [x] "Haplotype Sharing" color scheme: heat map from red (one haplotype)
      to blue (all), legend in the Display tab
- [x] Node info panel: "Haplotypes: X of N (passes)"
- [ ] F1: click a gene: highlight and colour its reference nodes
- [ ] F1: pick a single exon or intron (BED12 blocks), not only the gene
- [ ] F2: per-haplotype coverage table for the selected gene (nodes, bp,
      fraction, max multiplicity, total visits) + `haplotype_gap` banner
- [x] F3: reference-sharing table with orderings (shared sequence, total
      sequence, % of the haplotype on the reference, % of the reference
      covered, sample name) in the Haplotypes tab, with TSV download and a
      warning for split haplotypes. Still missing: a user-supplied metadata
      column (e.g. population) to sort by
- [ ] F4: walk-rows track (reference on top, one row per haplotype);
      look at clustermap.js `refactor` branch for Mauve-style ribbons
- [ ] F6: click a node: its site and nesting stack (see BubbleGun2 above)
- [ ] F7: traversals through a site, both ends in either order, walking
      the hierarchy; list for small sites, length distribution for large
- [ ] Exports: a download button per table, with graph, window, reference
      and gap in a header comment

## Small fixes

- [x] `gfaParser.ts`: strip `\r` so CRLF files don't add 1 bp to tagless
      segments
- [x] Rename the "Copy #" / copy-number track to traversal multiplicity
      (button "Multiplicity"; internal names still say copyNumber)
- [ ] On-screen caveats: only sequence on the reference is annotated (for
      the gene features); node sharing is not sequence identity (done, in
      the Haplotypes tab)
