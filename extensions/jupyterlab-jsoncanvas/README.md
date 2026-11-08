# jupyterlab-jsoncanvas

Read-only viewer for [JSON Canvas](https://jsoncanvas.org/) (`.canvas`)
files in JupyterLab / JupyterLite.

Double-click a `.canvas` file and the board renders: text cards (Markdown),
file cards (vault path label), link cards (clickable), group containers, and
edges with arrowheads — with pan, zoom, and fit-to-view. Nothing is editable
and nothing is saved back; the file is only read.

## Spec

Implements JSON Canvas 1.0: `nodes` / `edges` arrays, node types `text`,
`file`, `link`, `group`, edge sides (`top` / `right` / `bottom` / `left`),
ends (`none` / `arrow`), labels, and preset (`"1"`–`"6"`) or hex colors.
Render order follows the array order. Files that fail to parse, or nodes /
edges that do not validate, are reported in the viewer instead of crashing
it.

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
