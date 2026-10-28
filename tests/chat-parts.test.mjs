import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../frontend/src/chat-parts.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { chatParts } = await import(
  'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
);
const shape = (parts) =>
  parts.map((part) => (part.kind === 'text' ? part.text : part.actions.map((action) => action.id)));

test('assistant turns interleave text and tool calls in the order they occurred', () => {
  const response = 'Creating a view.\n\nSelecting runs.\n\nDone.';
  const second = response.indexOf('Selecting'),
    third = response.indexOf('Done');
  assert.deepEqual(
    shape(
      chatParts(response, [
        { id: 'create', at: second },
        { id: 'select', at: third },
        { id: 'pin', at: third },
      ]),
    ),
    ['Creating a view.\n\n', ['create'], 'Selecting runs.\n\n', ['select', 'pin'], 'Done.'],
  );
  // A tool before any text and a tool after all text.
  assert.deepEqual(
    shape(
      chatParts('Answer', [
        { id: 'first', at: 0 },
        { id: 'last', at: 6 },
      ]),
    ),
    [['first'], 'Answer', ['last']],
  );
  // While streaming, the text after the latest tool may still be empty.
  assert.deepEqual(shape(chatParts('Checking.\n\n', [{ id: 'run', at: 11 }])), [
    'Checking.\n\n',
    ['run'],
  ]);
});

test('turns saved without tool positions keep their tools before the text', () => {
  assert.deepEqual(shape(chatParts('Done.', [{ id: 'a' }, { id: 'b' }])), [['a', 'b'], 'Done.']);
  assert.deepEqual(shape(chatParts('', [])), []);
  // Positions beyond the text (for example after trimming) clamp to its end.
  assert.deepEqual(shape(chatParts('Done.', [{ id: 'a', at: 99 }])), ['Done.', ['a']]);
});

test('continuing old turns mixes legacy and positioned tools without moving existing groups', () => {
  const response = 'Earlier reply.\n\nChecking 🧪.\n\nDone.';
  const at = response.indexOf('Done.');
  const actions = [{ id: 'legacy' }, { id: 'new', at }];
  assert.deepEqual(shape(chatParts(response, actions)), [
    ['legacy'],
    response.slice(0, at),
    ['new'],
    'Done.',
  ]);
  const keys = chatParts(response, actions)
    .filter((part) => part.kind === 'actions')
    .map((part) => part.key);
  assert.deepEqual(
    chatParts(response.slice(0, at), actions)
      .filter((part) => part.kind === 'actions')
      .map((part) => part.key),
    keys,
  );
  assert.deepEqual(
    shape(
      chatParts('Before\n\nAfter', [
        { id: 'a', at: 6 },
        { id: 'b', at: 8 },
      ]),
    ),
    ['Before', ['a', 'b'], 'After'],
  );
});
