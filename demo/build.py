"""Build the static demo site (GitHub Pages) from the app's own pages.

    python3 demo/build.py [output_dir]   # default: _site

The pages and scripts are the real ones; demo.js answers their /api requests with sample data.
"""
from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "app" / "static"
DEMO = ROOT / "demo"
REPO = "https://github.com/infestacool/moviebrain"

BANNER = f"""<div class="demo-banner">
  <span>🧠 <b>Moviebrain demo</b> · sample data, public-domain titles</span>
  <span class="demo-links"><a href="./">Something playing</a> · <a href="./?idle">Nothing playing</a> · <a href="{REPO}">Get it on GitHub</a></span>
</div>"""


def page(name: str, script: str) -> str:
    html = (STATIC / name).read_text()
    html = html.replace('"/static/', '"static/')            # the site lives under /moviebrain/
    html = html.replace('href="/settings"', 'href="settings.html"').replace('href="/"', 'href="./"')
    html = html.replace("</head>", '  <link rel="stylesheet" href="static/demo/demo.css">\n</head>', 1)
    html = re.sub(r"(<body[^>]*>)", r"\1\n" + BANNER, html, count=1)
    # demo.js must run first, so the app's requests go to it.
    html = html.replace(f'<script src="static/{script}"></script>',
                        f'<script src="static/demo/demo.js"></script>\n  <script src="static/{script}"></script>', 1)
    assert "static/demo/demo.js" in html, f"couldn't add demo.js to {name}"
    return html


def main(out: Path) -> None:
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(STATIC, out / "static")
    (out / "static" / "demo").mkdir()
    for f in ("demo.js", "demo.css", "charade.jpg", "notld-poster.jpg", "notld-backdrop.jpg"):
        shutil.copy(DEMO / f, out / "static" / "demo" / f)
    (out / "index.html").write_text(page("index.html", "app.js"))
    (out / "settings.html").write_text(page("settings.html", "settings.js"))

    manifest = json.loads((STATIC / "manifest.json").read_text())
    manifest["start_url"] = "../"
    for icon in manifest["icons"]:
        icon["src"] = icon["src"].replace("/static/", "")      # relative to the manifest
    (out / "static" / "manifest.json").write_text(json.dumps(manifest, indent=2))
    (out / ".nojekyll").write_text("")                          # serve files as they are
    print(f"Demo site built in {out}")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "_site")
