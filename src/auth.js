const { timingSafeEqual } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { isLoopback } = require('./config');
const { fail } = require('./errors');

const roles = new Set(['viewer', 'broadcaster', 'moderator']);
const validLogin = name => typeof name === 'string' && /^[A-Za-z0-9_]{1,25}$/.test(name);

function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function createAuthentication(config, options, now) {
  let secret;
  if (config.extensionSecret) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(config.extensionSecret)) {
      throw new Error('TWITCH_EXTENSION_SECRET must be valid base64');
    }
    secret = Buffer.from(config.extensionSecret, 'base64');
    if (secret.length < 32) throw new Error('TWITCH_EXTENSION_SECRET must decode to at least 32 bytes');
  }

  function localRequest(req) {
    return config.localDevelopment && isLoopback(req.socket.remoteAddress)
      && !req.headers['forwarded'] && !Object.keys(req.headers).some(x => x.startsWith('x-forwarded-'));
  }

  function unity(req) {
    if (config.unityKey === 'local-development-only' && !localRequest(req)) return false;
    return equalSecret(req.get('X-Unity-Key'), config.unityKey);
  }

  async function viewer(req) {
    if (req.get('X-Local-Viewer') !== undefined) {
      if (!localRequest(req)) fail(403, 'LOCAL_AUTH_DISABLED', 'Local identity is disabled');
      const name = req.get('X-Local-Viewer');
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) fail(400, 'INVALID_LOCAL_VIEWER', 'Invalid local viewer');
      return { channelId: config.localChannelId, viewerId: `local:${name}`, displayName: name, role: 'viewer', local: true };
    }
    if (options.authResolver) {
      const identity = await options.authResolver(req);
      if (!identity || !roles.has(identity.role) || typeof identity.viewerId !== 'string'
        || !/^[A-Za-z0-9:_-]{1,128}$/.test(identity.viewerId)
        || typeof identity.channelId !== 'string') fail(401, 'INVALID_IDENTITY', 'Invalid authenticated identity');
      return { ...identity, local: false };
    }
    const authorization = req.get('Authorization') || '';
    if (!secret || !/^Bearer \S+$/i.test(authorization)) fail(401, 'UNAUTHORIZED', 'A Twitch extension JWT is required');
    let claims;
    try {
      claims = jwt.verify(authorization.slice(7), secret, { algorithms: ['HS256'], clockTimestamp: Math.floor(now() / 1000) });
    } catch {
      fail(401, 'INVALID_TOKEN', 'Invalid or expired Twitch extension JWT');
    }
    if (!claims || typeof claims !== 'object' || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)
      || claims.exp <= now() / 1000 || !roles.has(claims.role)
      || typeof claims.channel_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(claims.channel_id)
      || typeof claims.opaque_user_id !== 'string' || !/^U[A-Za-z0-9_-]{1,127}$/.test(claims.opaque_user_id)
      || (claims.user_id !== undefined && (typeof claims.user_id !== 'string' || !/^\d{1,32}$/.test(claims.user_id)))) {
      fail(401, 'INVALID_CLAIMS', 'JWT requires numeric exp, a supported role and logged-in opaque identity');
    }
    return {
      channelId: claims.channel_id, role: claims.role, userId: claims.user_id,
      viewerId: claims.user_id || claims.opaque_user_id, local: false,
    };
  }

  const fetchImpl = options.fetch || globalThis.fetch;
  let token = null;
  let tokenPromise = null;
  const names = new Map();
  const nameRequests = new Map();

  async function appToken() {
    if (token && token.expiresAt > now() + 60000) return token.value;
    if (!tokenPromise) {
      tokenPromise = (async () => {
        const response = await fetchImpl('https://id.twitch.tv/oauth2/token', {
          method: 'POST', signal: AbortSignal.timeout(5000),
          body: new URLSearchParams({ client_id: config.twitchClientId, client_secret: config.twitchClientSecret, grant_type: 'client_credentials' }),
        });
        if (!response.ok) throw new Error('Twitch app token unavailable');
        const data = await response.json();
        if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('Invalid app token');
        token = { value: data.access_token, expiresAt: now() + data.expires_in * 1000 };
        return token.value;
      })().finally(() => { tokenPromise = null; });
    }
    return tokenPromise;
  }

  async function helixName(userId) {
    if (!config.twitchClientId || !config.twitchClientSecret) throw new Error('Twitch credentials unavailable');
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      const accessToken = await appToken();
      response = await fetchImpl(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(userId)}`, {
        headers: { 'Client-Id': config.twitchClientId, Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 401) break;
      token = null;
    }
    if (!response.ok) throw new Error('Twitch username unavailable');
    const data = await response.json();
    const user = data.data?.find(x => x.id === userId);
    if (!user || !validLogin(user.login)) throw new Error('Twitch username unavailable');
    return user.login;
  }

  async function publishingName(identity) {
    if (identity.local) return identity.displayName;
    if (!identity.userId) fail(403, 'SHARED_ID_REQUIRED', 'Share your Twitch identity before publishing');
    const cached = names.get(identity.userId);
    if (cached && cached.expiresAt > now()) return cached.name;
    try {
      if (!nameRequests.has(identity.userId)) {
        if (nameRequests.size >= config.maxViewers) fail(429, 'NAME_LOOKUP_LIMIT', 'Too many concurrent name lookups');
        nameRequests.set(identity.userId, Promise.resolve().then(() => (options.profileNameResolver || helixName)(identity.userId))
          .finally(() => nameRequests.delete(identity.userId)));
      }
      const name = await nameRequests.get(identity.userId);
      if (!validLogin(name)) throw new Error('Unverified username');
      names.delete(identity.userId);
      names.set(identity.userId, { name, expiresAt: now() + 600000 });
      while (names.size > 1000) names.delete(names.keys().next().value);
      return name;
    } catch (error) {
      if (error.status) throw error;
      fail(403, 'USERNAME_UNAVAILABLE', 'Verified Twitch username is unavailable; publication is blocked');
    }
  }

  return { viewer, unity, publishingName, localRequest };
}

module.exports = { createAuthentication };
