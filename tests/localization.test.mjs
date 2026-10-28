import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { parse } from 'svelte/compiler';
import ts from 'typescript';
const root = new URL('../frontend/src/', import.meta.url);
const languages = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'fr', 'es'];
const catalogs = Object.fromEntries(
  await Promise.all(
    languages.map(async (lang) => [
      lang,
      JSON.parse(await readFile(new URL('locales/' + lang + '.json', root), 'utf8')),
    ]),
  ),
);
const keys = Object.keys(catalogs.en);
const plural = /\.(one|other)$/;
const placeholders = (text) =>
  [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();

test('interface catalogs cover the same keys with matching placeholders', () => {
  for (const [lang, catalog] of Object.entries(catalogs)) {
    assert.deepEqual(Object.keys(catalog).sort(), [...keys].sort(), lang);
    for (const [key, text] of Object.entries(catalog)) {
      assert.ok(typeof text === 'string' && text.trim(), lang + ': ' + key);
      // A singular form may spell out its count ("1 run", "one more metric").
      const expected = placeholders(catalogs.en[key.replace(/\.one$/, '.other')]);
      const actual = placeholders(text);
      if (key.endsWith('.one'))
        assert.deepEqual(
          actual.filter((name) => name !== 'count'),
          expected.filter((name) => name !== 'count'),
          lang + ': ' + key,
        );
      else assert.deepEqual(actual, expected, lang + ': ' + key);
    }
  }
});

test('interface catalogs define each key once, sorted', async () => {
  for (const lang of languages) {
    const text = await readFile(new URL('locales/' + lang + '.json', root), 'utf8');
    const listed = [...text.matchAll(/^ {2}("(?:[^"\\]|\\.)*"):/gm)].map((match) =>
      JSON.parse(match[1]),
    );
    assert.equal(listed.length, Object.keys(catalogs[lang]).length, lang + ' repeats a key');
    assert.deepEqual(listed, [...listed].sort(), lang + ' keys are sorted');
  }
});

test('message keys are hierarchical identifiers, never English text', () => {
  const grammar = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
  for (const key of keys) assert.match(key, grammar);
  // A key names one message: it is never also the parent of other keys.
  for (const key of keys)
    assert.ok(!keys.some((other) => other.startsWith(key + '.')), key + ' is also a parent');
  // Plural forms come in complete pairs.
  for (const key of keys.filter((key) => plural.test(key)))
    assert.ok(
      catalogs.en[key.replace(plural, '.one')] && catalogs.en[key.replace(plural, '.other')],
      key,
    );
});

async function files(directory) {
  return (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map(async (entry) =>
        entry.isDirectory()
          ? files(new URL(entry.name + '/', directory))
          : [new URL(entry.name, directory)],
      ),
    )
  ).flat();
}
/** Every string literal in the interface sources and the shared run field catalog. */
async function literals() {
  const found = [];
  for (const file of await files(root)) {
    if (!/\.(svelte|ts)$/.test(file.pathname)) continue;
    const source = await readFile(file, 'utf8'),
      name = file.pathname.split('/frontend/src/')[1];
    if (file.pathname.endsWith('.svelte')) {
      const walk = (node, call) => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'Literal' && typeof node.value === 'string')
          found.push({ value: node.value, file: name, call });
        const next =
          node.type === 'CallExpression'
            ? node.callee.type === 'Identifier'
              ? node.callee.name
              : node.callee.property?.name
            : call;
        for (const [key, value] of Object.entries(node)) {
          if (key === 'parent') continue;
          if (Array.isArray(value)) value.forEach((item) => walk(item, next));
          else if (value && typeof value === 'object') walk(value, next);
        }
      };
      walk(parse(source, { modern: true }));
    } else {
      const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
      const walk = (node, call) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
          found.push({ value: node.text, file: name, call });
        const next = ts.isCallExpression(node)
          ? node.expression.getText(ast).split('.').at(-1)
          : call;
        ts.forEachChild(node, (child) => walk(child, next));
      };
      walk(ast);
    }
  }
  const fields = JSON.parse(
    await readFile(new URL('../backend/src/run-fields.json', import.meta.url), 'utf8'),
  );
  for (const field of Object.values(fields))
    found.push({ value: field.label, file: 'run-fields.json' });
  // Bundled plugins name randl catalog keys for their option labels.
  const { builtins } = await import('../backend/dist/plugins.js');
  for (const plugin of builtins)
    for (const option of plugin.settings.options)
      for (const key of [
        option.label,
        option.help,
        option.unit,
        ...(option.choices || []).map((choice) => choice.label),
      ])
        if (key) found.push({ value: key, file: 'backend/src/plugins.ts', call: 't' });
  return found;
}
const sources = await literals();

test('every catalog key is referenced by a literal in the interface sources', () => {
  const used = new Set(sources.map((item) => item.value));
  const unused = keys.filter((key) => !used.has(key.replace(plural, '')) && !used.has(key));
  assert.deepEqual(unused, []);
});

test('literal message keys passed to the translators exist', () => {
  const known = new Set([...keys, ...keys.filter((key) => plural.test(key)).map((key) => key.replace(plural, ''))]);
  const missing = sources
    .filter(
      (item) =>
        ['$t', 't', 'translate', 'message'].includes(item.call) &&
        /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(item.value) &&
        !known.has(item.value),
    )
    .map((item) => item.file + ': ' + item.value);
  assert.deepEqual(missing, []);
  // Plural forms are chosen by count; sources name the base key.
  const direct = sources
    .filter((item) => plural.test(item.value) && known.has(item.value))
    .map((item) => item.file + ': ' + item.value);
  assert.deepEqual(direct, []);
});

test('shared run field labels are catalog keys', async () => {
  const { runFieldCatalog } = await import('../backend/dist/run-fields.js');
  for (const field of Object.values(runFieldCatalog))
    for (const [lang, catalog] of Object.entries(catalogs))
      assert.ok(catalog[field.label], lang + ': ' + field.label);
});

test('structured server error codes map to catalog messages', async () => {
  const source = await readFile(new URL('api.ts', root), 'utf8');
  const block = source.slice(source.indexOf('const apiMessages'), source.indexOf('};', source.indexOf('const apiMessages')));
  const mapped = [...block.matchAll(/^\s+'?([\w.]+)'?: '([\w.]+)',$/gm)];
  assert.ok(mapped.length > 40);
  for (const [, code, key] of mapped) assert.ok(catalogs.en[key], code + ' -> ' + key);
  const { agentErrorCodes } = await import('../backend/dist/management-errors.js');
  for (const code of agentErrorCodes)
    assert.ok(mapped.some((item) => item[1] === code), code + ' has an interface message');
});

test('Traditional Chinese uses Taiwan wording', () => {
  // Mainland terms in Traditional script (patterns), with the Taiwan term to use instead.
  // 項目 (item), 代碼 (code number) and 用戶端 (client) are Taiwan usage too.
  const mainland = {
    服務器: '伺服器',
    網絡: '網路',
    界面: '介面',
    賬號: '帳號',
    賬戶: '帳戶',
    菜單: '選單',
    窗口: '視窗',
    對象: '物件',
    默認: '預設',
    設置: '設定',
    程序: '程式',
    信息: '訊息/資訊',
    軟件: '軟體',
    硬件: '硬體',
    '用戶(?!端)': '使用者',
    鼠標: '滑鼠',
    視頻: '影片',
    音頻: '音訊',
    字節: '位元組',
    內存: '記憶體',
    緩存: '快取',
    變量: '變數',
    加載: '載入',
    登錄: '登入',
    數據: '資料',
    文件夾: '資料夾',
    搜索: '搜尋',
    圖標: '圖示',
    鏈接: '連結',
    屏幕: '螢幕',
    全屏: '全螢幕',
    刷新: '重新整理',
    創建: '建立',
    導出: '匯出',
    導入: '匯入',
    支持: '支援',
    粘貼: '貼上',
    剪貼板: '剪貼簿',
    字符: '字元',
    文本: '文字',
    示例: '範例',
    模板: '範本',
    實時: '即時',
    端口: '連接埠',
    隊列: '佇列',
    運行: '執行',
    日誌: '記錄',
    標簽: '標籤',
    質量: '品質',
    選項卡: '分頁',
  };
  const found = [];
  for (const [key, text] of Object.entries(catalogs['zh-Hant']))
    for (const [term, taiwan] of Object.entries(mainland))
      if (new RegExp(term).test(text)) found.push(`${key}: ${term} → ${taiwan}`);
  assert.deepEqual(found, []);
});
