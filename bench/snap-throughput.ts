// How fast the snapshot service renders a whole project from a cold cache.
// Usage: node bench/snap-throughput.ts <workspace>
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/node/server/server.ts';
import { SnapshotService } from '../src/node/snapshot/service.ts';

const ws = process.argv[2];
if (!ws) throw new Error('usage: node bench/snap-throughput.ts <workspace>');
for (const d of fs.readdirSync(ws))
  fs.rmSync(path.join(ws, d, '.adl', 'cache', 'snap'), { recursive: true, force: true });
const s = await startServer({ workspace: ws, port: 4750, quiet: true });
const snaps = new SnapshotService(s);
s.snapshots = snaps;
const t0 = Date.now();
await snaps.start();
const t1 = Date.now();
await snaps.idle(600000);
const t2 = Date.now();
const n = [...s.service.projects.keys()].reduce((a, pid) => a + Object.keys(snaps.snapsFor(pid)).length, 0);
console.log(
  `chrome start ${t1 - t0} ms · ${n} snapshots in ${((t2 - t1) / 1000).toFixed(1)} s = ${(n / ((t2 - t1) / 1000)).toFixed(1)}/s`,
);
await s.close();
