const { randomUUID } = require('node:crypto');
const { fail } = require('./errors');

const ownObject = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
const cardId = value => identifier(value) || (Number.isSafeInteger(value) && value >= 0);
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const hasControls = value => /[\p{Cc}\p{Cf}]/u.test(value);

function label(value) {
  return typeof value === 'string' && value.trim().length > 0
    && [...value].length <= 80 && !hasControls(value) && !/[<>]/.test(value);
}

function validateIds(value, allowed, min, max, dead = []) {
  if (!Array.isArray(value) || value.length < min || value.length > max
    || new Set(value).size !== value.length || value.some(x => !cardId(x) || !allowed.includes(x) || dead.includes(x))) {
    fail(400, 'INVALID_CARD_IDS', 'Card IDs must be unique, available and within the permitted count');
  }
  return [...value];
}

function validateRound(value) {
  if (!ownObject(value) || !identifier(value.id) || !Number.isSafeInteger(value.cardCount)
    || value.cardCount < 1 || value.cardCount > 100 || !Number.isSafeInteger(value.maxVotes)
    || value.maxVotes < 1 || value.maxVotes > value.cardCount || !Array.isArray(value.cards)
    || value.cards.length !== value.cardCount
    || value.cards.some(x => !ownObject(x) || !cardId(x.id) || !label(x.name))
    || new Set(value.cards.map(x => x.id)).size !== value.cards.length) {
    fail(400, 'INVALID_ROUND', 'Provide an ID, 1..100 named cards and a valid maxVotes');
  }
  const cards = value.cards.map(x => ({ id: x.id, name: x.name }));
  const deadCards = validateIds(value.deadCards, cards.map(x => x.id), 0, cards.length);
  return { id: value.id, cardCount: value.cardCount, maxVotes: value.maxVotes, deadCards, cards, resolved: false, correctCardIds: [] };
}

function validateChoice(body) {
  if (!identifier(body.choiceId) || !Array.isArray(body.candidates) || body.candidates.length !== 3
    || body.candidates.some(x => !ownObject(x) || !identifier(x.id) || !label(x.name))
    || new Set(body.candidates.map(x => x.id)).size !== 3) {
    fail(400, 'INVALID_CHOICE', 'Provide a choice ID and exactly three uniquely identified named candidates');
  }
  return { id: body.choiceId, candidates: body.candidates.map(x => ({ id: x.id, name: x.name })), closed: false, winnerId: null, votes: new Map() };
}

function sanitizeMessage(value) {
  if (typeof value !== 'string') fail(400, 'INVALID_MESSAGE', 'Message text is required');
  // Preserve the emoji joiner, but remove control, bidi and invisible format codes.
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, x => x === '\u200d' ? x : '').trim();
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
        nextChoice: null, choiceHistory: new Map(), messages: new Map(), removedMessageIds: new Set(),
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
    const { viewerId, displayName, eyes, head, body } = profile;
    return { viewerId, displayName, eyes, head, body };
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
    if (Object.values(parts).some(x => !Number.isInteger(x) || x < 1 || x > 3)) {
      fail(400, 'INVALID_AVATAR', 'eyes, head and body must each be an integer from 1 to 3');
    }
    return parts;
  }

  publicChoice(channel, viewerId) {
    const choice = channel.nextChoice;
    if (!choice) return null;
    const counts = new Map(choice.candidates.map(x => [x.id, 0]));
    for (const id of choice.votes.values()) counts.set(id, counts.get(id) + 1);
    return {
      id: choice.id, candidates: choice.candidates.map(x => ({ ...x, votes: counts.get(x.id) })),
      selectedId: viewerId ? choice.votes.get(viewerId) || null : null,
      closed: choice.closed, winnerId: choice.winnerId,
    };
  }

  viewerState(channel, identity) {
    this.touch(channel, identity.viewerId);
    return {
      ok: true, serverSession: this.serverSession,
      round: channel.round || { id: '', cardCount: 0, maxVotes: 0, deadCards: [], cards: [], resolved: false, correctCardIds: [] },
      profile: this.publicProfile(channel.profiles.get(identity.viewerId)),
      voteIds: [...(channel.votes.get(identity.viewerId) || [])], messagesEnabled: channel.messagesEnabled,
      nextChoice: this.publicChoice(channel, identity.viewerId),
    };
  }

  unityState(channel, after) {
    if (!Number.isSafeInteger(after) || after < 0) fail(400, 'INVALID_CURSOR', 'after must be a nonnegative integer');
    return {
      ok: true, serverSession: this.serverSession,
      viewers: [...channel.profiles.values()].map(x => this.publicProfile(x)),
      messages: [...channel.messages.values()].filter(x => x.status === 'approved' && x.messageId > after)
        .map(x => ({ id: x.messageId, viewerId: x.viewerId, text: x.text, kind: x.kind })).sort((a, b) => a.id - b.id),
      latestMessageId: channel.latestMessageId, removedMessageIds: [...channel.removedMessageIds],
      nextChoice: this.publicChoice(channel),
    };
  }

  publishRound(channel, body) {
    const next = validateRound(body.round);
    if (channel.round?.id === next.id) {
      const knownIds = new Set([...channel.roundCardIds, ...next.cards.map(x => x.id)]);
      if (knownIds.size > 1000) fail(429, 'ROUND_CARD_HISTORY_LIMIT', 'Round card history limit reached');
      channel.roundCardIds = knownIds;
      // Metadata describes new selections; submitted votes and results are historical.
      channel.round = { ...next, resolved: channel.round.resolved, correctCardIds: [...channel.round.correctCardIds] };
    } else {
      if (channel.roundHistory.has(next.id)) fail(409, 'STALE_ROUND', 'Round ID was already used');
      if (channel.round) this.remember(channel.roundHistory, channel.round.id, { ...channel.round, knownCardIds: [...channel.roundCardIds] });
      channel.round = next;
      channel.roundCardIds = new Set(next.cards.map(x => x.id));
      channel.votes.clear();
      if (channel.nextChoice) this.remember(channel.choiceHistory, channel.nextChoice.id, channel.nextChoice);
      channel.nextChoice = null;
    }
    return { ok: true, round: channel.round };
  }

  vote(channel, identity, body) {
    this.unblocked(channel, identity.viewerId);
    const round = channel.round;
    if (!round || body.roundId !== round.id) fail(409, 'STALE_ROUND', 'Round is no longer current');
    if (round.resolved) fail(409, 'ROUND_CLOSED', 'Round is closed');
    const ids = validateIds(body.cardIds, round.cards.map(x => x.id), 1, round.maxVotes, round.deadCards);
    if (!channel.votes.has(identity.viewerId) && channel.votes.size >= this.config.maxViewers) fail(429, 'VOTE_LIMIT', 'Channel vote limit reached');
    channel.votes.set(identity.viewerId, ids);
    this.touch(channel, identity.viewerId);
    return { ok: true, voteIds: ids };
  }

  publishChoice(channel, body) {
    const next = validateChoice(body);
    if (channel.nextChoice?.id === next.id) {
      if (JSON.stringify(channel.nextChoice.candidates) !== JSON.stringify(next.candidates)) fail(409, 'CHOICE_CONFLICT', 'Choice candidates cannot change under the same ID');
    } else {
      if (channel.choiceHistory.has(next.id)) fail(409, 'STALE_CHOICE', 'Choice ID was already used');
      if (channel.nextChoice) this.remember(channel.choiceHistory, channel.nextChoice.id, channel.nextChoice);
      channel.nextChoice = next;
    }
    return { ok: true, nextChoice: this.publicChoice(channel) };
  }

  choose(channel, identity, body) {
    this.unblocked(channel, identity.viewerId);
    const choice = channel.nextChoice;
    if (!choice || body.choiceId !== choice.id) fail(409, 'STALE_CHOICE', 'Choice is no longer current');
    if (choice.closed) fail(409, 'CHOICE_CLOSED', 'Choice is closed');
    if (!choice.candidates.some(x => x.id === body.candidateId)) fail(400, 'INVALID_CANDIDATE', 'Candidate is unavailable');
    if (!choice.votes.has(identity.viewerId) && choice.votes.size >= this.config.maxViewers) fail(429, 'VOTE_LIMIT', 'Channel vote limit reached');
    choice.votes.set(identity.viewerId, body.candidateId);
    this.touch(channel, identity.viewerId);
    return { ok: true, nextChoice: this.publicChoice(channel, identity.viewerId) };
  }

  resolveChoice(channel, body) {
    const choice = channel.nextChoice?.id === body.choiceId ? channel.nextChoice : channel.choiceHistory.get(body.choiceId);
    if (!choice || (choice !== channel.nextChoice && !choice.closed)) fail(409, 'STALE_CHOICE', 'Choice is no longer current');
    if (!choice.closed) {
      const totals = this.publicChoice(channel).candidates;
      choice.winnerId = totals.reduce((winner, candidate) => candidate.votes > winner.votes ? candidate : winner).id;
      choice.closed = true;
    }
    return { ok: true, choiceId: choice.id, winnerId: choice.winnerId };
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
    const round = channel.round?.id === body.roundId ? channel.round : channel.roundHistory.get(body.roundId);
    if (!round || (round !== channel.round && !round.resolved)) fail(409, 'STALE_ROUND', 'Round is no longer current');
    const knownIds = round === channel.round ? [...channel.roundCardIds] : round.knownCardIds;
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
    return {
      ok: true, messagesEnabled: channel.messagesEnabled, requireApproval: channel.requireApproval,
      messages: [...channel.messages.values()].map(x => ({
        id: x.id, viewerId: x.viewerId, displayName: x.displayName, text: x.text,
        pending: x.status === 'pending', removed: x.status === 'removed',
      })), blockedViewers: [...channel.blocked],
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
    if ((body.messagesEnabled === undefined && body.requireApproval === undefined)
      || (body.messagesEnabled !== undefined && typeof body.messagesEnabled !== 'boolean')
      || (body.requireApproval !== undefined && typeof body.requireApproval !== 'boolean')) fail(400, 'INVALID_SETTINGS', 'Settings must be booleans');
    if (body.messagesEnabled !== undefined) channel.messagesEnabled = body.messagesEnabled;
    if (body.requireApproval !== undefined) channel.requireApproval = body.requireApproval;
    if (!channel.messagesEnabled) for (const message of channel.messages.values()) this.removeMessage(channel, message);
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
      if (!channel.nextChoice?.closed) channel.nextChoice?.votes.delete(body.viewerId);
      for (const message of channel.messages.values()) if (message.viewerId === body.viewerId) this.removeMessage(channel, message);
    } else channel.blocked.delete(body.viewerId);
    return { ok: true, viewerId: body.viewerId, blocked: body.blocked };
  }
}

module.exports = { Store, sanitizeMessage };
