import { Store } from '../backend/dist/database.js';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    runs: { type: 'string', default: '400' },
    steps: { type: 'string', default: '800' },
  },
});
if (!values['data-dir']) throw Error('Choose a separate demo database with --data-dir');
const store = new Store(resolve(values['data-dir']));
let seed = 42;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const count = Number(values.runs),
  steps = Number(values.steps);
for (let i = 0; i < count; i++) {
  const run = store.upsert({
    entity: 'demo',
    project: 'synthetic-sweep',
    name: `run-${String(i).padStart(4, '0')}`,
    displayName: `ppo-v${String(i + 1).padStart(3, '0')} · mlp256 · seed ${i % 8}`,
    config: { learning_rate: { value: 0.0003 }, seed: { value: i % 8 } },
  });
  if (run.history_count) continue;
  const quality = 0.65 + random() * 0.35,
    content = [];
  for (let step = 0; step < steps; step++) {
    const t = step / (steps - 1),
      noise = (random() - 0.5) * 0.04;
    content.push(
      JSON.stringify({
        _step: step * 100,
        'reward/mean': Math.max(0, quality * (1 - Math.exp(-5 * t)) + noise),
        'reward/shaped': Math.max(0, quality * (1 - Math.exp(-4 * t)) + noise * 2),
        'loss/policy':
          Math.exp(-6 * t) * 0.3 + noise * 0.3 + (step === Math.floor(steps / 2) ? 0.3 : 0),
        'loss/value': Math.exp(-4 * t) * 0.8 + noise,
        'train/success_rate': Math.min(1, Math.max(0, quality * (1 - Math.exp(-7 * t)) + noise)),
        'train/entropy': 1.6 * Math.exp(-2 * t) + noise,
        'train/episode_length': 800 - 500 * quality * (1 - Math.exp(-3 * t)) + noise * 100,
        'train/learning_rate': 0.0003 * (1 - 0.8 * t),
      }),
    );
  }
  store.ingest(run.id, {
    files: { 'wandb-history.jsonl': { offset: 0, content } },
    complete: i >= 6,
    exitcode: 0,
  });
}
store.db.close();
console.log(`Seeded ${count} synthetic runs × ${steps} records in ${values['data-dir']}`);
