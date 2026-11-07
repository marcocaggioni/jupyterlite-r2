// jupyter-drive Worker: the front door to the jupyter-lite R2 bucket.
//
// Design (agreed 2026-11-05):
// - Public reads: anyone can list and download, no credentials needed.
// - Writes (upload/delete) require a shared secret in the `x-write-secret`
//   header. The secret is set as a Worker secret named WRITE_SECRET —
//   pick it yourself in the dashboard; it is never shown in chat.
// - The Worker talks to R2 through a bucket BINDING (variable BUCKET), not
//   through S3 keys, so no R2 credentials live in this code at all.
// - CORS allows only https://marcocaggioni.github.io (the JupyterLite site).
//
// Dashboard setup:
//   1. Workers & Pages -> Create Worker, name it `jupyter-drive`.
//   2. Settings -> Variables -> R2 Bucket Bindings: add binding BUCKET -> jupyter-lite.
//   3. Settings -> Variables -> Secrets: add WRITE_SECRET with your chosen secret.
//   4. Paste this file as the Worker code and deploy.
//
// API (consumed later by the jupyter-drive-s3 JupyterLab drive):
//   GET  /api/health                 -> { ok: true }
//   GET  /api/list?prefix=&delimiter=/ -> { objects: [{key,size,uploaded}], folders: [], cursor }
//   GET  /api/file/<key>             -> object bytes (public); Last-Modified
//                                    header carries the R2 upload date
//   HEAD /api/file/<key>             -> headers only (public)
//   PUT  /api/file/<key>             -> upload, needs x-write-secret;
//                                    returns { ok, key, uploaded }
//   DELETE /api/file/<key>           -> delete, needs x-write-secret

const ALLOWED_ORIGIN = 'https://marcocaggioni.github.io';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'ETag, Last-Modified',
    'Access-Control-Max-Age': '3600',
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(), ...extraHeaders },
  });
}

function unauthorized() {
  return json({ error: 'missing or wrong write secret' }, 401);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true });
    }

    if (url.pathname === '/api/list' && request.method === 'GET') {
      const prefix = url.searchParams.get('prefix') || '';
      const delimiter = url.searchParams.get('delimiter') || undefined;
      const cursor = url.searchParams.get('cursor') || undefined;
      const result = await env.BUCKET.list({ prefix, delimiter, cursor, limit: 1000 });
      return json({
        objects: result.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })),
        folders: result.delimitedPrefixes || [],
        cursor: result.truncated ? result.cursor : null,
      });
    }

    const fileMatch = url.pathname.match(/^\/api\/file\/(.+)$/);
    if (fileMatch) {
      const key = decodeURIComponent(fileMatch[1]);

      if (request.method === 'GET' || request.method === 'HEAD') {
        const obj = await env.BUCKET.get(key);
        if (!obj) return json({ error: 'not found' }, 404);
        const headers = { ...corsHeaders(), ETag: obj.httpEtag };
        // The object's real upload date, so the drive can report a true
        // last_modified instead of fabricating "now" (which made
        // JupyterLab report the file as changed on disk on nearly
        // every save).
        if (obj.uploaded) headers['Last-Modified'] = obj.uploaded.toUTCString();
        if (obj.httpMetadata?.contentType) headers['content-type'] = obj.httpMetadata.contentType;
        if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
        return new Response(obj.body, { status: 200, headers });
      }

      if (request.method === 'PUT') {
        if (request.headers.get('x-write-secret') !== env.WRITE_SECRET) return unauthorized();
        const contentType = request.headers.get('content-type') || 'application/octet-stream';
        const result = await env.BUCKET.put(key, request.body, { httpMetadata: { contentType } });
        const uploaded = result.uploaded;
        const extraHeaders = uploaded ? { 'Last-Modified': uploaded.toUTCString() } : {};
        return json(
          { ok: true, key, uploaded: uploaded ? uploaded.toISOString() : null },
          200,
          extraHeaders
        );
      }

      if (request.method === 'DELETE') {
        if (request.headers.get('x-write-secret') !== env.WRITE_SECRET) return unauthorized();
        await env.BUCKET.delete(key);
        return json({ ok: true, key });
      }
    }

    return json({ error: 'not found' }, 404);
  },
};
