



const express = require("express");

const app = express();

app.use(express.json({ limit: "2kb" }));


const ALLOWED_ORIGINS = new Set([
  "https://supervisor.ext-twitch.tv",
  "https://www.twitch.tv",
  "https://twitch.tv",
]);

app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.url, "origin=", req.headers.origin || "-");
  next();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;

  // CORS (dla requestów robionych przez supervisor.js)
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    // fallback (np. gdy testujesz ręcznie)
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");

  // Pozwól Twitchowi embedować (gdyby jednak było użyte iframe)
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors https://supervisor.ext-twitch.tv https://*.twitch.tv"
  );
  res.removeHeader("X-Frame-Options");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// streamId -> state
const streams = Object.create(null);

/*
streams = {
  "streamer1": {
      roundId: 3,
      maxCards: 7,
      maxVotesPerUser: 1,
      votes: [0,0,0,0,0,0,0],
      userVotesThisRound: {}
  }
}
*/


function getStream(streamId) {
  if (!streams[streamId]) {
    streams[streamId] = {
      roundId: 1,
      maxCards: 10,
      maxVotesPerUser: 1,
      votes: Array(10).fill(0),
      userVotesThisRound: Object.create(null),
    };
  }
  return streams[streamId];
}

function parseVoteLimit(raw, cardCount) {
  if (raw === undefined || raw === null || raw === "") return 1;

  const limit = Number(raw);
  const maxAllowed = Math.min(4, cardCount);

  if (!Number.isInteger(limit) || limit < 1 || limit > maxAllowed) {
    return null;
  }

  return limit;
}

function startRound(req, res, source) {
  const body = source === "query" ? req.query : req.body;
  const streamId = String(body.streamId || "").trim();
  const cardCount = Number(body.cardCount);
  let requestedVoteLimit = body.maxVotesPerUser;
  if (requestedVoteLimit === undefined) requestedVoteLimit = body.voteLimit;
  if (requestedVoteLimit === undefined) requestedVoteLimit = body.votesPerUser;
  if (requestedVoteLimit === undefined) requestedVoteLimit = body.allowedVotes;

  if (!streamId) {
    return res.status(400).json({ ok: false, error: "Missing streamId" });
  }

  if (!Number.isInteger(cardCount) || cardCount < 1 || cardCount > 10) {
    return res.status(400).json({ ok: false, error: "Invalid cardCount (1-10)" });
  }

  const maxVotesPerUser = parseVoteLimit(requestedVoteLimit, cardCount);
  if (maxVotesPerUser === null) {
    return res.status(400).json({
      ok: false,
      error: `Invalid maxVotesPerUser (1-${Math.min(4, cardCount)})`
    });
  }

  const stream = getStream(streamId);

  stream.roundId++;
  stream.maxCards = cardCount;
  stream.maxVotesPerUser = maxVotesPerUser;
  stream.votes = Array(cardCount).fill(0);
  stream.userVotesThisRound = Object.create(null);

  console.log("ROUND STARTED FOR:", streamId, "cards=", cardCount, "votesPerUser=", maxVotesPerUser);

  res.json({
    ok: true,
    streamId,
    roundId: stream.roundId,
    maxCards: stream.maxCards,
    maxVotesPerUser: stream.maxVotesPerUser
  });
}




// ====== Round control ======

app.post("/startRound", (req, res) => {
  startRound(req, res, "body");
});



app.post("/vote", (req, res) => {
  const streamId = String(req.body.streamId || "").trim();
  const cardId = Number(req.body.cardId);
  const userId = String(req.body.userId || "").trim();

  if (!streamId) {
    return res.status(400).json({ ok: false, error: "Missing streamId" });
  }

  if (!userId) {
    return res.status(400).json({ ok: false, error: "Missing userId" });
  }

  const stream = getStream(streamId);

  if (
    !Number.isInteger(cardId) ||
    cardId < 1 ||
    cardId > stream.maxCards
  ) {
    return res.status(400).json({
      ok: false,
      error: `Invalid cardId (1-${stream.maxCards})`
    });
  }

  if (!stream.userVotesThisRound) {
    stream.userVotesThisRound = Object.create(null);
  }

  let userVotes = stream.userVotesThisRound[userId];
  if (!userVotes || userVotes.roundId !== stream.roundId) {
    userVotes = { roundId: stream.roundId, cards: [] };
    stream.userVotesThisRound[userId] = userVotes;
  }

  if (userVotes.cards.includes(cardId)) {
    return res.status(409).json({
      ok: false,
      error: "ALREADY_VOTED_CARD",
      maxVotesPerUser: stream.maxVotesPerUser,
      votesUsed: userVotes.cards.length,
      votesRemaining: Math.max(0, stream.maxVotesPerUser - userVotes.cards.length)
    });
  }

  if (userVotes.cards.length >= stream.maxVotesPerUser) {
    return res.status(409).json({
      ok: false,
      error: "VOTE_LIMIT_REACHED",
      maxVotesPerUser: stream.maxVotesPerUser,
      votesUsed: userVotes.cards.length,
      votesRemaining: 0
    });
  }

  stream.votes[cardId - 1]++;
  userVotes.cards.push(cardId);

  res.json({
    ok: true,
    streamId,
    roundId: stream.roundId,
    cardId,
    maxVotesPerUser: stream.maxVotesPerUser,
    votesUsed: userVotes.cards.length,
    votesRemaining: Math.max(0, stream.maxVotesPerUser - userVotes.cards.length)
  });
});



// Unity będzie to odpytywać
app.get("/results", (req, res) => {

  const streamId = String(req.query.streamId || "").trim();

  if (!streamId) {
    return res.status(400).json({ ok:false, error:"Missing streamId" });
  }

  const stream = getStream(streamId);

  const votesObj = {};
  for (let i=1;i<=stream.maxCards;i++)
    votesObj[i] = stream.votes[i-1] || 0;

  res.json({
    ok:true,
    roundId: stream.roundId,
    maxCards: stream.maxCards,
    maxVotesPerUser: stream.maxVotesPerUser || 1,
    votes: votesObj
  });
});



app.get("/__whoami", (req, res) => {
  res.type("text").send("WHOAMI: https-server.cjs WITH RESULTS v1");
});


app.get("/startRound", (req, res) => {
  startRound(req, res, "query");
});


app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
