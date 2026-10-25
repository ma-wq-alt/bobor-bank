import express from 'express';
import { WebSocketServer } from 'ws';
import { createClient } from '@libsql/client';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
const db = (TURSO_URL && TURSO_TOKEN) ? createClient({ url: TURSO_URL, authToken: TURSO_TOKEN }) : null;

const TTFBL_PER_RUB = 10, RUB_PER_TTFBL = 0.1;
const FIAT = { RUB: 1, USD: 90, TRY: 2.8, KZT: 0.2 };
const CUR = ['TTFBL', 'RUB', 'USD', 'TRY', 'KZT'];
const DEC = { RUB: 2, USD: 2, TRY: 2, KZT: 2, TTFBL: 0 };
const ADMIN_EMAIL = 'mar.maks999@gmail.com';
const ADMIN_PASS = '1495';

function toMinor(v, c) { return Math.round(Number(v) * Math.pow(10, DEC[c])); }
function fromMinor(m, c) { return m / Math.pow(10, DEC[c]); }
function convertMinor(m, f, t) { 
  if (f === t) return m;
  const fr = f === 'TTFBL' ? RUB_PER_TTFBL : FIAT[f];
  const tr = t === 'TTFBL' ? RUB_PER_TTFBL : FIAT[t];
  return Math.floor((m / Math.pow(10, DEC[f])) * (fr / tr) * Math.pow(10, DEC[t])); 
}
function genNum() { return 'BOB' + Math.floor(1000000000 + Math.random() * 8999999999); }

async function initSchema() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, pwd TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', display_name TEXT, secret_word TEXT, last_bonus_date TEXT)`,
    `CREATE TABLE IF NOT EXISTS accounts (email TEXT NOT NULL, currency TEXT NOT NULL, num TEXT NOT NULL, bal INTEGER NOT NULL DEFAULT 0, vault_bal INTEGER DEFAULT 0, PRIMARY KEY (email, currency))`,
    `CREATE TABLE IF NOT EXISTS txs (id INTEGER PRIMARY KEY AUTOINCREMENT, from_email TEXT, to_email TEXT, cur TEXT NOT NULL, amt INTEGER NOT NULL, fee INTEGER NOT NULL DEFAULT 0, descr TEXT NOT NULL, date TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, from_email TEXT, from_name TEXT, text TEXT, image_url TEXT, date TEXT)`,
    `CREATE TABLE IF NOT EXISTS profiles (email TEXT PRIMARY KEY, avatar_url TEXT)`
  ]);
  try { await db.execute('ALTER TABLE users ADD COLUMN banned_until TEXT'); } catch(e) {}
  try { await db.execute('ALTER TABLE users ADD COLUMN display_name TEXT'); } catch(e) {}
  try { await db.execute('ALTER TABLE users ADD COLUMN secret_word TEXT'); } catch(e) {}
  try { await db.execute('ALTER TABLE accounts ADD COLUMN vault_bal INTEGER DEFAULT 0'); } catch(e) {}
  try { await db.execute('ALTER TABLE messages ADD COLUMN image_url TEXT'); } catch(e) {}

  const admin = await db.execute({ sql: 'SELECT email FROM users WHERE email = ?', args: [ADMIN_EMAIL] });
  if (admin.rows.length === 0) {
    await createUser(ADMIN_EMAIL, ADMIN_PASS, 'hank', 'admin', 'hank', 'тсб');
  }
}

async function createUser(email, pwd, name, role, display_name, secret_word) {
  await db.execute({ sql: 'INSERT INTO users (email, pwd, name, role, display_name, secret_word, last_bonus_date) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [email, pwd, name, role, display_name, secret_word, new Date().toISOString()] });
  for (const c of CUR) {
    const start = (c === 'TTFBL') ? toMinor(3075, 'TTFBL') : 0;
    await db.execute({ sql: 'INSERT INTO accounts (email, currency, num, bal, vault_bal) VALUES (?, ?, ?, ?, 0)', args: [email, c, genNum(), start] });
  }
}

async function getUser(email) {
  const r = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [String(email).toLowerCase()] });
  if (r.rows.length === 0) return null;
  const u = r.rows[0];
  const accs = await db.execute({ sql: 'SELECT * FROM accounts WHERE email = ?', args: [u.email] });
  const accounts = {};
  for (const a of accs.rows) accounts[a.currency] = { num: a.num, bal: Number(a.bal), vault_bal: Number(a.vault_bal || 0) };
  return { email: u.email, name: u.name, display_name: u.display_name || u.name, role: u.role, banned_until: u.banned_until, accounts };
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.userEmail = null;
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    try { await handle(ws, msg); } catch (e) { console.error(e); }
  });
  ws.on('close', () => clients.delete(ws));
});

async function pushStateTo(ws, email) {
  const u = await getUser(email);
  if (u) ws.send(JSON.stringify({ type: 'state', user: u, accounts: u.accounts }));
  return u;
}

async function handle(ws, msg) {
  if (msg.type === 'register') {
    const { email, pwd, name, secret } = msg;
    if (await getUser(email)) return ws.send(JSON.stringify({ type: 'error', message: 'Email уже занят' }));
    await createUser(email.toLowerCase(), pwd, name, 'user', name, secret);
    ws.userEmail = email.toLowerCase();
    return pushStateTo(ws, ws.userEmail);
  }

  if (msg.type === 'login') {
    const { email, pwd, secret, auto } = msg;
    const u = await getUser(email || '');
    if (!u) return ws.send(JSON.stringify({ type: 'error', message: 'Неверный email или пароль' }));
    
    const check = await db.execute({ sql: 'SELECT pwd, secret_word FROM users WHERE email = ?', args: [u.email] });
    const dbSecret = check.rows[0].secret_word;
    
    if (auto) {
      if (dbSecret !== secret) return ws.send(JSON.stringify({ type: 'error', message: 'Неверное секретное слово' }));
    } else {
      if (check.rows[0].pwd !== pwd) return ws.send(JSON.stringify({ type: 'error', message: 'Неверный пароль' }));
      if (!dbSecret) {
        if (!secret) return ws.send(JSON.stringify({ type: 'ask_secret' }));
        await db.execute({ sql: 'UPDATE users SET secret_word = ? WHERE email = ?', args: [secret, u.email] });
      } else {
        if (dbSecret !== secret) return ws.send(JSON.stringify({ type: 'error', message: 'Неверное секретное слово' }));
      }
    }
    ws.userEmail = u.email;
    return pushStateTo(ws, ws.userEmail);
  }

  if (!ws.userEmail) return;
  const me = await getUser(ws.userEmail);
  if (!me) return;

  if (msg.type === 'refresh') return pushStateTo(ws, ws.userEmail);

  // --- НОВАЯ КОМАНДА ДЛЯ ВКЛАДКИ "ИНФА" ---
  if (msg.type === 'admin_get_info') {
    if (me.role !== 'admin') return;
    const r = await db.execute('SELECT email, pwd, name, role, secret_word FROM users');
    return ws.send(JSON.stringify({ type: 'admin_info_list', users: r.rows }));
  }

  if (msg.type === 'logout') {
    ws.userEmail = null;
    return ws.send(JSON.stringify({ type: 'loggedout' }));
  }

  // ... ТУТ ОСТАЛЬНОЙ КОД (ПЕРЕВОДЫ, ВКЛАДЫ И Т.Д.) ОСТАЕТСЯ БЕЗ ИЗМЕНЕНИЙ ...
  // (Чтобы не спамить, я не дублирую остальные 200 строк, они у тебя уже есть и работают).
  // Просто добавь блок `admin_get_info` выше, внутри функции handle, после `if (!ws.userEmail)`.
}

setInterval(async () => { try { await db.execute('SELECT 1'); } catch (e) {} }, 4 * 60 * 1000);
const PORT = process.env.PORT || 3000;
initSchema().then(() => server.listen(PORT, () => console.log(`BANK на :${PORT}`)));
