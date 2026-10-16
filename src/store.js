const { randomUUID } = require('node:crypto');
const { fail } = require('./errors');

function ownObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}

function cardId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function sameSet(first, second) {
  if (first.length !== second.length) return false;
  for (const id of first) {
    if (!second.includes(id)) return false;
  }
  return true;
}

function label(value) {
  if (typeof value !== 'string') return false;
  if (value.trim().length === 0 || Array.from(value).length > 80) return false;
  return !/[<>\p{Cc}\p{Cf}]/u.test(value);
}

// Przegladarka tez sprawdza glosy, ale serwer nie moze jej ufac.
function validateIds(selected, available, minimum, maximum, dead = []) {
  if (!Array.isArray(selected)) {
    fail(400, 'INVALID_CARD_IDS', 'Card IDs must be a list');
  }
  if (selected.length < minimum || selected.length > maximum) {
    fail(400, 'INVALID_CARD_IDS', 'Incorrect number of selected cards');
  }
  const checked = [];
  for (const id of selected) {
    if (!cardId(id) || !available.includes(id)) {
      fail(400, 'INVALID_CARD_IDS', 'Selected card is unavailable');
    }
    if (dead.includes(id)) {
      fail(400, 'INVALID_CARD_IDS', 'Cannot vote for a dead card');
    }
    if (checked.includes(id)) {
      fail(400, 'INVALID_CARD_IDS', 'A card was selected twice');
    }
    checked.push(id);
  }
  return checked;
}

function validateRound(value) {
  if (!ownObject(value) || !identifier(value.id)) {
    fail(400, 'INVALID_ROUND', 'Round ID is required');
  }
  if (!Array.isArray(value.cards) || value.cards.length < 1 || value.cards.length > 100) {
    fail(400, 'INVALID_ROUND', 'A round needs 1 to 100 cards');
  }
  if (value.cardCount !== value.cards.length) {
    fail(400, 'INVALID_ROUND', 'Card count does not match the list');
  }
  if (!Number.isInteger(value.maxVotes) || value.maxVotes < 1 || value.maxVotes > value.cardCount) {
    fail(400, 'INVALID_ROUND', 'Incorrect vote limit');
  }
  const cards = [];
  const ids = [];
  for (const card of value.cards) {
    if (!ownObject(card) || !cardId(card.id) || !label(card.name)) {
      fail(400, 'INVALID_ROUND', 'Invalid card number or name');
    }
    if (ids.includes(card.id)) fail(400, 'INVALID_ROUND', 'Duplicate card number');
    cards.push({ id: card.id, name: card.name });
    ids.push(card.id);
  }
  const deadCards = validateIds(value.deadCards, ids, 0, cards.length);
  return { id: value.id, cardCount: value.cardCount, maxVotes: value.maxVotes, deadCards, cards, resolved: false, correctCardIds: [] };
}

function sanitizeMessage(value) {
  if (typeof value !== 'string') fail(400, 'INVALID_MESSAGE', 'Message text is required');
  // Usuwamy niewidoczne znaki sterujace, ale zostawiamy lacznik emoji.
  let text = '';
  for (const character of value) {
    if (character === '\u200d' || !/[\p{Cc}\p{Cf}]/u.test(character)) text += character;
  }
  text = text.trim();
  if (!text || [...text].length > 120 || /[<>]/.test(text)) {
    fail(400, 'INVALID_MESSAGE', 'Use 1..120 Unicode characters without angle brackets');
  }
  return text;
}

class Store {
  constructor(config, now) {
    this.config = config;
    this.now = now;
    this.serverSession = randomUUID();
    this.channels = new Map();
  }

  channel(id) {
    if (typeof id !== 'string' || !this.config.allowedChannelIds.has(id)) fail(403, 'CHANNEL_FORBIDDEN', 'Channel is not allowed');
    let channel = this.channels.get(id);
    if (!channel) {
      if (this.channels.size >= this.config.maxChannels) fail(429, 'CHANNEL_LIMIT', 'Server channel limit reached');
      channel = {
        id, profiles: new Map(), cooldowns: new Map(), round: null, roundCardIds: new Set(), votes: new Map(), roundHistory: new Map(),
        messages: new Map(), removedMessageIds: new Set(),
        nextReviewId: 1, latestMessageId: 0, blocked: new Set(), messagesEnabled: true,
        requireApproval: this.config.requireApproval,
      };
      this.channels.set(id, channel);
    }
    this.prune(channel);
    return channel;
  }

  remember(map, id, value) {
    map.set(id, value);
    while (map.size > this.config.maxHistory) map.delete(map.keys().next().value);
  }

  prune(channel) {
    const time = this.now();
    for (const [id, profile] of channel.profiles) {
      if (time - profile.lastSeen >= this.config.presenceTtlMs) {
        channel.profiles.delete(id);
        channel.cooldowns.delete(id);
      }
    }
    for (const [id, message] of channel.messages) {
      if (time - message.createdAt >= this.config.messageTtlMs) {
        this.removeMessage(channel, message);
        channel.messages.delete(id);
      }
    }
  }

  touch(channel, viewerId) {
    const profile = channel.profiles.get(viewerId);
    if (profile) profile.lastSeen = this.now();
  }

  publicProfile(profile) {
    if (!profile) return null;
    return { viewerId: profile.viewerId, displayName: profile.displayName,
      eyes: profile.eyes, head: profile.head, body: profile.body };
  }

  unblocked(channel, viewerId) {
    if (channel.blocked.has(viewerId)) fail(403, 'VIEWER_BLOCKED', 'Viewer is blocked');
  }

  saveProfile(channel, identity, displayName, parts) {
    this.unblocked(channel, identity.viewerId);
    if (!channel.profiles.has(identity.viewerId) && channel.profiles.size >= this.config.maxViewers) {
      fail(429, 'VIEWER_LIMIT', 'Channel avatar limit reached');
    }
    const profile = { ...parts, viewerId: identity.viewerId, displayName, lastSeen: this.now() };
    channel.profiles.set(identity.viewerId, profile);
    return this.publicProfile(profile);
  }

  avatarParts(body) {
    const parts = { eyes: body.eyes, head: body.head, body: body.body };
    for (const number of Object.values(parts)) {
      if (!Number.isInteger(number) || number < 1 || number > 3) {
        fail(400, 'INVALID_AVATAR', 'Each avatar part must be 1, 2 or 3');
      }
    }
    return parts;
  }

  viewerState(channel, identity) {
    this.touch(channel, identity.viewerId);
    return {
      ok: true, serverSession: this.serverSession,
      round: channel.round || { id: '', cardCount: 0, maxVotes: 0, deadCards: [], cards: [], resolved: false, correctCardIds: [] },
      profile: this.publicProfile(channel.profiles.get(identity.viewerId)),
      voteIds: [...(channel.votes.get(identity.viewerId) || [])], messagesEnabled: channel.messagesEnabled,
    };
  }

  unityState(channel, after) {
    if (!Number.isSafeInteger(after) || after < 0) fail(400, 'INVALID_CURSOR', 'after must be a nonnegative integer');
    const viewers = [];
    for (const profile of channel.profiles.values()) viewers.push(this.publicProfile(profile));
    const messages = [];
    for (const message of channel.messages.values()) {
      if (message.status === 'approved' && message.messageId > after) {
        messages.push({ id: message.messageId, viewerId: message.viewerId, text: message.text, kind: message.kind });
      }
    }
    messages.sort(function (first, second) { return first.id - second.id; });
    return {
      ok: true, serverSession: this.serverSession,
      viewers: viewers,
      messages: messages,
      latestMessageId: channel.latestMessageId, removedMessageIds: [...channel.removedMessageIds],
    };
  }

  publishRound(channel, body) {
    const next = validateRound(body.round);
    if (channel.round?.id === next.id) {
      const knownIds = new Set(channel.roundCardIds);
      for (const card of next.cards) knownIds.add(card.id);
      if (knownIds.size > 1000) fail(429, 'ROUND_CARD_HISTORY_LIMIT', 'Round card history limit reached');
      channel.roundCardIds = knownIds;
      // Zabicie lub odsloniecie karty nie kasuje wczesniejszych glosow.
      channel.round = { ...next, resolved: channel.round.resolved, correctCardIds: [...channel.round.correctCardIds] };
    } else {
      if (channel.roundHistory.has(next.id)) fail(409, 'STALE_ROUND', 'Round ID was already used');
      if (channel.round) this.remember(channel.roundHistory, channel.round.id, { ...channel.round, knownCardIds: [...channel.roundCardIds] });
      channel.round = next;
      channel.roundCardIds = new Set();
      for (const card of next.cards) channel.roundCardIds.add(card.id);
      channel.votes.clear();
    }
    return { ok: true, round: channel.round };
  }

  vote(channel, identity, body) {
    this.unblocked(channel, identity.viewerId);
    const round = channel.round;
    if (!round || body.roundId !== round.id) fail(409, 'STALE_ROUND', 'Round is no longer current');
    if (round.resolved) fail(409, 'ROUND_CLOSED', 'Round is closed');
    const available = [];
    for (const card of round.cards) available.push(card.id);
    const ids = validateIds(body.cardIds, available, 1, round.maxVotes, round.deadCards);
    if (!channel.votes.has(identity.viewerId) && channel.votes.size >= this.config.maxViewers) fail(429, 'VOTE_LIMIT', 'Channel vote limit reached');
    channel.votes.set(identity.viewerId, ids);
    this.touch(channel, identity.viewerId);
    return { ok: true, voteIds: ids };
  }

  publishMessage(channel, message) {
    if (message.status === 'approved') return;
    message.status = 'approved';
    message.messageId = ++channel.latestMessageId;
    message.createdAt = this.now();
  }

  removeMessage(channel, message) {
    if (message.messageId !== null) {
      channel.removedMessageIds.add(message.messageId);
      while (channel.removedMessageIds.size > this.config.maxMessages) channel.removedMessageIds.delete(channel.removedMessageIds.values().next().value);
    }
    message.status = 'removed';
  }

  enqueue(channel, profile, text, pending, kind = 'message') {
    const message = {
      id: channel.nextReviewId++, viewerId: profile.viewerId, displayName: profile.displayName, text,
      status: 'pending', messageId: null, createdAt: this.now(), kind,
    };
    if (!pending) this.publishMessage(channel, message);
    channel.messages.set(message.id, message);
    while (channel.messages.size > this.config.maxMessages) {
      const [id, oldest] = channel.messages.entries().next().value;
      this.removeMessage(channel, oldest);
      channel.messages.delete(id);
    }
    return message;
  }

  checkMessage(channel, identity) {
    this.unblocked(channel, identity.viewerId);
    if (!channel.messagesEnabled) fail(403, 'MESSAGES_DISABLED', 'Messages are disabled');
    const previous = channel.cooldowns.get(identity.viewerId);
    if (previous !== undefined && this.now() - previous < this.config.messageCooldownMs) {
      const error = new Error('Wait before sending another message');
      error.status = 429;
      error.code = 'MESSAGE_COOLDOWN';
      error.retryAfter = Math.ceil((this.config.messageCooldownMs - (this.now() - previous)) / 1000);
      throw error;
    }
  }

  message(channel, identity, displayName, text) {
    this.checkMessage(channel, identity);
    const current = channel.profiles.get(identity.viewerId);
    const profile = this.saveProfile(channel, identity, displayName, current || { eyes: 1, head: 1, body: 1 });
    const message = this.enqueue(channel, profile, text, channel.requireApproval);
    channel.cooldowns.set(identity.viewerId, this.now());
    return { ok: true, id: message.id, pending: message.status === 'pending' };
  }

  result(channel, body) {
    let round = channel.round;
    if (!round || round.id !== body.roundId) round = channel.roundHistory.get(body.roundId);
    if (!round) fail(409, 'STALE_ROUND', 'Round is no longer current');
    if (round !== channel.round && !round.resolved) fail(409, 'STALE_ROUND', 'Round is no longer current');
    let knownIds = round.knownCardIds;
    if (round === channel.round) knownIds = Array.from(channel.roundCardIds);
    const ids = validateIds(body.correctCardIds, knownIds, 0, 100);
    if (round.resolved) {
      if (!sameSet(round.correctCardIds, ids)) fail(409, 'RESULT_CONFLICT', 'Round result was already published with different IDs');
      return { ok: true, roundId: round.id, correctCardIds: [...round.correctCardIds] };
    }
    round.resolved = true;
    round.correctCardIds = ids;
    if (channel.messagesEnabled) {
      for (const [viewerId, vote] of channel.votes) {
        const profile = channel.profiles.get(viewerId);
        if (profile && !channel.blocked.has(viewerId) && sameSet(vote, ids)) this.enqueue(channel, profile, 'Dobrze wybrałem!', false, 'correct');
      }
    }
    return { ok: true, roundId: round.id, correctCardIds: ids };
  }

  moderationState(channel) {
    const messages = [];
    for (const message of channel.messages.values()) {
      messages.push({ id: message.id, viewerId: message.viewerId, displayName: message.displayName,
        text: message.text, pending: message.status === 'pending', removed: message.status === 'removed' });
    }
    return {
      ok: true, messagesEnabled: channel.messagesEnabled, requireApproval: channel.requireApproval,
      messages: messages, blockedViewers: Array.from(channel.blocked),
    };
  }

  moderate(channel, body) {
    if (!Number.isSafeInteger(body.id) || body.id < 1 || !['approve', 'remove'].includes(body.action)) fail(400, 'INVALID_MODERATION', 'Provide a message ID and approve/remove action');
    const message = channel.messages.get(body.id);
    if (!message) fail(404, 'MESSAGE_NOT_FOUND', 'Message is unavailable');
    if (body.action === 'approve') {
      if (message.status === 'removed') fail(409, 'MESSAGE_REMOVED', 'Removed messages cannot be republished');
      if (!channel.messagesEnabled || channel.blocked.has(message.viewerId)) fail(403, 'MESSAGES_DISABLED', 'Publication is disabled');
      this.publishMessage(channel, message);
    } else this.removeMessage(channel, message);
    return { ok: true, id: message.id, pending: message.status === 'pending', removed: message.status === 'removed' };
  }

  settings(channel, body) {
    if (body.messagesEnabled === undefined && body.requireApproval === undefined) {
      fail(400, 'INVALID_SETTINGS', 'Provide a setting to change');
    }
    if (body.messagesEnabled !== undefined && typeof body.messagesEnabled !== 'boolean') {
      fail(400, 'INVALID_SETTINGS', 'Messages enabled must be a boolean');
    }
    if (body.requireApproval !== undefined && typeof body.requireApproval !== 'boolean') {
      fail(400, 'INVALID_SETTINGS', 'Require approval must be a boolean');
    }
    if (body.messagesEnabled !== undefined) channel.messagesEnabled = body.messagesEnabled;
    if (body.requireApproval !== undefined) channel.requireApproval = body.requireApproval;
    if (!channel.messagesEnabled) {
      for (const message of channel.messages.values()) this.removeMessage(channel, message);
    }
    return { ok: true, messagesEnabled: channel.messagesEnabled, requireApproval: channel.requireApproval };
  }

  block(channel, body) {
    if (!identifier(body.viewerId) || typeof body.blocked !== 'boolean') fail(400, 'INVALID_BLOCK', 'Provide viewerId and boolean blocked');
    if (body.blocked) {
      if (!channel.blocked.has(body.viewerId) && channel.blocked.size >= this.config.maxBlocked) fail(429, 'BLOCK_LIMIT', 'Channel block list limit reached');
      channel.blocked.add(body.viewerId);
      channel.profiles.delete(body.viewerId);
      channel.cooldowns.delete(body.viewerId);
      channel.votes.delete(body.viewerId);
      for (const message of channel.messages.values()) if (message.viewerId === body.viewerId) this.removeMessage(channel, message);
    } else channel.blocked.delete(body.viewerId);
    return { ok: true, viewerId: body.viewerId, blocked: body.blocked };
  }
}

module.exports = { Store, sanitizeMessage };
