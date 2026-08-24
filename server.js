require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

// Optional Firebase Admin SDK Initialization
let firestoreDb = null;
try {
  const admin = require('firebase-admin');
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    let serviceAccount;
    try {
      // Check if it's a JSON string or path
      if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY.trim().startsWith('{')) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
      } else if (fs.existsSync(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)) {
        serviceAccount = require(path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_KEY));
      }
    } catch (e) {
      console.warn('Firebase Service Account Key parse note:', e.message);
    }

    if (serviceAccount) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL
      });
      firestoreDb = admin.firestore();
      console.log('⚡ Firebase Admin SDK Connected to Cloud Firestore!');
    }
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_PROJECT_ID) {
    admin.initializeApp();
    firestoreDb = admin.firestore();
    console.log('⚡ Firebase Admin SDK Connected via default credentials!');
  }
} catch (fbErr) {
  console.log('ℹ️ Running in resilient local storage mode (Firebase Admin unconfigured).');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');

app.use(express.static(path.join(__dirname, 'public')));

// Dynamic Global Leaderboard Store (With Cloud Firestore Sync & Resilient Local Fallback)
function loadLeaderboard() {
  try {
    if (fs.existsSync(LEADERBOARD_FILE)) {
      const data = fs.readFileSync(LEADERBOARD_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading leaderboard:', err);
  }
  return [];
}

async function saveLeaderboard(board) {
  try {
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(board, null, 2));
  } catch (err) {
    console.error('Error saving local leaderboard:', err);
  }

  // Asynchronously sync top players to Cloud Firestore
  if (firestoreDb) {
    try {
      const batch = firestoreDb.batch();
      const topEntries = board.slice(0, 50);
      topEntries.forEach((player, idx) => {
        const docRef = firestoreDb.collection('leaderboards').doc(player.name.replace(/[^a-zA-Z0-9_-]/g, '_'));
        batch.set(docRef, { ...player, rank: idx + 1, updatedAt: new Date().toISOString() }, { merge: true });
      });
      await batch.commit();
    } catch (fsErr) {
      console.warn('Firestore async sync note:', fsErr.message);
    }
  }
}

function sortLeaderboard(board) {
  // Primary Ranking: Matches Won -> Round Wins -> Total Score -> Win Percentage
  return board.sort((a, b) => {
    if (b.matchesWon !== a.matchesWon) return b.matchesWon - a.matchesWon;
    if (b.roundsWon !== a.roundsWon) return b.roundsWon - a.roundsWon;
    if (b.score !== a.score) return b.score - a.score;
    return b.winPercentage - a.winPercentage;
  });
}

function updatePlayerStats(playerName, isMatchWinner, roundsWon, roundsLost, damageGiven, damageTaken, scoreEarned) {
  if (!playerName || playerName.trim() === '') return;
  const board = loadLeaderboard();
  let entry = board.find(p => p.name.toLowerCase() === playerName.toLowerCase());

  if (!entry) {
    entry = {
      name: playerName,
      totalMatches: 0,
      matchesWon: 0,
      matchesLost: 0,
      roundsWon: 0,
      roundsLost: 0,
      energyDamageGiven: 0,
      energyDamageTaken: 0,
      winPercentage: 0,
      score: 0,
      winStreak: 0,
      bestWinStreak: 0
    };
    board.push(entry);
  }

  entry.totalMatches += 1;
  if (isMatchWinner) {
    entry.matchesWon += 1;
    entry.winStreak += 1;
    if (entry.winStreak > entry.bestWinStreak) entry.bestWinStreak = entry.winStreak;
  } else {
    entry.matchesLost += 1;
    entry.winStreak = 0;
  }

  entry.roundsWon += roundsWon;
  entry.roundsLost += roundsLost;
  entry.energyDamageGiven += damageGiven;
  entry.energyDamageTaken += damageTaken;
  entry.score += scoreEarned;
  entry.winPercentage = Math.round((entry.matchesWon / entry.totalMatches) * 100);

  sortLeaderboard(board);
  saveLeaderboard(board);
  io.emit('leaderboard_update', board);
}

// Logical World & Combat Constants
const WORLD = {
  WIDTH: 1920,
  HEIGHT: 1080,
  LOG_TOP_Y: 680,
  SEAT_OFFSET: 12,
  LOG_LEFT_X: 320,
  LOG_RIGHT_X: 1600,
  RED_START_X: 520,
  BLUE_START_X: 1400,
  SPEED: 9.0,
  TOTAL_ROUNDS: 3,
  ROUND_TIME_SECONDS: 60,
  HURTBOX_WIDTH: 130,
  HURTBOX_HEIGHT: 210
};

// 4 Attack Types Definition
const ATTACKS = {
  quick: { name: 'Quick Hit', damage: 10, knockback: 22, attackTicks: 16, cooldownTicks: 12 },
  power: { name: 'Power Smash', damage: 25, knockback: 42, attackTicks: 24, cooldownTicks: 35 },
  combo: { name: 'Combo Strike', damage: 18, knockback: 32, attackTicks: 28, cooldownTicks: 40 },
  ultimate: { name: 'Ultimate Slam', damage: 40, knockback: 70, attackTicks: 34, cooldownTicks: 60 }
};

const onlinePlayers = new Map();
const matchmakingQueue = [];
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'ONAM-';
  for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

class GameRoom {
  constructor(roomCode, redSocket, blueSocket) {
    this.roomCode = roomCode;
    this.players = {
      red: {
        socketId: redSocket.id,
        name: onlinePlayers.get(redSocket.id)?.name || 'Red Player',
        x: WORLD.RED_START_X,
        y: WORLD.LOG_TOP_Y + WORLD.SEAT_OFFSET,
        vx: 0,
        vy: 0,
        facingRight: true,
        state: 'IDLE',
        frameIndex: 1,
        energy: 100,
        ultMeter: 0,
        attackType: null,
        attackTimer: 0,
        cooldown: 0,
        hitCooldown: 0,
        roundWins: 0,
        points: 0,
        consecutiveHits: 0,
        damageGivenMatch: 0,
        damageTakenMatch: 0,
        input: { move: 0, attackType: null }
      },
      blue: {
        socketId: blueSocket.id,
        name: onlinePlayers.get(blueSocket.id)?.name || 'Blue Player',
        x: WORLD.BLUE_START_X,
        y: WORLD.LOG_TOP_Y + WORLD.SEAT_OFFSET,
        vx: 0,
        vy: 0,
        facingRight: false,
        state: 'IDLE',
        frameIndex: 1,
        energy: 100,
        ultMeter: 0,
        attackType: null,
        attackTimer: 0,
        cooldown: 0,
        hitCooldown: 0,
        roundWins: 0,
        points: 0,
        consecutiveHits: 0,
        damageGivenMatch: 0,
        damageTakenMatch: 0,
        input: { move: 0, attackType: null }
      }
    };
    this.currentRound = 1;
    this.roundTimeRemaining = WORLD.ROUND_TIME_SECONDS;
    this.roundState = 'COUNTDOWN';
    this.countdownSeconds = 3;
    this.countdownTimer = null;
    this.matchTimerInterval = null;
    this.combatIntensity = 0;
    this.lastHitTime = 0;
    this.rematchVotes = new Set();
    this.tickInterval = null;

    this.startCountdown();
  }

  getRoundTitle() {
    if (this.currentRound === 1) return 'ROUND 1';
    if (this.currentRound === 2) return 'ROUND 2';
    return 'FINAL ROUND';
  }

  startCountdown() {
    this.roundState = 'COUNTDOWN';
    this.countdownSeconds = 3;
    this.roundTimeRemaining = WORLD.ROUND_TIME_SECONDS;
    this.resetPositions();

    if (this.countdownTimer) clearInterval(this.countdownTimer);
    if (this.matchTimerInterval) clearInterval(this.matchTimerInterval);

    io.to(this.roomCode).emit('round_countdown', {
      seconds: this.countdownSeconds,
      round: this.currentRound,
      roundTitle: this.getRoundTitle(),
      redRoundWins: this.players.red.roundWins,
      blueRoundWins: this.players.blue.roundWins
    });

    this.countdownTimer = setInterval(() => {
      this.countdownSeconds--;
      if (this.countdownSeconds <= 0) {
        clearInterval(this.countdownTimer);
        this.roundState = 'PLAYING';
        this.startMatchTimer();
        io.to(this.roomCode).emit('round_start', {
          round: this.currentRound,
          roundTitle: this.getRoundTitle()
        });
      } else {
        io.to(this.roomCode).emit('round_countdown', {
          seconds: this.countdownSeconds,
          round: this.currentRound,
          roundTitle: this.getRoundTitle(),
          redRoundWins: this.players.red.roundWins,
          blueRoundWins: this.players.blue.roundWins
        });
      }
    }, 1000);
  }

  startMatchTimer() {
    if (this.matchTimerInterval) clearInterval(this.matchTimerInterval);
    this.matchTimerInterval = setInterval(() => {
      if (this.roundState !== 'PLAYING') return;
      this.roundTimeRemaining--;

      if (this.roundTimeRemaining <= 0) {
        this.handleTimeExpired();
      }
    }, 1000);
  }

  handleTimeExpired() {
    if (this.roundState !== 'PLAYING') return;

    const red = this.players.red;
    const blue = this.players.blue;

    let roundWinner = null;
    if (red.energy > blue.energy) roundWinner = 'red';
    else if (blue.energy > red.energy) roundWinner = 'blue';
    else roundWinner = red.damageGivenMatch >= blue.damageGivenMatch ? 'red' : 'blue';

    this.awardRoundWin(roundWinner, 'TIME EXPIRED!');
  }

  resetPositions() {
    this.players.red.x = WORLD.RED_START_X;
    this.players.red.y = WORLD.LOG_TOP_Y + WORLD.SEAT_OFFSET;
    this.players.red.vx = 0;
    this.players.red.vy = 0;
    this.players.red.energy = 100;
    this.players.red.state = 'IDLE';
    this.players.red.frameIndex = 1;
    this.players.red.attackTimer = 0;
    this.players.red.cooldown = 0;
    this.players.red.hitCooldown = 0;

    this.players.blue.x = WORLD.BLUE_START_X;
    this.players.blue.y = WORLD.LOG_TOP_Y + WORLD.SEAT_OFFSET;
    this.players.blue.vx = 0;
    this.players.blue.vy = 0;
    this.players.blue.energy = 100;
    this.players.blue.state = 'IDLE';
    this.players.blue.frameIndex = 1;
    this.players.blue.attackTimer = 0;
    this.players.blue.cooldown = 0;
    this.players.blue.hitCooldown = 0;
  }

  handleInput(socketId, input) {
    if (this.roundState !== 'PLAYING') return;
    const player = socketId === this.players.red.socketId ? this.players.red : this.players.blue;
    player.input = input;

    // Trigger attack if valid attackType requested and player is ready
    if (input.attackType && player.state === 'IDLE' && player.attackTimer === 0 && player.cooldown === 0 && player.hitCooldown === 0) {
      const attackDef = ATTACKS[input.attackType];
      if (attackDef) {
        if (input.attackType === 'ultimate' && player.ultMeter < 100) return;

        if (input.attackType === 'ultimate') player.ultMeter = 0;

        player.state = 'ATTACKING';
        player.attackType = input.attackType;
        player.attackTimer = attackDef.attackTicks;
        player.cooldown = attackDef.cooldownTicks;
      }
    }
  }

  update() {
    if (this.roundState !== 'PLAYING') return;

    if (Date.now() - this.lastHitTime > 3000) {
      this.combatIntensity = Math.max(0, this.combatIntensity - 0.35);
    }

    const red = this.players.red;
    const blue = this.players.blue;

    this.updatePlayerPhysics(red, blue, true);
    this.updatePlayerPhysics(blue, red, false);

    this.checkEdgeFalling(red, blue, 'red');
    this.checkEdgeFalling(blue, red, 'blue');

    io.to(this.roomCode).emit('game_tick', {
      red: {
        x: red.x,
        y: red.y,
        vx: red.vx,
        vy: red.vy,
        state: red.state,
        frameIndex: red.frameIndex,
        energy: red.energy,
        ultMeter: red.ultMeter,
        roundWins: red.roundWins,
        points: red.points
      },
      blue: {
        x: blue.x,
        y: blue.y,
        vx: blue.vx,
        vy: blue.vy,
        state: blue.state,
        frameIndex: blue.frameIndex,
        energy: blue.energy,
        ultMeter: blue.ultMeter,
        roundWins: blue.roundWins,
        points: blue.points
      },
      combatIntensity: Math.round(this.combatIntensity),
      roundState: this.roundState,
      roundTimeRemaining: this.roundTimeRemaining,
      roundTitle: this.getRoundTitle()
    });
  }

  updatePlayerPhysics(player, opponent, isRed) {
    if (player.cooldown > 0) player.cooldown--;
    if (player.hitCooldown > 0) {
      player.hitCooldown--;
      if (player.hitCooldown === 0 && player.state === 'KNOCKBACK') {
        player.state = 'IDLE';
      }
    }

    if (player.state === 'ATTACKING') {
      player.attackTimer--;
      const attackDef = ATTACKS[player.attackType] || ATTACKS.quick;
      const total = attackDef.attackTicks;
      const progress = 1 - (player.attackTimer / total);

      if (progress < 0.2) player.frameIndex = 1;
      else if (progress < 0.4) player.frameIndex = 2;
      else if (progress < 0.6) player.frameIndex = 3;
      else if (progress < 0.8) player.frameIndex = 4;
      else player.frameIndex = 5;

      if (player.attackTimer <= 0) {
        player.state = 'IDLE';
        player.frameIndex = 1;
        player.attackType = null;
      }

      if ((player.frameIndex === 3 || player.frameIndex === 4) && player.attackTimer % 2 === 0) {
        this.checkHitCollision(player, opponent, isRed);
      }
    } else if (player.state === 'IDLE') {
      player.frameIndex = 1;
      const moveDir = player.input.move;
      if (moveDir !== 0) {
        player.vx = moveDir * WORLD.SPEED;
        player.x += player.vx;
        player.x = Math.max(WORLD.LOG_LEFT_X, Math.min(WORLD.LOG_RIGHT_X, player.x));
      } else {
        player.vx = 0;
      }
    } else if (player.state === 'KNOCKBACK') {
      player.x += player.vx;
      player.vx *= 0.84;
    } else if (player.state === 'FALLING') {
      player.vy += 0.85;
      player.y += player.vy;
      player.x += player.vx;
    }
  }

  checkHitCollision(attacker, defender, isAttackerRed) {
    if (defender.state === 'FALLING' || defender.state === 'WATER_SPLASH' || defender.hitCooldown > 0) return;

    const attackDef = ATTACKS[attacker.attackType] || ATTACKS.quick;
    const attackDir = isAttackerRed ? 1 : -1;
    const pillowReachX = attacker.x + attackDir * 130;
    const defenderHurtboxMinX = defender.x - WORLD.HURTBOX_WIDTH / 2;
    const defenderHurtboxMaxX = defender.x + WORLD.HURTBOX_WIDTH / 2;

    if (
      (isAttackerRed && pillowReachX >= defenderHurtboxMinX && attacker.x < defender.x + 40) ||
      (!isAttackerRed && pillowReachX <= defenderHurtboxMaxX && attacker.x > defender.x - 40)
    ) {
      const isCounter = defender.state === 'ATTACKING';
      const isUltimate = attacker.attackType === 'ultimate';

      defender.state = 'KNOCKBACK';
      defender.hitCooldown = isUltimate ? 24 : 16;

      // Energy Damage & Instability multiplier
      const baseDamage = attackDef.damage + (isCounter ? 6 : 0);
      defender.energy = Math.max(0, defender.energy - baseDamage);
      attacker.damageGivenMatch += baseDamage;
      defender.damageTakenMatch += baseDamage;

      // Instability increases as energy decreases
      const instability = 1.0 + ((100 - defender.energy) / 45.0);
      const knockbackForce = (isAttackerRed ? 1 : -1) * (attackDef.knockback * instability + (isCounter ? 14 : 0));
      defender.vx = knockbackForce;

      // Ultimate meter gain
      attacker.ultMeter = Math.min(100, attacker.ultMeter + 25);
      defender.ultMeter = Math.min(100, defender.ultMeter + 15);

      attacker.consecutiveHits += 1;
      defender.consecutiveHits = 0;
      attacker.points += baseDamage + (isCounter ? 10 : 5);

      this.combatIntensity = Math.min(100, this.combatIntensity + (isUltimate ? 35 : isCounter ? 22 : 14));
      this.lastHitTime = Date.now();

      io.to(this.roomCode).emit('pillow_impact', {
        attacker: isAttackerRed ? 'red' : 'blue',
        defender: isAttackerRed ? 'blue' : 'red',
        attackType: attacker.attackType,
        damage: baseDamage,
        defenderRemainingEnergy: defender.energy,
        impactX: (attacker.x + defender.x) / 2,
        impactY: WORLD.LOG_TOP_Y - 40,
        isCounter,
        isUltimate,
        comboCount: attacker.consecutiveHits,
        shakeIntensity: isUltimate ? 34 : isCounter ? 24 : 14,
        hitStopMs: isUltimate ? 160 : isCounter ? 100 : 50
      });

      // 0 Energy KO Trigger
      if (defender.energy <= 0) {
        defender.state = 'FALLING';
        defender.vy = -6; // Dramatic launch upwards
        defender.vx = (isAttackerRed ? 1 : -1) * 6;
      }
    }
  }

  checkEdgeFalling(player, opponent, color) {
    if (player.state === 'FALLING' || player.state === 'WATER_SPLASH') {
      if (player.y >= 920 && player.state !== 'WATER_SPLASH') {
        player.state = 'WATER_SPLASH';
        this.awardRoundWin(color === 'red' ? 'blue' : 'red', 'KNOCKOUT!');
      }
      return;
    }

    if (player.x < WORLD.LOG_LEFT_X - 30 || player.x > WORLD.LOG_RIGHT_X + 30) {
      player.state = 'FALLING';
      player.vy = -4;
      player.vx = (player.x < WORLD.LOG_LEFT_X) ? -4 : 4;
    }
  }

  awardRoundWin(winnerColor, reasonText) {
    if (this.roundState === 'ROUND_OVER' || this.roundState === 'MATCH_OVER') return;

    this.roundState = 'ROUND_OVER';
    if (this.matchTimerInterval) clearInterval(this.matchTimerInterval);

    const winner = winnerColor === 'red' ? this.players.red : this.players.blue;
    winner.roundWins += 1;

    io.to(this.roomCode).emit('round_over', {
      roundWinner: winnerColor,
      reason: reasonText,
      redRoundWins: this.players.red.roundWins,
      blueRoundWins: this.players.blue.roundWins
    });

    if (this.players.red.roundWins >= 2 || this.players.blue.roundWins >= 2 || this.currentRound >= WORLD.TOTAL_ROUNDS) {
      setTimeout(() => {
        let matchWinnerColor = 'red';
        if (this.players.blue.roundWins > this.players.red.roundWins) matchWinnerColor = 'blue';
        else if (this.players.blue.roundWins === this.players.red.roundWins) {
          matchWinnerColor = this.players.red.damageGivenMatch >= this.players.blue.damageGivenMatch ? 'red' : 'blue';
        }
        this.endMatch(matchWinnerColor);
      }, 2500);
    } else {
      this.currentRound += 1;
      setTimeout(() => {
        this.startCountdown();
      }, 3000);
    }
  }

  endMatch(winnerColor) {
    this.roundState = 'MATCH_OVER';

    const redWon = winnerColor === 'red';
    const winnerName = redWon ? this.players.red.name : this.players.blue.name;

    updatePlayerStats(
      this.players.red.name,
      redWon,
      this.players.red.roundWins,
      this.players.blue.roundWins,
      this.players.red.damageGivenMatch,
      this.players.red.damageTakenMatch,
      this.players.red.points
    );
    updatePlayerStats(
      this.players.blue.name,
      !redWon,
      this.players.blue.roundWins,
      this.players.red.roundWins,
      this.players.blue.damageGivenMatch,
      this.players.blue.damageTakenMatch,
      this.players.blue.points
    );

    io.to(this.roomCode).emit('match_over', {
      winnerColor,
      winnerName,
      red: {
        name: this.players.red.name,
        roundWins: this.players.red.roundWins,
        points: this.players.red.points,
        damageGiven: this.players.red.damageGivenMatch
      },
      blue: {
        name: this.players.blue.name,
        roundWins: this.players.blue.roundWins,
        points: this.players.blue.points,
        damageGiven: this.players.blue.damageGivenMatch
      }
    });
  }

  startTickLoop() {
    this.tickInterval = setInterval(() => {
      this.update();
    }, 1000 / 60);
  }

  stopTickLoop() {
    if (this.tickInterval) clearInterval(this.tickInterval);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    if (this.matchTimerInterval) clearInterval(this.matchTimerInterval);
  }
}

io.on('connection', (socket) => {
  onlinePlayers.set(socket.id, { name: 'Player', status: 'idle' });

  socket.on('set_username', (name) => {
    const cleanName = (name || '').trim().substring(0, 15) || `Player_${socket.id.substring(0, 4)}`;
    const playerData = onlinePlayers.get(socket.id);
    if (playerData) playerData.name = cleanName;
    socket.emit('username_confirmed', cleanName);
    io.emit('online_players_list', getOnlinePlayersPayload());
  });

  socket.on('get_online_players', () => {
    socket.emit('online_players_list', getOnlinePlayersPayload());
  });

  socket.on('send_challenge', (targetSocketId) => {
    const challenger = onlinePlayers.get(socket.id);
    const target = onlinePlayers.get(targetSocketId);
    if (challenger && target && targetSocketId !== socket.id) {
      io.to(targetSocketId).emit('incoming_challenge', {
        fromSocketId: socket.id,
        fromName: challenger.name
      });
    }
  });

  socket.on('respond_challenge', ({ fromSocketId, accepted }) => {
    if (!accepted) {
      io.to(fromSocketId).emit('challenge_declined', { fromName: onlinePlayers.get(socket.id)?.name });
      return;
    }
    const roomCode = generateRoomCode();
    const challengerSocket = io.sockets.sockets.get(fromSocketId);
    if (challengerSocket) createGameRoom(roomCode, challengerSocket, socket);
  });

  socket.on('create_room', () => {
    const roomCode = generateRoomCode();
    socket.join(roomCode);
    socket.roomCode = roomCode;
    onlinePlayers.get(socket.id).status = 'in_room';
    socket.emit('room_created', { roomCode, isRed: true });
    io.emit('online_players_list', getOnlinePlayersPayload());
  });

  socket.on('join_room', (roomCode) => {
    const code = (roomCode || '').toUpperCase().trim();
    const roomSockets = io.sockets.adapter.rooms.get(code);

    if (!roomSockets || roomSockets.size === 0) {
      socket.emit('room_error', 'Room not found! Please check the room code.');
      return;
    }

    if (roomSockets.size >= 2) {
      socket.emit('room_error', 'Room is full! Maximum 2 players per match.');
      return;
    }

    const hostSocketId = Array.from(roomSockets)[0];
    const hostSocket = io.sockets.sockets.get(hostSocketId);
    if (hostSocket) createGameRoom(code, hostSocket, socket);
  });

  socket.on('find_match', () => {
    const playerData = onlinePlayers.get(socket.id);
    if (!playerData) return;

    if (!matchmakingQueue.includes(socket.id)) {
      matchmakingQueue.push(socket.id);
      playerData.status = 'matchmaking';
    }

    socket.emit('matchmaking_status', 'Searching for an opponent...');

    if (matchmakingQueue.length >= 2) {
      const p1Id = matchmakingQueue.shift();
      const p2Id = matchmakingQueue.shift();
      const s1 = io.sockets.sockets.get(p1Id);
      const s2 = io.sockets.sockets.get(p2Id);
      if (s1 && s2) {
        const roomCode = generateRoomCode();
        createGameRoom(roomCode, s1, s2);
      }
    }
  });

  socket.on('cancel_matchmaking', () => {
    const idx = matchmakingQueue.indexOf(socket.id);
    if (idx !== -1) matchmakingQueue.splice(idx, 1);
    const playerData = onlinePlayers.get(socket.id);
    if (playerData) playerData.status = 'idle';
    socket.emit('matchmaking_cancelled');
  });

  socket.on('player_input', (input) => {
    if (socket.roomCode && rooms.has(socket.roomCode)) {
      rooms.get(socket.roomCode).handleInput(socket.id, input);
    }
  });

  socket.on('request_rematch', () => {
    if (!socket.roomCode || !rooms.has(socket.roomCode)) return;
    const room = rooms.get(socket.roomCode);
    room.rematchVotes.add(socket.id);
    io.to(socket.roomCode).emit('rematch_update', { votes: room.rematchVotes.size });

    if (room.rematchVotes.size >= 2) {
      room.rematchVotes.clear();
      room.players.red.roundWins = 0;
      room.players.red.points = 0;
      room.players.blue.roundWins = 0;
      room.players.blue.points = 0;
      room.currentRound = 1;
      room.startCountdown();
    }
  });

  socket.on('get_leaderboard', () => {
    socket.emit('leaderboard_update', loadLeaderboard());
  });

  socket.on('disconnect', () => {
    onlinePlayers.delete(socket.id);
    const idx = matchmakingQueue.indexOf(socket.id);
    if (idx !== -1) matchmakingQueue.splice(idx, 1);

    if (socket.roomCode && rooms.has(socket.roomCode)) {
      const room = rooms.get(socket.roomCode);
      room.stopTickLoop();
      io.to(socket.roomCode).emit('opponent_disconnected');
      rooms.delete(socket.roomCode);
    }

    io.emit('online_players_list', getOnlinePlayersPayload());
  });
});

function createGameRoom(roomCode, hostSocket, guestSocket) {
  hostSocket.join(roomCode);
  guestSocket.join(roomCode);

  hostSocket.roomCode = roomCode;
  guestSocket.roomCode = roomCode;

  onlinePlayers.get(hostSocket.id).status = 'in_room';
  onlinePlayers.get(guestSocket.id).status = 'in_room';

  const room = new GameRoom(roomCode, hostSocket, guestSocket);
  rooms.set(roomCode, room);

  hostSocket.emit('match_joined', { roomCode, isRed: true, opponentName: room.players.blue.name });
  guestSocket.emit('match_joined', { roomCode, isRed: false, opponentName: room.players.red.name });

  room.startTickLoop();
  io.emit('online_players_list', getOnlinePlayersPayload());
}

function getOnlinePlayersPayload() {
  const list = [];
  for (const [id, data] of onlinePlayers.entries()) {
    list.push({ socketId: id, name: data.name, status: data.status });
  }
  return list;
}

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`  ONAM PILLOW FIGHT SERVER RUNNING AT:`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});
