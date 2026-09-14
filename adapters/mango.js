import { MangoClient } from '@jkershaw/mangodb';
import { mkdir, open, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { validateGraph } from '../core/graph.js';

export async function openStore(directory) {
  const path = resolve(directory);
  await mkdir(path, { recursive: true });
  const lockPath = join(path, 'writer.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Store is locked: ${lockPath}. Remove only after confirming no TAG process is running.`);
    throw error;
  }
  const client = new MangoClient(path);
  try {
    await lock.writeFile(String(process.pid));
    await client.connect();
  } catch (error) {
    await lock.close();
    await unlink(lockPath);
    throw error;
  }
  const snapshots = client.db('tag').collection('snapshots');
  let closed = false;
  const checkOpen = () => { if (closed) throw new Error('Store is closed'); };
  return {
    async load() {
      checkOpen();
      const document = await snapshots.findOne({ _id: 'graph' });
      return document ? validateGraph(document.state) : null;
    },
    async save(state, expectedRevision = null) {
      checkOpen();
      validateGraph(state);
      const existing = await snapshots.findOne({ _id: 'graph' });
      if ((existing?.state.revision ?? null) !== expectedRevision) throw new Error('Stale store revision');
      if (existing && state.revision !== expectedRevision + 1) throw new Error('Revision must increase by one');
      // One document commits graph mutations and their audit record together.
      await snapshots.replaceOne({ _id: 'graph' }, { _id: 'graph', state }, { upsert: true });
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await client.close();
      } finally {
        await lock.close();
        await unlink(lockPath);
      }
    },
  };
}
