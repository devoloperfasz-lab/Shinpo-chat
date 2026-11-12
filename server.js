require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '.env.admin') });
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
const webpush = require('web-push');
const admin = require('firebase-admin');

const {
  PORT = 3000,
  JWT_SECRET,
  GMAIL_USER,
  GMAIL_APP_PASSWORD,
  GOOGLE_CLIENT_ID,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  DATA_FILE = './data.json',
  FIREBASE_SERVICE_ACCOUNT,
  FIREBASE_DATABASE_URL,
} = process.env;

if (!JWT_SECRET || !GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.error('Isi JWT_SECRET, GMAIL_USER, dan GMAIL_APP_PASSWORD di file .env');
  process.exit(1);
}

const pushOn = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushOn) webpush.setVapidDetails('mailto:' + GMAIL_USER, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
else console.warn('VAPID key kosong: notifikasi saat aplikasi ditutup dinonaktifkan.');
if (!GOOGLE_CLIENT_ID) console.warn('GOOGLE_CLIENT_ID kosong: login Google dinonaktifkan.');

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD.replace(/\s/g, '') },
});
mailer.verify().then(
  () => console.log('Gmail siap mengirim OTP'),
  (e) => console.error('Gmail gagal: ' + e.message)
);

// ---------- Penyimpanan (Firebase Realtime Database, atau file JSON jika Firebase belum diatur) ----------
let db = { users: {}, messages: [], reads: {}, subs: {}, calls: [] };
let rtdb = null;
if (FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  if (!FIREBASE_DATABASE_URL) {
    console.error('Isi FIREBASE_DATABASE_URL di .env (alamat ada di Firebase Console, menu Realtime Database)');
    process.exit(1);
  }
  try {
    const opts = { databaseURL: FIREBASE_DATABASE_URL };
    if (FIREBASE_SERVICE_ACCOUNT) {
      const raw = FIREBASE_SERVICE_ACCOUNT.trim();
      const cred = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
      opts.credential = admin.credential.cert(cred);
    }
    admin.initializeApp(opts);
    rtdb = admin.database();
  } catch (e) {
    console.error('Konfigurasi Firebase tidak valid: ' + e.message);
    process.exit(1);
  }
} else {
  console.warn('Firebase belum diatur: data disimpan di file lokal ' + DATA_FILE);
}

// Kunci Realtime Database tidak boleh memuat titik, jadi email disandikan.
const ek = (e) => encodeURIComponent(e).replace(/\./g, '%2E');
const dk = (k) => decodeURIComponent(k);
const nz = (x) => {
  const n = Array.isArray(x) ? x.length : x && typeof x === 'object' ? Object.keys(x).length : 1;
  return n ? x : null;
};

const lastJson = new Map();
let savedMsg = 0;
let savedCall = 0;
const delIds = { messages: [], calls: [] };

async function loadDb() {
  if (!rtdb) {
    try {
      if (fs.existsSync(DATA_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
    } catch (e) {
      console.error('Gagal membaca ' + DATA_FILE + ': ' + e.message);
      process.exit(1);
    }
    return;
  }
  const val = (p) => rtdb.ref(p).once('value').then((s) => s.val() || {});
  const [u, r, s, mSnap, cSnap] = await Promise.all([
    val('users'),
    val('reads'),
    val('subs'),
    rtdb.ref('messages').orderByChild('ts').limitToLast(20000).once('value'),
    rtdb.ref('calls').orderByChild('ts').limitToLast(2000).once('value'),
  ]);
  for (const [k, v] of Object.entries(u)) {
    const e = dk(k);
    db.users[e] = v;
    lastJson.set('users/' + e, JSON.stringify(v));
  }
  for (const [k, v] of Object.entries(r)) {
    const e = dk(k);
    const m = {};
    for (const [pk, t] of Object.entries(v)) m[dk(pk)] = t;
    db.reads[e] = m;
    lastJson.set('reads/' + e, JSON.stringify(m));
  }
  for (const [k, v] of Object.entries(s)) {
    const e = dk(k);
    const list = Array.isArray(v) ? v.filter(Boolean) : Object.values(v);
    db.subs[e] = list;
    lastJson.set('subs/' + e, JSON.stringify(list));
  }
  mSnap.forEach((ch) => { db.messages.push(ch.val()); });
  cSnap.forEach((ch) => { db.calls.push(ch.val()); });
  savedMsg = db.messages.length;
  savedCall = db.calls.length;
  console.log('Realtime Database terhubung: ' + Object.keys(db.users).length + ' pengguna, ' + db.messages.length + ' pesan dimuat');
}

async function flushRtdb() {
  const ops = {};
  const marks = [];
  const sync = (name, obj, wrap) => {
    for (const [k, v] of Object.entries(obj)) {
      const id = name + '/' + k;
      const js = JSON.stringify(v);
      if (lastJson.get(id) === js) continue;
      ops[name + '/' + ek(k)] = nz(wrap(JSON.parse(js)));
      marks.push([id, js]);
    }
  };
  sync('users', db.users, (v) => v);
  sync('reads', db.reads, (v) => {
    const o = {};
    for (const [p, t] of Object.entries(v)) o[ek(p)] = t;
    return o;
  });
  sync('subs', db.subs, (v) => v);
  const dels = [];
  for (const [name, obj] of [['users', db.users], ['reads', db.reads], ['subs', db.subs]]) {
    for (const id of lastJson.keys()) {
      if (!id.startsWith(name + '/')) continue;
      const k = id.slice(name.length + 1);
      if (!(k in obj)) { ops[name + '/' + ek(k)] = null; dels.push(id); }
    }
  }
  const dm = delIds.messages.slice();
  const dc = delIds.calls.slice();
  dm.forEach((id) => { ops['messages/' + id] = null; });
  dc.forEach((id) => { ops['calls/' + id] = null; });
  const nm = db.messages.length;
  const nc = db.calls.length;
  db.messages.slice(savedMsg).forEach((m) => { ops['messages/' + m.id] = JSON.parse(JSON.stringify(m)); });
  db.calls.slice(savedCall).forEach((c) => { ops['calls/' + c.id] = JSON.parse(JSON.stringify(c)); });
  const entries = Object.entries(ops);
  for (let i = 0; i < entries.length; i += 300) {
    await rtdb.ref().update(Object.fromEntries(entries.slice(i, i + 300)));
  }
  marks.forEach(([id, js]) => lastJson.set(id, js));
  dels.forEach((id) => lastJson.delete(id));
  delIds.messages.splice(0, dm.length);
  delIds.calls.splice(0, dc.length);
  savedMsg = nm;
  savedCall = nc;
}

function flushFile() {
  return new Promise((resolve, reject) => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), (e) => {
      if (e) return reject(e);
      fs.rename(tmp, DATA_FILE, (e2) => (e2 ? reject(e2) : resolve()));
    });
  });
}

let saveTimer = null;
let running = false;
let again = false;
async function runSave() {
  if (running) { again = true; return; }
  running = true;
  let delay = 300;
  try {
    await (rtdb ? flushRtdb() : flushFile());
  } catch (e) {
    console.error('Gagal menyimpan: ' + e.message);
    again = true;
    delay = 5000;
  }
  running = false;
  if (again) { again = false; setTimeout(runSave, delay); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function idle() { while (running) await sleep(30); }
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(runSave, 300);
}
process.on('SIGTERM', async () => {
  clearTimeout(saveTimer);
  try { await (rtdb ? flushRtdb() : flushFile()); } catch (_) {}
  process.exit(0);
});

// ---------- Util ----------
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sign = (email) => jwt.sign({ email }, JWT_SECRET, { expiresIn: '30d' });
const pub = (u) => ({ email: u.email, name: u.name, picture: u.picture || '', about: u.about || 'Halo, saya memakai Chat', ready: Boolean(u.ready) });

function upsert(email, info = {}) {
  const u = db.users[email] || { email, name: email.split('@')[0], picture: '', created: Date.now() };
  if (info.name && !u.custom) u.name = info.name;
  if (info.picture && !u.custom) u.picture = info.picture;
  db.users[email] = u;
  save();
  return u;
}

function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').slice(7);
    const { email } = jwt.verify(token, JWT_SECRET);
    if (!db.users[email] || db.users[email].banned) throw new Error('unknown');
    req.email = email;
    next();
  } catch (_) {
    res.status(401).json({ error: 'Sesi berakhir, silakan masuk lagi' });
  }
}


// ---------- Owner (panel admin) ----------
const ADMIN_USER = String(process.env.ADMIN_USERNAME || '').trim().toLowerCase();
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_HASH = String(process.env.ADMIN_PASSWORD_HASH || '').trim();
const adminOn = Boolean((ADMIN_USER || ADMIN_EMAIL) && ADMIN_HASH);
const ADMIN_SECRET = JWT_SECRET + ':owner';
function getCookie(req, name) {
  const hit = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
}
function isAdmin(req) {
  if (!adminOn) return false;
  try { return jwt.verify(getCookie(req, 'oa'), ADMIN_SECRET).adm === 1; } catch (_) { return false; }
}
function setAdminCookie(req, res) {
  const t = jwt.sign({ adm: 1 }, ADMIN_SECRET, { expiresIn: '12h' });
  res.append('Set-Cookie', 'oa=' + t + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200' + (req.secure ? '; Secure' : ''));
}
// Bukan owner: lanjut ke rute berikutnya sehingga hasilnya 404 biasa, seolah halaman tidak ada.
const adm = (req, res, next) => {
  if (!isAdmin(req)) return next('route');
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'X-Frame-Options': 'DENY' });
  next();
};

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '150kb' }));
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
if (process.env.TURN_URL) {
  iceServers.push({
    urls: process.env.TURN_URL.split(',').map((x) => x.trim()),
    username: process.env.TURN_USER || '',
    credential: process.env.TURN_PASS || '',
  });
}
app.get('/api/config', (_req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null, vapid: pushOn ? VAPID_PUBLIC_KEY : null, ice: iceServers });
});

const otps = new Map();
setInterval(() => {
  for (const [k, v] of otps) if (v.exp < Date.now()) otps.delete(k);
}, 60000).unref();

const pending = new Map();
const fails = new Map();

function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  const [s, h] = String(stored || '').split(':');
  if (!s || !h) return false;
  const a = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
  const b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function sendOtp(email) {
  const old = otps.get(email);
  if (old && Date.now() - old.sent < 30000) return { status: 429, error: 'Tunggu 30 detik sebelum meminta kode lagi' };
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  try {
    await mailer.sendMail({
      from: 'ShinPo Chat <' + GMAIL_USER + '>',
      to: email,
      subject: 'Kode verifikasi: ' + code,
      text: 'Kode verifikasi Anda adalah ' + code + '. Kode berlaku 5 menit. Jangan berikan kode ini kepada siapa pun.',
    });
  } catch (e) {
    console.error('Kirim OTP gagal: ' + e.message);
    return { status: 500, error: 'Email gagal dikirim. Periksa konfigurasi Gmail di server.' };
  }
  otps.set(email, { hash: sha(code), exp: Date.now() + 300000, sent: Date.now(), tries: 0 });
  return null;
}

app.post('/api/register', async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const name = String(b.name || '').trim().slice(0, 40);
  const password = String(b.password || '');
  if (!emailRe.test(email)) return res.status(400).json({ error: 'Email tidak valid' });
  if (!name) return res.status(400).json({ error: 'Nama tidak boleh kosong' });
  if (password.length < 8 || password.length > 100) return res.status(400).json({ error: 'Kata sandi minimal 8 karakter' });
  if (db.users[email] && db.users[email].pass) return res.status(409).json({ error: 'Email sudah terdaftar. Silakan masuk.' });
  const err = await sendOtp(email);
  if (err) return res.status(err.status).json({ error: err.error });
  pending.set(email, { name, pass: hashPw(password), exp: Date.now() + 3600000 });
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  let f = fails.get(email);
  if (!f || Date.now() - f.t > 600000) f = { n: 0, t: Date.now() };
  if (f.n >= 8) return res.status(429).json({ error: 'Terlalu banyak percobaan. Tunggu 10 menit atau masuk dengan kode email.' });
  if (adminOn) {
    const pwOk = checkPw(password.slice(0, 200), ADMIN_HASH);
    if (pwOk && email && (email === ADMIN_EMAIL || email === ADMIN_USER)) {
      fails.delete(email);
      setAdminCookie(req, res);
      return res.json({ redirect: '/panel' });
    }
  }
  const u = db.users[email];
  if (!u || !password || !checkPw(password, u.pass)) {
    f.n++;
    fails.set(email, f);
    return res.status(401).json({ error: 'Email atau kata sandi salah' });
  }
  fails.delete(email);
  if (u.banned) return res.status(403).json({ error: 'Akun ini dinonaktifkan' });
  res.json({ token: sign(email), user: pub(u) });
});

app.post('/api/otp/request', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!emailRe.test(email)) return res.status(400).json({ error: 'Email tidak valid' });
  const old = otps.get(email);
  if (old && Date.now() - old.sent < 30000) {
    return res.status(429).json({ error: 'Tunggu 30 detik sebelum meminta kode lagi' });
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  try {
    await mailer.sendMail({
      from: 'ShinPo Chat <' + GMAIL_USER + '>',
      to: email,
      subject: 'Kode masuk: ' + code,
      text: 'Kode masuk Anda adalah ' + code + '. Kode berlaku 5 menit. Jangan berikan kode ini kepada siapa pun.',
    });
  } catch (e) {
    console.error('Kirim OTP gagal: ' + e.message);
    return res.status(500).json({ error: 'Email gagal dikirim. Periksa konfigurasi Gmail di server.' });
  }
  otps.set(email, { hash: sha(code), exp: Date.now() + 300000, sent: Date.now(), tries: 0 });
  res.json({ ok: true });
});

app.post('/api/otp/verify', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const code = String((req.body && req.body.code) || '').trim();
  const rec = otps.get(email);
  if (!rec || rec.exp < Date.now()) return res.status(400).json({ error: 'Kode kedaluwarsa, minta kode baru' });
  if (rec.tries >= 5) {
    otps.delete(email);
    return res.status(429).json({ error: 'Terlalu banyak percobaan, minta kode baru' });
  }
  if (sha(code) !== rec.hash) {
    rec.tries++;
    return res.status(400).json({ error: 'Kode salah' });
  }
  otps.delete(email);
  if (db.users[email] && db.users[email].banned) return res.status(403).json({ error: 'Akun ini dinonaktifkan' });
  const user = upsert(email);
  const pend = pending.get(email);
  if (pend && pend.exp > Date.now()) {
    user.pass = pend.pass;
    user.name = pend.name;
    user.custom = true;
    pending.delete(email);
    save();
  }
  res.json({ token: sign(email), user: pub(user) });
});

app.post('/api/google', async (req, res) => {
  if (!googleClient) return res.status(503).json({ error: 'Login Google belum diatur di server' });
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: String((req.body && req.body.credential) || ''),
      audience: GOOGLE_CLIENT_ID,
    });
    const p = ticket.getPayload();
    if (!p.email || !p.email_verified) throw new Error('email belum terverifikasi');
    const email = p.email.toLowerCase();
    if (db.users[email] && db.users[email].banned) return res.status(403).json({ error: 'Akun ini dinonaktifkan' });
    const user = upsert(email, { name: p.name, picture: p.picture });
    user.ready = true;
    res.json({ token: sign(email), user: pub(user) });
  } catch (e) {
    console.error('Google login gagal: ' + e.message);
    res.status(401).json({ error: 'Login Google gagal' });
  }
});

app.get('/api/me', auth, (req, res) => res.json(pub(db.users[req.email])));

app.get('/api/users', auth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 3) return res.json([]);
  res.json(
    Object.values(db.users)
      .filter((u) => !u.banned && u.email !== req.email && (u.email.includes(q) || u.name.toLowerCase().includes(q)))
      .slice(0, 10)
      .map(pub)
  );
});

app.get('/api/chats', auth, (req, res) => {
  const me = req.email;
  const reads = db.reads[me] || {};
  const map = {};
  for (const m of db.messages) {
    if (m.from !== me && m.to !== me) continue;
    const p = m.from === me ? m.to : m.from;
    const c = map[p] || (map[p] = { last: m, unread: 0 });
    c.last = m;
    if (m.from === p && m.ts > (reads[p] || 0)) c.unread++;
  }
  res.json(
    Object.entries(map)
      .filter(([p]) => db.users[p])
      .map(([p, c]) => ({ user: pub(db.users[p]), last: c.last, unread: c.unread }))
      .sort((a, b) => b.last.ts - a.last.ts)
  );
});

app.get('/api/messages', auth, (req, res) => {
  const me = req.email;
  const other = String(req.query.with || '').toLowerCase();
  res.json(
    db.messages.filter((m) => (m.from === me && m.to === other) || (m.from === other && m.to === me)).slice(-200)
  );
});

app.post('/api/read', auth, (req, res) => {
  const other = String((req.body && req.body.with) || '').toLowerCase();
  (db.reads[req.email] = db.reads[req.email] || {})[other] = Date.now();
  save();
  res.json({ ok: true });
});

app.put('/api/profile', auth, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 40);
  const about = String((req.body && req.body.about) || '').trim().slice(0, 140);
  if (!name) return res.status(400).json({ error: 'Nama tidak boleh kosong' });
  const u = db.users[req.email];
  u.name = name;
  u.about = about;
  u.custom = true;
  u.ready = true;
  const pic = req.body && req.body.picture;
  if (typeof pic === 'string' && pic.startsWith('data:image/jpeg;base64,') && pic.length <= 100000) u.picture = pic;
  save();
  res.json(pub(u));
});

app.get('/api/calls', auth, (req, res) => {
  const me = req.email;
  res.json(
    db.calls
      .filter((c) => c.from === me || c.to === me)
      .slice(-100)
      .reverse()
      .map((c) => {
        const p = c.from === me ? c.to : c.from;
        return { ...c, user: db.users[p] ? pub(db.users[p]) : { email: p, name: p, picture: '' } };
      })
  );
});

function dropEndpoint(endpoint) {
  for (const k of Object.keys(db.subs)) db.subs[k] = db.subs[k].filter((s) => s.endpoint !== endpoint);
}

app.post('/api/push', auth, (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) return res.status(400).json({ error: 'Langganan tidak valid' });
  dropEndpoint(sub.endpoint);
  (db.subs[req.email] = db.subs[req.email] || []).push(sub);
  save();
  res.json({ ok: true });
});

app.post('/api/push/remove', auth, (req, res) => {
  dropEndpoint(String((req.body && req.body.endpoint) || ''));
  save();
  res.json({ ok: true });
});

// ---------- Rute owner ----------
app.get('/panel', adm, (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'panel.html')));

app.get('/api/adm/stats', adm, (_req, res) => {
  const online = new Set();
  for (const sk of io.sockets.sockets.values()) if (sk.email) online.add(sk.email);
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const users = Object.values(db.users);
  res.json({
    users: users.length,
    banned: users.filter((u) => u.banned).length,
    online: online.size,
    messages: db.messages.length,
    today: db.messages.filter((m) => m.ts >= day.getTime()).length,
    calls: db.calls.length,
  });
});

app.get('/api/adm/users', adm, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const sent = {};
  for (const m of db.messages) sent[m.from] = (sent[m.from] || 0) + 1;
  const online = new Set();
  for (const sk of io.sockets.sockets.values()) if (sk.email) online.add(sk.email);
  res.json(
    Object.values(db.users)
      .filter((u) => !q || u.email.includes(q) || String(u.name || '').toLowerCase().includes(q))
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .slice(0, 500)
      .map((u) => ({
        email: u.email,
        name: u.name,
        created: u.created || 0,
        banned: Boolean(u.banned),
        online: online.has(u.email),
        sent: sent[u.email] || 0,
      }))
  );
});

app.post('/api/adm/ban', adm, (req, res) => {
  const email = String((req.body && req.body.email) || '').toLowerCase();
  const u = db.users[email];
  if (!u) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
  u.banned = Boolean(req.body.banned);
  if (u.banned) io.in(email).disconnectSockets(true);
  save();
  res.json({ ok: true });
});

app.post('/api/adm/delete', adm, async (req, res) => {
  const email = String((req.body && req.body.email) || '').toLowerCase();
  if (!db.users[email]) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
  io.in(email).disconnectSockets(true);
  await idle();
  if (!db.users[email]) return res.json({ ok: true });
  delete db.users[email];
  delete db.reads[email];
  delete db.subs[email];
  for (const r of Object.values(db.reads)) delete r[email];
  const strip = (arr, saved, ids) => {
    let n = 0;
    const out = arr.filter((x, i) => {
      const hit = x.from === email || x.to === email;
      if (hit && i < saved) { n++; ids.push(x.id); }
      return !hit;
    });
    return [out, n];
  };
  const m = strip(db.messages, savedMsg, delIds.messages);
  db.messages = m[0];
  savedMsg -= m[1];
  const c = strip(db.calls, savedCall, delIds.calls);
  db.calls = c[0];
  savedCall -= c[1];
  pending.delete(email);
  otps.delete(email);
  fails.delete(email);
  save();
  res.json({ ok: true });
});

app.post('/api/adm/logout', adm, (_req, res) => {
  res.append('Set-Cookie', 'oa=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ---------- Real-time ----------
async function notify(to, msg) {
  if (db.users[to] && db.users[to].banned) return;
  const subs = db.subs[to] || [];
  if (!pushOn || !subs.length) return;
  const sender = db.users[msg.from];
  const payload = JSON.stringify({ title: sender.name, body: msg.text.slice(0, 120), from: msg.from });
  for (const s of subs.slice()) {
    try {
      await webpush.sendNotification(s, payload);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        dropEndpoint(s.endpoint);
        save();
      } else {
        console.error('Push gagal: ' + e.message);
      }
    }
  }
}

const active = new Map();

function notifyCall(to, call) {
  const text = call.status === 'missed' ? 'Panggilan tidak terjawab' : 'Panggilan ' + (call.video ? 'video' : 'suara') + ' masuk';
  notify(to, { from: call.from, text });
}

function finish(id, reason, by) {
  const a = active.get(id);
  if (!a) return;
  active.delete(id);
  clearTimeout(a.timer);
  const c = a.call;
  if (c.status === 'ringing') c.status = by === c.to ? 'declined' : 'missed';
  else c.duration = Math.round((Date.now() - c.answeredAt) / 1000);
  delete c.answeredAt;
  db.calls.push(c);
  save();
  io.to(c.from).to(c.to).emit('call:ended', { id, reason, status: c.status });
}

io.use((socket, next) => {
  try {
    const { email } = jwt.verify(String((socket.handshake.auth || {}).token || ''), JWT_SECRET);
    if (!db.users[email] || db.users[email].banned) throw new Error('unknown');
    socket.email = email;
    next();
  } catch (_) {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.join(socket.email);
  socket.on('send', (d, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const to = String((d && d.to) || '').toLowerCase();
    const text = String((d && d.text) || '').trim().slice(0, 2000);
    if (!text || to === socket.email || !db.users[to]) return reply({ ok: false, error: 'Pesan tidak valid' });
    const msg = { id: crypto.randomUUID(), from: socket.email, to, text, ts: Date.now() };
    db.messages.push(msg);
    save();
    const out = { ...msg, fromName: db.users[socket.email].name };
    io.to(to).emit('message', out);
    io.to(socket.email).emit('message', out);
    notify(to, msg);
    reply({ ok: true });
  });

  socket.on('call:start', (d, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const to = String((d && d.to) || '').toLowerCase();
    if (!db.users[to] || to === socket.email) return reply({ ok: false, error: 'Pengguna tidak valid' });
    for (const a of active.values()) {
      if ([a.call.from, a.call.to].some((x) => x === socket.email || x === to)) {
        return reply({ ok: false, error: 'Salah satu pihak sedang dalam panggilan' });
      }
    }
    const call = { id: crypto.randomUUID(), from: socket.email, to, video: Boolean(d.video), ts: Date.now(), status: 'ringing', duration: 0 };
    const room = io.sockets.adapter.rooms.get(to);
    if (!room || !room.size) {
      call.status = 'missed';
      db.calls.push(call);
      save();
      notifyCall(to, call);
      return reply({ ok: false, error: 'Pengguna sedang tidak online. Pemberitahuan panggilan tak terjawab sudah dikirim.' });
    }
    const timer = setTimeout(() => finish(call.id, 'timeout'), 45000);
    active.set(call.id, { call, timer });
    io.to(to).emit('call:incoming', { id: call.id, from: call.from, fromName: db.users[call.from].name, video: call.video });
    notifyCall(to, call);
    reply({ ok: true, id: call.id });
  });

  socket.on('call:accept', (d) => {
    const a = d && active.get(d.id);
    if (!a || a.call.to !== socket.email || a.call.status !== 'ringing') return;
    a.call.status = 'answered';
    a.call.answeredAt = Date.now();
    clearTimeout(a.timer);
    io.to(a.call.from).emit('call:accepted', { id: d.id });
  });

  socket.on('call:signal', (d) => {
    const a = d && active.get(d.id);
    if (!a || ![a.call.from, a.call.to].includes(socket.email)) return;
    const other = a.call.from === socket.email ? a.call.to : a.call.from;
    io.to(other).emit('call:signal', { id: d.id, data: d.data });
  });

  socket.on('call:end', (d) => {
    const a = d && active.get(d.id);
    if (a && [a.call.from, a.call.to].includes(socket.email)) finish(d.id, 'ended', socket.email);
  });

  socket.on('disconnect', () => {
    const room = io.sockets.adapter.rooms.get(socket.email);
    if (room && room.size) return;
    for (const [id, a] of active) {
      if ([a.call.from, a.call.to].includes(socket.email)) finish(id, 'disconnected', socket.email);
    }
  });
});

loadDb().then(
  () => server.listen(PORT, () => console.log('Server berjalan di port ' + PORT + (rtdb ? ' (Realtime Database)' : ' (file lokal)'))),
  (e) => {
    console.error('Gagal memuat data: ' + e.message);
    process.exit(1);
  }
);
