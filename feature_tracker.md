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
- [x] Traversals through a bubble: grouped by exact route, the
      reference's marked, length vs the reference, a length histogram for
      10+ traversals, the route highlighted in red, TSV download (see F7)

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
- [x] F1: click a gene (in the gene track, or the gene line of a node's
      info panel): the panel shows it, with its reference nodes found in
      any layout, and the whole gene is outlined in the graph
- [x] F1: pick exons and introns: tick boxes in the gene panel (5′ first,
      with lengths; parts outside the graph greyed), "All exons", "All
      introns", "Clear", "Zoom to highlighted". The outline covers exactly
      the ticked bases, also inside long nodes, in any color scheme
- [x] F1: colour a gene's reference nodes in any layout: the "Genes" color
      scheme, position along the gene as a rainbow from 5′ (blue) to 3′
      (red), introns faded, grey outside genes or off the reference. Nodes
      are colored along their length (a gradient per piece of their line),
      so long nodes show their own stretch of the gene and a node crossing
      an exon/intron boundary or a gene end changes color there. Placed
      through the reference walk (rGFA: the SO tags), so it works in
      force-directed layouts; built-in genes now load in any layout.
      `utils/geneNodes.ts`, tested with Vitest. To decide after trying it:
      whether the faded introns are clear enough
- [x] F1: hover a node (and the node info panel): where it sits in its
      gene and in each exon or intron it overlaps, counted from the gene's
      5′ end, e.g. "AMY1C (−) · gene bases 2,444–3,467 of 8,794" then
      "intron 4 of 10: bases 212–448 of 448", "exon 5 of 11: bases 1–231 of
      231", ...; any part of the node outside the gene is noted
- [x] F1: say when a gene is cut off by the graph's edge: the Genes legend
      lists them ("PLG: 23%, 3′ end outside"), the hover and the gene panel
      say which of its bases are in the graph
- [x] Genes color scheme in dark mode: introns are now washed out toward
      grey at the same brightness instead of faded toward the dark canvas
      (which made them brown). To judge after trying it
- [ ] F2 (later): per-haplotype coverage table for the selected gene
      (nodes, bp, fraction, max multiplicity, total visits) +
      `haplotype_gap` banner. To think about first: gene information for
      every haplotype, not only the reference
- [x] F3: reference-sharing table with orderings (shared sequence, total
      sequence, % of the haplotype on the reference, % of the reference
      covered, sample name) in the Haplotypes tab, with TSV download and a
      warning for split haplotypes. Still missing: a user-supplied metadata
      column (e.g. population) to sort by
- [ ] F4: walk-rows track (reference on top, one row per haplotype);
      look at clustermap.js `refactor` branch for Mauve-style ribbons
- [ ] F6: click a node: its site and nesting stack (see BubbleGun2 above)
- [x] F7: traversals through a site, both ends in either order, read
      between the site's own ends (so nested sites are included); list for
      small sites, length distribution for large. LPA KIV-2 site: 464/464
      haplotypes, 457 traversals (451 singletons), 5-172,073 bp, r = 0.9928
      with seqLen. `utils/traversals.ts`, tested with Vitest
- [ ] F7 follow-up (maybe): group a superbubble's traversals by the route
      taken through each nested bubble instead of the exact node sequence
- [ ] Exports: a download button per table, with graph, window, reference
      and gap in a header comment

## FASTA downloads

Spelled from the node sequences on the fly ('-' nodes reverse-complemented).
Segments without a sequence ('*') can't be spelled, so say so instead.

- [x] Bubbles tab, picked bubble: "Download FASTA" next to the traversals'
      TSV, one record per traversal, the sequence between the two ends:
      `>bubble7495_T3 bp=99847 reference=no haplotype_count=2
      haplotypes=HG00438#1,HG00621#2` (every haplotype listed, after the
      short ID, so tools that cut names at the first space keep the ID)
- [x] Haplotypes tab: "Download FASTA" next to "Download TSV", one record
      per walk, named by its path with coordinates when known, e.g.
      `>CHM13#0#chr1:103642745-103751970 haplotype=CHM13#0 bp=109225`
      (AMY1C: 519 records, 56 MB, 0.6 s)
- [x] Downloads where they belong: the whole graph from the top, haplotype
      TSV + FASTA in the Haplotypes tab, the bubble list TSV + JSON in the
      Bubbles tab, a picked bubble's traversal TSV + FASTA under it

## rGFA (minigraph) graphs

No haplotype paths, only the reference rebuilt from the rank-0 segments'
SN/SO tags, and each segment's rank (SR) and the assembly that first added
it (SN).

- [x] "rGFA Rank" color scheme: reference (rank 0) blue, other ranks on a
      ramp by the order their assemblies were added (amber to magenta;
      pale yellow to red in dark mode), with a legend
- [x] A clear message instead of "T1 (reference) 100%" and other
      one-haplotype results: bubble traversals, the Haplotypes tab, the
      Haplotype Sharing legend; the node panel drops "Haplotypes: 1 of 1"
- [x] An "All Haplotypes" region query on an rGFA returns only the rank-0
      (reference) segments, since there are no haplotype paths to follow.
      Tracks from segment tags (region-paths `source: "S"`) are now always
      queried with BFS: All Haplotypes is disabled there, with a note

## Small fixes

- [x] `gfaParser.ts`: strip `\r` so CRLF files don't add 1 bp to tagless
      segments
- [x] Rename the "Copy #" / copy-number track to traversal multiplicity
      (button "Multiplicity"; internal names still say copyNumber)
- [x] Uploaded PGGB graphs: P-lines named "sample#hap#contig:start-end"
      (or "sample#contig:start-end") get coordinates when the range is as
      long as the path, so genes (and the linear-layout ruler) work on
      them; other uploaded P-lines get none, and the Genes legend says why
- [x] On-screen caveats: only sequence on the reference is annotated (in
      the Genes legend); node sharing is not sequence identity (in the
      Haplotypes tab)
