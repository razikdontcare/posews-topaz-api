'use strict';

/**
 * Multipart helpers for tests.
 *
 * The body is assembled from real parts so both orders are valid multipart:
 *
 *   part := "--" boundary CRLF headers CRLF CRLF data
 *   body := part (CRLF part)* CRLF "--" boundary "--" CRLF
 *
 * Two upload styles are supported on purpose:
 *  - `stream` sends a chunked body built from an async generator, which exercises
 *    the streaming path (and the in-flight size limit),
 *  - `blob`  sends a FormData body with an explicit Content-Length, which
 *    exercises the cheap "reject before reading the body" path.
 */

const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');

const CRLF = Buffer.from('\r\n');

function buildPart({ boundary, headers, chunks }) {
  return {
    preamble: Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`),
    chunks,
  };
}

function createMultipartUpload({
  fields = {},
  filename = 'input.mp4',
  fieldName = 'video',
  chunks = [],
  boundary = `----vua${randomUUID().replace(/-/g, '')}`,
  fieldsLast = false,
}) {
  const fieldParts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) =>
      buildPart({
        boundary,
        headers: `Content-Disposition: form-data; name="${name}"`,
        chunks: [Buffer.from(String(value))],
      }),
    );

  const filePart = buildPart({
    boundary,
    headers:
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      'Content-Type: application/octet-stream',
    chunks,
  });

  const ordered = fieldsLast ? [filePart, ...fieldParts] : [...fieldParts, filePart];
  const closing = Buffer.from(`--${boundary}--\r\n`);

  const contentLength =
    ordered.reduce(
      (total, part) => total + part.preamble.length + part.chunks.reduce((n, c) => n + c.length, 0),
      0,
    ) +
    // one CRLF after every part's data (including the last), plus the closing boundary
    CRLF.length * ordered.length +
    closing.length;

  const stream = Readable.from(
    (async function* bodyGenerator() {
      for (const part of ordered) {
        yield part.preamble;
        for (const chunk of part.chunks) yield chunk;
        yield CRLF;
      }
      yield closing;
    })(),
  );

  return {
    boundary,
    contentLength,
    fileBytes: chunks.reduce((total, chunk) => total + chunk.length, 0),
    stream,
    withFields(extraFields) {
      return createMultipartUpload({
        fields: { ...fields, ...extraFields },
        filename,
        fieldName,
        chunks,
        boundary,
        fieldsLast,
      });
    },
  };
}

/** `count` chunks of `chunkSize` bytes filled with a repeating byte. */
function repeatChunks(chunkSize, count, byte = 0x61) {
  const chunk = Buffer.alloc(chunkSize, byte);
  return new Array(count).fill(chunk);
}

/**
 * Uploads a video to the API.
 *
 * @param {string} baseUrl
 * @param {{ fields?: object, filename?: string, chunks?: Buffer[], mode?: 'stream'|'blob',
 *           fieldName?: string, fieldsLast?: boolean, signal?: AbortSignal, path?: string }} options
 */
async function uploadVideo(baseUrl, options = {}) {
  const {
    fields = {},
    filename = 'input.mp4',
    chunks = [Buffer.alloc(2048, 0x61)],
    mode = 'stream',
    fieldName = 'video',
    fieldsLast = false,
    signal,
    path: requestPath = '/api/v1/jobs',
  } = options;
  const multipart = createMultipartUpload({ fields, filename, chunks, fieldName, fieldsLast });

  let response;
  if (mode === 'blob') {
    const form = new FormData();
    form.append(fieldName, new Blob(chunks), filename);
    for (const [name, value] of Object.entries(fields)) {
      if (value !== undefined) form.append(name, String(value));
    }
    response = await fetch(`${baseUrl}${requestPath}`, { method: 'POST', body: form, signal });
  } else {
    response = await fetch(`${baseUrl}${requestPath}`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${multipart.boundary}` },
      body: multipart.stream,
      duplex: 'half',
      signal,
    });
  }

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers, multipart };
}

module.exports = { createMultipartUpload, repeatChunks, uploadVideo };
