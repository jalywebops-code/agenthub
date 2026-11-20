// "From this computer" (step C): some settings (default models, program paths, folders, phone access) can only be
// changed by someone sitting at the computer AgentHub runs on, never from a phone. Decided on the server from the
// connection itself, never from anything the page says.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * True when a request comes from a browser on this computer: the connection is loopback, nothing forwarded it
 * (`tailscale serve` also arrives over loopback but adds X-Forwarded-For, so a phone through it never counts) and it
 * asked for localhost or 127.0.0.1 by name.
 */
export function fromThisComputer({ peer = '', forwarded = '', host = '' }) {
  if (!LOOPBACK.has(peer) || forwarded) return false;
  const name = String(host).toLowerCase().replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}
