import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from './db.js';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export type Hosting = { host?: string; publicUrl?: string; apiKey?: string; sessionHours?: number };
export async function configureAuth(app: FastifyInstance, db: DB, options: Hosting) {
  const host = options.host || '127.0.0.1',
    publicUrl = options.publicUrl ? new URL(options.publicUrl) : undefined,
    key = options.apiKey || '';
  const remote =
    !['127.0.0.1', 'localhost', '::1'].includes(host) ||
    (!!publicUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(publicUrl.hostname));
  if (remote && (!publicUrl || !key))
    throw Error('Remote hosting requires --public-url and RANDL_API_KEY');
  if (key && key.length < 40) throw Error('RANDL_API_KEY must contain at least 40 characters');
  if (remote && publicUrl!.protocol !== 'https:')
    throw Error('Remote public URLs require HTTPS; terminate TLS at your reverse proxy');
  if (
    publicUrl &&
    (publicUrl.username ||
      publicUrl.password ||
      publicUrl.pathname !== '/' ||
      publicUrl.search ||
      publicUrl.hash)
  )
    throw Error('Public URL must be an origin without credentials, path, query or fragment');
  const enabled = !!key,
    secure = publicUrl?.protocol === 'https:',
    cookieName = secure ? '__Host-randl' : 'randl_session',
    sessionSeconds = Math.min(24 * 7, Math.max(1, options.sessionHours || 12)) * 3600;
  const allowedHosts = new Set([
      '127.0.0.1',
      'localhost',
      ...(publicUrl ? [publicUrl.hostname] : []),
    ]),
    failures = new Map<string, { count: number; until: number }>();
  await db.call('authConfigure', enabled ? digest(key) : '');
  const valid = (candidate: string) =>
    candidate.length <= 4096 &&
    timingSafeEqual(Buffer.from(digest(candidate), 'hex'), Buffer.from(digest(key), 'hex'));
  const cookie = (req: FastifyRequest) =>
    String(req.headers.cookie || '')
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(cookieName + '='))
      ?.slice(cookieName.length + 1) || '';
  const apiToken = (req: FastifyRequest) => {
    const header = String(req.headers.authorization || '');
    if (header.startsWith('Bearer ')) return header.slice(7);
    if (header.startsWith('Basic ')) {
      const value = Buffer.from(header.slice(6), 'base64').toString();
      return value.slice(value.indexOf(':') + 1);
    }
    return '';
  };
  const signature = (method: string, path: string, expires: string) =>
    createHmac('sha256', key)
      .update(method + '\n' + path + '\n' + expires)
      .digest('hex');
  const signed = (req: FastifyRequest) => {
    if (!enabled || !/^\/(upload|storage)\//.test(req.url)) return false;
    const url = new URL(req.url, 'http://localhost'),
      expires = url.searchParams.get('expires') || '',
      value = url.searchParams.get('signature') || '';
    if (
      !/^\d+$/.test(expires) ||
      !/^[a-f0-9]{64}$/.test(value) ||
      Number(expires) < Date.now() / 1000 ||
      Number(expires) > Date.now() / 1000 + 3600
    )
      return false;
    return timingSafeEqual(
      Buffer.from(value, 'hex'),
      Buffer.from(signature(req.method, url.pathname, expires), 'hex'),
    );
  };
  const signUrl = (urlString: string, method: string) => {
    if (!enabled) return urlString;
    const url = new URL(urlString),
      expires = String(Math.floor(Date.now() / 1000) + 1800);
    url.searchParams.set('expires', expires);
    url.searchParams.set('signature', signature(method, url.pathname, expires));
    return url.toString();
  };
  const authenticated = async (req: FastifyRequest) => {
    if (!enabled || signed(req)) return true;
    const token = apiToken(req);
    if (token && valid(token)) return true;
    const session = cookie(req);
    return /^[a-f0-9]{64}$/.test(session) && !!(await db.call('sessionGet', digest(session)));
  };
  app.addHook('onRequest', async (req, reply) => {
    if (!allowedHosts.has(req.hostname))
      return reply.code(403).send({ error: 'Host is not configured for randl' });
    const origin = req.headers.origin,
      localOrigins = new Set([
        `http://${req.headers.host}`,
        ...(!remote ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : []),
      ]);
    const permitted = origin
      ? remote
        ? origin === publicUrl!.origin
        : localOrigins.has(origin) || origin === publicUrl?.origin
      : true;
    if (!permitted || req.headers['sec-fetch-site'] === 'cross-site')
      return reply.code(403).send({ error: 'Cross-origin access is disabled' });
    // Fastify decodes route segments. Authorize the matched route, never the
    // raw URL: /%61pi/runs is the same endpoint as /api/runs.
    const route = req.routeOptions.url;
    let path: string;
    try {
      path = decodeURIComponent(req.url.split('?')[0]);
    } catch {
      return reply.code(400).send({ error: 'Invalid URL' });
    }
    const protectedNamespace = /^\/(api|graphql|files|upload|storage)(\/|$)/.test(path);
    const publicRoute =
      (route === '/api/auth/status' && req.method === 'GET') ||
      (route === '/api/auth/login' && req.method === 'POST') ||
      (route === '/*' && !protectedNamespace && ['GET', 'HEAD'].includes(req.method));
    if (!publicRoute && !(await authenticated(req)))
      return reply.code(401).send({ error: 'Authentication required' });
    if (secure) reply.header('Strict-Transport-Security', 'max-age=31536000');
  });
  app.get('/api/auth/status', async (req) => ({
    required: enabled,
    authenticated: await authenticated(req),
    remote,
    ...(publicUrl ? { publicUrl: publicUrl.origin } : {}),
  }));
  app.post(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          properties: { key: { type: 'string', maxLength: 4096 } },
          required: ['key'],
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const address = req.ip,
        current = failures.get(address);
      if (current && current.until > Date.now() && current.count >= 10)
        return reply.code(429).send({ error: 'Too many attempts. Try again in one minute.' });
      if (!enabled) return { ok: true };
      if (!valid((req.body as any).key)) {
        if (failures.size > 1000)
          for (const [k, v] of failures) if (v.until <= Date.now()) failures.delete(k);
        if (failures.size >= 1000 && !failures.has(address))
          failures.delete(failures.keys().next().value!);
        failures.set(address, {
          count: current && current.until > Date.now() ? current.count + 1 : 1,
          until: current && current.until > Date.now() ? current.until : Date.now() + 60000,
        });
        return reply.code(401).send({ error: 'Invalid API key', code: 'AUTH_INVALID_KEY' });
      }
      failures.delete(address);
      const token = randomBytes(32).toString('hex');
      await db.call('sessionCreate', digest(token), Date.now() + sessionSeconds * 1000);
      reply.header(
        'Set-Cookie',
        `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionSeconds}${secure ? '; Secure' : ''}`,
      );
      return { ok: true };
    },
  );
  app.post('/api/auth/logout', async (req, reply) => {
    const token = cookie(req);
    if (token) await db.call('sessionDelete', digest(token));
    reply.header(
      'Set-Cookie',
      `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`,
    );
    return { ok: true };
  });
  return { enabled, remote, publicUrl: publicUrl?.origin, signUrl, authenticated };
}
