#!/usr/bin/env python3
"""Build the two column README header: the gzl.dev portrait, then text.

The source art assumes square character cells. A markdown code block uses cells
roughly 0.40 wide for every 1.0 tall, so the rows are resampled to keep the
proportions of the original. The five characters the site draws with are also
remapped onto a longer ramp, which holds the tones together at small widths.

    python3 scripts/make-header.py            # 64 column portrait, two columns
    python3 scripts/make-header.py 80         # wider portrait
"""
import pathlib, sys

SOURCE_RAMP = " :+X&"                     # the alphabet gzl.dev draws with
OUT_RAMP = " .:-=+*#%@"                   # finer ramp, survives downsampling
LEVEL = {c: i for i, c in enumerate(SOURCE_RAMP)}
CELL_ASPECT = 0.40 / 0.63                 # code block cell / source cell
GUTTER = 4

TEXT = """
GIOVANNI LUPO
─────────────────────────────
new york
gio@gi-os.com
gzl.dev

shops    storefronts, and the
         dashboard that deploys them
phones   twenty kotlin apps, and the
         store they live in
systems  a desktop in a browser tab,
         2015 to version 7
"""

def load(path):
    rows = [r for r in pathlib.Path(path).read_text().split("\n") if r.strip()]
    w = max(len(r) for r in rows)
    return [[LEVEL.get(c, 0) for c in r.ljust(w)] for r in rows]

def resample(grid, width):
    """Box filter to `width` columns, then stretch the contrast over OUT_RAMP."""
    sh, sw = len(grid), len(grid[0])
    height = max(1, round(sh * (width / sw) * CELL_ASPECT))
    tones = []
    for ry in range(height):
        y0, y1 = ry * sh // height, max(ry * sh // height + 1, (ry + 1) * sh // height)
        row = []
        for rx in range(width):
            x0, x1 = rx * sw // width, max(rx * sw // width + 1, (rx + 1) * sw // width)
            cells = [grid[y][x] for y in range(y0, y1) for x in range(x0, x1)]
            row.append(sum(cells) / len(cells) / (len(SOURCE_RAMP) - 1))
        tones.append(row)
    flat = [v for row in tones for v in row]
    lo, hi = min(flat), max(flat)
    span = (hi - lo) or 1
    top = len(OUT_RAMP) - 1
    return ["".join(OUT_RAMP[round((v - lo) / span * top)] for v in row) for row in tones]

def compose(art, width):
    """Portrait on the left, text vertically centered against it on the right."""
    text = TEXT.strip("\n").split("\n")
    top = max(0, (len(art) - len(text)) // 2)
    lines = []
    for i in range(max(len(art), top + len(text))):
        left = art[i] if i < len(art) else " " * width
        right = text[i - top] if top <= i < top + len(text) else ""
        lines.append((left.ljust(width) + " " * GUTTER + right).rstrip())
    return "\n".join(lines)

if __name__ == "__main__":
    width = int(sys.argv[1]) if len(sys.argv) > 1 else 64
    here = pathlib.Path(__file__).parent
    print(compose(resample(load(here / "art-source.txt"), width), width))
