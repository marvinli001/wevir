"""Build the desktop renderer's bundled fonts (U1). Optional tools: fonttools==4.60.1, brotli==1.1.0.

    python3 -m venv .wevir-dev/fonts-venv
    .wevir-dev/fonts-venv/bin/pip install fonttools==4.60.1 brotli==1.1.0
    .wevir-dev/fonts-venv/bin/python apps/desktop/scripts/build-fonts.py

Downloads the pinned sources below into .wevir-dev/fonts/ (sha256-checked), then writes
apps/desktop/src/renderer/src/assets/fonts/*.woff2 and apps/desktop/licenses/fonts/*/OFL.txt.
WEVIR_GITHUB_MIRROR replaces the https://github.com prefix, same as scripts/fetch-codex.sh.

- Mona Sans and JetBrains Mono: the variable TTFs converted to WOFF2 without any other change. Mona
  Sans has the Reserved Font Name "Mona", so it must not be subset or otherwise modified (OFL §3).

Run it again after changing a version, and update NOTICE §7 and
src/renderer/src/assets/fonts/SOURCE.md with it.
"""

import hashlib
import io
import os
import sys
import urllib.request
import zipfile
from pathlib import Path

from fontTools.ttLib import TTFont

MONA = {
    "url": "https://github.com/github/mona-sans/releases/download/v2.0.27/mona-sans-variable-v2.0.27.zip",
    "sha256": "a95127550b2957ff84cd636d4532b227ddc33d3485082437fa27816ef1d066ec",
}
JETBRAINS = {
    "url": "https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip",
    "sha256": "6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf",
}
DESKTOP = Path(__file__).resolve().parents[1]
REPO = DESKTOP.parents[1]
CACHE = REPO / ".wevir-dev" / "fonts"
OUT = DESKTOP / "src" / "renderer" / "src" / "assets" / "fonts"
LICENSES = DESKTOP / "licenses" / "fonts"


def mirrored(url: str) -> str:
    mirror = os.environ.get("WEVIR_GITHUB_MIRROR", "https://github.com").rstrip("/")
    return mirror + url.removeprefix("https://github.com")


def fetch(source: dict) -> bytes:
    name = source["url"].rsplit("/", 1)[1]
    path = CACHE / source["sha256"][:16] / name
    if path.exists():
        data = path.read_bytes()
    else:
        print(f"下载 {source['url']}")
        with urllib.request.urlopen(mirrored(source["url"]), timeout=300) as response:
            data = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != source["sha256"]:
        sys.exit(f"{name} 的 sha256 不对：{digest}，应为 {source['sha256']}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def member(archive: bytes, name: str) -> bytes:
    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        return zf.read(name)


def to_woff2(data: bytes, target: str) -> None:
    font = TTFont(io.BytesIO(data), recalcTimestamp=False)
    font.flavor = "woff2"
    font.save(OUT / target)


def write_license(folder: str, data: bytes) -> None:
    (LICENSES / folder).mkdir(parents=True, exist_ok=True)
    (LICENSES / folder / "OFL.txt").write_bytes(data)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    mona = fetch(MONA)
    to_woff2(member(mona, "fonts/variable/MonaSansVF[opsz,wght].ttf"), "mona-sans.woff2")
    to_woff2(member(mona, "fonts/variable/MonaSansVF-Italic[opsz,wght].ttf"), "mona-sans-italic.woff2")
    write_license("mona-sans", member(mona, "OFL.txt"))

    jetbrains = fetch(JETBRAINS)
    to_woff2(member(jetbrains, "fonts/variable/JetBrainsMono[wght].ttf"), "jetbrains-mono.woff2")
    to_woff2(member(jetbrains, "fonts/variable/JetBrainsMono-Italic[wght].ttf"), "jetbrains-mono-italic.woff2")
    write_license("jetbrains-mono", member(jetbrains, "OFL.txt"))

    for path in sorted(OUT.glob("*.woff2")):
        print(f"{path.relative_to(REPO)}  {path.stat().st_size / 1024:.1f} KiB")


if __name__ == "__main__":
    main()
