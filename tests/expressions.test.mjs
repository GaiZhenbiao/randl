import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExpression,
  expressionReferences,
  compileExpression,
  validateComputedMetrics,
  expressionLimits,
} from '../backend/dist/expressions.js';

const evaluate = (source, values = {}) => {
  const tree = parseExpression(source),
    inputs = expressionReferences(tree);
  return compileExpression(tree, inputs)(inputs.map((name) => values[name]));
};

test('expressions evaluate arithmetic, precedence, comparisons and Math with metric references', () => {
  const v = { a: 6, 'rollout/b': 3, 'x y': 2, 'c.d': -4 };
  assert.equal(evaluate('${a} / ${rollout/b}', v), 2);
  assert.equal(evaluate('${a} + ${rollout/b} * ${x y}', v), 12);
  assert.equal(evaluate('(${a} + ${rollout/b}) * ${x y}', v), 18);
  assert.equal(evaluate('${x y} ** 3 ** 2', v), 512);
  assert.equal(evaluate('-${x y} ** 2', v), -4);
  assert.equal(evaluate('${a} % 4 - ${c.d}', v), 6);
  assert.equal(evaluate('${a} > ${rollout/b}', v), 1);
  assert.equal(evaluate('${a} === 5 || !${c.d}', v), 0);
  assert.equal(evaluate('${a} > 1 && ${rollout/b} >= 3', v), 1);
  assert.equal(evaluate('${c.d} < 0 ? -${c.d} : ${c.d}', v), 4);
  assert.equal(evaluate('Math.abs(${c.d}) + Math.max(${a}, 10, ${x y})', v), 14);
  assert.equal(evaluate('Math.log(Math.E) * ${a}', v), 6);
  assert.equal(evaluate('Math.atan2(${x y}, 0) * 2 / Math.PI', v), 1);
  assert.equal(evaluate('.5e1 + 1.5 + 2E0 * ${a}', v), 18.5);
  assert.ok(Number.isNaN(evaluate('${a} / 0 - ${a} / 0', v)));
  assert.deepEqual(expressionReferences(parseExpression('${a} / ${b} + ${a}')), ['a', 'b']);
});

test('unsafe or unsupported input is rejected with structured codes and positions', () => {
  const rejects = (source, code, params = {}) =>
    assert.throws(
      () => parseExpression(source),
      (error) => {
        assert.equal(error.code, code, source);
        for (const [key, value] of Object.entries(params)) assert.equal(error.params[key], value);
        assert.equal(error.statusCode, 400);
        return true;
      },
    );
  for (const source of [
    'constructor',
    '__proto__',
    'globalThis',
    'process',
    'require("fs")',
    'eval(1)',
    'Function("return 1")',
    'this',
    'window',
    'loss',
    'rollout.truncated_episodes / rollout.episodes',
  ])
    rejects(source, 'EXPRESSION_UNKNOWN_NAME', { position: 1 });
  rejects('${a}.constructor', 'EXPRESSION_UNEXPECTED', { token: '.' });
  rejects('Math.constructor', 'EXPRESSION_UNKNOWN_MATH', { token: 'constructor' });
  rejects('Math.__proto__', 'EXPRESSION_UNKNOWN_MATH');
  rejects('Math.random()', 'EXPRESSION_UNKNOWN_MATH', { token: 'random' });
  rejects('Math.constructor("return 1")()', 'EXPRESSION_UNKNOWN_MATH');
  rejects('Math["abs"](${a})', 'EXPRESSION_UNEXPECTED', { token: '[' });
  rejects('Math.abs', 'EXPRESSION_UNKNOWN_MATH');
  rejects('Math.abs(${a}, ${b})', 'EXPRESSION_ARGUMENTS', { token: 'abs' });
  rejects('${a} = 1', 'EXPRESSION_UNEXPECTED', { token: '=' });
  rejects('${a} += 1', 'EXPRESSION_UNEXPECTED');
  rejects('${a}++', 'EXPRESSION_INCOMPLETE');
  rejects('"a" + ${a}', 'EXPRESSION_UNEXPECTED', { token: '"', position: 1 });
  rejects('`${a}`', 'EXPRESSION_UNEXPECTED');
  rejects('${a}; ${b}', 'EXPRESSION_UNEXPECTED', { token: ';' });
  rejects('${a} => 1', 'EXPRESSION_UNEXPECTED');
  rejects('[${a}]', 'EXPRESSION_UNEXPECTED');
  rejects('{}', 'EXPRESSION_UNEXPECTED');
  rejects('${a} +', 'EXPRESSION_INCOMPLETE');
  rejects('(${a}', 'EXPRESSION_INCOMPLETE');
  rejects('${a} ? 1', 'EXPRESSION_INCOMPLETE');
  rejects('${a', 'EXPRESSION_UNTERMINATED_REFERENCE', { position: 1 });
  rejects('1 + ${ }', 'EXPRESSION_EMPTY_REFERENCE', { position: 5 });
  rejects('1 + 2', 'EXPRESSION_NO_METRIC');
  rejects('Math.PI', 'EXPRESSION_NO_METRIC');
  rejects('', 'EXPRESSION_EMPTY');
  rejects('   ', 'EXPRESSION_EMPTY');
  rejects('${a} + '.repeat(200) + '${a}', 'EXPRESSION_TOO_LONG', {
    limit: expressionLimits.length,
  });
  rejects('('.repeat(40) + '${a}' + ')'.repeat(40), 'EXPRESSION_TOO_COMPLEX');
  rejects(Array.from({ length: 120 }, () => '${a}').join('+'), 'EXPRESSION_TOO_COMPLEX');
  assert.throws(() => parseExpression(42), { code: 'EXPRESSION_EMPTY' });
});

test('metric names are data: prototype-like names are ordinary references', () => {
  const tree = parseExpression('${constructor} + ${__proto__}');
  assert.deepEqual(expressionReferences(tree), ['constructor', '__proto__']);
  assert.equal(compileExpression(tree, ['constructor', '__proto__'])([1, 2]), 3);
});

test('panel computed metrics validate names, collisions and the series limit', () => {
  const parsed = validateComputedMetrics([{ name: ' Rate ', expression: '${a} / ${b}' }], ['loss']);
  assert.equal(parsed[0].name, 'Rate');
  assert.deepEqual(parsed[0].inputs, ['a', 'b']);
  assert.throws(() => validateComputedMetrics([{ name: '', expression: '${a}' }]), {
    code: 'COMPUTED_METRIC_NAME',
  });
  assert.throws(() => validateComputedMetrics([{ name: 'loss', expression: '${a}' }], ['loss']), {
    code: 'COMPUTED_METRIC_DUPLICATE',
  });
  assert.throws(
    () =>
      validateComputedMetrics([
        { name: 'r', expression: '${a}' },
        { name: 'r', expression: '${b}' },
      ]),
    { code: 'COMPUTED_METRIC_DUPLICATE' },
  );
  assert.throws(
    () =>
      validateComputedMetrics(
        Array.from({ length: 3 }, (_, i) => ({ name: 'c' + i, expression: '${a}' })),
        Array.from({ length: 6 }, (_, i) => 'm' + i),
      ),
    { code: 'COMPUTED_METRIC_LIMIT', params: { limit: 8 } },
  );
  assert.throws(() => validateComputedMetrics([{ name: 'bad', expression: 'process.exit()' }]), {
    code: 'EXPRESSION_UNKNOWN_NAME',
    params: { token: 'process', position: 1, name: 'bad' },
  });
});

test('tolerant scanning is lossless and uses parser positions', async () => {
  const { scanExpression } = await import('../backend/dist/expressions.js');
  for (const source of ['${a', '${}', '  Math.log(${a}) + .5e2 @', '${a} ) 2', 'unknown + ${a}']) {
    const tokens = scanExpression(source);
    assert.equal(tokens.map((token) => token.text).join(''), source);
    for (const token of tokens) assert.equal(source.slice(token.start, token.end), token.text);
    try {
      parseExpression(source);
    } catch (error) {
      if (error.params.position)
        assert.ok(
          tokens.some(
            (token) =>
              token.start <= error.params.position - 1 && token.end > error.params.position - 1,
          ),
        );
    }
  }
  assert.equal(scanExpression('${a')[0].type, 'ref-open');
  assert.equal(scanExpression('Math.log')[0].type, 'math');
  // Lexical reference errors still precede parser errors.
  assert.throws(() => parseExpression('unknown ${a'), {
    code: 'EXPRESSION_UNTERMINATED_REFERENCE',
    params: { position: 9 },
  });
});

test('suggested names strip references, collapse whitespace and bound collision suffixes', async () => {
  const { suggestedName } = await import('../backend/dist/expressions.js');
  assert.equal(suggestedName(' ${a}  /\n ${b} '), 'a / b');
  assert.equal(suggestedName('  '), '');
  assert.equal(suggestedName('${a}', ['a', 'a (2)']), 'a (3)');
  const long = suggestedName('x'.repeat(250));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
  const duplicate = suggestedName('x'.repeat(250), [long]);
  assert.equal(duplicate.length, 200);
  assert.ok(duplicate.endsWith('… (2)'));
});
