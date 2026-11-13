#!/usr/bin/env python3
"""Build the gene annotations shipped with the frontend.

One transcript per protein-coding gene, the MANE Select transcript, for both
GRCh38 and T2T-CHM13:

- GRCh38: MANE's own RefSeq GTF.
- CHM13: the transcripts whose accession is MANE Select on GRCh38, from two
  annotations of T2T-CHM13v2.0:
  - NCBI's RefSeq annotation (UCSC hs1), used first. A transcript that maps
    to more than one locus (UCSC appends "_2", "_3", ...) is kept at each one.
  - The T2T consortium's Liftoff of RefSeq, for the genes NCBI's lacks and for
    extra copies of a gene: where CHM13 has more copies than GRCh38 (e.g.
    seven AMY1 copies against three), NCBI annotates the extras as predicted
    LOC genes, while Liftoff places the GRCh38 transcript on each. Those are
    marked "extra copy N" in the RefSeq column.

Output, under frontend/public/annotations/<assembly>/:

- chrN.bed.gz: BED12, sorted by start, plus a 13th column with the RefSeq
  transcript (and copy, if an extra one) and a 14th with the Ensembl
  transcript. The app fetches only the
  chromosome it is showing.
- genes.tsv.gz: symbol, chrom, start, end, strand; used by gene search.

Usage: python3 scripts/build_gene_annotations.py [--cache DIR]
Only the Python standard library is needed.
"""

import argparse
import gzip
import re
import urllib.request
from collections import defaultdict
from pathlib import Path

MANE_VERSION = "1.5"
MANE_BASE = "https://ftp.ncbi.nlm.nih.gov/refseq/MANE/MANE_human/current"
MANE_SUMMARY_URL = f"{MANE_BASE}/MANE.GRCh38.v{MANE_VERSION}.summary.txt.gz"
GRCH38_URL = f"{MANE_BASE}/MANE.GRCh38.v{MANE_VERSION}.refseq_genomic.gtf.gz"
CHM13_URL = "https://hgdownload.soe.ucsc.edu/goldenPath/hs1/bigZips/genes/hs1.ncbiRefSeq.gtf.gz"
CHM13_LIFTOFF_URL = "https://s3-us-west-2.amazonaws.com/human-pangenomics/T2T/CHM13/assemblies/annotation/chm13v2.0_RefSeq_Liftoff_v5.2.gff3.gz"

PRIMARY_CHROM = re.compile(r"^chr([1-9]|1[0-9]|2[0-2]|X|Y)$")
# An exon's or CDS's transcript: transcript_id in GTF, Parent in GFF3.
GTF_TRANSCRIPT_ID = re.compile(r'transcript_id "([^"]+)"')
GFF3_PARENT = re.compile(r"(?:^|;)Parent=([^;]+)")
EXTRA_COPY = re.compile(r"(?:^|;)extra_copy_number=(\d+)")
# "NM_001008219.3_3" (Liftoff's third extra copy) -> "NM_001008219"
ACCESSION = re.compile(r"^(NM_\d+)")

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = REPO_ROOT / "frontend" / "public" / "annotations"


def download(url: str, cache_dir: Path) -> Path:
    path = cache_dir / url.rsplit("/", 1)[1]
    if not path.exists():
        print(f"Downloading {url}")
        urllib.request.urlretrieve(url, path)
    return path


def read_mane_select(path: Path) -> dict:
    """Unversioned RefSeq accession -> (symbol, RefSeq id, Ensembl id)."""
    selected = {}
    with gzip.open(path, "rt") as handle:
        header = handle.readline().lstrip("#").rstrip("\n").split("\t")
        col = {name: index for index, name in enumerate(header)}
        for line in handle:
            fields = line.rstrip("\n").split("\t")
            if fields[col["MANE_status"]] != "MANE Select":
                continue
            refseq = fields[col["RefSeq_nuc"]]
            selected[refseq.split(".")[0]] = (
                fields[col["symbol"]],
                refseq,
                fields[col["Ensembl_nuc"]],
            )
    return selected


def read_transcripts(path: Path, mane: dict) -> list:
    """Collects exons and the coding span of every MANE Select transcript."""
    transcript_id_pattern = (
        GFF3_PARENT if path.name.endswith((".gff3.gz", ".gff.gz")) else GTF_TRANSCRIPT_ID
    )
    transcripts = {}
    with gzip.open(path, "rt") as handle:
        for line in handle:
            if line.startswith("#"):
                continue
            fields = line.rstrip("\n").split("\t")
            if len(fields) < 9:
                continue
            chrom, _, feature, start, end, _, strand, _, attributes = fields
            if feature not in ("exon", "CDS", "start_codon", "stop_codon"):
                continue
            if not PRIMARY_CHROM.match(chrom):
                continue
            match = transcript_id_pattern.search(attributes)
            if not match:
                continue
            transcript_id = match.group(1)
            accession = ACCESSION.match(transcript_id)
            if not accession or accession.group(1) not in mane:
                continue

            copy = EXTRA_COPY.search(attributes)
            record = transcripts.setdefault(
                transcript_id,
                {
                    "chrom": chrom,
                    "strand": strand,
                    "mane": mane[accession.group(1)],
                    "extra_copy": int(copy.group(1)) if copy else 0,
                    "exons": [],
                    "coding": [],
                },
            )
            # GTF and GFF3 are 1-based inclusive; BED is 0-based half-open.
            interval = (int(start) - 1, int(end))
            if feature == "exon":
                record["exons"].append(interval)
            else:
                # A GTF CDS excludes the stop codon, so it's added back here
                # to make the thick (coding) part cover the whole ORF.
                record["coding"].append(interval)

    rows = []
    for record in transcripts.values():
        exons = sorted(record["exons"])
        if not exons:
            continue
        start = exons[0][0]
        end = max(exon_end for _, exon_end in exons)
        if record["coding"]:
            thick_start = min(s for s, _ in record["coding"])
            thick_end = max(e for _, e in record["coding"])
        else:
            thick_start = thick_end = start
        symbol, refseq_id, ensembl_id = record["mane"]
        rows.append(
            {
                "accession": refseq_id.split(".")[0],
                "extra_copy": record["extra_copy"],
                "chrom": record["chrom"],
                "start": start,
                "end": end,
                "symbol": symbol,
                "strand": record["strand"],
                "thick_start": thick_start,
                "thick_end": thick_end,
                "exons": exons,
                "refseq": refseq_id,
                "ensembl": ensembl_id,
            }
        )
    return rows


def add_liftoff(rows: list, liftoff_rows: list) -> list:
    """Adds Liftoff's placements of genes missing from rows, and its extra
    gene copies that don't overlap a placement rows already has."""
    placed = defaultdict(list)
    for row in rows:
        placed[row["accession"]].append(row)

    merged = list(rows)
    for row in liftoff_rows:
        existing = placed.get(row["accession"])
        if existing is not None:
            if not row["extra_copy"]:
                continue
            if any(
                other["chrom"] == row["chrom"]
                and other["start"] < row["end"]
                and row["start"] < other["end"]
                for other in existing
            ):
                continue
        merged.append(row)
    return merged


def write_gzip(path: Path, lines: list) -> None:
    # mtime=0 keeps the output byte-identical across rebuilds of the same data.
    with open(path, "wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as handle:
            handle.write("".join(lines).encode())


def write_assembly(assembly: str, rows: list) -> None:
    out_dir = OUTPUT_DIR / assembly
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.gz"):
        old.unlink()

    by_chrom = defaultdict(list)
    for row in rows:
        by_chrom[row["chrom"]].append(row)

    for chrom, chrom_rows in by_chrom.items():
        chrom_rows.sort(key=lambda row: (row["start"], row["end"]))
        lines = []
        for row in chrom_rows:
            refseq = row["refseq"]
            if row["extra_copy"]:
                refseq += f" (extra copy {row['extra_copy']})"
            sizes = ",".join(str(e - s) for s, e in row["exons"])
            starts = ",".join(str(s - row["start"]) for s, _ in row["exons"])
            lines.append(
                f"{chrom}\t{row['start']}\t{row['end']}\t{row['symbol']}\t0\t"
                f"{row['strand']}\t{row['thick_start']}\t{row['thick_end']}\t0\t"
                f"{len(row['exons'])}\t{sizes}\t{starts}\t"
                f"{refseq}\t{row['ensembl']}\n"
            )
        write_gzip(out_dir / f"{chrom}.bed.gz", lines)

    index = sorted(rows, key=lambda row: (row["symbol"].upper(), row["chrom"], row["start"]))
    write_gzip(
        out_dir / "genes.tsv.gz",
        [
            f"{row['symbol']}\t{row['chrom']}\t{row['start']}\t{row['end']}\t{row['strand']}\n"
            for row in index
        ],
    )
    print(
        f"{assembly}: {len(rows)} transcripts, "
        f"{len({row['symbol'] for row in rows})} genes, {len(by_chrom)} chromosomes"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--cache",
        type=Path,
        default=REPO_ROOT / "build" / "annotation-sources",
        help="where downloaded source files are kept",
    )
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)

    mane = read_mane_select(download(MANE_SUMMARY_URL, args.cache))
    print(f"MANE Select v{MANE_VERSION}: {len(mane)} transcripts")
    write_assembly(
        "GRCh38", read_transcripts(download(GRCH38_URL, args.cache), mane)
    )
    write_assembly(
        "CHM13",
        add_liftoff(
            read_transcripts(download(CHM13_URL, args.cache), mane),
            read_transcripts(download(CHM13_LIFTOFF_URL, args.cache), mane),
        ),
    )


if __name__ == "__main__":
    main()
