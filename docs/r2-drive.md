# R2 living drive — connection details

This site is meant to grow a second, living drive backed by Cloudflare R2,
so notebooks and files live in shared cloud storage instead of only in the
browser. Status: **not yet connected** — this page records what the drive
spike needs. No secret keys are stored in this repo, ever.

## Bucket

- **S3 endpoint:** `https://85d6a5c660ec816b604c5308e69e9937.r2.cloudflarestorage.com`
- **Bucket:** `jupyter-lite`
- **Region:** `auto`
- **Storage class:** Standard (free tier: 10 GB storage, 1M Class A ops,
  10M Class B ops per month, zero egress)

## Credentials (NOT in this repo)

The drive needs an R2 API token: an Access Key ID + a Secret Access Key with
**Object Read & Write** permission, scoped to the `jupyter-lite` bucket.
Marco creates it in the Cloudflare dashboard: **R2 → Manage R2 API Tokens →
Create API token**. The secret is shown exactly once.

- For the `jupydrive-s3` spike, the keys are entered by the user in the
  running site's **Settings → Credentials Provider** (browser storage only).
- For the fallback custom drive (`jupyter-drive-s3`), the keys go into
  **Worker secrets** — the Worker holds them, the browser never sees them.

## Drive spike plan (next step)

1. Add `jupydrive_s3` to `requirements.txt` (client-side S3 `IDrive`,
   endpoint configurable → R2). It is unproven in static JupyterLite.
2. Configure CORS on the `jupyter-lite` bucket (the browser talks to R2
   directly, so R2 must allow the site's origin).
3. In the built site, open Settings → Credentials Provider and enter the
   endpoint, bucket, access key ID and secret access key; check the bucket
   appears as a drive with folders, and that a notebook can be opened,
   edited and saved there.
4. If `jupydrive-s3` fails in Lite, build the custom `jupyter-drive-s3`
   plugin (see `jupyterlite-r2-research.md` §5): an `IDrive` talking to a
   small Cloudflare Worker REST API, keys in Worker secrets.

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
