# jupyterlab-jsoncanvas

Read-only viewer for [JSON Canvas](https://jsoncanvas.org/) (`.canvas`)
files in JupyterLab / JupyterLite.

Double-click a `.canvas` file and the board renders: text cards (Markdown),
file cards (vault path label), link cards (clickable), group containers, and
edges with arrowheads — with pan, zoom, and fit-to-view, a minimap, and
light / dark themes following JupyterLab. Nothing is editable
and nothing is saved back; the file is only read.

Rendering is done by the [Hesprs JSON Canvas Viewer](https://github.com/Hesprs/JSON-Canvas-Viewer)
(`json-canvas-viewer` on npm, MIT), which implements 100% of the JSON
Canvas 1.0 spec. This extension only wires the library into JupyterLab:
file-type registration, the document widget, feeding the parsed `.canvas`
JSON to the viewer, and error handling. File-node attachments are not
remapped, so a referenced file shows as a placeholder rather than a
preview.

## Spec

Rendering follows JSON Canvas 1.0 via the Hesprs library: `nodes` /
`edges` arrays, node types `text`, `file`, `link`, `group`, edge sides
(`top` / `right` / `bottom` / `left`), ends (`none` / `arrow`), labels,
and preset (`"1"`–`"6"`) or hex colors. Files that fail to parse, or are
not JSON objects with `nodes` / `edges` arrays, are reported in the
viewer instead of crashing it.

## Build

```bash
tsc
jupyter labextension build --core-version 4.4.10 .
python -m build --wheel
```

(The `labextension/` output must exist before the wheel build; the hatch
hook skips the npm build when it is already there.)

## Demo

`content/json-canvas-demo.canvas` in the site repo exercises all four node
types, edges with sides / ends / labels / colors, and groups.
