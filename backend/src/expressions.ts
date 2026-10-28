// Computed-metric expressions: a restricted arithmetic language evaluated per history record.
//
// Shared by the backend (validation, chart computation) and the frontend editor (inline
// validation, autocomplete). Expressions are parsed into an AST and compiled to closures; no
// JavaScript is ever evaluated. Only these forms exist:
//   numbers           1, 0.5, 2e-3
//   metric references ${train/loss}   (the name is everything up to the first `}`)
//   operators         + - * / % **  < <= > >= == != === !==  && || !  ?:  ( )
//   Math              whitelisted Math.<function>(...) calls and Math.<constant> values
// Comparisons and logical operators yield 1 or 0. `-a ** 2` means -(a ** 2).

export const expressionLimits = { length: 1000, nodes: 200, depth: 32, series: 8, name: 200 };

const functions = new Map<string, { fn: (...args: number[]) => number; min: number; max: number }>([
  ['abs', { fn: Math.abs, min: 1, max: 1 }],
  ['sign', { fn: Math.sign, min: 1, max: 1 }],
  ['sqrt', { fn: Math.sqrt, min: 1, max: 1 }],
  ['cbrt', { fn: Math.cbrt, min: 1, max: 1 }],
  ['exp', { fn: Math.exp, min: 1, max: 1 }],
  ['expm1', { fn: Math.expm1, min: 1, max: 1 }],
  ['log', { fn: Math.log, min: 1, max: 1 }],
  ['log1p', { fn: Math.log1p, min: 1, max: 1 }],
  ['log2', { fn: Math.log2, min: 1, max: 1 }],
  ['log10', { fn: Math.log10, min: 1, max: 1 }],
  ['sin', { fn: Math.sin, min: 1, max: 1 }],
  ['cos', { fn: Math.cos, min: 1, max: 1 }],
  ['tan', { fn: Math.tan, min: 1, max: 1 }],
  ['asin', { fn: Math.asin, min: 1, max: 1 }],
  ['acos', { fn: Math.acos, min: 1, max: 1 }],
  ['atan', { fn: Math.atan, min: 1, max: 1 }],
  ['sinh', { fn: Math.sinh, min: 1, max: 1 }],
  ['cosh', { fn: Math.cosh, min: 1, max: 1 }],
  ['tanh', { fn: Math.tanh, min: 1, max: 1 }],
  ['floor', { fn: Math.floor, min: 1, max: 1 }],
  ['ceil', { fn: Math.ceil, min: 1, max: 1 }],
  ['round', { fn: Math.round, min: 1, max: 1 }],
  ['trunc', { fn: Math.trunc, min: 1, max: 1 }],
  ['atan2', { fn: Math.atan2, min: 2, max: 2 }],
  ['pow', { fn: Math.pow, min: 2, max: 2 }],
  ['min', { fn: Math.min, min: 1, max: 8 }],
  ['max', { fn: Math.max, min: 1, max: 8 }],
  ['hypot', { fn: Math.hypot, min: 1, max: 8 }],
]);
const constants = new Map<string, number>([
  ['PI', Math.PI],
  ['E', Math.E],
  ['LN2', Math.LN2],
  ['LN10', Math.LN10],
  ['LOG2E', Math.LOG2E],
  ['LOG10E', Math.LOG10E],
  ['SQRT2', Math.SQRT2],
  ['SQRT1_2', Math.SQRT1_2],
]);

export type ExpressionErrorCode =
  | 'EXPRESSION_EMPTY'
  | 'EXPRESSION_TOO_LONG'
  | 'EXPRESSION_TOO_COMPLEX'
  | 'EXPRESSION_UNEXPECTED'
  | 'EXPRESSION_INCOMPLETE'
  | 'EXPRESSION_UNKNOWN_NAME'
  | 'EXPRESSION_UNKNOWN_MATH'
  | 'EXPRESSION_ARGUMENTS'
  | 'EXPRESSION_UNTERMINATED_REFERENCE'
  | 'EXPRESSION_EMPTY_REFERENCE'
  | 'EXPRESSION_NO_METRIC';
const messages: Record<ExpressionErrorCode, string> = {
  EXPRESSION_EMPTY: 'Enter an expression.',
  EXPRESSION_TOO_LONG: 'Expressions can be up to {limit} characters long.',
  EXPRESSION_TOO_COMPLEX: 'This expression is too complex. Split it or simplify it.',
  EXPRESSION_UNEXPECTED: 'Unexpected “{token}” at position {position}.',
  EXPRESSION_INCOMPLETE: 'The expression ends too early. Complete it after position {position}.',
  EXPRESSION_UNKNOWN_NAME:
    'Unknown name “{token}” at position {position}. Reference metrics as ${metric/name}.',
  EXPRESSION_UNKNOWN_MATH: 'Math.{token} is not available (position {position}).',
  EXPRESSION_ARGUMENTS:
    'Math.{token} received the wrong number of arguments at position {position}.',
  EXPRESSION_UNTERMINATED_REFERENCE: 'Close the metric reference at position {position} with }.',
  EXPRESSION_EMPTY_REFERENCE: 'Enter a metric name in the reference at position {position}.',
  EXPRESSION_NO_METRIC: 'Reference at least one metric, such as ${loss}.',
};
export type ExpressionErrorParams = Record<string, string | number>;
export class ExpressionError extends Error {
  readonly statusCode = 400;
  constructor(
    readonly code: ExpressionErrorCode,
    readonly params: ExpressionErrorParams = {},
  ) {
    super(
      messages[code].replace(/\{(\w+)\}/g, (token, key) =>
        params[key] === undefined ? token : String(params[key]),
      ),
    );
    this.name = 'ExpressionError';
  }
}
export const expressionErrorCodes = Object.keys(messages) as ExpressionErrorCode[];

type Token =
  | { type: 'number'; value: number; position: number; text: string }
  | { type: 'ref'; name: string; position: number; text: string }
  | { type: 'name'; name: string; position: number; text: string }
  | { type: 'op'; op: string; position: number; text: string }
  | { type: 'invalid'; position: number; text: string }
  | { type: 'end'; position: number; text: string };
export type ExpressionNode =
  | { type: 'number'; value: number }
  | { type: 'ref'; name: string }
  | { type: 'unary'; op: string; argument: ExpressionNode }
  | { type: 'binary'; op: string; left: ExpressionNode; right: ExpressionNode }
  | { type: 'conditional'; test: ExpressionNode; then: ExpressionNode; otherwise: ExpressionNode }
  | { type: 'call'; name: string; args: ExpressionNode[] }
  | { type: 'constant'; name: string };

const operators = [
  '===',
  '!==',
  '**',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '?',
  ':',
  '(',
  ')',
  ',',
  '.',
];
const numberPattern = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const namePattern = /^[A-Za-z_$][A-Za-z0-9_$]*/;

export const expressionFunctions: Readonly<Record<string, { min: number; max: number }>> =
  Object.fromEntries([...functions].map(([name, { min, max }]) => [name, { min, max }]));
export const expressionConstants = [...constants.keys()];

export type ExpressionToken = {
  type: 'ref' | 'ref-open' | 'number' | 'name' | 'math' | 'op' | 'invalid' | 'space';
  start: number;
  end: number;
  text: string;
  name?: string;
};
/** Lossless, tolerant scanner. Offsets are zero-based; parser positions remain one-based. */
export function scanExpression(source: string): ExpressionToken[] {
  const tokens: ExpressionToken[] = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    let type: ExpressionToken['type'], text: string, name: string | undefined;
    const space = /^\s+/.exec(rest),
      number = numberPattern.exec(rest),
      identifier = namePattern.exec(rest),
      math = /^Math\.[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
    if (space) {
      type = 'space';
      text = space[0];
    } else if (rest.startsWith('${')) {
      const close = source.indexOf('}', i + 2);
      type = close < 0 ? 'ref-open' : 'ref';
      text = source.slice(i, close < 0 ? source.length : close + 1);
      name = text.slice(2, close < 0 ? undefined : -1);
    } else if (number) {
      type = 'number';
      text = number[0];
    } else if (math) {
      type = 'math';
      text = math[0];
      name = text.slice(5);
    } else if (identifier) {
      type = 'name';
      text = identifier[0];
      name = text;
    } else {
      const op = operators.find((candidate) => rest.startsWith(candidate));
      type = op ? 'op' : 'invalid';
      text = op || rest[0];
    }
    tokens.push({
      type,
      start: i,
      end: i + text.length,
      text,
      ...(name === undefined ? {} : { name }),
    });
    i += text.length;
  }
  return tokens;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  for (const token of scanExpression(source)) {
    const { type, text, start } = token,
      position = start + 1;
    if (type === 'space') continue;
    if (type === 'ref-open')
      throw new ExpressionError('EXPRESSION_UNTERMINATED_REFERENCE', { position });
    if (type === 'ref') {
      if (!token.name!.trim())
        throw new ExpressionError('EXPRESSION_EMPTY_REFERENCE', { position });
      tokens.push({ type, text, position, name: token.name! });
    } else if (type === 'math') {
      tokens.push(
        { type: 'name', name: 'Math', text: 'Math', position },
        { type: 'op', op: '.', text: '.', position: position + 4 },
        { type: 'name', name: token.name!, text: token.name!, position: position + 5 },
      );
    } else if (type === 'number') tokens.push({ type, text, position, value: Number(text) });
    else if (type === 'name') tokens.push({ type, text, position, name: text });
    else if (type === 'op') tokens.push({ type, text, position, op: text });
    else tokens.push({ type, text, position });
  }
  tokens.push({ type: 'end', position: source.length + 1, text: '' });
  return tokens;
}

/** A readable default label, with room for a collision suffix inside the name limit. */
export function suggestedName(expression: string, taken: string[] = []): string {
  const base = expression
    .replace(/\$\{([^}]*)\}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return '';
  const clamp = (length: number) => (base.length > length ? base.slice(0, length - 1) + '…' : base);
  let name = clamp(expressionLimits.name),
    index = 2;
  while (taken.includes(name)) {
    const suffix = ` (${index++})`;
    name = clamp(expressionLimits.name - suffix.length) + suffix;
  }
  return name;
}

const binary: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '===': 3,
  '!==': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

/** Parses an expression into an AST, or throws an ExpressionError with a 1-based position. */
export function parseExpression(source: string): ExpressionNode {
  if (typeof source !== 'string' || !source.trim()) throw new ExpressionError('EXPRESSION_EMPTY');
  if (source.length > expressionLimits.length)
    throw new ExpressionError('EXPRESSION_TOO_LONG', { limit: expressionLimits.length });
  const tokens = tokenize(source);
  let index = 0,
    nodes = 0,
    depth = 0,
    metrics = 0;
  const peek = () => tokens[index];
  const isOp = (op: string) => {
    const token = peek();
    return token.type === 'op' && token.op === op;
  };
  const unexpected = (token = peek()): never => {
    if (token.type === 'end')
      throw new ExpressionError('EXPRESSION_INCOMPLETE', {
        position: Math.max(1, token.position - 1),
      });
    throw new ExpressionError('EXPRESSION_UNEXPECTED', {
      token: token.text,
      position: token.position,
    });
  };
  const expect = (op: string) => {
    if (!isOp(op)) unexpected();
    index++;
  };
  const node = <T extends ExpressionNode>(value: T): T => {
    if (++nodes > expressionLimits.nodes) throw new ExpressionError('EXPRESSION_TOO_COMPLEX');
    return value;
  };
  const nested = <T>(parse: () => T): T => {
    if (++depth > expressionLimits.depth) throw new ExpressionError('EXPRESSION_TOO_COMPLEX');
    try {
      return parse();
    } finally {
      depth--;
    }
  };
  function primary(): ExpressionNode {
    const token = peek();
    if (token.type === 'number') {
      index++;
      return node({ type: 'number', value: token.value });
    }
    if (token.type === 'ref') {
      index++;
      metrics++;
      return node({ type: 'ref', name: token.name });
    }
    if (token.type === 'op' && token.op === '(') {
      index++;
      const inner = nested(conditional);
      expect(')');
      return inner;
    }
    if (token.type === 'name') {
      if (token.name !== 'Math')
        throw new ExpressionError('EXPRESSION_UNKNOWN_NAME', {
          token: token.name,
          position: token.position,
        });
      index++;
      expect('.');
      const member = peek();
      if (member.type !== 'name') unexpected(member);
      const name = (member as { name: string }).name;
      index++;
      if (isOp('(')) {
        const spec = functions.get(name);
        if (!spec)
          throw new ExpressionError('EXPRESSION_UNKNOWN_MATH', {
            token: name,
            position: member.position,
          });
        index++;
        const args: ExpressionNode[] = [];
        if (!isOp(')'))
          for (;;) {
            args.push(nested(conditional));
            if (!isOp(',')) break;
            index++;
          }
        expect(')');
        if (args.length < spec.min || args.length > spec.max)
          throw new ExpressionError('EXPRESSION_ARGUMENTS', {
            token: name,
            min: spec.min,
            max: spec.max,
            position: member.position,
          });
        return node({ type: 'call', name, args });
      }
      if (!constants.has(name))
        throw new ExpressionError('EXPRESSION_UNKNOWN_MATH', {
          token: name,
          position: member.position,
        });
      return node({ type: 'constant', name });
    }
    return unexpected(token);
  }
  // Unary operators bind looser than **, so -a ** 2 is -(a ** 2).
  function unary(): ExpressionNode {
    const token = peek();
    if (token.type === 'op' && ['-', '+', '!'].includes(token.op)) {
      index++;
      return node({ type: 'unary', op: token.op, argument: nested(unary) });
    }
    const base = primary();
    if (isOp('**')) {
      index++;
      return node({ type: 'binary', op: '**', left: base, right: nested(unary) });
    }
    return base;
  }
  function binaryExpression(minimum: number): ExpressionNode {
    let left = unary();
    for (;;) {
      const token = peek();
      const precedence = token.type === 'op' ? binary[token.op] : undefined;
      if (precedence === undefined || precedence < minimum) return left;
      index++;
      const right = nested(() => binaryExpression(precedence + 1));
      left = node({ type: 'binary', op: (token as { op: string }).op, left, right });
    }
  }
  function conditional(): ExpressionNode {
    const test = binaryExpression(1);
    if (!isOp('?')) return test;
    index++;
    const then = nested(conditional);
    expect(':');
    const otherwise = nested(conditional);
    return node({ type: 'conditional', test, then, otherwise });
  }
  const tree = conditional();
  if (peek().type !== 'end') unexpected();
  if (!metrics) throw new ExpressionError('EXPRESSION_NO_METRIC');
  return tree;
}

/** Metric names referenced by an expression, in first-use order. */
export function expressionReferences(tree: ExpressionNode): string[] {
  const names = new Set<string>();
  const visit = (item: ExpressionNode): void => {
    if (item.type === 'ref') names.add(item.name);
    else if (item.type === 'unary') visit(item.argument);
    else if (item.type === 'binary') (visit(item.left), visit(item.right));
    else if (item.type === 'conditional')
      (visit(item.test), visit(item.then), visit(item.otherwise));
    else if (item.type === 'call') item.args.forEach(visit);
  };
  visit(tree);
  return [...names];
}

type Evaluate = (values: number[]) => number;
const truth = (value: unknown) => (value ? 1 : 0);
/**
 * Compiles an AST to a closure over metric values, ordered like `inputs`. The result can be any
 * number, including NaN or ±Infinity; callers decide how to treat non-finite values.
 */
export function compileExpression(tree: ExpressionNode, inputs: string[]): Evaluate {
  const compile = (item: ExpressionNode): Evaluate => {
    switch (item.type) {
      case 'number': {
        const value = item.value;
        return () => value;
      }
      case 'constant': {
        const value = constants.get(item.name)!;
        return () => value;
      }
      case 'ref': {
        const position = inputs.indexOf(item.name);
        if (position < 0) throw Error('Expression input missing: ' + item.name);
        return (values) => values[position];
      }
      case 'unary': {
        const argument = compile(item.argument);
        if (item.op === '-') return (values) => -argument(values);
        if (item.op === '+') return (values) => +argument(values);
        return (values) => (argument(values) ? 0 : 1);
      }
      case 'conditional': {
        const test = compile(item.test),
          then = compile(item.then),
          otherwise = compile(item.otherwise);
        return (values) => (test(values) ? then(values) : otherwise(values));
      }
      case 'call': {
        const fn = functions.get(item.name)!.fn,
          args = item.args.map(compile);
        if (args.length === 1) {
          const [a] = args;
          return (values) => fn(a(values));
        }
        return (values) => fn(...args.map((arg) => arg(values)));
      }
      case 'binary': {
        const a = compile(item.left),
          b = compile(item.right);
        switch (item.op) {
          case '+':
            return (v) => a(v) + b(v);
          case '-':
            return (v) => a(v) - b(v);
          case '*':
            return (v) => a(v) * b(v);
          case '/':
            return (v) => a(v) / b(v);
          case '%':
            return (v) => a(v) % b(v);
          case '**':
            return (v) => a(v) ** b(v);
          case '<':
            return (v) => truth(a(v) < b(v));
          case '<=':
            return (v) => truth(a(v) <= b(v));
          case '>':
            return (v) => truth(a(v) > b(v));
          case '>=':
            return (v) => truth(a(v) >= b(v));
          case '==':
          case '===':
            return (v) => truth(a(v) === b(v));
          case '!=':
          case '!==':
            return (v) => truth(a(v) !== b(v));
          case '&&':
            return (v) => truth(a(v) && b(v));
          case '||':
            return (v) => truth(a(v) || b(v));
        }
      }
    }
    throw Error('Unsupported expression node');
  };
  return compile(tree);
}

export type ComputedMetric = { name: string; expression: string };
/** Validates a panel's computed metrics against its plain metrics; returns parsed expressions. */
export function validateComputedMetrics(expressions: unknown, plain: string[] = []) {
  if (!Array.isArray(expressions) || !expressions.length)
    throw new ExpressionError('EXPRESSION_EMPTY');
  if (expressions.length + plain.length > expressionLimits.series)
    throw new ComputedMetricsError('COMPUTED_METRIC_LIMIT', { limit: expressionLimits.series });
  const names = new Set(plain);
  return expressions.map((item: any, index) => {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!name || name.length > expressionLimits.name)
      throw new ComputedMetricsError('COMPUTED_METRIC_NAME', { index: index + 1 });
    if (names.has(name)) throw new ComputedMetricsError('COMPUTED_METRIC_DUPLICATE', { name });
    names.add(name);
    try {
      const tree = parseExpression(item.expression);
      return {
        name,
        expression: item.expression as string,
        tree,
        inputs: expressionReferences(tree),
      };
    } catch (error) {
      if (error instanceof ExpressionError)
        throw new ExpressionError(error.code, { ...error.params, name });
      throw error;
    }
  });
}
const metricMessages = {
  COMPUTED_METRIC_LIMIT: 'A panel can plot up to {limit} metrics and computed metrics.',
  COMPUTED_METRIC_NAME: 'Name computed metric {index}.',
  COMPUTED_METRIC_DUPLICATE: '“{name}” is already a series in this panel. Choose another name.',
};
export class ComputedMetricsError extends Error {
  readonly statusCode = 400;
  constructor(
    readonly code: keyof typeof metricMessages,
    readonly params: ExpressionErrorParams = {},
  ) {
    super(
      metricMessages[code].replace(/\{(\w+)\}/g, (token, key) =>
        params[key] === undefined ? token : String(params[key]),
      ),
    );
    this.name = 'ComputedMetricsError';
  }
}
export const computedMetricErrorCodes = Object.keys(metricMessages);
