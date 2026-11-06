# R2 living drive — idea, implementation, install

This site has a living drive backed by Cloudflare R2, so notebooks and
files live in shared cloud storage instead of only in the browser. Status:
**live** — the drive is the `jupyter-drive-s3` plugin (source in
`extensions/jupyter-drive-s3/`, prebuilt wheel in `vendor/`), talking to
the `jupyter-drive` Cloudflare Worker. No secret keys are stored in this
repo, ever.

## The idea

A JupyterLite site with two storage plugins, one for each kind of content:

- **A living drive** — an R2-backed shared hard drive. Notebooks (already
  JSON), data files, images, PDFs, folders. Anything you save goes to the
  bucket, and **any JupyterLite install with the drive plugin gets the
  same shared drive** — the bucket is the hard drive, the site is just a
  window onto it.
- **A read-only GitHub bridge for frozen content** — public GitHub-hosted
  notebooks opened with `?fromURL=` (see "GitHub side" below). Frozen
  means frozen: opening one gives you a local copy, edits never write
  back to GitHub.

The auth model follows from that split. **Public reads need no
credentials**: anyone opening the site sees the bucket. **Writes go
through a Worker** that holds the R2 keys and checks a shared secret, so
multiple users can share one Worker — and one bucket — without ever
seeing the keys. A user who knows the secret can save; a user who
doesn't gets a read-only drive.

## How it works

- The Worker fronts the `jupyter-lite` R2 bucket through a bucket
  binding (variable `BUCKET`): `GET /api/health`, `GET /api/list`,
  `GET|HEAD /api/file/<key>` are public; `PUT|DELETE /api/file/<key>`
  need the `x-write-secret` header.
- The plugin is `jupyter-drive-s3` 0.1.0, a custom `Contents.IDrive`
  (derived from jupydrive-s3 0.1.0) that talks to the Worker REST API
  with `fetch()` instead of the AWS S3 SDK. It **replaces the default
  file browser** with the Drive Browser. Settings live in the running
  site under **Settings → Credentials Provider**: Worker URL (default
  `https://jupyter-drive.marco-caggioni.workers.dev`), Custom root path
  (empty = bucket top level), Write secret (empty = read-only).
- **Public reads need no credentials.** Anyone opening the site sees the
  bucket contents in the Drive Browser.
- **Writes need a shared secret** (`WRITE_SECRET`, a Worker secret set in
  the Cloudflare dashboard). It is entered in the running site's
  **Settings → Credentials Provider** (browser storage only, masked
  input); empty means read-only.
- The browser never sees any R2 keys — the Worker holds the bucket
  binding, not S3 credentials. **The R2 API token is not needed by the
  Worker route at all.**
- CORS is set by the Worker itself (`Access-Control-Allow-Origin:
  https://marcocaggioni.github.io`, preflight handled), so **the bucket
  needs no CORS policy for the Worker route**. (A CORS policy on the
  bucket was only needed by the earlier jupydrive-s3 spike, which talked
  to R2 directly from the browser.)

## Bucket

- **Worker:** `https://jupyter-drive.marco-caggioni.workers.dev`
- **Bucket:** `jupyter-lite`
- **Storage class:** Standard (free tier: 10 GB storage, 1M Class A ops,
  10M Class B ops per month, zero egress)

## Installing jupyter-drive-s3 in your own JupyterLite

Two halves: the plugin in your JupyterLite build, and a Worker in front
of your own R2 bucket. Full plugin build details live in
[`extensions/jupyter-drive-s3/README.md`](../extensions/jupyter-drive-s3/README.md).

### 1. The plugin

The quickest route is the prebuilt wheel. Copy `vendor/` from this repo
(or rebuild it from `extensions/jupyter-drive-s3/` — see below) and add
it to your `requirements.txt`:

```
./vendor/jupyter_drive_s3-0.1.0-py3-none-any.whl
```

Then build as usual — the extension is picked up automatically:

```bash
pip install -r requirements.txt
jupyter lite build --contents content --output-dir dist
```

To rebuild the wheel from source after changing the TypeScript:

```bash
cd extensions/jupyter-drive-s3
jlpm install        # node dependencies
jlpm build:prod     # tsc + jupyter labextension build
python -m build     # wheel — replace the one in vendor/
```

The extension replaces the default file browser with the Drive Browser
and points at the Worker URL from its settings. The drive shows the
bucket contents. A second sidebar panel, **Local Files**, shows
JupyterLite's stock browser-storage drive (IndexedDB, per-device, not
shared) — the bundled demo notebooks live there. The R2 Drive Browser
stays the default.

### 2. The Worker

Deploy `worker/index.js` as a Cloudflare Worker named `jupyter-drive`:

1. **Dashboard:** Workers & Pages → Create Worker → paste
   `worker/index.js` as the code → Deploy. (Or `wrangler deploy`
   with `worker/wrangler.toml`.)
2. **R2 bucket binding:** Settings → Variables → R2 Bucket Bindings →
   add binding with variable name `BUCKET` pointing at your bucket.
3. **Write secret:** Settings → Variables → Secrets → add
   `WRITE_SECRET` with a secret you choose (or
   `wrangler secret put WRITE_SECRET`). Anyone who knows it can write
   to the bucket — share it out of band, never in a repo or a URL.
4. **Point the plugin at it:** in the running site, Settings →
   Credentials Provider → Worker URL = your Worker's
   `https://<name>.<subdomain>.workers.dev` address. The default is
   this site's Worker; change it when you deploy your own.

The Worker talks to R2 through the bucket binding — **no R2 API token
is needed, and no S3 keys go into the Worker code**. CORS for your
site's origin is set in `worker/index.js` (`ALLOWED_ORIGIN`); change
that one constant if your site lives elsewhere.

### Notes and limits

- Directories are emulated: R2 has no real folders, so an empty folder
  is a zero-byte object whose key ends in `/`.
- Checkpoints are not implemented (same as jupydrive-s3).
- Renaming a folder from the context menu is disabled; files can be
  renamed.
- The plugin needs JupyterLab >= 4.2.5 / JupyterLite 0.8.x, and
  `jupyter-secrets-manager` for the masked write-secret input.

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
  `requirements.txt` by path, so it needs no Node. Deployed in commit
  `f96c907`; verified live the same evening — the Drive Browser lists
  the bucket contents, Settings shows the Worker URL prefilled with no
  S3/key/region fields, and no errors. The write path (PUT/DELETE with
  the secret) is exercised by the plugin, not by a server-side test.
- `jupyter-drive-s3` 0.1.2 (Nov 6, 2026): adds a second sidebar panel,
  Local Files, for the browser-storage drive (the ContentsManager
  default drive, addressed with unprefixed paths — the drive object is
  named `BrowserStorage`, but that name is not a registered additional
  drive). The R2 Drive Browser is unchanged and stays the default.

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

Why not the plugin: `jupyterlab-github` is read-only in source (save,
delete, rename all reject), and in Lite its auth token is not applied to
frontend requests, leaving the 60-requests-per-hour unauthenticated
GitHub API limit. `?fromURL=` reads from `raw.githubusercontent.com`,
which serves CORS headers, so it just works — same read-only result
without the breakage or the rate limit.
