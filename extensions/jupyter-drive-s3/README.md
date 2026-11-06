# jupyter-drive-s3

A JupyterLab extension that adds a cloud drive backed by Cloudflare R2, reached through a small Cloudflare Worker REST API. It is the living-drive side of the [jupyterlite-r2](https://github.com/marcocaggioni/jupyterlite-r2) site: notebooks and files live in a shared R2 bucket instead of only in the browser, and any JupyterLite install with this plugin gets the same drive.

Derived from [jupydrive-s3](https://github.com/QuantStack/jupydrive-s3) 0.1.0 (QuantStack, BSD-3-Clause): the plugin shell, the default Drive Browser and the `Contents.IDrive` surface are adapted from it; the S3 SDK layer is replaced by `fetch()` calls to the Worker, and the multi-bucket features (bucket switching, copy to another bucket) are removed — there is exactly one drive.

## How it works

The Worker (`jupyter-drive`, Cloudflare dashboard) fronts the `jupyter-lite` R2 bucket through a bucket binding:

- `GET /api/health` → `{ ok: true }`
- `GET /api/list?prefix=&delimiter=/` → `{ objects: [{key, size, uploaded}], folders: [], cursor }`
- `GET /api/file/<key>` → object bytes (public)
- `PUT /api/file/<key>` / `DELETE /api/file/<key>` → need the `x-write-secret` header

Auth model: **public reads need no credentials; writes require a shared secret** (`WRITE_SECRET`, a Worker secret set in the Cloudflare dashboard). The browser never sees any R2 keys — the Worker holds the bucket binding, not S3 credentials.

Settings (`Settings → Credentials Provider` in the running site):

| Setting | Default | Meaning |
|---|---|---|
| Worker URL | `https://jupyter-drive.marco-caggioni.workers.dev` | Base URL of the Worker |
| Custom root path | _(empty)_ | Folder inside the bucket acting as root |
| Write secret | _(empty)_ | Shared secret for saves/uploads/deletes; empty = read-only |

## Build

```bash
jlpm install        # install node dependencies
jlpm build:prod     # tsc + jupyter labextension build
python -m build     # wheel (prebuilt labextension) — see below
```

The wheel is the deploy artifact: it is committed to the site repo under `vendor/` and installed from `requirements.txt` by path (`./vendor/jupyter_drive_s3-0.1.0-py3-none-any.whl`), so the GitHub Actions deploy needs no Node. After changing the TypeScript source, rebuild the wheel and replace the one in `vendor/`.

## Install (local JupyterLite test)

```bash
pip install vendor/jupyter_drive_s3-0.1.0-py3-none-any.whl
jupyter lite build --contents content --output-dir dist
```

The extension replaces the default file browser with the Drive Browser, backed by the Worker. No demo notebooks are bundled into the drive view — the drive shows the bucket contents.

## Notes

- No secrets of any kind live in this repo or in the extension code: no R2 API keys, no write secret. The write secret is entered by each user in the site's Settings (browser storage only) or shared out of band.
- Directories are emulated: R2 has no real folders, so an empty folder is a zero-byte object whose key ends in `/`.
- Checkpoints are not implemented (same as jupydrive-s3): `createCheckpoint` returns an empty checkpoint, `listCheckpoints` is empty, restore/delete reject.
- Directory rename from the context menu is disabled (same as jupydrive-s3); files can be renamed.
