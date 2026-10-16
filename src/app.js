const express = require('express');
const { createConfig } = require('./config');
const { createAuthentication } = require('./auth');
const { Store, sanitizeMessage } = require('./store');
const { fail } = require('./errors');

// Express 4 wymaga przekazania bledu z funkcji async do next().
function route(handler) {
  return async function (request, response, next) {
    try {
      await handler(request, response, next);
    } catch (error) {
      next(error);
    }
  };
}

function createApp(options = {}) {
  const config = createConfig(options);
  const now = options.clock || Date.now; // Testy przesuwaja czas bez czekania.
  const auth = createAuthentication(config, options, now);
  const store = new Store(config, now);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  function allowedOrigin(origin) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.origin !== origin) return false;
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      return config.localDevelopment && ['http:', 'https:'].includes(url.protocol);
    }
    if (url.protocol !== 'https:') return false;
    if (config.allowedOrigins.has(origin)) return true;
    return /^[a-z0-9-]+\.ext-twitch\.tv$/i.test(url.hostname) && !url.port;
  }

  app.use(function (request, response, next) {
    response.set('Cache-Control', 'no-store');
    response.set('X-Content-Type-Options', 'nosniff');
    const origin = request.get('Origin');
    if (origin) {
      if (!allowedOrigin(origin)) {
        return response.status(403).json({ ok: false, error: 'Origin is not allowed', code: 'ORIGIN_FORBIDDEN' });
      }
      response.set('Access-Control-Allow-Origin', origin);
      response.vary('Origin');
      response.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      response.set('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Unity-Key,X-Local-Viewer');
      response.set('Access-Control-Expose-Headers', 'Retry-After');
    }
    if (request.method === 'OPTIONS') return response.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));

  // Uprawnienia sa sprawdzane raz dla calej grupy adresow.
  app.use('/api/viewer', route(async function (request, response, next) {
    request.viewer = await auth.viewer(request);
    request.channel = store.channel(request.viewer.channelId);
    next();
  }));
  app.use('/api/unity', function (request, response, next) {
    if (!auth.unity(request)) fail(401, 'UNITY_UNAUTHORIZED', 'A valid Unity API key is required');
    let channelId = request.body.channelId;
    if (request.method === 'GET') channelId = request.query.channelId;
    request.channel = store.channel(channelId);
    next();
  });
  app.use('/api/moderation', route(async function (request, response, next) {
    let channelId;
    if (config.localDevelopment && auth.localRequest(request) && auth.unity(request)) {
      if (request.method === 'GET') channelId = request.query.channelId;
      else channelId = request.body.channelId;
      if (!channelId) channelId = config.localChannelId;
    } else {
      const viewer = await auth.viewer(request);
      if (viewer.role !== 'broadcaster') fail(403, 'MODERATION_FORBIDDEN', 'Only the broadcaster can moderate');
      channelId = viewer.channelId;
    }
    request.channel = store.channel(channelId);
    next();
  }));

  app.get('/health', function (request, response) {
    response.json({ ok: true });
  });
  app.get('/api/viewer/state', function (request, response) {
    response.json(store.viewerState(request.channel, request.viewer));
  });
  app.post('/api/viewer/avatar', route(async function (request, response) {
    const parts = store.avatarParts(request.body);
    store.unblocked(request.channel, request.viewer.viewerId);
    const name = await auth.publishingName(request.viewer);
    store.prune(request.channel);
    const profile = store.saveProfile(request.channel, request.viewer, name, parts);
    response.json({ ok: true, profile: profile });
  }));
  app.post('/api/viewer/message', route(async function (request, response) {
    const text = sanitizeMessage(request.body.text);
    store.checkMessage(request.channel, request.viewer);
    const name = await auth.publishingName(request.viewer);
    // Podczas pobierania nicku mogla przyjsc druga wiadomosc lub blokada.
    store.prune(request.channel);
    response.json(store.message(request.channel, request.viewer, name, text));
  }));
  app.post('/api/viewer/vote', function (request, response) {
    response.json(store.vote(request.channel, request.viewer, request.body));
  });

  app.get('/api/unity/state', function (request, response) {
    let after = request.query.after;
    if (after === undefined) after = '0';
    if (typeof after !== 'string' || !/^\d+$/.test(after)) {
      fail(400, 'INVALID_CURSOR', 'Invalid message number');
    }
    response.json(store.unityState(request.channel, Number(after)));
  });
  app.post('/api/unity/round', function (request, response) {
    response.json(store.publishRound(request.channel, request.body));
  });
  app.post('/api/unity/result', function (request, response) {
    response.json(store.result(request.channel, request.body));
  });

  app.get('/api/moderation/state', function (request, response) {
    response.json(store.moderationState(request.channel));
  });
  app.post('/api/moderation/message', function (request, response) {
    response.json(store.moderate(request.channel, request.body));
  });
  app.post('/api/moderation/settings', function (request, response) {
    response.json(store.settings(request.channel, request.body));
  });
  app.post('/api/moderation/block', function (request, response) {
    response.json(store.block(request.channel, request.body));
  });

  app.use('/api', function (request, response) {
    response.status(404).json({ ok: false, error: 'API route not found', code: 'NOT_FOUND' });
  });
  if (config.localDevelopment) {
    app.use(express.static(config.viewerDir, { dotfiles: 'deny', index: false }));
  }
  app.use(function (request, response) {
    response.status(404).json({ ok: false, error: 'Route not found', code: 'NOT_FOUND' });
  });
  app.use(function (error, request, response, next) {
    if (response.headersSent) return next(error);
    let status = error.status || 500;
    if (error.type === 'entity.too.large' || error.type === 'entity.parse.failed') status = 400;
    let message = error.message;
    let code = error.code || 'INVALID_REQUEST';
    if (status >= 500) {
      message = 'Internal server error';
      code = 'INTERNAL_ERROR';
    }
    if (error.retryAfter) response.set('Retry-After', String(error.retryAfter));
    response.status(status).json({ ok: false, error: message, code: code });
  });
  app.locals.config = config;
  app.locals.store = store;
  return app;
}

module.exports = { createApp };
