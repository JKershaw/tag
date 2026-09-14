import { openStore } from './mango.js';
import { createProvider } from './openrouter.js';
import { dispatchRun } from '../core/dispatch.js';

export async function dispatch(task, { directory, apiKey = process.env.OPENROUTER_API_KEY, model, provider } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('An isolated run directory is required');
  const agent = createProvider({ apiKey, model, provider });
  const store = await openStore(directory);
  try {
    return await dispatchRun(task, { store, provider: agent });
  } finally {
    await store.close();
  }
}
