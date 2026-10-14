const express = require('express');
const { createConfig } = require('./config');
const { createAuthentication } = require('./auth');
const { Store, sanitizeMessage } = require('./store');
const { fail } = require('./errors');

const asyncRoute = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);

function createApp(options = {}) {
  const config = createConfig(options);
  const now = options.clock || Date.now;
  const auth = createAuthentication(config, options, now);
  const store = new Store(config, now);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  function allowedOrigin(origin) {
    let url;
    try { url = new URL(origin); } catch { return false; }
    if (url.origin !== origin || url.username || url.password) return false;
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (local) return config.localDevelopment && ['http:', 'https:'].includes(url.protocol);
    return (url.protocol === 'https:' && /^[a-z0-9-]+\.ext-twitch\.tv$/i.test(url.hostname) && !url.port)
      || (url.protocol === 'https:' && config.allowedOrigins.has(origin));
  }

  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    const origin = req.get('Origin');
    if (origin) {
      if (!allowedOrigin(origin)) return next(Object.assign(new Error('Origin is not allowed'), { status: 403, code: 'ORIGIN_FORBIDDEN' }));
      res.set('Access-Control-Allow-Origin', origin);
      res.vary('Origin');
      res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Unity-Key,X-Local-Viewer');
      res.set('Access-Control-Expose-Headers', 'Retry-After');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));

  const viewerRoute = handler => asyncRoute(async (req, res) => {
    const identity = await auth.viewer(req);
    const channel = store.channel(identity.channelId);
    res.json(await handler(req, channel, identity));
  });
  const unityRoute = handler => asyncRoute(async (req, res) => {
    if (!auth.unity(req)) fail(401, 'UNITY_UNAUTHORIZED', 'A valid Unity API key is required');
    const channel = store.channel(req.method === 'GET' ? req.query.channelId : req.body.channelId);
    res.json(await handler(req, channel));
  });
  const moderationRoute = handler => asyncRoute(async (req, res) => {
    let channel;
    if (config.localDevelopment && auth.localRequest(req) && auth.unity(req)) {
      channel = store.channel((req.method === 'GET' ? req.query.channelId : req.body.channelId) || config.localChannelId);
    } else {
      const identity = await auth.viewer(req);
      if (identity.role !== 'broadcaster') fail(403, 'MODERATION_FORBIDDEN', 'Broadcaster authentication is required');
      channel = store.channel(identity.channelId);
    }
    res.json(await handler(req, channel));
  });

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get('/api/viewer/state', viewerRoute((req, channel, identity) => store.viewerState(channel, identity)));
  app.post('/api/viewer/avatar', viewerRoute(async (req, channel, identity) => {
    const parts = store.avatarParts(req.body);
    store.unblocked(channel, identity.viewerId);
    const name = await auth.publishingName(identity);
    // Recheck limits and blocks after the asynchronous username lookup.
    store.prune(channel);
    return { ok: true, profile: store.saveProfile(channel, identity, name, parts) };
  }));
  app.post('/api/viewer/vote', viewerRoute((req, channel, identity) => store.vote(channel, identity, req.body)));
  app.post('/api/viewer/next-choice', viewerRoute((req, channel, identity) => store.choose(channel, identity, req.body)));
  app.post('/api/viewer/message', viewerRoute(async (req, channel, identity) => {
    const text = sanitizeMessage(req.body.text);
    store.checkMessage(channel, identity);
    const name = await auth.publishingName(identity);
    store.prune(channel);
    return store.message(channel, identity, name, text);
  }));

  app.get('/api/unity/state', unityRoute((req, channel) => {
    const raw = req.query.after ?? '0';
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) fail(400, 'INVALID_CURSOR', 'after must be a nonnegative integer');
    return store.unityState(channel, Number(raw));
  }));
  app.post('/api/unity/round', unityRoute((req, channel) => store.publishRound(channel, req.body)));
  app.post('/api/unity/result', unityRoute((req, channel) => store.result(channel, req.body)));
  app.post('/api/unity/next-choice', unityRoute((req, channel) => store.publishChoice(channel, req.body)));
  app.post('/api/unity/next-choice/resolve', unityRoute((req, channel) => store.resolveChoice(channel, req.body)));

  app.get('/api/moderation/state', moderationRoute((req, channel) => store.moderationState(channel)));
  app.post('/api/moderation/message', moderationRoute((req, channel) => store.moderate(channel, req.body)));
  app.post('/api/moderation/settings', moderationRoute((req, channel) => store.settings(channel, req.body)));
  app.post('/api/moderation/block', moderationRoute((req, channel) => store.block(channel, req.body)));
  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'API route not found', code: 'NOT_FOUND' }));
  if (config.localDevelopment) app.use(express.static(config.viewerDir, { dotfiles: 'deny', index: 'index.html' }));
  app.use((req, res) => res.status(404).json({ ok: false, error: 'Route not found', code: 'NOT_FOUND' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    let status = error.status || 500;
    if (error.type === 'entity.too.large' || error.type === 'entity.parse.failed') status = 400;
    if (status >= 500) options.onError?.(error);
    if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    res.status(status).json({ ok: false, error: status >= 500 ? 'Internal server error' : error.message,
      code: status >= 500 ? 'INTERNAL_ERROR' : error.code || 'INVALID_REQUEST' });
  });
  app.locals.config = config;
  app.locals.store = store;
  return app;
}

module.exports = { createApp };
