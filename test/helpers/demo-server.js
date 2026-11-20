// Start the real server in demo mode on a free port for a test file, and talk to it like the page does.
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

export async function startDemo() {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, AGENTHUB_DEMO: '1', AGENTHUB_PORT: String(port) }, stdio: 'ignore' });
  const origin = `http://127.0.0.1:${port}`;
  /** A raw request (any Host / Origin / body), answered as { status, headers, text, json }. */
  const request = (method, path, { body, headers = {}, raw } = {}) => new Promise((resolve, reject) => {
    const data = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    // A header given as null is left out (e.g. { origin: null }: a request with no Origin at all).
    const all = { host: `127.0.0.1:${port}`, ...(data !== undefined ? { 'content-type': 'application/json', origin } : {}), ...headers };
    const sent = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== null && v !== undefined));
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: sent }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await request('GET', '/api/hello')).status === 200) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { port, origin, request, stop: () => child.kill('SIGTERM') };
}
