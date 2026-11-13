// The documentation and agent skills against the code: generated references are current, links
// and anchors resolve, every tool request validates against its schema, every `randl` command
// parses, skills have valid frontmatter, and nothing machine-specific is committed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Ajv from 'ajv';
import { parse as parseYaml } from 'yaml';
import { toolCatalog } from '../backend/dist/tools.js';
import { isManagementCode } from '../backend/dist/management-errors.js';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function walk(directory) {
  const out = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (entry.name.endsWith('.md')) out.push(path);
  }
  return out;
}
const top = (await readdir(root)).filter((name) => name.endsWith('.md'));
const files = [...top, ...(await walk('docs')), ...(await walk('.claude/skills'))];
const texts = new Map(
  await Promise.all(files.map(async (file) => [file, await readFile(join(root, file), 'utf8')])),
);
/** Fenced code blocks with their info string. */
const blocks = (text) =>
  [...text.matchAll(/^(`{3,})([^\n`]*)\n([\s\S]*?)^\1\s*$/gm)].map((match) => ({
    lang: match[2].trim(),
    body: match[3],
  }));
const prose = (text) => text.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');

test('the generated tool and CLI references match the code', async () => {
  await run(process.execPath, [join(root, 'scripts/docs-reference.mjs'), '--check'], {
    cwd: root,
  });
});

/** GitHub's heading anchors. */
function anchors(text) {
  const seen = new Map(),
    out = new Set();
  for (const [, heading] of prose(text).matchAll(/^#{1,6} +(.+?) *#*$/gm)) {
    const base = heading
      .replace(/`/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\- _]/gu, '')
      .replace(/ /g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out.add(count ? `${base}-${count}` : base);
  }
  for (const [, id] of text.matchAll(/<a (?:id|name)="([^"]+)"/g)) out.add(id);
  return out;
}

test('relative links and anchors in the docs, READMEs and skills resolve', () => {
  const broken = [];
  for (const [file, text] of texts) {
    const links = [
      ...[...prose(text).matchAll(/\]\(([^)\s]+)(?: "[^"]*")?\)/g)].map((match) => match[1]),
      ...[...text.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]),
    ];
    for (const link of links) {
      if (/^(https?:|mailto:)/.test(link)) continue;
      const [path, anchor] = link.split('#');
      const target = path ? join(dirname(file), decodeURI(path)) : file;
      if (!existsSync(join(root, target))) {
        broken.push(`${file}: ${link}`);
        continue;
      }
      if (anchor && target.endsWith('.md')) {
        const other = texts.get(target);
        if (other && !anchors(other).has(anchor)) broken.push(`${file}: ${link} (no anchor)`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

test('every tool named in the docs and skills exists, and every example request is valid', () => {
  const tools = new Map(toolCatalog.map((tool) => [tool.name, tool]));
  // As the server validates: no coercion, no removal of unknown fields.
  const ajv = new Ajv({ coerceTypes: false, removeAdditional: false, allErrors: true });
  const problems = [];
  let checked = 0;
  for (const [file, text] of texts) {
    for (const [, name] of text.matchAll(/\/api\/tools\/([a-z_]+)/g))
      if (!tools.has(name)) problems.push(`${file}: unknown tool ${name}`);
    for (const block of blocks(text)) {
      const request = /^POST \/api\/tools\/([a-z_]+)\n(?:[A-Za-z-]+: .*\n)*\n([\s\S]+)$/.exec(
        block.body,
      );
      if (block.lang !== 'http' || !request) continue;
      const [, name, body] = request,
        tool = tools.get(name);
      if (!tool) continue;
      let value;
      try {
        value = JSON.parse(body);
      } catch (error) {
        problems.push(`${file}: ${name} body is not JSON: ${error.message}`);
        continue;
      }
      if (!ajv.validate(tool.parameters, value))
        problems.push(`${file}: ${name} ${ajv.errorsText(ajv.errors)}`);
      checked++;
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(checked >= toolCatalog.length, `only ${checked} requests checked`);
});

test('error codes named in the docs and skills are codes the server sends', () => {
  const unknown = [];
  for (const [file, text] of texts)
    for (const [, code] of text.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g))
      if (!isManagementCode(code) && !/^(RANDL|WANDB|PLAYWRIGHT|NODE|CUDA)_/.test(code))
        unknown.push(`${file}: ${code}`);
  assert.deepEqual(unknown, []);
});

/** Shell words of a command line: quoted parts joined, quotes removed, variables as written. */
function words(line) {
  const out = [];
  for (const [word] of line.matchAll(/(?:'[^']*'|"(?:\\.|[^"\\])*"|[^\s'"]+)+/g))
    out.push(
      [...word.matchAll(/'([^']*)'|"((?:\\.|[^"\\])*)"|([^\s'"]+)/g)]
        .map((part) => part[1] ?? part[2]?.replace(/\\(.)/g, '$1') ?? part[3])
        .join(''),
    );
  return out;
}
/** `randl …` invocations in shell blocks, continuation lines joined, cut at pipes. */
function commands(text) {
  const out = [];
  for (const block of blocks(text)) {
    if (!['sh', 'bash', 'shell', ''].includes(block.lang)) continue;
    // Join continuation lines and newlines inside quotes, as the shell reads them.
    let joined = '',
      quote = null;
    for (const char of block.body.replace(/\\\n\s*/g, ' ')) {
      if (quote ? char === quote : char === "'" || char === '"') quote = quote ? null : char;
      joined += quote && char === '\n' ? ' ' : char;
    }
    // A quoted command substitution in an argument, such as --json "$(jq … file)", stands for
    // JSON the example's reader supplies.
    joined = joined.replace(/"\$\((?!\s*(?:npm run randl --|randl)\b)[^)]*\)"/g, "'{}'");
    for (const line of joined.split('\n')) {
      for (const [, command] of line.matchAll(
        /(?:^|\$\(|\|\s*|&&\s*|;\s*)\s*(?:npm run randl --|randl)\s+([^|;)&#]*)/g,
      ))
        out.push(command.replace(/\s*[<>].*$/, '').trim());
    }
  }
  return out;
}

test('every randl command in the docs and skills parses and names its required flags', async () => {
  const seen = new Map();
  for (const [file, text] of texts)
    for (const command of commands(text))
      if (!/^(serve|agent|--help)\b/.test(command) && !seen.has(command)) seen.set(command, file);
  assert.ok(seen.size > 20, `only ${seen.size} commands found`);
  const failures = [];
  // A closed port: parsing and flag checks happen before the request fails to connect.
  const url = 'http://127.0.0.1:9';
  await Promise.all(
    [...seen].map(async ([command, file]) => {
      const args = [...words(command), '--url', url];
      const message = await new Promise((done) => {
        const child = execFile(
          process.execPath,
          [join(root, 'backend/dist/cli.js'), ...args],
          { env: { ...process.env, RANDL_API_KEY: '' }, timeout: 20000 },
          (error, _stdout, stderr) => done(error ? stderr.trim() || error.message : ''),
        );
        child.stdin.end('[]');
      });
      // Reaching the network, or a file the example's reader would supply, means it parsed.
      if (!/fetch failed|ECONNREFUSED|^ENOENT: no such file/.test(message))
        failures.push(`${file}: randl ${command}\n  ${message || 'succeeded without a server'}`);
    }),
  );
  assert.deepEqual(failures, []);
});

test('agent skills have valid frontmatter and stay concise', async () => {
  const skills = await readdir(join(root, '.claude/skills'), { withFileTypes: true });
  const names = skills.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.ok(names.length >= 5);
  for (const name of names) {
    const text = texts.get(join('.claude/skills', name, 'SKILL.md'));
    assert.ok(text, `${name}/SKILL.md is missing`);
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(front, `${name}: no frontmatter`);
    const meta = parseYaml(front[1]);
    assert.equal(meta.name, name);
    assert.match(meta.name, /^[a-z0-9-]{1,64}$/);
    assert.equal(typeof meta.description, 'string');
    assert.ok(meta.description.length > 50 && meta.description.length <= 1024, name);
    assert.doesNotMatch(meta.description, /[<>]/);
    assert.ok(text.split('\n').length <= 500, `${name}: SKILL.md over 500 lines`);
  }
});

test('nothing machine-specific or secret is committed in the docs and skills', async () => {
  // Names that must stay out of the repository can be listed, one per line, in the ignored
  // tmp/private-terms.txt; the test then checks for them too.
  const terms = (await readFile(join(root, 'tmp/private-terms.txt'), 'utf8').catch(() => ''))
    .split('\n')
    .map((term) => term.trim())
    .filter(Boolean);
  const patterns = [
    /\/(?:home|Users)\/[a-z]/,
    /\b(?:sk|pk|ghp|xox[bp])-?[A-Za-z0-9_-]{20,}/,
    // Keys such as `openssl rand -hex 32`; shorter hex strings are commit hashes.
    /\b(?!0+\b)[0-9a-f]{48,}\b/,
    ...terms.map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')),
  ];
  const found = [];
  const extra = await walk('.claude/skills').then(() =>
    readdir(join(root, '.claude/skills'), { recursive: true }),
  );
  const all = new Map(texts);
  for (const path of extra.filter((path) => /\.(js|json|mjs)$/.test(path)))
    all.set(
      join('.claude/skills', path),
      await readFile(join(root, '.claude/skills', path), 'utf8'),
    );
  for (const [file, text] of all)
    for (const pattern of patterns)
      if (pattern.test(text)) found.push(`${relative(root, join(root, file))}: ${pattern}`);
  assert.deepEqual(found, []);
});
