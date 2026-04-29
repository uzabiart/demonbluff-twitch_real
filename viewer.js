




window.addEventListener("DOMContentLoaded", () => {

    const API_BASE = "https://demonbluff-twitchreal-production.up.railway.app";

// 🔥 FAKE TWITCH (LOCAL TEST MODE)
if (!window.Twitch) {
  console.log("FAKE TWITCH MODE");

  window.Twitch = {
    ext: {
      onAuthorized: (cb) => {
        setTimeout(() => {
          cb({
            channelId: "local_channel",
            userId: "local_user"
          });
        }, 100);
      },

      onContext: (cb) => {
        setTimeout(() => {
          cb({
            videoResolution: "1920x1080",
            displayResolution: "1920x1080",
            isFullScreen: false,
            isTheatreMode: false
          }, []);
        }, 200);
      }
    }
  };
}

   let ilosc_kart = 9;

   let lastFitScale = null;

  let currentRoundId = null;
  let currentMaxVotesPerUser = 1;
  let selectedCardsThisRound = new Set();
  let pollingStarted = false;
  let streamId = null;
  let userId = null;
  let isAuthorized = false;
  let firstContextReceived = false;

    // Na start: tylko pokazujemy 5 kart "na sztywno", żeby sprawdzić czy overlay w ogóle działa
    const stage = document.getElementById("stage");
    const stageWrap = document.getElementById("stageWrap");
    const uiScale = document.getElementById("uiScale");




let ui = { x: 0, y: 0, scale: 1 }; 
// x,y are OFFSETS IN DESIGN FRACTIONS (not window fractions)


let design = { w: 1920, h: 1080 }; // updated from Twitch context.videoResolution when available
let lastContext = null;

function setDesign(w, h) {
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return;
  design.w = w;
  design.h = h;
  document.documentElement.style.setProperty("--design-w", `${w}px`);
  document.documentElement.style.setProperty("--design-h", `${h}px`);
}

function parseResolution(str) {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(str || "");
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}



/**
 * Compute the true video content rectangle inside the iframe viewport,
 * assuming the video is fit-to-container while preserving aspect ratio ("contain").
 * Uses ONLY window metrics.
 */
function getVideoRect() {
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;

  const videoAR = design.w / design.h;
  const winAR = vw / vh;

  let x, y, w, h;

  if (winAR > videoAR) {
    // container too wide => pillarbox left/right
    h = vh;
    w = h * videoAR;
    x = (vw - w) / 2;
    y = 0;
  } else {
    // container too tall => letterbox top/bottom
    w = vw;
    h = w / videoAR;
    x = 0;
    y = (vh - h) / 2;
  }

  

  const fitScale = w / design.w; // design px -> screen px
  return { x, y, w, h, fitScale };
}




function applyUI(reason = "applyUI") {
  const rect = getVideoRect();
  const fit = rect.fitScale;

  if (!Number.isFinite(fit) || fit <= 0) return;

  // 🔥 BLOKADA mikro-zmian (KLUCZOWE)
  if (lastFitScale !== null && Math.abs(fit - lastFitScale) < 0.01) {
    return;
  }

  lastFitScale = fit;

  const cx = design.w / 2;
  const cy = design.h / 2;

  const tx = ui.x * design.w;
  const ty = ui.y * design.h;

  stage.style.transform =
    `translate(${rect.x}px, ${rect.y}px) ` +
    `scale(${fit}) ` +
    `translate(${cx}px, ${cy}px) ` +
    `scale(${ui.scale}) ` +
    `translate(${-cx}px, ${-cy}px) ` +
    `translate(${tx}px, ${ty}px)`;

  console.log("APPLY UI:", reason);
  console.log("FIT:", fit);
}



// suwak
if (uiScale) {
  uiScale.addEventListener("input", () => {
    ui.scale = Number(uiScale.value);
    applyUI("slider");
  });
}




let dragging = false;
let startX = 0, startY = 0, startUiX = 0, startUiY = 0;

stageWrap.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".card")) return;

  dragging = true;
  stageWrap.classList.add("dragging");
  stageWrap.setPointerCapture(e.pointerId);

  startX = e.clientX;
  startY = e.clientY;
  startUiX = ui.x;
  startUiY = ui.y;
});

stageWrap.addEventListener("pointermove", (e) => {
  if (!dragging) return;

  const rect = getVideoRect();
  const totalScale = rect.fitScale * ui.scale; // design px -> screen px

  if (!Number.isFinite(totalScale) || totalScale <= 0) return;

  // Convert screen delta to design delta, then to design fractions
  const dxDesign = (e.clientX - startX) / totalScale;
  const dyDesign = (e.clientY - startY) / totalScale;

  ui.x = startUiX + dxDesign / design.w;
  ui.y = startUiY + dyDesign / design.h;

  applyUI("drag");
});

function endDrag() {
  dragging = false;
  stageWrap.classList.remove("dragging");
}

stageWrap.addEventListener("pointerup", endDrag);
stageWrap.addEventListener("pointercancel", endDrag);









function computeSlots5() {
  const cx = design.w / 2;
  const cy = design.h / 2;

  const radius = Math.min(design.w, design.h) * 0.36;
  const anglesDeg = [-90, -18, 54, 126, 198];

  return anglesDeg.map((a) => {
    const rad = (a * Math.PI) / 180;
    return {
      x: cx + Math.cos(rad) * radius,
      y: cy + Math.sin(rad) * radius,
    };
  });
}

function computeSlots6() {
  const cx = design.w / 2;
  const cy = design.h / 2;

  const radius = Math.min(design.w, design.h) * 0.36;
  const anglesDeg = [-90, -30, 30, 90, 150, 210];

  return anglesDeg.map((a) => {
    const rad = (a * Math.PI) / 180;
    return {
      x: cx + Math.cos(rad) * radius,
      y: cy + Math.sin(rad) * radius,
    };
  });
}


function computeSlots7() {
  const cx = design.w / 2;
  const cy = design.h / 2;

  const radius = Math.min(design.w, design.h) * 0.36;

  const anglesDeg = [
    -90,
    -38.57,
    12.86,
    64.29,
    115.71,
    167.14,
    218.57
  ];

  return anglesDeg.map((a) => {
    const rad = (a * Math.PI) / 180;
    return {
      x: cx + Math.cos(rad) * radius,
      y: cy + Math.sin(rad) * radius,
    };
  });
}

function computeSlots8() {
  const cx = design.w / 2;
  const cy = design.h / 2;

  const radius = Math.min(design.w, design.h) * 0.36;

  const anglesDeg = [
    -90,
    -45,
    0,
    45,
    90,
    135,
    180,
    225
  ];

  return anglesDeg.map((a) => {
    const rad = (a * Math.PI) / 180;
    return {
      x: cx + Math.cos(rad) * radius,
      y: cy + Math.sin(rad) * radius,
    };
  });
}


function computeSlots9() {
  const cx = design.w / 2;
  const cy = design.h / 2;

  const radius = Math.min(design.w, design.h) * 0.36;

  const anglesDeg = [
    -90,
    -50,
    -10,
    30,
    70,
    110,
    150,
    190,
    230
  ];

  return anglesDeg.map((a) => {
    const rad = (a * Math.PI) / 180;
    return {
      x: cx + Math.cos(rad) * radius,
      y: cy + Math.sin(rad) * radius,
    };
  });
}






function computeSlotsByCount(count) {
  if (count === 5) return computeSlots5();
  if (count === 6) return computeSlots6();
  if (count === 7) return computeSlots7();
  if (count === 8) return computeSlots8();
  if (count === 9) return computeSlots9();

  console.warn("Brak layoutu dla:", count, "używam layoutu 9");
return computeSlots9();
}


async function fetchGameState() {

  if (!streamId) return;

  let res;
  try {
    res = await fetch(`${API_BASE}/results?streamId=${encodeURIComponent(streamId)}`, {
  cache: "no-store"
    });
  } catch {
    return;
  }

  if (!res.ok) return;

  const data = await res.json();

  console.log("RESULTS:", data);

  // 🔥 zmiana rundy
  if (currentRoundId !== data.roundId) {

    currentRoundId = data.roundId;
    selectedCardsThisRound = new Set();

    // liczba kart z backendu
    if (Number.isInteger(data.maxCards)) {
  ilosc_kart = Math.min(data.maxCards, 9);
}

    if (Number.isInteger(data.maxVotesPerUser)) {
      currentMaxVotesPerUser = Math.max(1, Math.min(data.maxVotesPerUser, 4, ilosc_kart));
    } else {
      currentMaxVotesPerUser = 1;
    }

    console.log("NEW ROUND", currentRoundId,
                "cards:", ilosc_kart,
                "votes per user:", currentMaxVotesPerUser);

    showCards();
  }
}

function startPolling() {
  if (pollingStarted) return;
  if (!streamId) return;   // ⭐ NOWE

  pollingStarted = true;

  setInterval(fetchGameState, 1000);
}



let rafPending = false;
function scheduleApplyUI(reason, extra) {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    applyUI(reason);
    // optional debug logging here
  });
}

window.addEventListener("resize", () => scheduleApplyUI("resize"));
document.addEventListener("fullscreenchange", () => scheduleApplyUI("fullscreenchange"));

function waitForTwitch() {
  if (window.Twitch && window.Twitch.ext) {
    console.log("TWITCH READY");

    window.Twitch.ext.onContext((context, changed) => {

  if (!changed.includes("videoResolution")) {
    return; // ❌ ignoruj spam
  }

  console.log("REAL RES CHANGE", context.videoResolution);

  const vr = parseResolution(context.videoResolution);
  if (vr && (vr.w !== design.w || vr.h !== design.h)) {
    setDesign(vr.w, vr.h);
  }

  scheduleApplyUI("onContext");
});

    window.Twitch.ext.onAuthorized((auth) => {
      isAuthorized = true;

      streamId = String(auth.channelId || "").trim();
      userId = String(auth.userId || "").trim();

      console.log("AUTHORIZED");
      console.log("STREAM ID =", streamId);
      console.log("USER ID =", userId);

      startPolling();
    });

  } else {
    setTimeout(waitForTwitch, 50);
  }
}

waitForTwitch();


// start
setDesign(design.w, design.h);
applyUI("startup");




window.addEventListener("resize", applyUI);



//logi

const DEBUG = true;

function logMetrics(tag, extra) {
  if (!DEBUG) return;

  const rect = getVideoRect();

  console.log(`[overlay:${tag}]`,
    {
      inner: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      design,
      videoRect: rect,
      ui,
      stageTransform: stage.style.transform,
      context: lastContext ? {
        isFullScreen: lastContext.isFullScreen,
        isTheatreMode: lastContext.isTheatreMode,
        displayResolution: lastContext.displayResolution,
        videoResolution: lastContext.videoResolution,
      } : null,
      extra
    }
  );
}











function addCard(label, x, y, cardId) {
  const el = document.createElement("div");
  el.className = "card";
  el.dataset.cardId = String(cardId);
  el.textContent = label;
  el.style.left = x + "px";
  el.style.top  = y + "px";

  el.addEventListener("click", () => {
    console.log("CARD CLICKED", cardId);
    sendVote(cardId);
  });

  stage.appendChild(el);
}


function showCards() {

  stage.innerHTML = "";

  const slots = computeSlotsByCount(ilosc_kart);

  for (let i = 0; i < ilosc_kart; i++) {

  // przesunięcie indeksów o 1 w lewo
  const slotIndex = (i + 1) % slots.length;

const slot = slots[slotIndex];
if (!slot) continue;

addCard(
  "#" + (i + 1),
  slot.x,
  slot.y,
  i + 1
);
}
}


/*
if (window.Twitch && window.Twitch.ext && window.Twitch.ext.onAuthorized) {
  window.Twitch.ext.onAuthorized((auth) => {
    isAuthorized = true;

    streamId = String(auth.channelId || "").trim();
    userId = String(auth.userId || "").trim();

    console.log("AUTHORIZED");
    console.log("STREAM ID =", streamId);
    console.log("USER ID =", userId);

    startPolling();
  });
}
*/





    function setStatus(msg) {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = msg;
}

function markCardSelected(cardId) {
  const el = stage.querySelector(`.card[data-card-id="${cardId}"]`);
  if (!el) return;
  el.classList.add("selected");
}

function getUserId() {
  if (userId) return userId;

  let id = localStorage.getItem("demo_uid");
  if (!id) {
    id = "demo_" + Math.random().toString(36).slice(2);
    localStorage.setItem("demo_uid", id);
  }
  return id;
}

async function sendVote(cardId) {
  if (!streamId) {
    setStatus("No streamId.");
    return;
  }

  if (selectedCardsThisRound.has(cardId)) {
    setStatus("Already selected this card.");
    return;
  }

  if (selectedCardsThisRound.size >= currentMaxVotesPerUser) {
    setStatus(`Vote limit reached (${currentMaxVotesPerUser}).`);
    return;
  }

  const uid = getUserId();

  let res;
  try {
  res = await fetch(`${API_BASE}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamId: streamId,
        cardId: cardId,
        userId: uid
      }),
    });
  } catch (e) {
    console.error("Vote request failed:", e);
    setStatus("Vote failed (network error).");
    return;
  }

  if (res.ok) {
    let data = null;
    try {
      data = await res.json();
    } catch {}

    selectedCardsThisRound.add(cardId);
    markCardSelected(cardId);

    const votesUsed = Number.isInteger(data?.votesUsed) ? data.votesUsed : selectedCardsThisRound.size;
    const maxVotes = Number.isInteger(data?.maxVotesPerUser) ? data.maxVotesPerUser : currentMaxVotesPerUser;
    const votesRemaining = Math.max(0, maxVotes - votesUsed);

    if (votesRemaining > 0) {
      setStatus(`Voted ${votesUsed}/${maxVotes}.`);
    } else {
      setStatus(`Voted ${votesUsed}/${maxVotes}.`);
    }
    return;
  }

  if (res.status === 409) {
    let data = null;
    try {
      data = await res.json();
    } catch {}

    if (data?.error === "ALREADY_VOTED_CARD") {
      setStatus("Already selected this card.");
      return;
    }

    if (data?.error === "VOTE_LIMIT_REACHED") {
      const maxVotes = Number.isInteger(data.maxVotesPerUser) ? data.maxVotesPerUser : currentMaxVotesPerUser;
      setStatus(`Vote limit reached (${maxVotes}).`);
      return;
    }

    setStatus("You already voted this round.");
    return;
  }

  let data = null;
  try {
    data = await res.json();
  } catch {}

  console.error("Vote error:", res.status, data);
  setStatus("Vote failed.");
}
})


