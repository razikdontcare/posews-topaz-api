'use strict';

/**
 * Remote-URL helpers for creating jobs from a link instead of an upload.
 *
 * Two concerns live here:
 *  1. Strict parsing of the client-provided URL (scheme allowlist, no credentials,
 *     bounded length) — never an ffmpeg argument, never a local path.
 *  2. SSRF protection: a request may only fetch a host that resolves to a public
 *     address (loopback, private, link-local, CGNAT, multicast, …) are rejected
 *     unless `URL_ALLOW_PRIVATE_HOSTS=true` is set explicitly.
 *
 * The host is re-checked on every redirect hop by the URL download service, so a
 * public URL cannot bounce to `http://127.0.0.1/`.
 */

const net = require('node:net');
const path = require('node:path');
const dns = require('node:dns/promises');
const { errors } = require('./errors');
const { sanitizeExtension, stripDirectory } = require('./filename');

const MAX_URL_LENGTH = 2048;
const ALLOWED_PROTOCOLS = Object.freeze(['http:', 'https:']);

/** Content-Type -> container extension, used when the URL path has no usable one. */
const CONTENT_TYPE_EXTENSIONS = Object.freeze({
  'video/mp4': '.mp4',
  'video/x-m4v': '.m4v',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi',
  'video/mpeg': '.mpeg',
  'video/mp2t': '.ts',
  'application/mp4': '.mp4',
});

/** Strips the brackets `URL.hostname` keeps around IPv6 literals. */
function unwrapHostname(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '');
}

function ipv4ToInt(ip) {
  const parts = ip.split('.').map((part) => Number(part));
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIpv4(ip) {
  const value = ipv4ToInt(ip);
  const inRange = (base, bits) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  };
  return (
    inRange('0.0.0.0', 8) || // "this network"
    inRange('10.0.0.0', 8) || // private
    inRange('100.64.0.0', 10) || // CGNAT
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local
    inRange('172.16.0.0', 12) || // private
    inRange('192.0.0.0', 24) || // IETF protocol assignments
    inRange('192.168.0.0', 16) || // private
    inRange('198.18.0.0', 15) || // benchmarking
    inRange('198.51.100.0', 24) || // documentation
    inRange('203.0.113.0', 24) || // documentation
    inRange('224.0.0.0', 4) || // multicast
    inRange('240.0.0.0', 4) // reserved
  );
}

function isPrivateIpv6(address) {
  const ip = String(address).toLowerCase().split('%')[0];
  if (ip === '::' || ip === '::1') return true;
  const mapped = ip.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(ip)) return true; // fe80::/10 link local
  if (ip.startsWith('ff')) return true; // ff00::/8 multicast
  if (ip.startsWith('2001:db8')) return true; // documentation
  return false;
}

/** True for loopback/private/link-local/reserved addresses (and anything unknown). */
function isPrivateAddress(address) {
  const ip = unwrapHostname(address);
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  // Not an IP literal: treat as unsafe rather than guessing.
  return true;
}

/**
 * Parses and validates the client-provided URL.
 *
 * @param {unknown} raw
 * @returns {URL}
 * @throws {AppError} INVALID_URL / URL_NOT_ALLOWED
 */
function parseTargetUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw errors.validation('"url" is required and must be a string.', { field: 'url' });
  }
  const value = raw.trim();
  if (value.length > MAX_URL_LENGTH) {
    throw errors.invalidUrl(`"url" must be at most ${MAX_URL_LENGTH} characters.`, {
      field: 'url',
      maxLength: MAX_URL_LENGTH,
    });
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw errors.invalidUrl('"url" is not a valid absolute URL.', { field: 'url' });
  }

  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    throw errors.urlNotAllowed(
      `"url" must use the http or https scheme (received "${url.protocol}").`,
      { field: 'url', allowedProtocols: ['http', 'https'] },
    );
  }
  if (url.username || url.password) {
    throw errors.invalidUrl('"url" must not embed credentials.', { field: 'url' });
  }
  if (!url.hostname) {
    throw errors.invalidUrl('"url" must include a host.', { field: 'url' });
  }
  return url;
}

/**
 * Rejects URLs whose host resolves to a non-public address unless private hosts
 * are explicitly allowed.
 *
 * @param {string} hostname
 * @param {{ allowPrivate?: boolean, lookup?: Function }} [options]
 * @returns {Promise<string[]>} resolved IP addresses
 * @throws {AppError} URL_NOT_ALLOWED / URL_DOWNLOAD_ERROR
 */
async function assertHostAllowed(hostname, options = {}) {
  const allowPrivate = options.allowPrivate === true;
  if (allowPrivate) return [];

  const host = unwrapHostname(hostname).toLowerCase();
  if (!host) throw errors.invalidUrl('"url" must include a host.', { field: 'url' });
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw errors.urlNotAllowed('"url" points at a loopback host, which is not allowed.', {
      field: 'url',
    });
  }

  const lookup = options.lookup || dns.lookup;
  const literal = net.isIP(host);
  let addresses;
  if (literal) {
    addresses = [host];
  } else {
    let records;
    try {
      records = await lookup(host, { all: true, verbatim: true });
    } catch (error) {
      throw errors.urlDownload(`The host "${host}" could not be resolved.`, {
        cause: error,
        details: { host },
      });
    }
    addresses = (Array.isArray(records) ? records : []).map((record) => record.address);
  }

  if (addresses.length === 0) {
    throw errors.urlDownload(`The host "${host}" did not resolve to any address.`, {
      details: { host },
    });
  }
  if (addresses.some((address) => isPrivateAddress(address))) {
    throw errors.urlNotAllowed(
      `"url" resolves to a private, loopback or otherwise reserved address and is not allowed ` +
        '(set URL_ALLOW_PRIVATE_HOSTS=true to permit it).',
      { field: 'url' },
    );
  }
  return addresses;
}

/** `.mp4` when the URL pathname ends in a whitelisted extension, else null. */
function videoExtensionFromUrl(url, allowedExtensions) {
  let pathname = '';
  try {
    pathname = url instanceof URL ? url.pathname : new URL(String(url)).pathname;
  } catch {
    return null;
  }
  const extension = sanitizeExtension(path.extname(pathname));
  if (!extension) return null;
  if (allowedExtensions && !allowedExtensions.has(extension.slice(1))) return null;
  return extension;
}

/** `.mp4`/`.mkv`/… when the response Content-Type maps to a whitelisted one, else null. */
function extensionFromContentType(contentType, allowedExtensions) {
  const mediaType = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const extension = CONTENT_TYPE_EXTENSIONS[mediaType];
  if (!extension) return null;
  if (allowedExtensions && !allowedExtensions.has(extension.slice(1))) return null;
  return extension;
}

/** Best-effort original filename from the final URL (metadata only). */
function filenameFromUrl(url) {
  let pathname = '';
  try {
    pathname = url instanceof URL ? url.pathname : new URL(String(url)).pathname;
  } catch {
    return '';
  }
  const raw = pathname.split('/').filter(Boolean).pop() || '';
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* keep the raw value */
  }
  return stripDirectory(decoded);
}

/** Parses `filename` / `filename*` out of a Content-Disposition header. */
function filenameFromContentDisposition(header) {
  if (!header) return '';
  const value = String(header);

  const extended = value.match(/filename\*\s*=\s*([^;]+)/i);
  if (extended) {
    let raw = extended[1].trim().replace(/^"|"$/g, '');
    const parts = raw.split("''");
    raw = parts.length === 2 ? parts[1] : raw;
    try {
      const decoded = stripDirectory(decodeURIComponent(raw));
      if (decoded) return decoded;
    } catch {
      /* fall through to filename= */
    }
  }

  const basic = value.match(/filename\s*=\s*("([^"]*)"|([^;]+))/i);
  if (basic) {
    const candidate = stripDirectory((basic[2] ?? basic[3] ?? '').trim());
    if (candidate) return candidate;
  }
  return '';
}

/** True when a Content-Type is obviously not a video (used for fast rejection). */
function isObviousNonVideoContentType(contentType) {
  const mediaType = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!mediaType) return false;
  return mediaType.startsWith('text/') || mediaType === 'application/json' || mediaType === 'application/xml';
}

module.exports = {
  ALLOWED_PROTOCOLS,
  CONTENT_TYPE_EXTENSIONS,
  MAX_URL_LENGTH,
  assertHostAllowed,
  extensionFromContentType,
  filenameFromContentDisposition,
  filenameFromUrl,
  isObviousNonVideoContentType,
  isPrivateAddress,
  isPrivateIpv4,
  isPrivateIpv6,
  parseTargetUrl,
  unwrapHostname,
  videoExtensionFromUrl,
};
