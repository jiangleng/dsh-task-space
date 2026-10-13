// @ts-check
/**
 * dsh-task-space — browser-trust fence for the plugin HTTP routes.
 *
 * Behaviorally identical to the /api gateway's fence in
 * @deepseek-ai/dsh-client-connection (and the fence used by other DSH
 * community plugins): a loopback Host header or a configured trusted
 * authority passes; cross-site browser markers refuse. This is a
 * DNS-rebinding / cross-site defense, NOT authentication.
 *
 * On top of that, every non-GET request must carry the plugin's own
 * `x-dsh-plugin: dsh-task-space` header (the client sets it), so a plain
 * cross-origin form post that happens to pass the origin fence still cannot
 * trigger directory creation or deletion.
 *
 * @module dsh-task-space/trust-fence
 */

/** The header every mutating (non-GET) request must carry. */
export const PLUGIN_HEADER = 'x-dsh-plugin';
/** The value the header must hold. */
export const PLUGIN_HEADER_VALUE = 'dsh-task-space';

/**
 * Decide whether one request may reach the plugin routes.
 * @param {{headers: Record<string, string | string[] | undefined>}} request - node request facts.
 * @param {readonly string[]} trustedHosts - non-loopback authorities this deployment serves.
 * @returns {boolean} true when the Host is ours (loopback or trusted) and browser markers are same-origin.
 */
export function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, 'host');
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false;
  const origin = header(request.headers, 'origin');
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/**
 * A mutating request must also carry the plugin header.
 * @param {{headers: Record<string, string | string[] | undefined>}} request
 * @returns {boolean}
 */
export function hasPluginHeader(request) {
  const value = header(request.headers, PLUGIN_HEADER);
  return value !== undefined && value.toLowerCase() === PLUGIN_HEADER_VALUE;
}

/**
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {string} name
 * @returns {string | undefined}
 */
function header(headers, name) {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** @param {string} authority */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

/**
 * Whether a normalized URL hostname names the local loopback authority.
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Canonical authority form: hostname, or hostname:port when port was written.
 * @param {string} entry - trusted host entry.
 * @param {URL} entryUrl - parsed entry.
 * @returns {string}
 */
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port;
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

/**
 * Whether the request authority matches a trustedHosts entry (exact or port-less).
 * @param {URL} hostUrl - the request's parsed Host URL.
 * @param {readonly string[]} trustedHosts
 * @returns {boolean}
 */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
  });
}
