#!/usr/bin/env python3
"""Rebuild the ASCII header from the gzl.dev portrait.

The source art assumes square character cells. A markdown code block uses cells
that are roughly 0.40 wide for every 1.0 tall, so the rows get resampled to keep
the proportions of the original. Run from the profile-readme directory:

    python3 scripts/make-header.py 100 > /tmp/header.txt
"""
import pathlib, sys

RAMP = " :+X&"                       # light to dark, the alphabet the site uses
LEVEL = {c: i for i, c in enumerate(RAMP)}
CELL_ASPECT = 0.40 / 0.63            # code block cell / source cell

def load(path):
    rows = [r for r in pathlib.Path(path).read_text().split("\n") if r.strip()]
    w = max(len(r) for r in rows)
    return [[LEVEL.get(c, 0) for c in r.ljust(w)] for r in rows]

def resample(grid, width):
    sh, sw = len(grid), len(grid[0])
    height = max(1, round(sh * (width / sw) * CELL_ASPECT))
    out = []
    for ry in range(height):
        y0, y1 = ry * sh // height, max(ry * sh // height + 1, (ry + 1) * sh // height)
        row = []
        for rx in range(width):
            x0, x1 = rx * sw // width, max(rx * sw // width + 1, (rx + 1) * sw // width)
            cells = [grid[y][x] for y in range(y0, y1) for x in range(x0, x1)]
            row.append(RAMP[min(4, max(0, round(sum(cells) / len(cells))))])
        out.append("".join(row).rstrip())
    return out

if __name__ == "__main__":
    width = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    here = pathlib.Path(__file__).parent
    print("\n".join(resample(load(here / "art-source.txt"), width)))
