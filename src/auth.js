const { timingSafeEqual } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { isLoopback } = require('./config');
const { fail } = require('./errors');

function validLogin(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_]{1,25}$/.test(name);
}

function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || !expected) return false;
  const first = Buffer.from(actual);
  const second = Buffer.from(expected);
  if (first.length !== second.length) return false;
  return timingSafeEqual(first, second);
}

function createAuthentication(config, options, now) {
  let secret;
  if (config.extensionSecret) {
    secret = Buffer.from(config.extensionSecret, 'base64');
    if (secret.length < 32 || secret.toString('base64') !== config.extensionSecret) {
      throw new Error('TWITCH_EXTENSION_SECRET must be a base64 key of at least 32 bytes');
    }
  }

  function localRequest(request) {
    if (!config.localDevelopment || !isLoopback(request.socket.remoteAddress)) return false;
    if (request.headers.forwarded) return false;
    for (const header of Object.keys(request.headers)) {
      if (header.startsWith('x-forwarded-')) return false;
    }
    return true;
  }

  function unity(request) {
    if (config.unityKey === 'local-development-only' && !localRequest(request)) return false;
    return equalSecret(request.get('X-Unity-Key'), config.unityKey);
  }

  function viewer(request) {
    const localName = request.get('X-Local-Viewer');
    if (localName !== undefined) {
      if (!localRequest(request)) fail(403, 'LOCAL_AUTH_DISABLED', 'Local testing is disabled');
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(localName)) fail(400, 'INVALID_LOCAL_VIEWER', 'Invalid local name');
      return {
        channelId: config.localChannelId, viewerId: 'local:' + localName,
        displayName: localName, role: 'viewer', local: true
      };
    }

    const authorization = request.get('Authorization') || '';
    if (!secret || !/^Bearer \S+$/i.test(authorization)) {
      fail(401, 'UNAUTHORIZED', 'A Twitch extension token is required');
    }
    let claims;
    try {
      // Biblioteka sprawdza podpis. Nie piszemy wlasnej kryptografii.
      claims = jwt.verify(authorization.slice(7), secret, {
        algorithms: ['HS256'], clockTimestamp: Math.floor(now() / 1000)
      });
    } catch {
      fail(401, 'INVALID_TOKEN', 'Invalid or expired Twitch token');
    }
    if (!claims || typeof claims !== 'object') fail(401, 'INVALID_CLAIMS', 'Invalid Twitch identity');
    if (!Number.isFinite(claims.exp) || claims.exp <= now() / 1000) {
      fail(401, 'INVALID_CLAIMS', 'Token expiration is missing or invalid');
    }
    if (!['viewer', 'broadcaster', 'moderator'].includes(claims.role)) {
      fail(401, 'INVALID_CLAIMS', 'Invalid Twitch role');
    }
    if (typeof claims.channel_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(claims.channel_id)) {
      fail(401, 'INVALID_CLAIMS', 'Invalid channel ID');
    }
    if (typeof claims.opaque_user_id !== 'string' || !/^U[A-Za-z0-9_-]{1,127}$/.test(claims.opaque_user_id)) {
      fail(401, 'INVALID_CLAIMS', 'Log in to Twitch first');
    }
    if (claims.user_id !== undefined) {
      if (typeof claims.user_id !== 'string' || !/^\d{1,32}$/.test(claims.user_id)) {
        fail(401, 'INVALID_CLAIMS', 'Invalid user ID');
      }
    }
    let viewerId = claims.opaque_user_id;
    if (claims.user_id) viewerId = claims.user_id;
    return {
      channelId: claims.channel_id, role: claims.role, userId: claims.user_id,
      viewerId: viewerId, local: false
    };
  }

  // Testy podmieniaja zapytania do Twitcha; Railway uzywa zwyklego fetch.
  const fetchTwitch = options.fetch || globalThis.fetch;
  let token = null;
  let tokenRequest = null;
  const names = new Map();
  const nameRequests = new Map();

  async function requestToken() {
    const response = await fetchTwitch('https://id.twitch.tv/oauth2/token', {
      method: 'POST', signal: AbortSignal.timeout(5000),
      body: new URLSearchParams({
        client_id: config.twitchClientId, client_secret: config.twitchClientSecret,
        grant_type: 'client_credentials'
      })
    });
    if (!response.ok) throw new Error('Twitch app token unavailable');
    const data = await response.json();
    if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      throw new Error('Invalid app token');
    }
    token = { value: data.access_token, expiresAt: now() + data.expires_in * 1000 };
    return token.value;
  }

  async function appToken() {
    if (token && token.expiresAt > now() + 60000) return token.value;
    // Kilku widzow moze dolaczyc naraz. Czekaja na to samo zapytanie.
    if (!tokenRequest) tokenRequest = requestToken();
    try {
      return await tokenRequest;
    } finally {
      tokenRequest = null;
    }
  }

  async function helixName(userId) {
    if (!config.twitchClientId || !config.twitchClientSecret) throw new Error('Twitch credentials missing');
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      const accessToken = await appToken();
      response = await fetchTwitch('https://api.twitch.tv/helix/users?id=' + encodeURIComponent(userId), {
        headers: { 'Client-Id': config.twitchClientId, Authorization: 'Bearer ' + accessToken },
        signal: AbortSignal.timeout(5000)
      });
      if (response.status !== 401) break;
      token = null;
    }
    if (!response.ok) throw new Error('Twitch username unavailable');
    const data = await response.json();
    if (Array.isArray(data.data)) {
      for (const user of data.data) {
        if (user.id === userId && validLogin(user.login)) return user.login;
      }
    }
    throw new Error('Twitch user not found');
  }

  async function publishingName(identity) {
    if (identity.local) return identity.displayName;
    if (!identity.userId) fail(403, 'SHARED_ID_REQUIRED', 'Share your Twitch identity first');
    const cached = names.get(identity.userId);
    if (cached && cached.expiresAt > now()) return cached.name;

    let lookup = helixName;
    if (options.profileNameResolver) lookup = options.profileNameResolver; // Tylko testy.
    try {
      if (!nameRequests.has(identity.userId)) {
        if (nameRequests.size >= config.maxViewers) fail(429, 'NAME_LOOKUP_LIMIT', 'Too many name requests');
        nameRequests.set(identity.userId, lookup(identity.userId));
      }
      const name = await nameRequests.get(identity.userId);
      if (!validLogin(name)) throw new Error('Invalid verified name');
      names.delete(identity.userId);
      names.set(identity.userId, { name: name, expiresAt: now() + 600000 });
      while (names.size > 1000) names.delete(names.keys().next().value);
      return name;
    } catch (error) {
      if (error.status) throw error;
      fail(403, 'USERNAME_UNAVAILABLE', 'Cannot verify your Twitch name');
    } finally {
      nameRequests.delete(identity.userId);
    }
  }

  return { viewer, unity, publishingName, localRequest };
}

module.exports = { createAuthentication };
