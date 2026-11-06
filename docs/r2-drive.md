# R2 living drive — connection details

This site has a living drive backed by Cloudflare R2, so notebooks and
files live in shared cloud storage instead of only in the browser. Status:
**live** — the drive is the `jupyter-drive-s3` plugin (source in
`extensions/jupyter-drive-s3/`, prebuilt wheel in `vendor/`), talking to
the `jupyter-drive` Cloudflare Worker. No secret keys are stored in this
repo, ever.

## How it works

- The Worker fronts the `jupyter-lite` R2 bucket through a bucket binding
  (variable `BUCKET`): `GET /api/health`, `GET /api/list`, `GET|HEAD
  /api/file/<key>` are public; `PUT|DELETE /api/file/<key>` need the
  `x-write-secret` header.
- **Public reads need no credentials.** Anyone opening the site sees the
  bucket contents in the Drive Browser.
- **Writes need a shared secret** (`WRITE_SECRET`, a Worker secret set in
  the Cloudflare dashboard). It is entered in the running site's
  **Settings → Credentials Provider** (browser storage only, masked
  input); empty means read-only.
- The browser never sees any R2 keys — the Worker holds the bucket
  binding, not S3 credentials. The R2 API token is not needed by the
  Worker at all.

## Bucket

- **Worker:** `https://jupyter-drive.marco-caggioni.workers.dev`
- **Bucket:** `jupyter-lite`
- **Storage class:** Standard (free tier: 10 GB storage, 1M Class A ops,
  10M Class B ops per month, zero egress)

## History

- `jupydrive-s3` 0.1.0 spike (Nov 5, 2026): client-side S3 `IDrive`
  talking directly to R2 with user-entered keys. Verified working in Lite
  (region `auto`, CORS policy on the bucket), but every new user had to
  paste their own R2 keys — that is why the Worker route replaced it.
- `jupyter-drive-s3` 0.1.0 (Nov 5, 2026): custom `IDrive` against the
  Worker REST API, derived from jupydrive-s3 0.1.0. Rebuild the wheel in
  `extensions/jupyter-drive-s3/` (`jlpm install`, `jlpm build:prod`,
  `python -m build --wheel`) and replace `vendor/` after changing the
  TypeScript source; the GitHub Actions deploy installs the wheel from
  `requirements.txt` by path, so it needs no Node.

## GitHub side (frozen content)

The GitHub bridge plugin (`jupyterlab-github`) is read-only by design and
broken in Lite, so it is deliberately **not** installed. Instead, open any
public GitHub-hosted notebook with a URL parameter (see README):

```
https://marcocaggioni.github.io/jupyterlite-r2/lab?fromURL=https://raw.githubusercontent.com/<user>/<repo>/<branch>/<path>.ipynb
```

Multiple `fromURL` values open multiple files; add `fromURLToFolder=<folder>`
to place them in a folder. Fetched files are a local copy in browser storage
— edits do not write back to GitHub.
