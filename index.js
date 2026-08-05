import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { sequelize } from './db.js';
import { User } from './models/User.js';
import { SaveData } from './models/SaveData.js';

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('JWT_SECRET이 .env에 없습니다. 서버를 시작할 수 없어요.');
  process.exit(1);
}

// Netlify redirect(/api/*)를 통해서만 들어오므로 CORS는 넓게 열어도
// 실제로는 프록시를 거친 same-origin 요청이라 문제 없음.
app.use(cors());
app.use(express.json({ limit: '256kb' })); // 세이브 데이터는 작아서 넉넉히

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function signToken(user) {
  return jwt.sign({ uid: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
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

app.get('/health', (req, res) => res.json({ ok: true }));

// ── 회원가입 ──
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
    res.json({ token, username: user.username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── 로그인 ──
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await User.findOne({ where: { username } });
    if (!user) return res.status(401).json({ error: 'invalid_credentials', message: '아이디 또는 비밀번호가 틀렸어요.' });
    const ok = await bcrypt.compare(password || '', user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials', message: '아이디 또는 비밀번호가 틀렸어요.' });

    const token = signToken(user);
    const save = await SaveData.findOne({ where: { UserId: user.id } });
    res.json({ token, username: user.username, save: save ? save.data : null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── 세이브 불러오기 ──
app.get('/api/save', auth, async (req, res) => {
  try {
    const save = await SaveData.findOne({ where: { UserId: req.user.uid } });
    res.json({ save: save ? save.data : null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── 세이브 저장 (덮어쓰기 upsert) ──
app.put('/api/save', auth, async (req, res) => {
  try {
    const { data } = req.body || {};
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'bad_data' });

    const [row, created] = await SaveData.findOrCreate({
      where: { UserId: req.user.uid },
      defaults: { data, UserId: req.user.uid },
    });
    if (!created) {
      row.data = data;
      await row.save();
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

sequelize.sync().then(() => {
  app.listen(PORT, () => console.log(`✅ poke-stone-server on :${PORT}`));
}).catch((e) => {
  console.error('DB 연결/동기화 실패:', e.message);
  process.exit(1);
});
