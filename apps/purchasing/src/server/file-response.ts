// ---------------------------------------------------------------------------
// file-response.ts — handing a stored file back to a browser, safely.
//
// PCC serves two kinds of file: purchase-order PDFs it generated itself, and
// photographs somebody uploaded from a job site. The second kind is the reason
// this module exists. Its filename and its content type are strings a user
// chose, and both of them end up in response HEADERS, which is a short walk
// from two real problems:
//
//   * a content type of `text/html` on a file whose bytes are a script turns
//     an attachment into stored cross-site scripting the moment a browser
//     renders it — served from PCC's own origin, with the viewer's session;
//   * a quote or a newline in the filename ends the `Content-Disposition`
//     header early and lets the rest of the name write its own headers.
//
// So nothing here trusts what was stored. The disposition is ALWAYS
// `attachment`, so nothing renders in place; the type is drawn from a short
// allow-list and anything unrecognised becomes octet-stream; the filename is
// reduced to safe ASCII for the quoted form and repeated, percent-encoded, in
// the RFC 6266 `filename*` form so accented names still arrive intact.
//
// Sanitizing on the way OUT rather than only on the way in is deliberate: rows
// written before the ingest rules existed are already in the pilot database,
// and they are served by this code too.
//
// NO FRAMEWORK IMPORT HERE, deliberately. These are string rules, and string
// rules should be testable by `node scripts/eval-purchasing.mjs` without a
// bundler — importing `next/server` for a class that only adds sugar over the
// standard Response made this module unloadable outside Next, which is to say
// untestable. Route handlers accept a plain Response.
// ---------------------------------------------------------------------------

/**
 * Types PCC will name on a response. Everything PCC itself generates, plus the
 * shapes a phone camera and a scanner produce.
 *
 * `text/html`, `image/svg+xml` and `application/xml` are absent ON PURPOSE:
 * each can carry script, and none is a thing anybody photographs a packing
 * slip with. They are served as octet-stream, which downloads rather than runs.
 */
const SERVEABLE_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'text/plain',
  'text/csv',
]);

const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/** A content type we are willing to put in a header, or the inert default. */
export function safeContentType(claimed: string | null | undefined): string {
  // Parameters (`; charset=`, `; boundary=`) are dropped rather than parsed:
  // the type alone decides how a browser treats the body, and a parameter is
  // one more place for a stray character to live.
  const bare = (claimed ?? '').split(';')[0].trim().toLowerCase();
  return SERVEABLE_CONTENT_TYPES.has(bare) ? bare : FALLBACK_CONTENT_TYPE;
}

/**
 * A filename fit for a header: no directories, no control characters, no
 * quotes, and not so long that it is the whole header.
 *
 * The path stripping matters beyond this file. The Supabase attachment writer
 * builds a storage key as `<org>/requests/<id>/<filename>`, so a name
 * containing `../` would place one company's photograph outside its own prefix.
 * Names are cleaned where they ENTER (app/actions.ts) for that reason; this is
 * the second pass, for rows that predate it.
 */
export function safeFilename(raw: string | null | undefined, fallback = 'attachment'): string {
  const base = (raw ?? '')
    // Anything after the last separator, whichever kind of machine wrote it.
    .split(/[\\/]/)
    .pop() ?? '';

  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["\\]/g, '')
    .trim()
    // A name that is only dots is `.` or `..` wearing a hat.
    .replace(/^\.+$/, '');

  return (cleaned.slice(0, 120) || fallback);
}

/**
 * The `Content-Disposition` value, in both forms RFC 6266 defines.
 *
 * The quoted form is ASCII-only because a header is bytes; the `filename*`
 * form carries the real name percent-encoded, and every browser in use prefers
 * it when present. So `Reçu #12.jpg` downloads under its own name, and a
 * client that only understands the old form still gets something sensible.
 */
export function contentDisposition(filename: string): string {
  const safe = safeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/**
 * Serve stored bytes as a download.
 *
 * `nosniff` is what stops a browser from deciding for itself that an
 * octet-stream is really HTML — without it the allow-list above is advice.
 * `no-store` keeps a purchase order out of a shared machine's disk cache.
 */
export function fileDownloadResponse(file: {
  bytes: Buffer;
  filename: string;
  contentType: string | null;
  byteSize?: number;
}): Response {
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      'Content-Type': safeContentType(file.contentType),
      'Content-Disposition': contentDisposition(file.filename),
      'Content-Length': String(file.bytes.byteLength),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store, private',
    },
  });
}
