import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { DataTypes } from 'sequelize';
import { sequelize } from './db.js';
import { User } from './models/User.js';
import { SaveData } from './models/SaveData.js';

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_CODE = process.env.ADMIN_CODE || 'stonemaster';
if (!JWT_SECRET) {
  console.error('JWT_SECRET이 .env에 없습니다. 서버를 시작할 수 없어요.');
  process.exit(1);
}

app.use(cors());
app.use(compression({ threshold: 1024, level: 4 }));
app.use(express.json({ limit: '1mb' }));

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const CARD_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const FRIENDLY_CODE_RE = /^[A-Z2-9]{6}$/;
const FRIENDLY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const FRIENDLY_ROOM_NAME_MAX = 28;
const FRIENDLY_PASSWORD_MAX = 32;
const MATCHMAKING_IDLE_MS = 60_000;
const FRIENDLY_ROOM_IDLE_MS = 10 * 60_000;
const FRIENDLY_GUEST_IDLE_MS = 90_000;
const FRIENDLY_RETURN_WAIT_MS = 3 * 60_000;
const ONLINE_PLAYER_IDLE_MS = 90_000;
const ONLINE_RATE_REFILL_PER_SECOND = 35;
const ONLINE_RATE_BURST = 70;
const ONLINE_RATE_BUCKET_IDLE_MS = 5 * 60_000;
const ONLINE_RUNTIME_SWEEP_MS = 15_000;
const ONLINE_COMMAND_TYPES = new Set([
  'mulligan',
  'play',
  'attack',
  'attack_obstacle',
  'discard_redraw',
  'end_turn',
  'resolve_pending',
  'resolve_choose',
  'surrender',
]);

// 랜덤 매칭/친선전 대기실/전투방은 단일 EC2 프로세스 메모리에서 관리한다.
// 서버 재시작 시 큐/대기실/매치는 초기화된다.
const matchmakingQueue = [];
const friendlyRooms = new Map();
const friendlyRoomByUser = new Map();
const activeMatches = new Map();
const matchByUser = new Map();
const onlineRateBuckets = new Map();

function signToken(user) {
  return jwt.sign(
    { uid: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: '30d' },
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

function onlineUser(req, res, next) {
  const uid = req.user?.uid;
  const username = req.user?.username;
  if (uid == null || typeof username !== 'string' || !username) {
    return res.status(401).json({ error: 'invalid_token' });
  }
  req.dbUser = { id: uid, username };
  next();
}

function onlineRateLimit(req, res, next) {
  const key = String(req.user?.uid ?? req.ip ?? 'unknown');
  const now = Date.now();
  const previous = onlineRateBuckets.get(key);
  const elapsed = previous ? Math.max(0, now - previous.updatedAt) : 0;
  const tokens = previous
    ? Math.min(
        ONLINE_RATE_BURST,
        previous.tokens + (elapsed * ONLINE_RATE_REFILL_PER_SECOND) / 1000,
      )
    : ONLINE_RATE_BURST;

  if (tokens < 1) {
    if (previous) {
      previous.updatedAt = now;
      previous.lastSeenAt = now;
      previous.tokens = tokens;
    }
    res.set('Retry-After', '1');
    return res.status(429).json({
      error: 'rate_limited',
      message: '온라인 요청이 너무 빠릅니다. 잠시 후 다시 시도해주세요.',
    });
  }

  onlineRateBuckets.set(key, {
    tokens: tokens - 1,
    updatedAt: now,
    lastSeenAt: now,
  });
  res.set('Cache-Control', 'private, no-store, max-age=0');
  next();
}

function sendSaveConflict(res, save) {
  return res.status(409).json({
    error: 'save_conflict',
    message: '다른 기기에서 더 최신 세이브가 저장되었습니다.',
    save: save ? save.data : null,
    revision: save ? save.revision : 0,
  });
}

async function ensureSaveRevisionColumn() {
  const queryInterface = sequelize.getQueryInterface();
  const tableName = SaveData.getTableName();
  const columns = await queryInterface.describeTable(tableName);

  if (!columns.revision) {
    await queryInterface.addColumn(tableName, 'revision', {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    console.log('✅ SaveData.revision 컬럼 추가 완료');
  }
}

async function ensureUserAdminColumn() {
  const queryInterface = sequelize.getQueryInterface();
  const tableName = User.getTableName();
  const columns = await queryInterface.describeTable(tableName);

  if (!columns.isAdmin) {
    await queryInterface.addColumn(tableName, 'isAdmin', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    console.log('✅ User.isAdmin 컬럼 추가 완료');
  }
}

function sanitizeDeckSnapshot(deck, deckShiny = {}) {
  if (!Array.isArray(deck) || deck.length !== 30) return null;
  if (!deck.every((cardId) => typeof cardId === 'string' && CARD_ID_RE.test(cardId))) {
    return null;
  }

  const shiny = {};
  if (deckShiny && typeof deckShiny === 'object' && !Array.isArray(deckShiny)) {
    const deckCounts = deck.reduce((acc, cardId) => {
      acc[cardId] = (acc[cardId] || 0) + 1;
      return acc;
    }, {});
    for (const [cardId, rawCount] of Object.entries(deckShiny)) {
      if (!CARD_ID_RE.test(cardId) || !deckCounts[cardId]) continue;
      const count = Number(rawCount);
      if (!Number.isInteger(count) || count <= 0) continue;
      shiny[cardId] = Math.min(count, deckCounts[cardId]);
    }
  }

  return { deck: [...deck], deckShiny: shiny };
}

function sanitizeFriendlyRoomName(rawName, username) {
  const name = String(rawName || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FRIENDLY_ROOM_NAME_MAX);
  return name || `${username}의 방`;
}

function sanitizeDeckName(rawName) {
  return String(rawName || '선택 덱')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24) || '선택 덱';
}

function removeQueuedUser(uid) {
  const index = matchmakingQueue.findIndex((entry) => entry.uid === uid);
  if (index >= 0) matchmakingQueue.splice(index, 1);
}

function pruneStaleQueue() {
  const cutoff = Date.now() - MATCHMAKING_IDLE_MS;
  for (let i = matchmakingQueue.length - 1; i >= 0; i -= 1) {
    if (matchmakingQueue[i].lastSeenAt < cutoff) matchmakingQueue.splice(i, 1);
  }
}

function generateFriendlyCode() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let code = '';
    for (let i = 0; i < 6; i += 1) {
      code += FRIENDLY_CODE_ALPHABET[
        crypto.randomInt(0, FRIENDLY_CODE_ALPHABET.length)
      ];
    }
    if (!friendlyRooms.has(code)) return code;
  }
  return crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
}

function friendlyParticipant(room, uid) {
  if (!room) return null;
  if (room.host?.uid === uid) return room.host;
  if (room.guest?.uid === uid) return room.guest;
  return null;
}

function currentFriendlyRoomForUser(uid) {
  const code = friendlyRoomByUser.get(uid);
  if (!code) return null;
  const room = friendlyRooms.get(code);
  if (!room || !friendlyParticipant(room, uid)) {
    friendlyRoomByUser.delete(uid);
    return null;
  }
  return room;
}

function destroyFriendlyRoom(room) {
  if (!room) return;
  friendlyRooms.delete(room.code);
  for (const participant of [room.host, room.guest]) {
    if (participant && friendlyRoomByUser.get(participant.uid) === room.code) {
      friendlyRoomByUser.delete(participant.uid);
    }
  }
}

function leaveFriendlyRoom(uid) {
  const room = currentFriendlyRoomForUser(uid);
  if (!room) return { ok: true };

  if (room.status === 'playing') {
    return {
      ok: false,
      error: 'battle_active',
      message: '배틀 중에는 친선전 방에서 나갈 수 없습니다.',
    };
  }

  if (room.host?.uid === uid) {
    destroyFriendlyRoom(room);
    return { ok: true };
  }

  if (room.guest?.uid === uid) {
    friendlyRoomByUser.delete(uid);
    room.guest = null;
    room.host.ready = false;
    room.status = 'waiting';
    room.matchId = null;
    room.returningAt = null;
    room.lastActivityAt = Date.now();
  }

  return { ok: true };
}

function friendlyRoomPayload(room, uid) {
  const me = friendlyParticipant(room, uid);
  if (!me) return null;
  const opponent = room.host?.uid === uid ? room.guest : room.host;
  const now = Date.now();
  me.lastSeenAt = now;
  room.lastActivityAt = now;

  const battleInProgress = room.status === 'playing' || room.status === 'returning';

  return {
    status: room.status,
    roomId: room.code,
    name: room.name,
    isPrivate: !!room.isPrivate,
    host: room.host.uid === uid,
    me: {
      username: me.username,
      ready: !!me.ready,
      deckName: me.deckName || '선택 덱',
      returned: !!me.returned,
    },
    opponent: opponent
      ? {
          username: opponent.username,
          ready: !!opponent.ready,
          deckName: opponent.deckName || '선택 덱',
          returned: !!opponent.returned,
        }
      : null,
    canStart:
      room.host.uid === uid &&
      !!room.host.ready &&
      !!room.guest?.ready &&
      room.status === 'waiting',
    canEditDeck: room.status === 'waiting',
    matchId: battleInProgress && !me.returned ? room.matchId : null,
  };
}

function friendlyRoomListPayload() {
  return [...friendlyRooms.values()]
    .filter((room) => room.status === 'waiting')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50)
    .map((room) => ({
      roomId: room.code,
      name: room.name,
      host: room.host.username,
      isPrivate: !!room.isPrivate,
      players: room.guest ? 2 : 1,
      full: !!room.guest,
      createdAt: room.createdAt,
    }));
}

function resetFriendlyRoomAfterBattle(room, match = null) {
  if (!room) return;
  room.status = 'waiting';
  room.matchId = null;
  room.startedAt = null;
  room.returningAt = null;
  room.lastActivityAt = Date.now();
  for (const participant of [room.host, room.guest]) {
    if (!participant) continue;
    participant.ready = false;
    participant.returned = false;
    participant.lastSeenAt = Date.now();
  }
  if (match) destroyMatch(match);
}

function pruneStaleFriendlyRooms() {
  const now = Date.now();
  for (const room of friendlyRooms.values()) {
    if (room.status === 'playing' || room.status === 'returning') {
      const match = room.matchId ? activeMatches.get(room.matchId) : null;
      if (!match) {
        resetFriendlyRoomAfterBattle(room);
        continue;
      }
      if (
        room.status === 'returning' &&
        room.returningAt &&
        now - room.returningAt > FRIENDLY_RETURN_WAIT_MS
      ) {
        resetFriendlyRoomAfterBattle(room, match);
      }
      continue;
    }

    if (now - (room.lastActivityAt || room.createdAt || 0) > FRIENDLY_ROOM_IDLE_MS) {
      destroyFriendlyRoom(room);
      continue;
    }

    if (
      room.guest &&
      now - (room.guest.lastSeenAt || room.guest.joinedAt || 0) > FRIENDLY_GUEST_IDLE_MS
    ) {
      friendlyRoomByUser.delete(room.guest.uid);
      room.guest = null;
      room.host.ready = false;
      room.lastActivityAt = now;
    }
  }
}

function destroyMatch(match) {
  if (!match) return;
  activeMatches.delete(match.id);
  for (const player of match.players || []) {
    if (matchByUser.get(player.uid) === match.id) matchByUser.delete(player.uid);
  }
}

function pruneStaleMatches() {
  const cutoff = Date.now() - ONLINE_PLAYER_IDLE_MS;
  for (const match of activeMatches.values()) {
    const playerExpired = (match.players || []).some(
      (player) => (player.lastSeenAt || match.matchedAt || 0) < cutoff,
    );
    if (playerExpired) destroyMatch(match);
  }
}

function pruneOnlineRateBuckets() {
  const cutoff = Date.now() - ONLINE_RATE_BUCKET_IDLE_MS;
  for (const [key, bucket] of onlineRateBuckets.entries()) {
    if ((bucket.lastSeenAt || 0) < cutoff) onlineRateBuckets.delete(key);
  }
}

function currentMatchForUser(uid) {
  const matchId = matchByUser.get(uid);
  if (!matchId) return null;
  const match = activeMatches.get(matchId);
  if (!match) {
    matchByUser.delete(uid);
    return null;
  }
  return match;
}

function playerForUser(match, uid) {
  return match?.players?.find((player) => player.uid === uid) || null;
}

function opponentForUser(match, uid) {
  return match?.players?.find((player) => player.uid !== uid) || null;
}

function canonicalSide(match, uid) {
  const player = playerForUser(match, uid);
  if (!player) return null;
  return player.seat === 'A' ? 'player' : 'enemy';
}

function firstSideForMatch(match) {
  return canonicalSide(match, match.firstUid) || 'player';
}

function matchmakingStatus(uid) {
  const match = currentMatchForUser(uid);
  if (match) {
    const me = playerForUser(match, uid);
    const opponent = opponentForUser(match, uid);
    const now = Date.now();
    if (me) me.lastSeenAt = now;
    match.lastActivityAt = now;
    return {
      status: 'matched',
      matchId: match.id,
      seat: me?.seat || null,
      goesFirst: match.firstUid === uid,
      opponent: opponent ? { username: opponent.username } : null,
      matchedAt: match.matchedAt,
      phase: match.phase,
      stateRevision: match.stateRevision,
    };
  }

  const queueIndex = matchmakingQueue.findIndex((entry) => entry.uid === uid);
  if (queueIndex >= 0) {
    matchmakingQueue[queueIndex].lastSeenAt = Date.now();
    return {
      status: 'searching',
      joinedAt: matchmakingQueue[queueIndex].joinedAt,
      queuePosition: queueIndex + 1,
    };
  }

  return { status: 'idle' };
}

function createMatch(firstEntry, secondEntry, options = {}) {
  const id = crypto.randomUUID();
  const firstUid = Math.random() < 0.5 ? firstEntry.uid : secondEntry.uid;
  const now = Date.now();
  const players = [
    { ...firstEntry, seat: 'A', lastSeenAt: now },
    { ...secondEntry, seat: 'B', lastSeenAt: now },
  ];
  const match = {
    id,
    matchedAt: now,
    lastActivityAt: now,
    firstUid,
    hostUid: players[0].uid,
    friendlyRoomId: options.friendlyRoomId || null,
    seed: crypto.randomBytes(12).toString('hex'),
    players,
    phase: 'waiting_host',
    state: null,
    stateRevision: 0,
    commandSeq: 0,
    pendingCommand: null,
    lastCommand: null,
    mulliganDone: Object.fromEntries(players.map((player) => [player.uid, false])),
  };
  activeMatches.set(id, match);
  matchByUser.set(firstEntry.uid, id);
  matchByUser.set(secondEntry.uid, id);
  return match;
}

function leaveMatchmaking(uid) {
  removeQueuedUser(uid);
  const match = currentMatchForUser(uid);
  if (!match) return;
  destroyMatch(match);
}

function matchFromRequest(req, res) {
  const match = activeMatches.get(req.params.matchId);
  if (!match || !playerForUser(match, req.dbUser.id)) {
    res.status(404).json({
      error: 'match_not_found',
      message: '온라인 배틀 세션을 찾을 수 없습니다.',
    });
    return null;
  }
  const now = Date.now();
  const player = playerForUser(match, req.dbUser.id);
  if (player) player.lastSeenAt = now;
  match.lastActivityAt = now;
  return match;
}

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function clientGameState(match, uid) {
  if (!match.state) return null;
  const game = cloneJson(match.state);
  if (uid === match.hostUid) return game;

  const mine = canonicalSide(match, uid);
  const hidden = mine === 'player' ? 'enemy' : 'player';
  const hiddenPlayer = game.players?.[hidden];
  if (hiddenPlayer) {
    const deckCount = Array.isArray(hiddenPlayer.deck) ? hiddenPlayer.deck.length : 0;
    const hand = Array.isArray(hiddenPlayer.hand) ? hiddenPlayer.hand : [];
    hiddenPlayer.deck = Array.from({ length: deckCount }, () => null);
    hiddenPlayer.hand = hand.map((entry) => ({
      uid: entry?.uid || null,
      hidden: true,
    }));
    hiddenPlayer._shinyDeckRemaining = {};
  }

  if (game.pendingChoose?.side === hidden) {
    game.pendingChoose = null;
  }
  if (Array.isArray(game.log) && game.log.length > 16) {
    game.log = game.log.slice(-16);
  }
  return game;
}

function roomStatePayload(match, uid) {
  const me = playerForUser(match, uid);
  const opponent = opponentForUser(match, uid);
  return {
    status: 'active',
    matchId: match.id,
    phase: match.phase,
    revision: match.stateRevision,
    host: match.hostUid === uid,
    mySide: canonicalSide(match, uid),
    firstSide: firstSideForMatch(match),
    opponent: opponent ? { username: opponent.username } : null,
    me: me ? { username: me.username, seat: me.seat } : null,
    mulligan: {
      me: !!match.mulliganDone[uid],
      opponent: opponent ? !!match.mulliganDone[opponent.uid] : false,
    },
    lastCommand:
      match.lastCommand?.uid === uid
        ? match.lastCommand
        : null,
    game: clientGameState(match, uid),
  };
}

function onlinePollResponse(req, match, host = false) {
  const revision = Number.parseInt(String(req.query?.revision ?? ''), 10);
  if (!Number.isInteger(revision) || revision !== match.stateRevision) return null;

  if (!host) {
    return {
      unchanged: true,
      revision: match.stateRevision,
    };
  }

  if (typeof req.query?.pending !== 'string') return null;
  const currentPending =
    match.pendingCommand?.id == null ? '' : String(match.pendingCommand.id);

  if (req.query.pending === currentPending) {
    return {
      unchanged: true,
      revision: match.stateRevision,
    };
  }

  return {
    delta: true,
    revision: match.stateRevision,
    pendingCommand: match.pendingCommand,
  };
}

function normalizeOnlineCommand(body) {
  const type = typeof body?.type === 'string' ? body.type : '';
  if (!ONLINE_COMMAND_TYPES.has(type)) return null;

  if (type === 'mulligan') {
    const raw = Array.isArray(body.cardUids) ? body.cardUids : [];
    const cardUids = [...new Set(raw)]
      .filter((uid) => typeof uid === 'string' && uid.length <= 128)
      .slice(0, 10);
    return { type, cardUids };
  }

  if (type === 'play') {
    if (typeof body.handUid !== 'string' || body.handUid.length > 128) return null;
    const command = { type, handUid: body.handUid };
    if (typeof body.targetUid === 'string' && body.targetUid.length <= 128) {
      command.targetUid = body.targetUid;
    }
    if (Number.isInteger(body.fieldIndex) && body.fieldIndex >= 0 && body.fieldIndex <= 6) {
      command.fieldIndex = body.fieldIndex;
    }
    return command;
  }

  if (type === 'attack') {
    if (
      typeof body.attackerUid !== 'string' || body.attackerUid.length > 128 ||
      typeof body.targetUid !== 'string' || body.targetUid.length > 128
    ) return null;
    return { type, attackerUid: body.attackerUid, targetUid: body.targetUid };
  }

  if (type === 'attack_obstacle') {
    if (
      typeof body.attackerUid !== 'string' || body.attackerUid.length > 128 ||
      typeof body.obstacleId !== 'string' || body.obstacleId.length > 128
    ) return null;
    return { type, attackerUid: body.attackerUid, obstacleId: body.obstacleId };
  }

  if (type === 'discard_redraw') {
    if (typeof body.handUid !== 'string' || body.handUid.length > 128) return null;
    return { type, handUid: body.handUid };
  }

  if (type === 'resolve_pending') {
    if (typeof body.targetUid !== 'string' || body.targetUid.length > 128) return null;
    return { type, targetUid: body.targetUid };
  }

  if (type === 'resolve_choose') {
    const value = body.value;
    if (!['string', 'number'].includes(typeof value)) return null;
    if (typeof value === 'string' && value.length > 128) return null;
    return { type, value };
  }

  return { type };
}

function validateSubmittedGame(game) {
  if (!game || typeof game !== 'object' || Array.isArray(game)) return false;
  if (!game.players?.player || !game.players?.enemy) return false;
  if (!['player', 'enemy'].includes(game.turn)) return false;
  if (!Array.isArray(game.log)) return false;
  return true;
}

const onlineRuntimeSweep = setInterval(() => {
  pruneStaleQueue();
  pruneStaleFriendlyRooms();
  pruneStaleMatches();
  pruneOnlineRateBuckets();
}, ONLINE_RUNTIME_SWEEP_MS);
onlineRuntimeSweep.unref?.();

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!USERNAME_RE.test(username || '')) {
      return res.status(400).json({ error: 'bad_username', message: '아이디는 영문/숫자/밑줄 3~20자여야 해요.' });
    }
    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'bad_password', message: '비밀번호는 4자 이상이어야 해요.' });
    }
    const exists = await User.findOne({ where: { username } });
    if (exists) return res.status(409).json({ error: 'username_taken', message: '이미 있는 아이디예요.' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, passwordHash });
    const token = signToken(user);
    res.json({
      token,
      username: user.username,
      isAdmin: !!user.isAdmin,
      save: null,
      revision: 0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await User.findOne({ where: { username } });
    if (!user) return res.status(401).json({ error: 'invalid_credentials', message: '아이디 또는 비밀번호가 틀렸어요.' });
    const ok = await bcrypt.compare(password || '', user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials', message: '아이디 또는 비밀번호가 틀렸어요.' });

    const token = signToken(user);
    const save = await SaveData.findOne({ where: { UserId: user.id } });
    res.json({
      token,
      username: user.username,
      isAdmin: !!user.isAdmin,
      save: save ? save.data : null,
      revision: save ? save.revision : 0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/admin/unlock', auth, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (code !== ADMIN_CODE) {
      return res.status(403).json({
        error: 'invalid_admin_code',
        message: '관리자 코드가 올바르지 않습니다.',
      });
    }

    const user = await User.findByPk(req.user.uid);
    if (!user) return res.status(401).json({ error: 'invalid_token' });
    if (!user.isAdmin) await user.update({ isAdmin: true });
    return res.json({ ok: true, isAdmin: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/save', auth, async (req, res) => {
  try {
    const [save, user] = await Promise.all([
      SaveData.findOne({ where: { UserId: req.user.uid } }),
      User.findByPk(req.user.uid, { attributes: ['isAdmin'] }),
    ]);
    res.json({
      save: save ? save.data : null,
      revision: save ? save.revision : 0,
      isAdmin: !!user?.isAdmin,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.put('/api/save', auth, async (req, res) => {
  try {
    const { data, revision } = req.body || {};
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'bad_data' });
    }
    if (!Number.isInteger(revision) || revision < 0) {
      return res.status(400).json({
        error: 'bad_revision',
        message: '세이브 버전 정보가 없습니다. 페이지를 새로고침해주세요.',
      });
    }

    const row = await SaveData.findOne({ where: { UserId: req.user.uid } });

    if (!row) {
      if (revision !== 0) return sendSaveConflict(res, null);

      try {
        const created = await SaveData.create({
          data,
          revision: 1,
          UserId: req.user.uid,
        });
        return res.json({ ok: true, revision: created.revision });
      } catch (e) {
        if (e?.name === 'SequelizeUniqueConstraintError') {
          const latest = await SaveData.findOne({ where: { UserId: req.user.uid } });
          return sendSaveConflict(res, latest);
        }
        throw e;
      }
    }

    if (row.revision !== revision) {
      return sendSaveConflict(res, row);
    }

    const nextRevision = revision + 1;
    const [updated] = await SaveData.update(
      { data, revision: nextRevision },
      {
        where: {
          id: row.id,
          UserId: req.user.uid,
          revision,
        },
      },
    );

    if (updated !== 1) {
      const latest = await SaveData.findOne({ where: { UserId: req.user.uid } });
      return sendSaveConflict(res, latest);
    }

    return res.json({ ok: true, revision: nextRevision });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.use(
  ['/api/matchmaking', '/api/friendly', '/api/online'],
  auth,
  onlineUser,
  onlineRateLimit,
);

app.post('/api/matchmaking/join', async (req, res) => {
  try {
    pruneStaleQueue();
    pruneStaleFriendlyRooms();
    const snapshot = sanitizeDeckSnapshot(req.body?.deck, req.body?.deckShiny);
    if (!snapshot) {
      return res.status(400).json({
        error: 'invalid_deck',
        message: '온라인 배틀은 30장 덱이 필요합니다.',
      });
    }

    const uid = req.dbUser.id;
    if (currentFriendlyRoomForUser(uid)) {
      return res.status(409).json({
        error: 'friendly_room_active',
        message: '친선전 방을 먼저 나가주세요.',
      });
    }
    const existingMatch = currentMatchForUser(uid);
    if (existingMatch) return res.json(matchmakingStatus(uid));

    const queued = matchmakingQueue.find((entry) => entry.uid === uid);
    if (queued) {
      queued.deck = snapshot.deck;
      queued.deckShiny = snapshot.deckShiny;
      queued.lastSeenAt = Date.now();
      return res.json(matchmakingStatus(uid));
    }

    const opponentIndex = matchmakingQueue.findIndex((entry) => entry.uid !== uid);
    if (opponentIndex >= 0) {
      const [opponent] = matchmakingQueue.splice(opponentIndex, 1);
      createMatch(opponent, {
        uid,
        username: req.dbUser.username,
        ...snapshot,
        joinedAt: Date.now(),
        lastSeenAt: Date.now(),
      });
      return res.json(matchmakingStatus(uid));
    }

    matchmakingQueue.push({
      uid,
      username: req.dbUser.username,
      ...snapshot,
      joinedAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    return res.json(matchmakingStatus(uid));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/matchmaking/status', async (req, res) => {
  pruneStaleQueue();
  return res.json(matchmakingStatus(req.dbUser.id));
});

app.post('/api/matchmaking/leave', async (req, res) => {
  leaveMatchmaking(req.dbUser.id);
  return res.json({ ok: true, status: 'idle' });
});

// ── 친선전 방 목록 / 대기실 ──
app.get('/api/friendly/rooms', async (req, res) => {
  pruneStaleFriendlyRooms();
  return res.json({ rooms: friendlyRoomListPayload() });
});

app.post('/api/friendly/create', async (req, res) => {
  try {
    pruneStaleFriendlyRooms();
    const snapshot = sanitizeDeckSnapshot(req.body?.deck, req.body?.deckShiny);
    if (!snapshot) {
      return res.status(400).json({
        error: 'invalid_deck',
        message: '친선전은 30장 덱이 필요합니다.',
      });
    }

    const uid = req.dbUser.id;
    if (currentMatchForUser(uid)) {
      return res.status(409).json({ error: 'match_active', message: '진행 중인 온라인 배틀이 있습니다.' });
    }

    const isPrivate = req.body?.isPrivate === true;
    const password = String(req.body?.password || '');
    if (isPrivate && (password.length < 4 || password.length > FRIENDLY_PASSWORD_MAX)) {
      return res.status(400).json({
        error: 'invalid_room_password',
        message: '비밀방 비밀번호는 4~32자로 설정해주세요.',
      });
    }

    removeQueuedUser(uid);
    const previous = currentFriendlyRoomForUser(uid);
    if (previous?.status === 'playing') {
      return res.status(409).json({ error: 'battle_active', message: '진행 중인 친선전이 있습니다.' });
    }
    leaveFriendlyRoom(uid);

    const now = Date.now();
    const code = generateFriendlyCode();
    const room = {
      code,
      name: sanitizeFriendlyRoomName(req.body?.name, req.dbUser.username),
      isPrivate,
      passwordHash: isPrivate ? await bcrypt.hash(password, 8) : null,
      status: 'waiting',
      createdAt: now,
      lastActivityAt: now,
      startedAt: null,
      returningAt: null,
      matchId: null,
      host: {
        uid,
        username: req.dbUser.username,
        ...snapshot,
        deckName: sanitizeDeckName(req.body?.deckName),
        ready: false,
        returned: false,
        joinedAt: now,
        lastSeenAt: now,
      },
      guest: null,
    };
    friendlyRooms.set(code, room);
    friendlyRoomByUser.set(uid, code);
    return res.json(friendlyRoomPayload(room, uid));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/friendly/join', async (req, res) => {
  try {
    pruneStaleFriendlyRooms();
    const roomId = String(req.body?.roomId || '').trim().toUpperCase();
    if (!FRIENDLY_CODE_RE.test(roomId)) {
      return res.status(400).json({ error: 'invalid_room', message: '친선전 방 정보가 올바르지 않습니다.' });
    }
    const snapshot = sanitizeDeckSnapshot(req.body?.deck, req.body?.deckShiny);
    if (!snapshot) {
      return res.status(400).json({ error: 'invalid_deck', message: '친선전은 30장 덱이 필요합니다.' });
    }

    const uid = req.dbUser.id;
    if (currentMatchForUser(uid)) {
      return res.status(409).json({ error: 'match_active', message: '진행 중인 온라인 배틀이 있습니다.' });
    }

    const room = friendlyRooms.get(roomId);
    if (!room || room.status !== 'waiting') {
      return res.status(404).json({ error: 'room_not_found', message: '입장할 수 있는 친선전 방을 찾지 못했습니다.' });
    }

    if (room.isPrivate) {
      const password = String(req.body?.password || '');
      const passwordOk = room.passwordHash
        ? await bcrypt.compare(password, room.passwordHash)
        : false;
      if (!passwordOk) {
        return res.status(403).json({ error: 'wrong_room_password', message: '방 비밀번호가 올바르지 않습니다.' });
      }
    }

    if (room.host.uid === uid) {
      friendlyRoomByUser.set(uid, room.code);
      room.host.deck = snapshot.deck;
      room.host.deckShiny = snapshot.deckShiny;
      room.host.deckName = sanitizeDeckName(req.body?.deckName);
      room.host.ready = false;
      return res.json(friendlyRoomPayload(room, uid));
    }
    if (room.guest && room.guest.uid !== uid) {
      return res.status(409).json({ error: 'room_full', message: '이미 두 명이 입장한 방입니다.' });
    }

    removeQueuedUser(uid);
    const previous = currentFriendlyRoomForUser(uid);
    if (previous && previous.code !== roomId) {
      if (previous.status === 'playing') {
        return res.status(409).json({ error: 'battle_active', message: '진행 중인 친선전이 있습니다.' });
      }
      leaveFriendlyRoom(uid);
    }

    const now = Date.now();
    room.guest = {
      uid,
      username: req.dbUser.username,
      ...snapshot,
      deckName: sanitizeDeckName(req.body?.deckName),
      ready: false,
      returned: false,
      joinedAt: now,
      lastSeenAt: now,
    };
    room.host.ready = false;
    room.lastActivityAt = now;
    friendlyRoomByUser.set(uid, roomId);
    return res.json(friendlyRoomPayload(room, uid));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/friendly/room', async (req, res) => {
  pruneStaleFriendlyRooms();
  const uid = req.dbUser.id;
  const room = currentFriendlyRoomForUser(uid);
  if (!room) {
    return res.status(404).json({ error: 'room_not_found', message: '친선전 방을 찾을 수 없습니다.' });
  }
  return res.json(friendlyRoomPayload(room, uid));
});

app.post('/api/friendly/deck', async (req, res) => {
  const uid = req.dbUser.id;
  const room = currentFriendlyRoomForUser(uid);
  if (!room || room.status !== 'waiting') {
    return res.status(409).json({ error: 'room_not_ready', message: '대기실에서만 덱을 변경할 수 있습니다.' });
  }
  const snapshot = sanitizeDeckSnapshot(req.body?.deck, req.body?.deckShiny);
  if (!snapshot) {
    return res.status(400).json({ error: 'invalid_deck', message: '30장으로 완성된 덱을 선택해주세요.' });
  }
  const participant = friendlyParticipant(room, uid);
  participant.deck = snapshot.deck;
  participant.deckShiny = snapshot.deckShiny;
  participant.deckName = sanitizeDeckName(req.body?.deckName);
  participant.ready = false;
  room.lastActivityAt = Date.now();
  return res.json(friendlyRoomPayload(room, uid));
});

app.post('/api/friendly/ready', async (req, res) => {
  const uid = req.dbUser.id;
  const room = currentFriendlyRoomForUser(uid);
  if (!room || room.status !== 'waiting') {
    return res.status(409).json({ error: 'room_not_ready', message: '아직 다음 배틀을 준비할 수 없습니다.' });
  }
  const participant = friendlyParticipant(room, uid);
  participant.ready = req.body?.ready === true;
  room.lastActivityAt = Date.now();
  return res.json(friendlyRoomPayload(room, uid));
});

app.post('/api/friendly/start', async (req, res) => {
  const uid = req.dbUser.id;
  const room = currentFriendlyRoomForUser(uid);
  if (!room || room.status !== 'waiting') {
    return res.status(409).json({ error: 'room_not_ready', message: '친선전 대기실이 준비되지 않았습니다.' });
  }
  if (room.host.uid !== uid) {
    return res.status(403).json({ error: 'host_only', message: '방장만 게임을 시작할 수 있습니다.' });
  }
  if (!room.guest) {
    return res.status(409).json({ error: 'opponent_missing', message: '상대의 입장을 기다려주세요.' });
  }
  if (!room.host.ready || !room.guest.ready) {
    return res.status(409).json({ error: 'players_not_ready', message: '두 플레이어 모두 준비해야 합니다.' });
  }

  room.host.returned = false;
  room.guest.returned = false;
  const match = createMatch(room.host, room.guest, { friendlyRoomId: room.code });
  room.status = 'playing';
  room.matchId = match.id;
  room.startedAt = Date.now();
  room.returningAt = null;
  room.lastActivityAt = room.startedAt;

  return res.json(friendlyRoomPayload(room, uid));
});

app.post('/api/friendly/return', async (req, res) => {
  const uid = req.dbUser.id;
  const room = currentFriendlyRoomForUser(uid);
  if (!room || !['playing', 'returning'].includes(room.status)) {
    return res.status(404).json({ error: 'room_not_found', message: '돌아갈 친선전 방을 찾을 수 없습니다.' });
  }

  const requestedMatchId = String(req.body?.matchId || '');
  if (!requestedMatchId || requestedMatchId !== room.matchId) {
    return res.status(409).json({ error: 'match_mismatch', message: '친선전 배틀 정보가 일치하지 않습니다.' });
  }

  const match = activeMatches.get(room.matchId);
  if (match && match.phase !== 'finished' && !match.state?.winner) {
    return res.status(409).json({ error: 'match_not_finished', message: '아직 배틀이 종료되지 않았습니다.' });
  }

  const participant = friendlyParticipant(room, uid);
  participant.returned = true;
  participant.ready = false;
  participant.lastSeenAt = Date.now();

  const everyoneReturned =
    !!room.host?.returned && (!room.guest || !!room.guest.returned);

  if (everyoneReturned) {
    resetFriendlyRoomAfterBattle(room, match);
  } else {
    room.status = 'returning';
    room.returningAt = room.returningAt || Date.now();
    room.lastActivityAt = Date.now();
  }

  return res.json(friendlyRoomPayload(room, uid));
});

app.post('/api/friendly/leave', async (req, res) => {
  const result = leaveFriendlyRoom(req.dbUser.id);
  if (!result.ok) {
    return res.status(409).json({ error: result.error, message: result.message });
  }
  return res.json({ ok: true });
});

// ── 온라인 배틀방 ──
app.get('/api/online/match/:matchId/bootstrap', async (req, res) => {
  const match = matchFromRequest(req, res);
  if (!match) return;
  const uid = req.dbUser.id;
  const me = playerForUser(match, uid);
  const opponent = opponentForUser(match, uid);
  const host = match.hostUid === uid;

  return res.json({
    matchId: match.id,
    seat: me?.seat || null,
    host,
    mySide: canonicalSide(match, uid),
    firstSide: firstSideForMatch(match),
    seed: match.seed,
    phase: match.phase,
    stateRevision: match.stateRevision,
    me: me ? { username: me.username } : null,
    opponent: opponent ? { username: opponent.username } : null,
    ...(host
      ? {
          playerDeck: {
            username: match.players[0].username,
            deck: match.players[0].deck,
            deckShiny: match.players[0].deckShiny,
          },
          enemyDeck: {
            username: match.players[1].username,
            deck: match.players[1].deck,
            deckShiny: match.players[1].deckShiny,
          },
        }
      : {}),
  });
});

app.post('/api/online/match/:matchId/initialize', async (req, res) => {
  const match = matchFromRequest(req, res);
  if (!match) return;
  if (match.hostUid !== req.dbUser.id) {
    return res.status(403).json({ error: 'host_only', message: '전투 초기화는 호스트만 할 수 있습니다.' });
  }
  if (match.state) return res.json(roomStatePayload(match, req.dbUser.id));
  if (!validateSubmittedGame(req.body?.game)) {
    return res.status(400).json({ error: 'invalid_game_state' });
  }
  if (req.body.game.firstSide !== firstSideForMatch(match)) {
    return res.status(409).json({ error: 'first_side_mismatch' });
  }

  match.state = cloneJson(req.body.game);
  match.stateRevision = 1;
  match.phase = 'mulligan';
  match.lastActivityAt = Date.now();
  return res.json(roomStatePayload(match, req.dbUser.id));
});

app.get('/api/online/match/:matchId/state', async (req, res) => {
  const match = matchFromRequest(req, res);
  if (!match) return;
  const compact = onlinePollResponse(req, match, false);
  if (compact) return res.json(compact);
  return res.json(roomStatePayload(match, req.dbUser.id));
});

app.get('/api/online/match/:matchId/host', async (req, res) => {
  const match = matchFromRequest(req, res);
  if (!match) return;
  if (match.hostUid !== req.dbUser.id) {
    return res.status(403).json({ error: 'host_only' });
  }

  const compact = onlinePollResponse(req, match, true);
  if (compact) return res.json(compact);

  return res.json({
    ...roomStatePayload(match, req.dbUser.id),
    pendingCommand: match.pendingCommand,
  });
});

app.post('/api/online/match/:matchId/command', async (req, res) => {
  const match = matchFromRequest(req, res);
  if (!match) return;
  const uid = req.dbUser.id;
  const side = canonicalSide(match, uid);
  const command = normalizeOnlineCommand(req.body);
  if (!command) {
    return res.status(400).json({ error: 'invalid_command' });
  }
  if (!match.state) {
    return res.status(409).json({ error: 'room_not_ready', message: '전투방 초기화를 기다리는 중입니다.' });
  }
  if (match.pendingCommand) {
    return res.status(409).json({ error: 'command_busy', message: '이전 행동을 처리 중입니다.' });
  }
  if (match.phase === 'finished') {
    return res.status(409).json({ error: 'match_finished' });
  }

  if (match.phase === 'mulligan') {
    if (command.type !== 'mulligan') {
      return res.status(409).json({ error: 'mulligan_required' });
    }
    if (match.mulliganDone[uid]) {
      return res.status(409).json({ error: 'mulligan_already_done' });
    }
  } else if (match.phase === 'battle') {
    if (command.type !== 'surrender' && match.state.turn !== side) {
      return res.status(409).json({ error: 'not_your_turn', message: '상대 턴입니다.' });
    }
  } else {
    return res.status(409).json({ error: 'room_not_ready' });
  }

  const id = ++match.commandSeq;
  match.pendingCommand = {
    id,
    uid,
    side,
    payload: command,
    createdAt: Date.now(),
    baseRevision: match.stateRevision,
  };
  match.lastActivityAt = Date.now();
  return res.json({ ok: true, commandId: id, revision: match.stateRevision });
});

app.post('/api/online/match/:matchId/host/commit', async (req, res) => {
  const match = matchFromRequest(req, res);
  if (!match) return;
  if (match.hostUid !== req.dbUser.id) {
    return res.status(403).json({ error: 'host_only' });
  }

  const pending = match.pendingCommand;
  if (!pending || pending.id !== req.body?.commandId) {
    return res.status(409).json({ error: 'command_mismatch' });
  }
  if (req.body?.baseRevision !== match.stateRevision || pending.baseRevision !== match.stateRevision) {
    return res.status(409).json({ error: 'revision_mismatch', revision: match.stateRevision });
  }
  if (!validateSubmittedGame(req.body?.game)) {
    return res.status(400).json({ error: 'invalid_game_state' });
  }

  const ok = req.body?.ok !== false;
  const error = ok ? null : String(req.body?.error || 'invalid_action').slice(0, 160);
  match.state = cloneJson(req.body.game);
  match.stateRevision += 1;
  match.lastCommand = {
    id: pending.id,
    uid: pending.uid,
    ok,
    error,
    revision: match.stateRevision,
  };

  if (ok && pending.payload.type === 'mulligan') {
    match.mulliganDone[pending.uid] = true;
    if (match.players.every((player) => match.mulliganDone[player.uid])) {
      match.phase = 'battle';
    }
  }

  if (ok && pending.payload.type === 'surrender') {
    match.phase = 'finished';
  }
  if (match.state?.winner) {
    match.phase = 'finished';
  }

  match.pendingCommand = null;
  match.lastActivityAt = Date.now();
  return res.json({
    ok: true,
    phase: match.phase,
    revision: match.stateRevision,
  });
});

sequelize.sync()
  .then(() => ensureSaveRevisionColumn())
  .then(() => ensureUserAdminColumn())
  .then(() => {
    app.listen(PORT, () => console.log(`✅ poke-stone-server on :${PORT}`));
  })
  .catch((e) => {
    console.error('DB 연결/동기화 실패:', e.message);
    process.exit(1);
  });