const { isIP } = require('node:net');
const path = require('node:path');

function isLoopback(address) {
  return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

function number(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Configuration number must be between ${min} and ${max}`);
  }
  return parsed;
}

function createConfig(options = {}) {
  const env = options.env || process.env;
  const host = options.host ?? env.HOST ?? (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  if (!isIP(host)) throw new Error('HOST must be a literal IP address');
  const development = options.development ?? (env.NODE_ENV !== 'production');
  const localDevelopment = development && env.NODE_ENV !== 'production'
    && (options.allowLocalTest ?? (env.ALLOW_LOCAL_TEST === 'true')) && isLoopback(host);
  const list = options.allowedChannelIds ?? (env.UNITY_CHANNEL_IDS || '').split(',');
  const allowedChannelIds = new Set();
  for (const value of list) {
    const id = String(value).trim();
    if (id !== '') allowedChannelIds.add(id);
  }
  const localChannelId = options.localChannelId ?? env.LOCAL_CHANNEL_ID ?? 'local_channel';
  if (!allowedChannelIds.size && localDevelopment) allowedChannelIds.add(localChannelId);
  if (!allowedChannelIds.size) throw new Error('UNITY_CHANNEL_IDS must contain an explicit channel allowlist');
  for (const id of allowedChannelIds) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid channel allowlist');
  }
  const unityKey = options.unityKey ?? env.UNITY_API_KEY ?? (localDevelopment ? 'local-development-only' : '');
  if (!localDevelopment && unityKey === 'local-development-only') {
    throw new Error('The local Unity key is forbidden outside loopback development');
  }
  if (!unityKey) throw new Error('UNITY_API_KEY is required');
  const defaultViewer = path.resolve(__dirname, '../../viewer_inz');
  return {
    host, localDevelopment, localChannelId, allowedChannelIds, unityKey,
    port: number(options.port ?? env.PORT, 8094, 0, 65535),
    extensionSecret: options.extensionSecret ?? env.TWITCH_EXTENSION_SECRET ?? '',
    twitchClientId: options.twitchClientId ?? env.TWITCH_CLIENT_ID ?? '',
    twitchClientSecret: options.twitchClientSecret ?? env.TWITCH_CLIENT_SECRET ?? '',
    allowedOrigins: new Set(options.allowedOrigins ?? (env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)),
    presenceTtlMs: number(options.presenceTtlMs ?? env.PRESENCE_TTL_MS, 300000, 1, 86400000),
    maxViewers: number(options.maxViewers ?? env.MAX_VIEWERS_PER_CHANNEL, 200, 1, 10000),
    maxChannels: number(options.maxChannels ?? env.MAX_CHANNELS, 1000, 1, 1000),
    maxMessages: number(options.maxMessages ?? env.MAX_MESSAGES_PER_CHANNEL, 200, 1, 10000),
    messageTtlMs: number(options.messageTtlMs ?? env.MESSAGE_TTL_MS, 300000, 1, 86400000),
    messageCooldownMs: number(options.messageCooldownMs ?? env.MESSAGE_COOLDOWN_MS, 10000, 1, 86400000),
    maxHistory: number(options.maxHistory ?? env.MAX_HISTORY_PER_CHANNEL, 100, 1, 1000),
    maxBlocked: number(options.maxBlocked ?? env.MAX_BLOCKED_PER_CHANNEL, 1000, 1, 10000),
    requireApproval: options.requireApproval ?? (env.REQUIRE_MESSAGE_APPROVAL
      ? env.REQUIRE_MESSAGE_APPROVAL !== 'false' : !localDevelopment),
    viewerDir: path.resolve(options.viewerDir ?? env.VIEWER_DIR ?? defaultViewer),
  };
}

module.exports = { createConfig, isLoopback };
