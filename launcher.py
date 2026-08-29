"""PyInstaller entry script.

PyInstaller treats the spec's analysis target as a top-level script,
which breaks `from .app import main` style relative imports in
`jav_scribe/__main__.py`. This wrapper uses an absolute
import so the bundled exe boots cleanly.

`python -m jav_scribe` continues to work via __main__.py.
"""

from jav_scribe.cli import main

if __name__ == "__main__":
    raise SystemExit(main(["gui"]))
