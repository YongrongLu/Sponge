import { isIP } from 'node:net';

export function phoneUrl(request, networks, configuredUrl = '') {
  if (configuredUrl.trim()) return configuredUrl.trim().replace(/\/+$/, '');

  const origin = `${request.protocol}://${request.host}`;
  const parsed = new URL(origin);
  const hostname = parsed.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(hostname)) return origin;

  const interfaces = Object.entries(networks).sort(([a], [b]) =>
    Number(b === 'en0') - Number(a === 'en0') || a.localeCompare(b));
  for (const [, addresses] of interfaces) {
    for (const item of addresses || []) {
      if (item.family !== 'IPv4' || item.internal || isIP(item.address) !== 4 ||
          item.address.startsWith('169.254.') || item.address === '0.0.0.0') continue;
      return `${request.protocol}://${item.address}${parsed.port ? `:${parsed.port}` : ''}`;
    }
  }
  return origin;
}
