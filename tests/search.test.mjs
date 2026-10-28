import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../frontend/src/search.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { matchScore, highlightRanges } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
);
test('search ranks exact, prefix, segment, substring and fallback subsequences', () => {
  assert.deepEqual(
    ['loss', 'loss/a', 'train/loss', 'gloss', 'long_steps'].map((text) => matchScore('loss', text)),
    [0, 1, 2, 3, 4],
  );
  assert.equal(matchScore('loss', 'long_steps', false), -1);
  assert.equal(matchScore('trun ep', 'rollout/truncated_episodes'), 2);
  assert.equal(matchScore('trun missing', 'rollout/truncated_episodes'), -1);
  assert.equal(matchScore('ＬＯＳＳ', 'loss'), 0);
  assert.equal(matchScore('測定', 'train/測定'), 2);
});
test('highlighting returns original offsets for multiword and compatibility matches', () => {
  assert.deepEqual(highlightRanges('trun ep', 'rollout/truncated_episodes'), [
    [8, 12],
    [18, 20],
  ]);
  assert.deepEqual(highlightRanges('ffi', 'aﬃb'), [[1, 2]]);
  assert.deepEqual(highlightRanges('ls', 'loss'), [
    [0, 1],
    [2, 3],
  ]);
});
