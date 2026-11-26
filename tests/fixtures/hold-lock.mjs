// Test child: hold the store lock until killed, so the parent can simulate a
// hard-killed owner and verify stale-lock takeover.
import { writeFile } from 'node:fs/promises';
import { DevelopmentStore } from '../../docs/examples/development/store.mjs';

const store = await DevelopmentStore.open(process.argv[2]);
await store.locked(async () => {
  await writeFile(process.argv[3], JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  await new Promise(resolve => setTimeout(resolve, 60_000));
}, 'store');
