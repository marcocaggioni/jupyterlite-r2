# JupyterLite Demo

[![lite-badge](https://jupyterlite.rtfd.io/en/latest/_static/badge.svg)](https://jupyterlite.github.io/demo)

JupyterLite deployed as a static site to GitHub Pages, for demo purposes.

## ✨ Try it in your browser ✨

➡️ **https://jupyterlite.github.io/demo**

![github-pages](https://user-images.githubusercontent.com/591645/120649478-18258400-c47d-11eb-80e5-185e52ff2702.gif)

## Requirements

JupyterLite is being tested against modern web browsers:

- Firefox 90+
- Chromium 89+

## Deploy your JupyterLite website on GitHub Pages

Check out the guide on the JupyterLite documentation: https://jupyterlite.readthedocs.io/en/latest/quickstart/deploy.html

## Further Information and Updates

For more info, keep an eye on the JupyterLite documentation:

- How-to Guides: https://jupyterlite.readthedocs.io/en/latest/howto/index.html
- Reference: https://jupyterlite.readthedocs.io/en/latest/reference/index.html

This template provides the Pyodide kernel (`jupyterlite-pyodide-kernel`), the JavaScript kernel (`jupyterlite-javascript-kernel`), and the p5 kernel (`jupyterlite-p5-kernel`), along with other
optional utilities and extensions to make the JupyterLite experience more enjoyable. See the
[`requirements.txt` file](requirements.txt) for a list of all the dependencies provided.

For a template based on the Xeus kernel, see the [`jupyterlite/xeus-python-demo` repository](https://github.com/jupyterlite/xeus-python-demo)

## R2 living drive (in progress)

This site is being wired up to a Cloudflare R2 bucket (`jupyter-lite`) as a
shared, living drive for notebooks and files. Connection details and the
spike plan live in [docs/r2-drive.md](docs/r2-drive.md).

- **S3 endpoint:** `https://85d6a5c660ec816b604c5308e69e9937.r2.cloudflarestorage.com`
- **Bucket:** `jupyter-lite`

No secret keys are stored in this repo. The R2 API token is created by the
bucket owner in the Cloudflare dashboard and entered at runtime (browser
settings for the spike, Worker secrets for the custom drive).

## Open a notebook from a GitHub URL

Append `?fromURL=` with a `raw.githubusercontent.com` link to open any
public GitHub-hosted notebook (read-only copy in browser storage):

```
https://marcocaggioni.github.io/jupyterlite-r2/lab?fromURL=https://raw.githubusercontent.com/<user>/<repo>/<branch>/<path>.ipynb
```

Multiple `fromURL` values open multiple files; `fromURLToFolder=<folder>`
places them in a folder.
