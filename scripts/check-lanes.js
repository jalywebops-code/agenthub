// Live connection check for every lane. Run: npm run check
// Reads only. Sends nothing.
import { LANES } from '../lib/board.js';

let failed = 0;
for (const [key, lane] of Object.entries(LANES)) {
  const started = Date.now();
  try {
    const res = await lane.mod.collect();
    const counts = {};
    for (const c of res.cards) counts[c.status] = (counts[c.status] || 0) + 1;
    console.log(`${res.connected ? 'LIVE   ' : 'BLOCKED'} ${lane.name.padEnd(12)} ${String(Date.now() - started).padStart(5)}ms  ${JSON.stringify(counts)}`);
    console.log(`        ${res.reason}`);
    if (!res.connected) failed++;
  } catch (e) {
    failed++;
    console.log(`ERROR   ${lane.name}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
