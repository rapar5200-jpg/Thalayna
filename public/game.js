/* ==========================================================================
   ONAM PILLOW FIGHT - CLIENT GAME ENGINE (MAJOR UPDATE)
   ========================================================================== */

const socket = io();

// World Grid Reference Resolution
const WORLD = {
  WIDTH: 1920,
  HEIGHT: 1080,
  LOG_TOP_Y: 680,
  SEAT_OFFSET: 12,
  LOG_LEFT_X: 320,
  LOG_RIGHT_X: 1600,
  HURTBOX_WIDTH: 130,
  HURTBOX_HEIGHT: 210
};

// Calibrated Pelvis Seat Anchors across all 5 frames
const ANCHORS = {
  red: {
    1: { seatX: 405, seatY: 1056 },
    2: { seatX: 348, seatY: 1057 },
    3: { seatX: 365, seatY: 1036 },
    4: { seatX: 480, seatY: 875 },
    5: { seatX: 359, seatY: 1061 }
  },
  blue: {
    1: { seatX: 660, seatY: 1065 },
    2: { seatX: 661, seatY: 1068 },
    3: { seatX: 663, seatY: 1068 },
    4: { seatX: 802, seatY: 799 },
    5: { seatX: 662, seatY: 1062 }
  }
};

// Canvas & Viewport Scaler
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

let scale = 1;
let offsetX = 0;
let offsetY = 0;

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  scale = Math.min(canvas.width / WORLD.WIDTH, canvas.height / WORLD.HEIGHT);
  offsetX = (canvas.width - WORLD.WIDTH * scale) / 2;
  offsetY = (canvas.height - WORLD.HEIGHT * scale) / 2;
}
window.addEventListener('resize', () => {
  resizeCanvas();
  if (typeof checkOrientation === 'function') checkOrientation();
});
resizeCanvas();

// Persistent One-Device Identity (UUID generation without relying on shared IPs)
function getOrCreateDeviceId() {
  let id = localStorage.getItem('onam_device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36);
    localStorage.setItem('onam_device_id', id);
  }
  return id;
}
const localDeviceId = getOrCreateDeviceId();

// Mobile Haptic Feedback Helper
function triggerHaptic(type = 'light') {
  if ('vibrate' in navigator) {
    try {
      if (type === 'light') navigator.vibrate(15);
      else if (type === 'medium') navigator.vibrate(35);
      else if (type === 'heavy') navigator.vibrate([40, 20, 60]);
    } catch (e) {}
  }
}

// Orientation & Landscape 16:9 Controller for Mobile Devices
// Only enforce on actual phones (small width AND touch); tablets/desktops exempt
function checkOrientation() {
  const isTouchPhone = ('ontouchstart' in window) && window.screen.width <= 900 && window.screen.height <= 900;
  const isPortrait = window.innerHeight > window.innerWidth;
  const orientEl = document.getElementById('orientation-warning');
  if (orientEl) {
    orientEl.classList.toggle('hidden', !(isTouchPhone && isPortrait));
  }
}

// NOTE: resize is already attached at line 52 — add orientation check there instead
// Remove the second duplicate resize listener that was added previously
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    resizeCanvas();
    checkOrientation();
  }, 300);
});

// Reset all keys when window loses focus or tab becomes hidden (prevents stuck buttons)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearKeys();
});
window.addEventListener('blur', clearKeys);

checkOrientation();

// User Credentials & Room State
let localPlayerName = localStorage.getItem('onam_player_name') || '';
let isAudioMuted = false;
let isDebugMode = false;
let myRoomCode = null;
let amIRed = true;
let currentChallengerId = null;

// Server Telemetry State
let serverState = {
  red: { x: 520, y: WORLD.LOG_TOP_Y + WORLD.SEAT_OFFSET, vx: 0, vy: 0, state: 'IDLE', frameIndex: 1, energy: 100, ultMeter: 0, roundWins: 0, points: 0 },
  blue: { x: 1400, y: WORLD.LOG_TOP_Y + WORLD.SEAT_OFFSET, vx: 0, vy: 0, state: 'IDLE', frameIndex: 1, energy: 100, ultMeter: 0, roundWins: 0, points: 0 },

  combatIntensity: 0,
  roundState: 'MENU',
  roundTimeRemaining: 60,
  roundTitle: 'ROUND 1'
};

// Interpolated Client Visual State
let clientState = {
  red: { x: 520, y: WORLD.LOG_TOP_Y + WORLD.SEAT_OFFSET, alpha: 1.0, sinkY: 0 },
  blue: { x: 1400, y: WORLD.LOG_TOP_Y + WORLD.SEAT_OFFSET, alpha: 1.0, sinkY: 0 }
};

// Visual Effects & Particle System
let cameraShake = { x: 0, y: 0, intensity: 0, zoom: 1.0 };
let hitStopTimer = 0;
let afterImages = { red: [], blue: [] };
let particles = [];
let petals = [];
let fireworks = [];
let shockwaves = [];
let bubbles = [];

// Preload Character Image Assets
const frameImages = { red: {}, blue: {} };

function preloadAssets() {
  for (let i = 1; i <= 5; i++) {
    const rImg = new Image();
    rImg.src = `/assets/red_player/frame_00${i}.png`;
    frameImages.red[i] = rImg;

    const bImg = new Image();
    bImg.src = `/assets/blue_player/frame_00${i}.png`;
    frameImages.blue[i] = bImg;
  }

  for (let i = 0; i < 40; i++) {
    petals.push({
      x: Math.random() * WORLD.WIDTH,
      y: Math.random() * WORLD.HEIGHT,
      speedY: 0.4 + Math.random() * 1.0,
      speedX: -0.4 + Math.random() * 0.8,
      size: 4 + Math.random() * 6,
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: -0.02 + Math.random() * 0.04
    });
  }
}
preloadAssets();

// Web Audio API Synthesizer
let audioCtx = null;
function initAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function playSound(type) {
  if (isAudioMuted) return;
  initAudio();
  if (!audioCtx) return;

  const now = audioCtx.currentTime;

  if (type === 'thud') {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, now);
    osc.frequency.exponentialRampToValueAtTime(35, now + 0.18);
    gain.gain.setValueAtTime(0.85, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.18);
  } else if (type === 'power') {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(260, now);
    osc.frequency.exponentialRampToValueAtTime(30, now + 0.3);
    gain.gain.setValueAtTime(1.0, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.3);
  } else if (type === 'ultimate') {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(450, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.5);
    gain.gain.setValueAtTime(1.0, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.5);
  } else if (type === 'splash') {
    const bufferSize = audioCtx.sampleRate * 0.5;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const output = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) output[i] = Math.random() * 2 - 1;
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(950, now);
    filter.frequency.exponentialRampToValueAtTime(100, now + 0.5);
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.95, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);
    noise.start(now);
  } else if (type === 'beep') {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, now);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.1);
  } else if (type === 'fight') {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1200, now);
    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.35);
  }
}

// User Inputs & 4 Attack Buttons Handler
const keys = { left: false, right: false, attackType: null };

function clearKeys() {
  keys.left = false;
  keys.right = false;
  keys.attackType = null;
  sendInputState();
}

window.addEventListener('keydown', (e) => {
  // If user is currently typing in an input box or textarea, do not capture game hotkeys
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
    if (e.key === 'Enter') {
      if (e.target.id === 'username-input') {
        confirmUsername();
      } else if (e.target.id === 'join-code-input') {
        joinPrivateRoom();
      }
    }
    return;
  }

  let isGameKey = false;

  if (e.key === 'a' || e.key === 'A' || e.key === 'ArrowLeft') { keys.left = true; isGameKey = true; }
  if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight') { keys.right = true; isGameKey = true; }

  if (e.key === '1') { keys.attackType = 'quick'; isGameKey = true; }
  if (e.key === '2') { keys.attackType = 'power'; isGameKey = true; }
  if (e.key === '3') { keys.attackType = 'combo'; isGameKey = true; }
  if (e.key === '4' || e.key === ' ' || e.key === 'k' || e.key === 'K') { keys.attackType = 'ultimate'; isGameKey = true; }

  if (e.key === '`' || e.key === '~') {
    isDebugMode = !isDebugMode;
    document.getElementById('debug-overlay').classList.toggle('hidden', !isDebugMode);
    isGameKey = true;
  }

  if (isGameKey) {
    e.preventDefault();
  }

  sendInputState();
});

window.addEventListener('keyup', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
    return;
  }

  let isGameKey = false;

  if (e.key === 'a' || e.key === 'A' || e.key === 'ArrowLeft') { keys.left = false; isGameKey = true; }
  if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight') { keys.right = false; isGameKey = true; }
  if (['1', '2', '3', '4', ' ', 'k', 'K'].includes(e.key)) { keys.attackType = null; isGameKey = true; }

  if (isGameKey) {
    e.preventDefault();
  }

  sendInputState();
});

window.addEventListener('blur', clearKeys);
window.addEventListener('focus', clearKeys);

// Mobile Touch Controls & 4 Attack Buttons Binding (Unified Pointer Events + Multi-touch + Pointer Capture)
const btnLeft = document.getElementById('btn-left');
const btnRight = document.getElementById('btn-right');
const btnQuick = document.getElementById('btn-attack-quick');
const btnPower = document.getElementById('btn-attack-power');
const btnCombo = document.getElementById('btn-attack-combo');
const btnUltimate = document.getElementById('btn-attack-ultimate');

function bindDirectionButton(btnEl, direction) {
  if (!btnEl) return;
  
  const handleDown = (e) => {
    e.preventDefault();
    try {
      if (e.pointerId !== undefined && btnEl.setPointerCapture) {
        btnEl.setPointerCapture(e.pointerId);
      }
    } catch (err) {}
    keys[direction] = true;
    triggerHaptic('light');
    sendInputState();
  };

  const handleUp = (e) => {
    e.preventDefault();
    try {
      if (e.pointerId !== undefined && btnEl.releasePointerCapture) {
        btnEl.releasePointerCapture(e.pointerId);
      }
    } catch (err) {}
    keys[direction] = false;
    sendInputState();
  };

  btnEl.addEventListener('pointerdown', handleDown);
  btnEl.addEventListener('pointerup', handleUp);
  btnEl.addEventListener('pointercancel', handleUp);
  btnEl.addEventListener('pointerleave', (e) => {
    // If not captured, release on pointer leave
    if (keys[direction]) {
      keys[direction] = false;
      sendInputState();
    }
  });
}

bindDirectionButton(btnLeft, 'left');
bindDirectionButton(btnRight, 'right');

function bindAttackButton(btnEl, attackType) {
  if (!btnEl) return;

  const handleAttackDown = (e) => {
    e.preventDefault();
    try {
      if (e.pointerId !== undefined && btnEl.setPointerCapture) {
        btnEl.setPointerCapture(e.pointerId);
      }
    } catch (err) {}
    keys.attackType = attackType;
    triggerHaptic(attackType === 'ultimate' ? 'heavy' : 'medium');
    sendInputState();
  };

  const handleAttackUp = (e) => {
    e.preventDefault();
    try {
      if (e.pointerId !== undefined && btnEl.releasePointerCapture) {
        btnEl.releasePointerCapture(e.pointerId);
      }
    } catch (err) {}
    keys.attackType = null;
    sendInputState();
  };

  btnEl.addEventListener('pointerdown', handleAttackDown);
  btnEl.addEventListener('pointerup', handleAttackUp);
  btnEl.addEventListener('pointercancel', handleAttackUp);
}

bindAttackButton(btnQuick, 'quick');
bindAttackButton(btnPower, 'power');
bindAttackButton(btnCombo, 'combo');
bindAttackButton(btnUltimate, 'ultimate');

function sendInputState() {
  if (!myRoomCode) return;
  let move = 0;
  if (keys.left) move -= 1;
  if (keys.right) move += 1;
  socket.emit('player_input', { move, attackType: keys.attackType });
}

// Socket Network Handlers
socket.on('connect', () => {
  if (localPlayerName) {
    socket.emit('set_username', { name: localPlayerName, deviceId: localDeviceId });
  } else {
    openNameModal();
  }
});

socket.on('username_confirmed', (res) => {
  const confirmedName = typeof res === 'object' ? res.name : res;
  localPlayerName = confirmedName;
  localStorage.setItem('onam_player_name', confirmedName);
  document.getElementById('player-display-name').innerText = confirmedName;
  closeModal('username-modal');
});

socket.on('online_players_list', (players) => {
  document.getElementById('online-count-badge').innerText = players.length;
  renderActivePlayersList(players);
});

socket.on('room_created', ({ roomCode, isRed }) => {
  myRoomCode = roomCode;
  amIRed = isRed;
  document.getElementById('generated-code-text').innerText = roomCode;
  document.getElementById('created-room-box').classList.remove('hidden');
});

socket.on('match_joined', ({ roomCode, isRed, opponentName }) => {
  myRoomCode = roomCode;
  amIRed = isRed;
  closeAllModals();
  clearKeys();
  
  // Stop onam cover songs and play InShot Battle BGM
  playBattleMusic(0.35);

  document.getElementById('menu-screen').classList.remove('active');
  document.getElementById('game-hud').classList.remove('hidden');
  const scorecardEl = document.getElementById('game-scorecard');
  if (scorecardEl) scorecardEl.classList.remove('hidden');
  document.getElementById('mobile-controls').classList.remove('hidden');

  if (isRed) {
    document.getElementById('hud-red-name').innerText = localPlayerName;
    document.getElementById('hud-blue-name').innerText = opponentName;
  } else {
    document.getElementById('hud-red-name').innerText = opponentName;
    document.getElementById('hud-blue-name').innerText = localPlayerName;
  }
});

socket.on('room_error', (msg) => {
  document.getElementById('room-error').innerText = msg;
});

socket.on('matchmaking_status', () => { openModal('matchmaking-modal'); });
socket.on('matchmaking_cancelled', () => { closeModal('matchmaking-modal'); });

socket.on('incoming_challenge', ({ fromSocketId, fromName }) => {
  currentChallengerId = fromSocketId;
  document.getElementById('challenger-name-text').innerText = `${fromName.toUpperCase()} HAS CHALLENGED YOU!`;
  openModal('challenge-modal');
});

socket.on('challenge_declined', ({ fromName }) => {
  alert(`${fromName} declined your 1v1 challenge.`);
});

socket.on('game_tick', (tickData) => {
  serverState = tickData;
  updateHUD(tickData);
});

socket.on('pillow_impact', ({ attacker, defender, attackType, damage, defenderRemainingEnergy, impactX, impactY, isCounter, isUltimate, comboCount, shakeIntensity, hitStopMs }) => {
  cameraShake.intensity = shakeIntensity;
  hitStopTimer = hitStopMs;
  playSound(isUltimate ? 'ultimate' : isCounter ? 'power' : 'thud');

  if (isUltimate) {
    cameraShake.zoom = 1.08;
    spawnFireworks(impactX, impactY - 100);
  }

  // Shockwave Ring
  shockwaves.push({ x: impactX, y: impactY, radius: 10, maxRadius: isUltimate ? 140 : 70, alpha: 1.0 });

  // Center Combat Popup Text
  let popupMsg = `${damage} DMG!`;
  if (isUltimate) popupMsg = '🌟 ULTIMATE PILLOW SLAM!';
  else if (isCounter) popupMsg = '💥 COUNTER HIT!';
  else if (comboCount >= 3) popupMsg = `🔥 ${comboCount} HIT COMBO!`;

  showCombatPopup(popupMsg);

  // Feather & Spark Explosion
  const count = isUltimate ? 45 : isCounter ? 28 : 16;
  for (let i = 0; i < count; i++) {
    particles.push({
      x: impactX,
      y: impactY,
      vx: (Math.random() - 0.5) * (isUltimate ? 24 : 14),
      vy: (Math.random() - 0.5) * (isUltimate ? 24 : 14),
      color: isUltimate ? '#FFD700' : isCounter ? '#FFB703' : '#FFFFFF',
      size: 4 + Math.random() * 8,
      life: 1.0,
      decay: 0.03
    });
  }
});

socket.on('player_fell_water', ({ fellPlayer, splashX, splashY }) => {
  playSound('splash');
  cameraShake.intensity = 28;
  clearKeys();

  // Water Splash Particles & Bubbles
  for (let i = 0; i < 55; i++) {
    particles.push({
      x: splashX,
      y: splashY,
      vx: (Math.random() - 0.5) * 22,
      vy: -Math.random() * 22 - 4,
      color: '#4CC9F0',
      size: 6 + Math.random() * 12,
      life: 1.0,
      decay: 0.02
    });
  }

  for (let i = 0; i < 20; i++) {
    bubbles.push({
      x: splashX + (Math.random() - 0.5) * 60,
      y: splashY + 20 + Math.random() * 40,
      speedY: -1.2 - Math.random() * 1.5,
      radius: 3 + Math.random() * 6,
      alpha: 1.0
    });
  }
});

socket.on('round_countdown', ({ seconds, roundTitle, redRoundWins, blueRoundWins }) => {
  clearKeys();
  showAnnouncer(seconds > 0 ? seconds : 'FIGHT!');
  playSound(seconds > 0 ? 'beep' : 'fight');
  playBattleMusic(0.35);
  document.getElementById('hud-round-indicator').innerText = roundTitle;
  document.getElementById('hud-red-score-num').innerText = redRoundWins;
  document.getElementById('hud-blue-score-num').innerText = blueRoundWins;
});

socket.on('round_start', ({ roundTitle }) => {
  showAnnouncer('FIGHT!');
  playSound('fight');
  playBattleMusic(0.35);
  setTimeout(() => hideAnnouncer(), 1000);

  if (roundTitle === 'FINAL ROUND') {
    spawnFireworks(WORLD.WIDTH / 2, 200);
  }
});

socket.on('round_over', ({ roundWinner, reason, redRoundWins, blueRoundWins }) => {
  clearKeys();
  const winnerText = `${roundWinner.toUpperCase()} PLAYER WINS ROUND!\n${reason}`;
  showAnnouncer(winnerText);
  document.getElementById('hud-red-score-num').innerText = redRoundWins;
  document.getElementById('hud-blue-score-num').innerText = blueRoundWins;
});

socket.on('match_over', ({ winnerName, red, blue }) => {
  clearKeys();
  spawnFireworks(WORLD.WIDTH / 2, 250);
  
  // Play Onam cover song softly on match complete
  playCoverMusic(0.18);

  document.getElementById('match-winner-title').innerText = `🏆 WINNER: ${winnerName.toUpperCase()}`;
  document.getElementById('final-red-name').innerText = red.name;
  document.getElementById('final-red-score-val').innerText = red.roundWins;
  document.getElementById('final-blue-name').innerText = blue.name;
  document.getElementById('final-blue-score-val').innerText = blue.roundWins;

  socket.emit('get_leaderboard');
  openModal('match-over-modal');
});

socket.on('rematch_update', ({ votes }) => {
  const cnt = document.getElementById('rematch-count');
  if (cnt) cnt.innerText = votes;
});

socket.on('leaderboard_update', (board) => {
  latestLeaderboardData = board || [];
  renderLeaderboard(latestLeaderboardData);
  renderResultTop10(latestLeaderboardData);
});

socket.on('opponent_disconnected', () => {
  alert('Your opponent disconnected from the match.');
  leaveMatchToMenu();
});

// UI Modal Handlers & Dynamic Leaderboard
let latestLeaderboardData = [];
let usernameCheckTimeout = null;
let isCurrentUsernameValid = false;

function openNameModal() { 
  openModal('username-modal'); 
  const input = document.getElementById('username-input');
  if (input) {
    input.value = localPlayerName || '';
    if (localPlayerName) {
      checkUsernameLive(localPlayerName);
    } else {
      resetUsernameStatus();
    }
  }
}

function resetUsernameStatus() {
  const statusEl = document.getElementById('username-status');
  const suggestionsEl = document.getElementById('username-suggestions');
  const confirmBtn = document.getElementById('username-confirm-btn');
  const inputEl = document.getElementById('username-input');
  const errorEl = document.getElementById('username-error');

  if (statusEl) statusEl.innerHTML = '';
  if (suggestionsEl) suggestionsEl.classList.add('hidden');
  if (confirmBtn) confirmBtn.disabled = true;
  if (inputEl) {
    inputEl.classList.remove('input-available', 'input-taken');
  }
  if (errorEl) errorEl.innerText = '';
  isCurrentUsernameValid = false;
}

async function checkUsernameLive(name) {
  const cleanName = (name || '').trim();
  const statusEl = document.getElementById('username-status');
  const suggestionsEl = document.getElementById('username-suggestions');
  const chipsEl = document.getElementById('suggestion-chips');
  const confirmBtn = document.getElementById('username-confirm-btn');
  const inputEl = document.getElementById('username-input');
  const errorEl = document.getElementById('username-error');

  if (!cleanName || cleanName.length < 2) {
    resetUsernameStatus();
    if (cleanName.length === 1 && errorEl) {
      errorEl.innerText = 'Name must be at least 2 characters.';
    }
    return;
  }

  if (statusEl) {
    statusEl.innerHTML = `<span class="status-checking"><span class="status-spinner"></span> Checking availability...</span>`;
  }
  if (errorEl) errorEl.innerText = '';

  try {
    const res = await fetch(`/api/username-check?username=${encodeURIComponent(cleanName)}&deviceId=${encodeURIComponent(localDeviceId)}`);
    const data = await res.json();

    if (data.available) {
      isCurrentUsernameValid = true;
      if (statusEl) {
        statusEl.innerHTML = `<span class="status-available"><i class="fa-solid fa-circle-check"></i> "${data.confirmedName}" is available!</span>`;
      }
      if (inputEl) {
        inputEl.classList.add('input-available');
        inputEl.classList.remove('input-taken');
      }
      if (suggestionsEl) suggestionsEl.classList.add('hidden');
      if (confirmBtn) confirmBtn.disabled = false;
      if (errorEl) errorEl.innerText = '';
    } else {
      isCurrentUsernameValid = false;
      if (statusEl) {
        statusEl.innerHTML = `<span class="status-taken"><i class="fa-solid fa-circle-xmark"></i> ${data.reason || 'Username is already taken.'}</span>`;
      }
      if (inputEl) {
        inputEl.classList.add('input-taken');
        inputEl.classList.remove('input-available');
      }
      if (confirmBtn) confirmBtn.disabled = true;

      // Render suggestions chips
      if (data.suggestions && data.suggestions.length > 0 && chipsEl && suggestionsEl) {
        chipsEl.innerHTML = '';
        data.suggestions.forEach(sug => {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'suggestion-chip';
          chip.innerText = sug;
          chip.onclick = () => selectSuggestion(sug);
          chipsEl.appendChild(chip);
        });
        suggestionsEl.classList.remove('hidden');
      }
    }
  } catch (err) {
    // If offline / server check fails, allow local confirm
    isCurrentUsernameValid = true;
    if (statusEl) statusEl.innerHTML = `<span class="status-available"><i class="fa-solid fa-circle-check"></i> Ready</span>`;
    if (confirmBtn) confirmBtn.disabled = false;
  }
}

function selectSuggestion(suggestion) {
  const inputEl = document.getElementById('username-input');
  if (inputEl) {
    inputEl.value = suggestion;
    checkUsernameLive(suggestion);
  }
}

// Bind live debounced typing on username input
const usernameInputEl = document.getElementById('username-input');
if (usernameInputEl) {
  usernameInputEl.addEventListener('input', (e) => {
    clearTimeout(usernameCheckTimeout);
    const val = e.target.value;
    usernameCheckTimeout = setTimeout(() => {
      checkUsernameLive(val);
    }, 280);
  });
}

function confirmUsername() {
  const input = document.getElementById('username-input')?.value.trim();
  if (!input || input.length < 2) {
    const err = document.getElementById('username-error');
    if (err) err.innerText = 'Name must be at least 2 characters.';
    return;
  }
  const errorEl = document.getElementById('username-error');
  if (errorEl) errorEl.innerText = '';
  socket.emit('set_username', { name: input, deviceId: localDeviceId });
}

function filterLeaderboard() {
  const query = (document.getElementById('leaderboard-search-input')?.value || '').toLowerCase().trim();
  if (!query) {
    renderLeaderboard(latestLeaderboardData);
  } else {
    const filtered = latestLeaderboardData.filter(p => p.name.toLowerCase().includes(query));
    renderLeaderboard(filtered);
  }
}

function showRoomModal() { openModal('room-modal'); }
function createPrivateRoom() { socket.emit('create_room'); }
function joinPrivateRoom() {
  const code = document.getElementById('join-code-input').value.trim();
  if (!code) {
    document.getElementById('room-error').innerText = 'Please enter a valid room code.';
    return;
  }
  socket.emit('join_room', code);
}

function copyRoomCode() {
  if (myRoomCode) {
    navigator.clipboard.writeText(myRoomCode);
    alert(`Copied room code: ${myRoomCode}`);
  }
}

function startMatchmaking() { socket.emit('find_match'); }
function cancelMatchmaking() { socket.emit('cancel_matchmaking'); }

function openActivePlayersModal() {
  socket.emit('get_online_players');
  openModal('active-players-modal');
}

function renderActivePlayersList(players) {
  const listEl = document.getElementById('active-players-list');
  listEl.innerHTML = '';
  const otherPlayers = players.filter(p => p.socketId !== socket.id);

  if (otherPlayers.length === 0) {
    listEl.innerHTML = `<p class="empty-text">No other players online right now. Invite a friend using a Room Code!</p>`;
    return;
  }

  otherPlayers.forEach(p => {
    const item = document.createElement('div');
    item.className = 'player-item';
    item.innerHTML = `
      <div>
        <strong>${p.name}</strong>
        <div class="player-status">${p.status.toUpperCase()}</div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="challengePlayer('${p.socketId}')" ${p.status !== 'idle' ? 'disabled' : ''}>
        CHALLENGE
      </button>
    `;
    listEl.appendChild(item);
  });
}

function challengePlayer(targetSocketId) {
  socket.emit('send_challenge', targetSocketId);
  closeModal('active-players-modal');
  alert('Challenge invitation sent!');
}

function acceptChallenge() {
  if (currentChallengerId) {
    socket.emit('respond_challenge', { fromSocketId: currentChallengerId, accepted: true });
    closeModal('challenge-modal');
  }
}

function declineChallenge() {
  if (currentChallengerId) {
    socket.emit('respond_challenge', { fromSocketId: currentChallengerId, accepted: false });
    closeModal('challenge-modal');
  }
}

function openLeaderboardModal() {
  socket.emit('get_leaderboard');
  openModal('leaderboard-modal');
}

// Render Live Dynamic Leaderboard (No Static Dummy Names)
function renderLeaderboard(board) {
  const tbody = document.getElementById('leaderboard-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!board || board.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10">
          <div class="lb-empty-state">
            <i class="fa-solid fa-trophy"></i>
            <p><strong>No champions yet!</strong><br>Play a match and be the first on the global leaderboard!</p>
          </div>
        </td>
      </tr>`;
    return;
  }

  board.forEach((p, idx) => {
    const tr = document.createElement('tr');
    const isCurrentPlayer = (p.name.toLowerCase() === localPlayerName.toLowerCase()) || (p.deviceId && p.deviceId === localDeviceId);
    if (isCurrentPlayer) tr.className = 'highlight-user-row';
    const medal = idx === 0 ? '🥇 ' : idx === 1 ? '🥈 ' : idx === 2 ? '🥉 ' : '';
    const rankClass = idx === 0 ? 'rank-1' : idx === 1 ? 'rank-2' : idx === 2 ? 'rank-3' : '';
    tr.innerHTML = `
      <td class="${rankClass}"><strong>${medal}#${idx + 1}</strong></td>
      <td><strong>${p.name}</strong> ${isCurrentPlayer ? '<span style="color:var(--primary-color); font-size:0.75rem;">(YOU)</span>' : ''}</td>
      <td>${p.totalMatches || 0}</td>
      <td>${p.matchesWon || 0}</td>
      <td>${p.matchesLost || 0}</td>
      <td>${p.roundsWon || 0}</td>
      <td>${p.energyDamageGiven || 0}</td>
      <td>${p.winPercentage || 0}%</td>
      <td><strong>${p.score || 0}</strong></td>
      <td>🔥 ${p.winStreak || 0}</td>
    `;
    tbody.appendChild(tr);
  });
}
// Render Global Top 10 on Match Result Screen (Real Players Only)
function renderResultTop10(board) {
  const tbody = document.getElementById('result-top10-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const cleanBoard = board || [];
  const top10 = cleanBoard.slice(0, 10);

  if (top10.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#A0C4E2;">No completed matches yet. Be the first champion!</td></tr>`;
  } else {
    top10.forEach((p, idx) => {
      const tr = document.createElement('tr');
      const isCurrentPlayer = (p.name === localPlayerName);
      if (isCurrentPlayer) tr.className = 'highlight-user-row';
      const rankClass = idx === 0 ? 'rank-1' : idx === 1 ? 'rank-2' : idx === 2 ? 'rank-3' : '';
      tr.innerHTML = `
        <td class="${rankClass}">#${idx + 1}</td>
        <td><strong>${p.name}</strong> ${isCurrentPlayer ? '(YOU)' : ''}</td>
        <td>${p.matchesWon || 0}</td>
        <td>${p.roundsWon || 0}</td>
        <td>${p.score || 0}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  // Render User Global Position Card
  const userCard = document.getElementById('user-global-position-card');
  const userRankEl = document.getElementById('ugp-rank');
  const userNameEl = document.getElementById('ugp-name');
  const userWinsEl = document.getElementById('ugp-wins');
  const userRoundsEl = document.getElementById('ugp-rounds');
  const userScoreEl = document.getElementById('ugp-score');

  if (userCard && localPlayerName) {
    const userIndex = cleanBoard.findIndex(p => p.name.toLowerCase() === localPlayerName.toLowerCase());
    if (userIndex !== -1) {
      const userStats = cleanBoard[userIndex];
      userRankEl.innerText = `#${userIndex + 1}`;
      userNameEl.innerText = `${userStats.name} (YOU)`;
      userWinsEl.innerText = userStats.matchesWon || 0;
      userRoundsEl.innerText = userStats.roundsWon || 0;
      userScoreEl.innerText = userStats.score || 0;
      userCard.classList.remove('hidden');
    } else {
      userRankEl.innerText = `#—`;
      userNameEl.innerText = `${localPlayerName} (YOU)`;
      userWinsEl.innerText = '0';
      userRoundsEl.innerText = '0';
      userScoreEl.innerText = '0';
      userCard.classList.remove('hidden');
    }
  }
}

// ==========================================================================
// ONAM AUDIO DUAL-ENGINE: COVER TRACKS (onam folder) & BATTLE TRACK (InShot)
// ==========================================================================
let onamCoverPlaylist = [];
let currentCoverTrackIndex = 0;
const bgmPlayer = document.getElementById('bgm-player');
let currentAudioMode = 'cover'; // 'cover' or 'battle'

fetch('/assets/audio/tracks.json')
  .then(res => res.json())
  .then(data => {
    onamCoverPlaylist = data;
    if (onamCoverPlaylist.length > 0) {
      currentCoverTrackIndex = Math.floor(Math.random() * onamCoverPlaylist.length);
      setCoverTrack(currentCoverTrackIndex);
    }
  })
  .catch(() => {
    onamCoverPlaylist = [{ id: 0, name: 'Onam Celebration Music', url: '/assets/bgm.mp3' }];
    setCoverTrack(0);
  });

function setCoverTrack(index) {
  if (!onamCoverPlaylist || onamCoverPlaylist.length === 0) return;
  currentCoverTrackIndex = (index + onamCoverPlaylist.length) % onamCoverPlaylist.length;
  const track = onamCoverPlaylist[currentCoverTrackIndex];
  if (bgmPlayer && currentAudioMode === 'cover') {
    bgmPlayer.src = track.url;
  }
  const titleEl = document.getElementById('music-track-title');
  if (titleEl && currentAudioMode === 'cover') {
    titleEl.innerText = track.name;
  }
}

if (bgmPlayer) {
  bgmPlayer.volume = 0.35;
  bgmPlayer.addEventListener('ended', () => {
    if (currentAudioMode === 'cover') {
      setCoverTrack(currentCoverTrackIndex + 1);
      playCoverMusic();
    } else {
      // Loop battle music
      bgmPlayer.currentTime = 0;
      playBattleMusic();
    }
  });
}

// Play Onam Cover Music (from onam folder)
function playCoverMusic(volume = 0.35) {
  currentAudioMode = 'cover';
  if (!bgmPlayer) return;
  if (onamCoverPlaylist.length > 0) {
    const track = onamCoverPlaylist[currentCoverTrackIndex];
    if (bgmPlayer.src !== window.location.origin + track.url) {
      bgmPlayer.src = track.url;
    }
    const titleEl = document.getElementById('music-track-title');
    if (titleEl) titleEl.innerText = track.name;
  }
  bgmPlayer.volume = volume;
  if (!isAudioMuted) {
    bgmPlayer.play().catch(() => {});
  }
  const waveBar = document.getElementById('music-wave-bar');
  if (waveBar) waveBar.classList.remove('hidden');
  updateMusicWaveBar();
}

// Play In-Game Battle Music strictly (InShot_20260824_231924488.mp3)
function playBattleMusic(volume = 0.35) {
  currentAudioMode = 'battle';
  if (!bgmPlayer) return;
  const battleTrackUrl = '/assets/bgm.mp3';
  if (bgmPlayer.src !== window.location.origin + battleTrackUrl) {
    bgmPlayer.src = battleTrackUrl;
  }
  // Do not show song name during active gameplay
  const waveBar = document.getElementById('music-wave-bar');
  if (waveBar) waveBar.classList.add('hidden');
  
  bgmPlayer.volume = volume;
  if (!isAudioMuted) {
    bgmPlayer.play().catch(() => {});
  }
}

function stopBGM() {
  if (bgmPlayer) {
    bgmPlayer.pause();
  }
  updateMusicWaveBar();
}

function updateMusicWaveBar() {
  const waveBar = document.getElementById('music-wave-bar');
  if (waveBar) {
    waveBar.classList.toggle('muted', isAudioMuted || (bgmPlayer && bgmPlayer.paused));
  }
  const coverBtn = document.getElementById('cover-mute-btn');
  if (coverBtn) {
    coverBtn.innerHTML = `<i class="fa-solid fa-volume-${isAudioMuted ? 'xmark' : 'high'}"></i> MUSIC: ${isAudioMuted ? 'OFF' : 'ON'}`;
  }
  const muteBtn = document.getElementById('mute-btn');
  if (muteBtn) {
    muteBtn.innerHTML = `<i class="fa-solid fa-volume-${isAudioMuted ? 'xmark' : 'high'}"></i> BGM & SOUND: ${isAudioMuted ? 'OFF' : 'ON'}`;
  }
}

// Auto-play on intro page load + gesture unlock
function autoPlayCoverMusic() {
  initAudio();
  if (!isAudioMuted && bgmPlayer) {
    playCoverMusic(0.35);
  }
}

// Try auto-play immediately on load
window.addEventListener('DOMContentLoaded', () => {
  autoPlayCoverMusic();
});
window.addEventListener('load', () => {
  autoPlayCoverMusic();
});

// User interaction unlock fallback
window.addEventListener('click', () => {
  initAudio();
  if (!isAudioMuted && bgmPlayer && bgmPlayer.paused) {
    if (myRoomCode) playBattleMusic(0.35);
    else playCoverMusic(0.35);
  }
}, { once: true });

window.addEventListener('touchstart', () => {
  initAudio();
  if (!isAudioMuted && bgmPlayer && bgmPlayer.paused) {
    if (myRoomCode) playBattleMusic(0.35);
    else playCoverMusic(0.35);
  }
}, { once: true });

window.addEventListener('keydown', () => {
  initAudio();
  if (!isAudioMuted && bgmPlayer && bgmPlayer.paused) {
    if (myRoomCode) playBattleMusic(0.35);
    else playCoverMusic(0.35);
  }
}, { once: true });

function toggleAudioMute() {
  isAudioMuted = !isAudioMuted;
  if (bgmPlayer) {
    if (isAudioMuted) bgmPlayer.pause();
    else {
      if (myRoomCode) playBattleMusic(0.35);
      else playCoverMusic(0.35);
    }
  }
  updateMusicWaveBar();
}

// ==========================================================================
// SCREEN TRANSITIONS: COVER -> LOBBY -> MATCH -> RESULT
// ==========================================================================
function enterGameLobby() {
  initAudio();
  playCoverMusic(0.35);
  const cover = document.getElementById('onam-cover-screen');
  const menu = document.getElementById('menu-screen');
  if (cover) cover.classList.remove('active');
  if (menu) menu.classList.add('active');
}

function returnToCoverScreen() {
  closeAllModals();
  myRoomCode = null;
  clearKeys();
  playCoverMusic(0.35);
  const cover = document.getElementById('onam-cover-screen');
  const menu = document.getElementById('menu-screen');
  const hud = document.getElementById('game-hud');
  const scorecard = document.getElementById('game-scorecard');
  const controls = document.getElementById('mobile-controls');

  if (hud) hud.classList.add('hidden');
  if (scorecard) scorecard.classList.add('hidden');
  if (controls) controls.classList.add('hidden');
  if (menu) menu.classList.remove('active');
  if (cover) cover.classList.add('active');
}

function returnToLobby() {
  closeAllModals();
  myRoomCode = null;
  clearKeys();
  playCoverMusic(0.35);
  const cover = document.getElementById('onam-cover-screen');
  const menu = document.getElementById('menu-screen');
  const hud = document.getElementById('game-hud');
  const scorecard = document.getElementById('game-scorecard');
  const controls = document.getElementById('mobile-controls');

  if (hud) hud.classList.add('hidden');
  if (scorecard) scorecard.classList.add('hidden');
  if (controls) controls.classList.add('hidden');
  if (cover) cover.classList.remove('active');
  if (menu) menu.classList.add('active');
}

function requestRematch() { socket.emit('request_rematch'); }
function leaveMatchToMenu() { returnToLobby(); }

function openModal(id) { clearKeys(); document.getElementById(id).classList.add('active'); }
function closeModal(id) { clearKeys(); document.getElementById(id).classList.remove('active'); }
function closeAllModals() { document.querySelectorAll('.modal').forEach(m => m.classList.remove('active')); }

function showAnnouncer(text) {
  const overlay = document.getElementById('announcer-overlay');
  document.getElementById('announcer-text').innerText = text;
  overlay.classList.remove('hidden');
}
function hideAnnouncer() { document.getElementById('announcer-overlay').classList.add('hidden'); }

function showCombatPopup(text) {
  const container = document.getElementById('combat-popup-container');
  const textEl = document.getElementById('combat-popup-text');
  textEl.innerText = text;
  container.classList.remove('hidden');
  setTimeout(() => container.classList.add('hidden'), 900);
}

function updateHUD(data) {
  // Update Red Energy Bar & Ultimate Bar
  const redEnergy = Math.max(0, data.red.energy);
  const redEnergyFill = document.getElementById('hud-red-energy-fill');
  if (redEnergyFill) {
    redEnergyFill.style.width = `${redEnergy}%`;
    if (redEnergy <= 25) redEnergyFill.className = 'slim-energy-fill red-energy-fill energy-low';
    else if (redEnergy <= 55) redEnergyFill.className = 'slim-energy-fill red-energy-fill energy-medium';
    else redEnergyFill.className = 'slim-energy-fill red-energy-fill energy-high';
  }
  const redEnergyText = document.getElementById('hud-red-energy-text');
  if (redEnergyText) redEnergyText.innerText = `${Math.round(redEnergy)} HP`;

  const redUltFill = document.getElementById('hud-red-ult-fill');
  if (redUltFill) redUltFill.style.width = `${data.red.ultMeter}%`;

  // Update Blue Energy Bar & Ultimate Bar
  const blueEnergy = Math.max(0, data.blue.energy);
  const blueEnergyFill = document.getElementById('hud-blue-energy-fill');
  if (blueEnergyFill) {
    blueEnergyFill.style.width = `${blueEnergy}%`;
    if (blueEnergy <= 25) blueEnergyFill.className = 'slim-energy-fill blue-energy-fill energy-low';
    else if (blueEnergy <= 55) blueEnergyFill.className = 'slim-energy-fill blue-energy-fill energy-medium';
    else blueEnergyFill.className = 'slim-energy-fill blue-energy-fill energy-high';
  }
  const blueEnergyText = document.getElementById('hud-blue-energy-text');
  if (blueEnergyText) blueEnergyText.innerText = `${Math.round(blueEnergy)} HP`;

  const blueUltFill = document.getElementById('hud-blue-ult-fill');
  if (blueUltFill) blueUltFill.style.width = `${data.blue.ultMeter}%`;

  // Update Score Numbers if present in tick
  if (data.red && typeof data.red.roundWins === 'number') {
    const redScoreEl = document.getElementById('hud-red-score-num');
    if (redScoreEl) redScoreEl.innerText = data.red.roundWins;
  }
  if (data.blue && typeof data.blue.roundWins === 'number') {
    const blueScoreEl = document.getElementById('hud-blue-score-num');
    if (blueScoreEl) blueScoreEl.innerText = data.blue.roundWins;
  }

  // Ultimate Button Glow State for Local Player
  const myUltMeter = amIRed ? data.red.ultMeter : data.blue.ultMeter;
  const ultBtn = document.getElementById('btn-attack-ultimate');
  if (ultBtn) ultBtn.classList.toggle('ready', myUltMeter >= 100);

  // Heartbeat Screen Filter if Local Player Energy is Critical
  const myEnergy = amIRed ? redEnergy : blueEnergy;
  const heartbeatEl = document.getElementById('heartbeat-overlay');
  if (heartbeatEl) heartbeatEl.classList.toggle('hidden', myEnergy > 25);

  // 60-Second Match Timer & Round Title
  const timerSec = data.roundTimeRemaining || 60;
  const mins = Math.floor(timerSec / 60);
  const secs = timerSec % 60;
  const timerEl = document.getElementById('hud-match-timer');
  if (timerEl) timerEl.innerText = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  const roundEl = document.getElementById('hud-round-indicator');
  if (roundEl) roundEl.innerText = data.roundTitle || 'ROUND 1';

  if (isDebugMode) {
    const dbg = document.getElementById('debug-text');
    if (dbg) {
      dbg.innerHTML = `
        LOG_TOP_Y: ${WORLD.LOG_TOP_Y}<br>
        RED: X=${Math.round(data.red.x)}, HP=${Math.round(data.red.energy)}, Ult=${data.red.ultMeter}%<br>
        BLUE: X=${Math.round(data.blue.x)}, HP=${Math.round(data.blue.energy)}, Ult=${data.blue.ultMeter}%<br>
        INTENSITY: ${data.combatIntensity}%<br>
        TIMER: ${timerSec}s
      `;
    }
  }
}

function spawnFireworks(centerX, centerY, burstCount = 8) {
  const colors = ['#FFD700', '#FFB703', '#FB8500', '#E63946', '#4CC9F0', '#9B5DE5', '#52B788', '#F72585', '#FFF'];
  
  for (let f = 0; f < burstCount; f++) {
    const fx = centerX + (Math.random() - 0.5) * 800;
    const fy = centerY + (Math.random() - 0.5) * 350;
    const color = colors[Math.floor(Math.random() * colors.length)];

    for (let i = 0; i < 50; i++) {
      const angle = (i / 50) * Math.PI * 2;
      const speed = 4 + Math.random() * 12;
      fireworks.push({
        x: fx,
        y: fy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        color,
        size: 5 + Math.random() * 8,
        life: 1.0,
        decay: 0.015
      });
    }
  }

  // Golden celebration confetti burst
  for (let c = 0; c < 80; c++) {
    particles.push({
      x: centerX + (Math.random() - 0.5) * 400,
      y: centerY - 100,
      vx: (Math.random() - 0.5) * 20,
      vy: -Math.random() * 18 - 5,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: 6 + Math.random() * 10,
      life: 1.0,
      decay: 0.012
    });
  }
}

// MAIN 60 FPS SHADOW FIGHT & KERALA FIREWORKS ENGINE
function renderLoop() {
  if (hitStopTimer > 0) {
    hitStopTimer -= 16;
    requestAnimationFrame(renderLoop);
    return;
  }

  // Smooth lerp client positions
  clientState.red.x += (serverState.red.x - clientState.red.x) * 0.35;
  clientState.red.y += (serverState.red.y - clientState.red.y) * 0.35;
  clientState.blue.x += (serverState.blue.x - clientState.blue.x) * 0.35;
  clientState.blue.y += (serverState.blue.y - clientState.blue.y) * 0.35;

  // Underwater Sinking & Bubble Physics
  if (serverState.red.state === 'WATER_SPLASH' || serverState.red.state === 'FALLING') {
    clientState.red.sinkY += 0.8;
    clientState.red.alpha = Math.max(0, clientState.red.alpha - 0.015);
  } else {
    clientState.red.sinkY = 0;
    clientState.red.alpha = 1.0;
  }

  if (serverState.blue.state === 'WATER_SPLASH' || serverState.blue.state === 'FALLING') {
    clientState.blue.sinkY += 0.8;
    clientState.blue.alpha = Math.max(0, clientState.blue.alpha - 0.015);
  } else {
    clientState.blue.sinkY = 0;
    clientState.blue.alpha = 1.0;
  }

  // Shadow After-Images Tracking during ATTACKING
  if (serverState.red.state === 'ATTACKING') {
    afterImages.red.push({ x: clientState.red.x, y: clientState.red.y, frameIdx: serverState.red.frameIndex, alpha: 0.5 });
    if (afterImages.red.length > 3) afterImages.red.shift();
  } else afterImages.red = [];

  if (serverState.blue.state === 'ATTACKING') {
    afterImages.blue.push({ x: clientState.blue.x, y: clientState.blue.y, frameIdx: serverState.blue.frameIndex, alpha: 0.5 });
    if (afterImages.blue.length > 3) afterImages.blue.shift();
  } else afterImages.blue = [];

  // Camera Shake Dampening
  let shakeX = 0, shakeY = 0;
  if (cameraShake.intensity > 0) {
    shakeX = (Math.random() - 0.5) * cameraShake.intensity;
    shakeY = (Math.random() - 0.5) * cameraShake.intensity;
    cameraShake.intensity *= 0.85;
    if (cameraShake.intensity < 0.4) cameraShake.intensity = 0;
  }

  if (cameraShake.zoom > 1.0) {
    cameraShake.zoom -= 0.005;
    if (cameraShake.zoom < 1.0) cameraShake.zoom = 1.0;
  }

  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.translate(offsetX + shakeX, offsetY + shakeY);
  ctx.scale(scale * cameraShake.zoom, scale * cameraShake.zoom);

  renderBackground(serverState.combatIntensity);
  renderWaterAndLogBack();
  renderPetals();

  // Shadow After-Images (Shadow Fight Style Trails)
  renderShadowAfterImages('red', afterImages.red);
  renderShadowAfterImages('blue', afterImages.blue);

  // Render Seated RED & BLUE Players
  renderPlayer('red', serverState.red, clientState.red, true);
  renderPlayer('blue', serverState.blue, clientState.blue, false);

  renderLogFrontDecorations();
  renderBubblesAndRipples();
  renderShockwaves();
  renderParticles();
  renderFireworks();

  if (isDebugMode) renderDebugColliders();

  ctx.restore();

  requestAnimationFrame(renderLoop);
}

function renderBackground(intensity) {
  let topColor = '#023047';
  let bottomColor = '#071722';

  if (intensity > 75) {
    topColor = '#4A0E17';
    bottomColor = '#1A0409';
  } else if (intensity > 50) {
    topColor = '#D94E1E';
    bottomColor = '#0F1A2C';
  } else if (intensity > 25) {
    topColor = '#028090';
    bottomColor = '#023047';
  }

  const grad = ctx.createLinearGradient(0, 0, 0, WORLD.HEIGHT);
  grad.addColorStop(0, topColor);
  grad.addColorStop(1, bottomColor);
  ctx.fillRect(0, 0, WORLD.WIDTH, WORLD.HEIGHT);

  const sunGrad = ctx.createRadialGradient(WORLD.WIDTH / 2, 280, 20, WORLD.WIDTH / 2, 280, 450);
  sunGrad.addColorStop(0, intensity > 50 ? 'rgba(255, 183, 3, 0.6)' : 'rgba(255, 235, 153, 0.4)');
  sunGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sunGrad;
  ctx.fillRect(0, 0, WORLD.WIDTH, WORLD.HEIGHT);

  ctx.fillStyle = '#03141F';
  drawPalmTree(140, 520, 0.9);
  drawPalmTree(1780, 500, 1.1);
}

function drawPalmTree(x, y, treeScale) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(treeScale, treeScale);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(20, -180, -30, -360);
  ctx.lineWidth = 24;
  ctx.strokeStyle = '#03141F';
  ctx.stroke();

  ctx.translate(-30, -360);
  for (let i = 0; i < 7; i++) {
    const angle = (i / 7) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(Math.cos(angle) * 90, Math.sin(angle) * 70 + 40, Math.cos(angle) * 140, Math.sin(angle) * 100);
    ctx.lineWidth = 10;
    ctx.strokeStyle = '#03141F';
    ctx.stroke();
  }
  ctx.restore();
}

function renderWaterAndLogBack() {
  const waterGrad = ctx.createLinearGradient(0, WORLD.LOG_TOP_Y + 70, 0, WORLD.HEIGHT);
  waterGrad.addColorStop(0, '#0077B6');
  waterGrad.addColorStop(1, '#03045E');
  ctx.fillStyle = waterGrad;
  ctx.fillRect(0, WORLD.LOG_TOP_Y + 70, WORLD.WIDTH, WORLD.HEIGHT - (WORLD.LOG_TOP_Y + 70));

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.lineWidth = 3;
  const time = Date.now() * 0.003;
  for (let y = WORLD.LOG_TOP_Y + 85; y < WORLD.HEIGHT; y += 45) {
    ctx.beginPath();
    for (let x = 0; x <= WORLD.WIDTH; x += 40) {
      const waveY = y + Math.sin(x * 0.01 + time + y) * 6;
      if (x === 0) ctx.moveTo(x, waveY);
      else ctx.lineTo(x, waveY);
    }
    ctx.stroke();
  }

  const logX = 260;
  const logWidth = 1400;
  const logHeight = 75;
  const logY = WORLD.LOG_TOP_Y;

  const woodGrad = ctx.createLinearGradient(0, logY, 0, logY + logHeight);
  woodGrad.addColorStop(0, '#A0632C');
  woodGrad.addColorStop(0.3, '#D28C45');
  woodGrad.addColorStop(1, '#5C3A21');

  ctx.fillStyle = woodGrad;
  ctx.beginPath();
  ctx.roundRect(logX, logY, logWidth, logHeight, 18);
  ctx.fill();

  ctx.strokeStyle = 'rgba(60, 30, 10, 0.45)';
  ctx.lineWidth = 4;
  for (let i = logX + 60; i < logX + logWidth - 60; i += 180) {
    ctx.beginPath();
    ctx.moveTo(i, logY + 8);
    ctx.lineTo(i + 120, logY + logHeight - 8);
    ctx.stroke();
  }
}

function renderLogFrontDecorations() {
  const logX = 260;
  const logWidth = 1400;
  const logHeight = 75;
  const logY = WORLD.LOG_TOP_Y;

  ctx.fillStyle = '#DAA520';
  ctx.fillRect(logX + 35, logY - 4, 30, logHeight + 8);
  ctx.fillRect(logX + logWidth - 65, logY - 4, 30, logHeight + 8);

  for (let x = logX + 110; x < logX + logWidth - 110; x += 60) {
    ctx.fillStyle = (x / 60) % 2 === 0 ? '#FFB703' : '#FB8500';
    ctx.beginPath();
    ctx.arc(x, logY + logHeight + 10 + Math.sin(x) * 6, 8, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderShadowAfterImages(color, trail) {
  trail.forEach(imgData => {
    const frameIdx = imgData.frameIdx || 1;
    const img = frameImages[color][frameIdx];
    const anchorConfig = ANCHORS[color][frameIdx];
    if (!img || !img.complete) return;

    ctx.save();
    ctx.globalAlpha = 0.3;
    const drawScale = 0.235;
    const scaledWidth = img.naturalWidth * drawScale;
    const scaledHeight = img.naturalHeight * drawScale;
    const scaledAnchorX = anchorConfig.seatX * drawScale;
    const scaledAnchorY = anchorConfig.seatY * drawScale;

    ctx.drawImage(img, imgData.x - scaledAnchorX, imgData.y - scaledAnchorY, scaledWidth, scaledHeight);
    ctx.restore();
  });
}

function renderPlayer(color, serverPlayer, clientPos, isRed) {
  const frameIdx = serverPlayer.frameIndex || 1;
  const img = frameImages[color][frameIdx];
  const anchorConfig = ANCHORS[color][frameIdx];

  if (!img || !img.complete || img.naturalWidth === 0) return;

  ctx.save();
  ctx.globalAlpha = clientPos.alpha;

  const drawScale = 0.235;
  const scaledWidth = img.naturalWidth * drawScale;
  const scaledHeight = img.naturalHeight * drawScale;
  const scaledAnchorX = anchorConfig.seatX * drawScale;
  const scaledAnchorY = anchorConfig.seatY * drawScale;

  const renderX = clientPos.x - scaledAnchorX;
  const renderY = (clientPos.y + clientPos.sinkY) - scaledAnchorY;

  if (serverPlayer.state === 'FALLING' || serverPlayer.state === 'WATER_SPLASH') {
    ctx.translate(clientPos.x, clientPos.y + clientPos.sinkY);
    ctx.rotate((isRed ? -1 : 1) * 0.55);
    ctx.translate(-clientPos.x, -(clientPos.y + clientPos.sinkY));
  }

  ctx.drawImage(img, renderX, renderY, scaledWidth, scaledHeight);
  ctx.restore();
}

function renderPetals() {
  petals.forEach(p => {
    p.y += p.speedY;
    p.x += p.speedX;
    p.rotation += p.rotSpeed;

    if (p.y > WORLD.HEIGHT) p.y = -10;
    if (p.x < 0) p.x = WORLD.WIDTH;
    if (p.x > WORLD.WIDTH) p.x = 0;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rotation);
    ctx.fillStyle = '#FFB703';
    ctx.beginPath();
    ctx.ellipse(0, 0, p.size, p.size * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

function renderShockwaves() {
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    const sw = shockwaves[i];
    sw.radius += 5;
    sw.alpha -= 0.04;

    if (sw.alpha <= 0 || sw.radius >= sw.maxRadius) {
      shockwaves.splice(i, 1);
      continue;
    }

    ctx.save();
    ctx.strokeStyle = `rgba(255, 215, 0, ${sw.alpha})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(sw.x, sw.y, sw.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function renderBubblesAndRipples() {
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    b.y += b.speedY;
    b.alpha -= 0.012;

    if (b.alpha <= 0 || b.y < WORLD.LOG_TOP_Y + 70) {
      bubbles.splice(i, 1);
      continue;
    }

    ctx.save();
    ctx.strokeStyle = `rgba(255, 255, 255, ${b.alpha})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function renderParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life -= p.decay;

    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }

    ctx.save();
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function renderFireworks() {
  for (let i = fireworks.length - 1; i >= 0; i--) {
    const fw = fireworks[i];
    fw.x += fw.vx;
    fw.y += fw.vy;
    fw.vy += 0.1; // gravity
    fw.life -= fw.decay;

    if (fw.life <= 0) {
      fireworks.splice(i, 1);
      continue;
    }

    ctx.save();
    ctx.globalAlpha = fw.life;
    ctx.fillStyle = fw.color;
    ctx.beginPath();
    ctx.arc(fw.x, fw.y, fw.size * fw.life, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function renderDebugColliders() {
  ctx.lineWidth = 2;

  ctx.strokeStyle = '#00FF00';
  ctx.beginPath();
  ctx.moveTo(0, WORLD.LOG_TOP_Y + WORLD.SEAT_OFFSET);
  ctx.lineTo(WORLD.WIDTH, WORLD.LOG_TOP_Y + WORLD.SEAT_OFFSET);
  ctx.stroke();

  ctx.strokeStyle = '#FFFF00';
  ctx.strokeRect(WORLD.LOG_LEFT_X, WORLD.LOG_TOP_Y, WORLD.LOG_RIGHT_X - WORLD.LOG_LEFT_X, 75);

  const redX = clientState.red.x;
  const redY = clientState.red.y;
  ctx.fillStyle = '#FF0000';
  ctx.beginPath();
  ctx.arc(redX, redY, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#FF0000';
  ctx.strokeRect(redX - WORLD.HURTBOX_WIDTH / 2, redY - 170, WORLD.HURTBOX_WIDTH, WORLD.HURTBOX_HEIGHT);

  const blueX = clientState.blue.x;
  const blueY = clientState.blue.y;
  ctx.fillStyle = '#0000FF';
  ctx.beginPath();
  ctx.arc(blueX, blueY, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#0000FF';
  ctx.strokeRect(blueX - WORLD.HURTBOX_WIDTH / 2, blueY - 170, WORLD.HURTBOX_WIDTH, WORLD.HURTBOX_HEIGHT);
}

// Start Main Render Loop
requestAnimationFrame(renderLoop);
