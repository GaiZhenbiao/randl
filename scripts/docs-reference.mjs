// Writes docs/reference/tools.md and docs/reference/cli.md from the code: the tool catalog's
// schemas, a request to every tool against a seeded synthetic server with the response it
// got, and `randl --help`. Run `npm run docs` after changing a tool or a command;
// `node scripts/docs-reference.mjs --check` (run by tests/docs.test.mjs) fails when they differ.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import prettier from 'prettier';
import { examples, seed } from './docs/tool-examples.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { createServer } = await import(join(root, 'backend/dist/server.js'));
const { toolCatalog, settingsSchema, viewBodySchema, panelSchema } = await import(
  join(root, 'backend/dist/tools.js')
);
/** Shapes several tools share, documented once at the end of the reference. */
const shared = new Map([
  [viewBodySchema, ['View body', 'view-body']],
  [panelSchema, ['Panel', 'panel']],
  [settingsSchema, ['Plot settings', 'plot-settings']],
]);

/** Tools by section, in the order the reference lists them. */
export const sections = [
  ['Projects', ['project_create', 'project_update', 'project_get', 'project_delete']],
  [
    'Runs',
    [
      'runs_list',
      'run_get',
      'metrics_list',
      'runs_update',
      'run_metadata_update',
      'run_state_set',
      'run_metrics_rename',
      'run_metrics_rename_undo',
      'run_history_write',
      'runs_compare',
      'runs_config_diff',
    ],
  ],
  [
    'Lineage',
    ['project_lineage', 'project_lineage_settings_get', 'project_lineage_settings_update'],
  ],
  [
    'Views and panels',
    [
      'workspace_snapshot',
      'view_create',
      'view_get',
      'view_rename',
      'view_save',
      'view_delete',
      'panel_add',
      'panel_update',
      'panel_remove',
      'runs_select',
      'plugins_list',
    ],
  ],
  [
    'Experiment ledger',
    [
      'finding_save',
      'findings_list',
      'finding_get',
      'finding_delete',
      'recipe_set',
      'recipe_get',
      'journal_add',
      'journal_list',
      'evidence_save',
    ],
  ],
  [
    'Planning',
    [
      'gpus_save',
      'gpus_list',
      'gpus_delete',
      'plan_save',
      'plans_list',
      'plan_queue',
      'plan_move',
      'plan_claim',
      'plan_delete',
      'project_occupancy',
      'idea_save',
      'idea_list',
      'idea_promote',
      'idea_from_plan',
      'idea_delete',
    ],
  ],
  [
    'Settings and media limits',
    [
      'settings_get',
      'settings_update',
      'project_media_limit_get',
      'project_media_limit_update',
      'media_limit_apply',
    ],
  ],
];

/** Runs every example in order on a fresh seeded server; returns each with its response. */
export async function runExamples() {
  const directory = await mkdtemp(join(tmpdir(), 'randl-docs-'));
  const server = await createServer(directory);
  try {
    await seed(server);
    const done = {},
      results = [];
    for (const example of examples) {
      const request =
        typeof example.request === 'function' ? example.request(done) : example.request;
      const response = await server.app.inject({
        method: 'POST',
        url: '/api/tools/' + example.tool,
        payload: request,
      });
      if (response.statusCode !== 200)
        throw Error(`${example.tool} example failed (${response.statusCode}): ${response.body}`);
      done[example.tool] = response.json();
      results.push({ ...example, request, response: response.json() });
    }
    return results;
  } finally {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

// Responses hold times, generated ids and long lists; the reference shows them stable and short.
const day = 1767225600;
function tidy(value, ids, cut, key = '') {
  if (Array.isArray(value)) {
    const kept = value.slice(0, 2).map((item) => tidy(item, ids, cut));
    return cut && value.length > 3
      ? [...kept, `… ${value.length - 2} more`]
      : value.map((item) => tidy(item, ids, cut));
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tidy(v, ids, cut, k)]));
  // Elapsed times (null until a run's first report) depend on how long the examples took;
  // show them as 0.
  if (
    /(runtime|compute|duration|elapsed)$/i.test(key) &&
    (value === null || typeof value === 'number')
  )
    return 0;
  if (typeof value === 'number') {
    if (value > 1.5e9 && value < 2.5e9) return day;
    if (value > 1.5e12 && value < 2.5e12) return day * 1000;
    if (
      /runtime|compute|duration|elapsed|bytes|size|database|wal|rss|heap/i.test(key) &&
      !Number.isInteger(value)
    )
      return Math.round(value);
    return value;
  }
  if (typeof value === 'string') {
    if (/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)) return '2026-01-01T00:00:00.000Z';
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
      /^[0-9a-f]{16,}$/i.test(value)
    ) {
      if (!ids.has(value)) ids.set(value, `id-${ids.size + 1}`);
      return ids.get(value);
    }
    return cut && value.length > 200 ? value.slice(0, 160) + '…' : value;
  }
  return value;
}

/** A schema's type in a few words. */
function typeOf(schema) {
  if (!schema) return 'any';
  if (schema.anyOf) return [...new Set(schema.anyOf.map(typeOf))].join(' or ');
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(', ');
  const type = Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type;
  if (type === 'array') return typeOf(schema.items) + '[]';
  if (type === 'object' && !schema.properties) return 'object';
  return type ?? 'any';
}
/** Limits worth stating: lengths, ranges, counts, patterns. */
function limits(schema) {
  const parts = [];
  if (schema.minLength)
    parts.push(schema.minLength === 1 ? 'non-empty' : `at least ${schema.minLength} characters`);
  if (schema.maxLength && schema.maxLength !== 4096)
    parts.push(`at most ${schema.maxLength} characters`);
  if (schema.minimum !== undefined) parts.push(`≥ ${schema.minimum}`);
  if (schema.exclusiveMinimum !== undefined) parts.push(`> ${schema.exclusiveMinimum}`);
  if (schema.maximum !== undefined) parts.push(`≤ ${schema.maximum}`);
  if (schema.minItems) parts.push(`at least ${schema.minItems} items`);
  if (schema.maxItems) parts.push(`at most ${schema.maxItems.toLocaleString('en')} items`);
  if (schema.uniqueItems) parts.push('unique');
  if (schema.pattern === '^[^_]' || schema.propertyNames?.pattern === '^[^_]')
    parts.push('keys must not start with `_`');
  if (schema.pattern === '^[^/]+$') parts.push('no `/`');
  if (schema.description) parts.push(schema.description);
  if (schema.anyOf) parts.push(...schema.anyOf.flatMap(limits));
  if (schema.items && typeof schema.items === 'object' && !schema.items.properties)
    parts.push(...limits(schema.items).map((part) => 'each ' + part));
  return [...new Set(parts)];
}
/** Parameter rows, nested objects (one level, small ones) flattened as `parent.child`. */
function rows(schema, prefix = '', depth = 0) {
  const out = [];
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    const name = prefix + key,
      required = (schema.required ?? []).includes(key),
      object = value.anyOf?.find((item) => item.properties) ?? value,
      items = value.type === 'array' && value.items?.properties ? value.items : null,
      nested = items ?? (object.properties ? object : null),
      link = shared.get(items ?? object),
      small = !link && nested && Object.keys(nested.properties).length <= 12 && depth < 1;
    out.push({
      name,
      type: small
        ? items
          ? 'object[]'
          : typeOf(value).replace(/^object\b/, 'object')
        : typeOf(value),
      required,
      notes: link
        ? [
            `${items ? 'each ' : ''}see [${link[0]}](#${link[1]})`,
            ...limits({ ...value, items: undefined }),
          ]
        : small
          ? limits({ ...value, properties: undefined })
          : nested
            ? [
                `fields: ${Object.keys(nested.properties)
                  .map((k) => '`' + k + '`')
                  .join(', ')}`,
              ]
            : limits(value),
    });
    if (small) out.push(...rows(nested, name + (items ? '[].' : '.'), depth + 1));
  }
  return out;
}
const cell = (text) => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ');

const ids = new Map();
async function renderTools(results) {
  const json = async (value, cut) =>
    (
      await prettier.format(JSON.stringify(tidy(value, ids, cut)), {
        parser: 'json',
        printWidth: 100,
      })
    ).trimEnd();
  const byTool = new Map(toolCatalog.map((tool) => [tool.name, tool]));
  const listed = sections.flatMap(([, names]) => names);
  const missing = toolCatalog.map((tool) => tool.name).filter((name) => !listed.includes(name));
  const unknown = listed.filter((name) => !byTool.has(name));
  if (missing.length || unknown.length)
    throw Error(`Sections out of date: missing ${missing}, unknown ${unknown}`);
  const lines = [
    '# Tool reference',
    '',
    '<!-- Generated by scripts/docs-reference.mjs from backend/src/tools.ts; do not edit. -->',
    '',
    `randl has ${toolCatalog.length} management tools. The dashboard, the \`randl\` CLI and the`,
    'Assistant all call them. Each one is an HTTP endpoint:',
    '',
    '```http',
    'POST /api/tools/<name>',
    'Content-Type: application/json',
    'Authorization: Bearer $RANDL_API_KEY',
    '',
    '{ …arguments… }',
    '```',
    '',
    'The `Authorization` header is needed only when the server has an API key. `GET /api/tools`',
    'returns the whole catalog with a JSON Schema for each tool, and `randl tool NAME --json ARGS`',
    'calls any tool from the command line.',
    '',
    'Requests are checked against the schema: unknown fields, wrong types and values out of range',
    'are refused with status 400. Every failure has the same body; `code` and `params` are present',
    'when the failure has a stable code that scripts can branch on:',
    '',
    '```json',
    '{ "error": "No GPUs are registered for host gpu-z; add them with gpus_save.", "code": "PLAN_HOST_UNKNOWN", "params": { "host": "gpu-z" } }',
    '```',
    '',
    'Status 503 with `Retry-After` means the database was busy; retry the same request. Tools',
    'marked **not available to the Assistant** are refused to the built-in Assistant but work over',
    'HTTP and the CLI.',
    '',
    'Each example below ran against a server seeded with a synthetic project, `team/navigation`,',
    'in the order shown, so later examples see the effects of earlier ones. Times, generated IDs',
    'and long lists in the responses are shortened.',
    '',
  ];
  for (const [title, names] of sections)
    lines.push(`- **${title}:** ${names.map((name) => `[\`${name}\`](#${name})`).join(', ')}`);
  for (const [title, names] of sections) {
    lines.push('', `## ${title}`);
    for (const name of names) {
      const tool = byTool.get(name),
        mine = results.filter((result) => result.tool === name);
      if (!mine.length) throw Error('No example for ' + name);
      lines.push('', `### ${name}`, '', tool.description);
      if (tool.agent === false) lines.push('', 'Not available to the Assistant.');
      if (tool.tier === 'confirm')
        lines.push('', 'The Assistant may only ask for it; a person confirms in the dashboard.');
      const table = rows(tool.parameters);
      if (table.length) {
        lines.push('', '| Field | Type | Required | Notes |', '| --- | --- | --- | --- |');
        for (const row of table)
          lines.push(
            `| \`${row.name}\` | ${cell(row.type)} | ${row.required ? 'yes' : ''} | ${cell(row.notes.join('; '))} |`,
          );
      } else lines.push('', 'No arguments.');
      for (const result of mine) {
        lines.push(
          '',
          result.label ? `Example (${result.label}):` : 'Example:',
          '',
          '```http',
          `POST /api/tools/${name}`,
          '',
          await json(result.request, false),
          '```',
          '',
          'Response:',
          '',
          '```json',
          await json(result.response, true),
          '```',
        );
        if (result.note) lines.push('', result.note);
      }
      const errors = [...new Set(mine.flatMap((result) => result.errors ?? []))];
      if (errors.length)
        lines.push('', 'Error codes: ' + errors.map((code) => `\`${code}\``).join(', ') + '.');
    }
  }
  lines.push(
    '',
    '## Shared shapes',
    '',
    'Views are saved whole: read one with `view_get`, change its body and save it with `view_save`.',
    'Plot settings apply at three levels, the workspace (`plotSettings`), a section',
    '(`sectionSettings[sectionId]`) and a panel (`settings`); the nearest level that sets a field wins.',
  );
  for (const [schema, [title]] of shared) {
    lines.push(
      '',
      `### ${title}`,
      '',
      '| Field | Type | Required | Notes |',
      '| --- | --- | --- | --- |',
    );
    for (const row of rows(schema))
      lines.push(
        `| \`${row.name}\` | ${cell(row.type)} | ${row.required ? 'yes' : ''} | ${cell(row.notes.join('; '))} |`,
      );
  }
  return lines.join('\n') + '\n';
}

async function renderCli() {
  const { stdout } = await promisify(execFile)(process.execPath, [
    join(root, 'backend/dist/cli.js'),
    '--help',
  ]);
  return [
    '# CLI reference',
    '',
    '<!-- Generated by scripts/docs-reference.mjs from `randl --help`; do not edit. -->',
    '',
    'The `randl` command talks to a server over HTTP, prints JSON on standard output and exits',
    'with a non-zero status after printing the error on standard error. It never prompts.',
    '',
    '- **Server:** `--url`, else `RANDL_URL`, else `http://127.0.0.1:8742`.',
    '- **Key:** `RANDL_API_KEY`, sent as a bearer token, when the server has one.',
    '- **Running it:** `npm run randl -- …` from the repository, or `node /path/to/randl/backend/dist/cli.js …`.',
    '  The docs write `randl …`; `alias randl="node $PWD/backend/dist/cli.js"` makes that work.',
    '',
    'Most commands call one tool from the [tool reference](tools.md); `randl tool NAME --json ARGS`',
    'calls any tool with every argument it takes, including ones a command has no flag for.',
    'Comma-separated flags (`--ids`, `--tags`, `--gpus`, `--cite`) take lists; flags ending in',
    '`-file` read a file, or standard input for `-`.',
    '',
    '```text',
    stdout.trimEnd(),
    '```',
    '',
  ].join('\n');
}

export async function render() {
  const results = await runExamples();
  const options = {
    ...(await prettier.resolveConfig(join(root, 'docs/x.md'))),
    parser: 'markdown',
  };
  return {
    'docs/reference/tools.md': await prettier.format(await renderTools(results), options),
    'docs/reference/cli.md': await prettier.format(await renderCli(), options),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = await render(),
    check = process.argv.includes('--check'),
    stale = [];
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, path);
    if (check) {
      if ((await readFile(target, 'utf8').catch(() => '')) !== text) stale.push(path);
    } else await writeFile(target, text);
  }
  if (stale.length) {
    console.error(`Out of date: ${stale.join(', ')}. Run npm run docs.`);
    process.exitCode = 1;
  }
}
