import crypto from 'node:crypto';
import path from 'node:path';
import { AuthStore } from './auth-db.js';

const DISCORD_API = 'https://discord.com/api/v10';
const COOKIE_NAME = 'cpmv_session';
const STATE_COOKIE_NAME = 'cpmv_oauth_state';
const DISCORD_ID = /^\d{17,20}$/;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

const base64url = value => Buffer.from(value).toString('base64url');
const randomToken = bytes => base64url(crypto.randomBytes(bytes));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(value => value.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2));
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function roleFor(roles, config) {
  if (roles.includes(config.adminRoleId)) return 'admin';
  return config.moderatorRoleIds.some(id => roles.includes(id)) ? 'moderator' : null;
}

async function discordJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, { ...options, signal: options.signal ?? AbortSignal.timeout(10_000) });
  if (!response.ok) {
    const error = new Error(`Discord API returned ${response.status}`);
    error.statusCode = response.status === 429 || response.status >= 500 ? 503 : 401;
    throw error;
  }
  return response.json();
}

/** Реєструє OAuth, сесії, перевірку ролей та адміністративний blacklist. */
export async function registerAuth(app, { cfg, rootDir, fetchImpl = fetch, authStore } = {}) {
  const source = cfg.discordAuth ?? {};
  const config = {
    enabled: source.enabled === true,
    publicOrigin: cfg.publicOrigin ?? `http://localhost:${cfg.port ?? 3010}`,
    redirectUri: source.redirectUri ?? `http://localhost:${cfg.port ?? 3010}/api/auth/discord/callback`,
    guildId: source.guildId,
    adminRoleId: source.adminRoleId,
    moderatorRoleIds: source.moderatorRoleIds ?? [],
    roleCheckIntervalMs: source.roleCheckIntervalMs ?? FIFTEEN_MINUTES,
    sessionMaxAgeMs: source.sessionMaxAgeMs ?? THIRTY_DAYS,
  };
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const store = authStore ?? new AuthStore(path.resolve(rootDir, source.databasePath ?? 'data/auth.db'));
  const secureCookie = new URL(config.publicOrigin).protocol === 'https:';

  if (config.enabled && (!clientId || !clientSecret)) throw new Error('DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are required');
  for (const [name, value] of Object.entries({ guildId: config.guildId, adminRoleId: config.adminRoleId })) {
    if (config.enabled && !DISCORD_ID.test(String(value ?? ''))) throw new Error(`discordAuth.${name} must be a Discord ID`);
  }

  async function refreshToken(session) {
    if (session.token_expires_at > Date.now() + 30_000) return session;
    if (!session.refresh_token) throw new Error('Discord token expired');
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refresh_token, client_id: clientId, client_secret: clientSecret });
    const token = await discordJson(fetchImpl, `${DISCORD_API}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    return { ...session, access_token: token.access_token, refresh_token: token.refresh_token ?? session.refresh_token, token_expires_at: Date.now() + token.expires_in * 1000 };
  }

  async function verifyRoles(session, tokenHash) {
    if (Date.now() - session.roles_checked_at < config.roleCheckIntervalMs) return session;
    session = await refreshToken(session);
    const member = await discordJson(fetchImpl, `${DISCORD_API}/users/@me/guilds/${config.guildId}/member`, { headers: { Authorization: `Bearer ${session.access_token}` } });
    const role = roleFor(member.roles ?? [], config);
    if (!role || store.isBlocked(session.discord_id)) {
      store.deleteSession(tokenHash);
      return null;
    }
    const values = { role, accessToken: session.access_token, refreshToken: session.refresh_token, tokenExpiresAt: session.token_expires_at, rolesCheckedAt: Date.now() };
    store.updateSession(tokenHash, values);
    return { ...session, role, roles_checked_at: values.rolesCheckedAt };
  }

  /** Завантажує та за потреби переперевіряє поточну сесію. */
  async function authenticate(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return null;
    const tokenHash = hash(token);
    let session = store.getSession(tokenHash);
    if (!session || store.isBlocked(session.discord_id)) {
      if (session) store.deleteSession(tokenHash);
      return null;
    }
    try { session = await verifyRoles(session, tokenHash); }
    catch (error) {
      if (error.statusCode >= 500 || error.name === 'TimeoutError') throw error;
      store.deleteSession(tokenHash);
      return null;
    }
    return session ? { tokenHash, session } : null;
  }

  app.get('/api/auth/discord/start', async (_req, reply) => {
    if (!config.enabled) return reply.code(503).send({ error: 'authentication disabled' });
    const state = randomToken(32);
    const verifier = randomToken(48);
    store.createState(hash(state), verifier, Date.now() + 10 * 60 * 1000);
    reply.header('Set-Cookie', serializeCookie(STATE_COOKIE_NAME, state, { maxAge: 10 * 60 * 1000, secure: secureCookie }));
    const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: config.redirectUri, scope: 'identify guilds.members.read', state, code_challenge: base64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
    return reply.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  app.get('/api/auth/discord/callback', async (req, reply) => {
    const { code, state } = req.query;
    const cookieState = parseCookies(req.headers.cookie)[STATE_COOKIE_NAME];
    const stateMatches = typeof state === 'string' && typeof cookieState === 'string'
      && state.length === cookieState.length && crypto.timingSafeEqual(Buffer.from(state), Buffer.from(cookieState));
    const saved = stateMatches && store.consumeState(hash(state));
    reply.header('Set-Cookie', serializeCookie(STATE_COOKIE_NAME, '', { maxAge: 0, secure: secureCookie }));
    if (!code || !saved) return reply.code(400).send({ error: 'invalid oauth state' });
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: String(code), redirect_uri: config.redirectUri, client_id: clientId, client_secret: clientSecret, code_verifier: saved.verifier });
    const token = await discordJson(fetchImpl, `${DISCORD_API}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const headers = { Authorization: `Bearer ${token.access_token}` };
    const [user, member] = await Promise.all([
      discordJson(fetchImpl, `${DISCORD_API}/users/@me`, { headers }),
      discordJson(fetchImpl, `${DISCORD_API}/users/@me/guilds/${config.guildId}/member`, { headers }),
    ]);
    const role = roleFor(member.roles ?? [], config);
    if (!role || store.isBlocked(user.id)) return reply.redirect(`${config.publicOrigin}/?auth=denied`);
    const rawSession = randomToken(48);
    const now = Date.now();
    store.createSession({ tokenHash: hash(rawSession), discordId: user.id, username: user.global_name || user.username, avatar: user.avatar ?? null, role, accessToken: token.access_token, refreshToken: token.refresh_token ?? null, tokenExpiresAt: now + token.expires_in * 1000, rolesCheckedAt: now, expiresAt: now + config.sessionMaxAgeMs });
    reply.header('Set-Cookie', serializeCookie(COOKIE_NAME, rawSession, { maxAge: config.sessionMaxAgeMs, secure: secureCookie }));
    return reply.redirect(config.publicOrigin);
  });

  app.get('/api/auth/me', async (req, reply) => {
    if (!config.enabled) return { id: 'local', username: 'Локальний користувач', avatar: null, role: 'moderator' };
    const auth = await authenticate(req);
    if (!auth) return reply.code(401).send({ error: 'unauthorized' });
    const { discord_id: id, username, avatar, role } = auth.session;
    return { id, username, avatar, role };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token) store.deleteSession(hash(token));
    reply.header('Set-Cookie', serializeCookie(COOKIE_NAME, '', { maxAge: 0, secure: secureCookie }));
    return reply.code(204).send();
  });

  app.get('/api/admin/blacklist', async (req, reply) => {
    const auth = await authenticate(req);
    if (auth?.session.role !== 'admin') return reply.code(auth ? 403 : 401).send({ error: 'forbidden' });
    return { users: store.listBlacklist() };
  });
  app.post('/api/admin/blacklist', async (req, reply) => {
    const auth = await authenticate(req);
    if (auth?.session.role !== 'admin') return reply.code(auth ? 403 : 401).send({ error: 'forbidden' });
    const discordId = String(req.body?.discordId ?? '');
    if (!DISCORD_ID.test(discordId)) return reply.code(400).send({ error: 'invalid discord id' });
    store.block(discordId, auth.session.discord_id);
    return reply.code(201).send({ discordId });
  });
  app.delete('/api/admin/blacklist/:discordId', async (req, reply) => {
    const auth = await authenticate(req);
    if (auth?.session.role !== 'admin') return reply.code(auth ? 403 : 401).send({ error: 'forbidden' });
    return { removed: store.unblock(String(req.params.discordId)) };
  });

  app.addHook('preHandler', async (req, reply) => {
    if (config.enabled && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== config.publicOrigin) return reply.code(403).send({ error: 'invalid origin' });
    }
    if (!config.enabled || !req.url.startsWith('/api/') || req.url.startsWith('/api/auth/') || req.url.startsWith('/api/admin/')) return;
    const auth = await authenticate(req);
    if (!auth) return reply.code(401).send({ error: 'unauthorized' });
    req.auth = auth.session;
  });

  app.addHook('onClose', async () => store.close?.());
  return { authenticate, store };
}
