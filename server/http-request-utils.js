import { isIP } from 'node:net';

export function clientAddress(request, trustProxy = false) {
  const forwarded = trustProxy ? request?.headers?.['x-forwarded-for'] : null;
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return request?.socket?.remoteAddress ?? 'unknown';
}

export function requestIsSecure(request, trustProxy = false) {
  if (request?.socket?.encrypted) return true;
  if (!trustProxy) return false;
  return String(request?.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase() === 'https';
}

export function requestIsSameOrigin(request) {
  const origin = request?.headers?.origin;
  const host = request?.headers?.host;
  if (typeof host !== 'string' || !host) return false;
  if (typeof origin !== 'string' || !origin) {
    return String(request?.headers?.['sec-fetch-site'] || '').toLowerCase() === 'same-origin';
  }
  try {
    const parsed = new URL(origin);
    return parsed.host === host && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
  } catch {
    return false;
  }
}

function ipv4Network(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

function expandIpv6(address) {
  let value = address.split('%')[0].toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(value);
  if (mapped) return { mappedIpv4: mapped[1] };

  const ipv4Tail = /(\d+\.\d+\.\d+\.\d+)$/u.exec(value);
  if (ipv4Tail) {
    const parts = ipv4Tail[1].split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }
    value = value.slice(0, -ipv4Tail[1].length)
      + `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (left.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))
    || right.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [
    ...left,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'),
    ...right,
  ].map((part) => Number.parseInt(part || '0', 16));
  return groups.length === 8 ? { groups } : null;
}

export function anonymizedNetwork(address) {
  let value = String(address || '').trim();
  if (value.startsWith('[') && value.includes(']')) value = value.slice(1, value.indexOf(']'));
  if (isIP(value) === 4) return ipv4Network(value) ?? 'unknown';
  if (isIP(value.split('%')[0]) !== 6) return 'unknown';
  const expanded = expandIpv6(value);
  if (!expanded) return 'unknown';
  if (expanded.mappedIpv4) return ipv4Network(expanded.mappedIpv4) ?? 'unknown';
  return `${expanded.groups.slice(0, 4).map((part) => part.toString(16)).join(':')}::/64`;
}
