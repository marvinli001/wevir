"""Regenerate the outlined wordmark. Optional tool: fonttools==4.60.1.

Font source: github/mona-sans, fonts/static/ttf/MonaSans-Bold.ttf,
commit 4bc6ba8b354c36b4fb66d32cd67b4c1f2beb0a06, SIL OFL-1.1.
"""
import json
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parents[2]
font = TTFont(root / "assets/icons/source/fonts/MonaSans-Bold.ttf")
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
scale = 100 / font["head"].unitsPerEm
paths = []
x = 0
bounds = []
for character in "Wevir":
    glyph = glyphs[cmap[ord(character)]]
    pen = SVGPathPen(glyphs, ntos=lambda n: f"{n:.4f}".rstrip("0").rstrip("."))
    transform = (scale, 0, 0, -scale, x, 0)
    glyph.draw(TransformPen(pen, transform))
    paths.append(pen.getCommands())
    bp = BoundsPen(glyphs)
    glyph.draw(TransformPen(bp, transform))
    bounds.append(bp.bounds)
    x += glyph.width * scale - 1.2
box = [min(b[0] for b in bounds), min(b[1] for b in bounds), max(b[2] for b in bounds), max(b[3] for b in bounds)]
result = {
    "font": "Mona Sans Bold",
    "license": "OFL-1.1",
    "source": "github/mona-sans/fonts/static/ttf/MonaSans-Bold.ttf",
    "commit": "4bc6ba8b354c36b4fb66d32cd67b4c1f2beb0a06",
    "paths": paths,
    "bounds": box,
}
(root / "assets/icons/source/wordmark-paths.json").write_text(json.dumps(result, indent=2) + "\n")
print("Outlined Wevir wordmark generated")
