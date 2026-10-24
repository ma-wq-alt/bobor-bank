import express from 'express';
import { WebSocketServer } from 'ws';
import { createClient } from '@libsql/client';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===== БАЗА (Turso) =====
const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('Нет TURSO_URL или TURSO_TOKEN в переменных окружения');
  process.exit(1);
}
const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ===== КОНСТАНТЫ БАНКА =====
const TTFBL_PER_RUB = 10;
const RUB_PER_TTFBL = 0.1;
const FIAT = { RUB: 1, USD: 90, TRY: 2.8, KZT: 0.2 };
const CUR = ['TTFBL', 'RUB', 'USD', 'TRY', 'KZT'];
const DEC = { RUB: 2, USD: 2, TRY: 2, KZT: 2, TTFBL: 0 };
const START_TTFBL = 3075;
const TX_FEE_PCT = 1;
const ADMIN_EMAIL = 'mar.maks999@gmail.com';
const ADMIN_PASS = '1495';

function toMinor(v, c) { return Math.round(Number(v) * Math.pow(10, DEC[c])); }
function fromMinor(m, c) { return m / Math.pow(10, DEC[c]); }
function rate(f, t) {
  if (f === t) return 1;
  const fr = f === 'TTFBL' ? RUB_PER_TTFBL : FIAT[f];
  const tr = t === 'TTFBL' ? RUB_PER_TTFBL : FIAT[t];
  return fr / tr;
}
function convertMinor(m, f, t) {
  return Math.floor((m / Math.pow(10, DEC[f])) * rate(f, t) * Math.pow(10, DEC[t]));
}
function genNum() { return 'BOB' + Math.floor(1000000000 + Math.random() * 8999999999); }

// ===== СХЕМА =====
async function initSchema() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      pwd TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user'
    )`,
    `CREATE TABLE IF NOT EXISTS accounts (
      email TEXT NOT NULL,
      currency TEXT NOT NULL,
      num TEXT NOT NULL,
      bal INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (email, currency)
    )`,
    `CREATE TABLE IF NOT EXISTS txs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_email TEXT,
      to_email TEXT,
      cur TEXT NOT NULL,
      amt INTEGER NOT NULL,
      fee INTEGER NOT NULL DEFAULT 0,
      descr TEXT NOT NULL,
      date TEXT NOT NULL
    )`,
  ]);

  const admin = await db.execute({
    sql: 'SELECT email FROM users WHERE email = ?',
    args: [ADMIN_EMAIL],
  });
  if (admin.rows.length === 0) {
    await createUser(ADMIN_EMAIL, ADMIN_PASS, 'Mar Maks', 'admin');
    console.log('Создан админ:', ADMIN_EMAIL);
  }
}

async function createUser(email, pwd, name, role) {
  await db.execute({
    sql: 'INSERT INTO users (email, pwd, name, role) VALUES (?, ?, ?, ?)',
    args: [email, pwd, name, role],
  });
  for (const c of CUR) {
    const start = (c === 'TTFBL') ? toMinor(START_TTFBL, 'TTFBL') : 0;
    await db.execute({
      sql: 'INSERT INTO accounts (email, currency, num, bal) VALUES (?, ?, ?, ?)',
      args: [email, c, genNum(), start],
    });
  }
}

async function getUser(email) {
  const r = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [String(email).toLowerCase()] });
  if (r.rows.length === 0) return null;
  const u = r.rows[0];
  const accs = await db.execute({ sql: 'SELECT * FROM accounts WHERE email = ?', args: [u.email] });
  const accounts = {};
  for (const a of accs.rows) {
    accounts[a.currency] = { num: a.num, bal: Number(a.bal) };
  }
  return { email: u.email, name: u.name, role: u.role, accounts };
}

// ===== HTTP + WS =====
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.userEmail = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return ws.send(JSON.stringify({ type: 'error', message: 'bad json' })); }
    try { await handle(ws, msg); }
    catch (e) {
      console.error('handle error:', e);
      ws.send(JSON.stringify({ type: 'error', message: e.message || 'ошибка' }));
    }
  });

  ws.on('close', () => clients.delete(ws));
});

async function pushStateTo(ws, email) {
  const u = await getUser(email);
  if (u) ws.send(JSON.stringify({ type: 'state', user: u, accounts: u.accounts }));
  return u;
}
async function pushStateByEmail(email) {
  for (const c of clients) {
    if (c.userEmail === email && c.readyState === 1) {
      await pushStateTo(c, email);
    }
  }
}

async function handle(ws, msg) {
  if (msg.type === 'register') {
    const { email, pwd, name } = msg;
    if (!email || email.indexOf('@') < 0) return ws.send(JSON.stringify({ type: 'error', message: 'Некорректный email' }));
    if (!pwd || pwd.length < 6) return ws.send(JSON.stringify({ type: 'error', message: 'Пароль мин. 6' }));
    if (!name || name.length < 2) return ws.send(JSON.stringify({ type: 'error', message: 'Введи имя' }));
    const exists = await getUser(email);
    if (exists) return ws.send(JSON.stringify({ type: 'error', message: 'Email уже занят' }));
    await createUser(email.toLowerCase(), pwd, name, 'user');
    ws.userEmail = email.toLowerCase();
    return pushStateTo(ws, ws.userEmail);
  }

  if (msg.type === 'login') {
    const { email, pwd } = msg;
    const u = await getUser(email || '');
    if (!u) return ws.send(JSON.stringify({ type: 'error', message: 'Неверный email или пароль' }));
    const check = await db.execute({ sql: 'SELECT pwd FROM users WHERE email = ?', args: [u.email] });
    if (check.rows[0].pwd !== pwd) return ws.send(JSON.stringify({ type: 'error', message: 'Неверный email или пароль' }));
    ws.userEmail = u.email;
    return pushStateTo(ws, ws.userEmail);
  }

  if (!ws.userEmail) return ws.send(JSON.stringify({ type: 'error', message: 'Не залогинен' }));
  const me = await getUser(ws.userEmail);
  if (!me) return ws.send(JSON.stringify({ type: 'error', message: 'Пользователь не найден' }));

  if (msg.type === 'logout') {
    ws.userEmail = null;
    return ws.send(JSON.stringify({ type: 'loggedout' }));
  }

  if (msg.type === 'convert') {
    const { from, to, amt } = msg;
    if (!CUR.includes(from) || !CUR.includes(to)) return ws.send(JSON.stringify({ type: 'error', message: 'Валюта не та' }));
    if (from === to) return ws.send(JSON.stringify({ type: 'error', message: 'Выбери разные валюты' }));
    const v = Number(amt);
    if (!(v > 0)) return ws.send(JSON.stringify({ type: 'error', message: 'Сумма > 0' }));
    const m = toMinor(v, from);
    if (me.accounts[from].bal < m) return ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно' }));
    const res = convertMinor(m, from, to);
    if (res <= 0) return ws.send(JSON.stringify({ type: 'error', message: 'Сумма слишком мала' }));
    await db.execute({ sql: 'UPDATE accounts SET bal = bal - ? WHERE email = ? AND currency = ?', args: [m, me.email, from] });
    await db.execute({ sql: 'UPDATE accounts SET bal = bal + ? WHERE email = ? AND currency = ?', args: [res, me.email, to] });
    await db.execute({
      sql: 'INSERT INTO txs (from_email, to_email, cur, amt, fee, descr, date) VALUES (?, ?, ?, ?, 0, ?, ?)',
      args: [null, null, `${from}→${to}`, m, `Конвертация ${from} → ${to}`, new Date().toLocaleString('ru-RU')],
    });
    await pushStateTo(ws, ws.userEmail);
    return ws.send(JSON.stringify({ type: 'toast', message: `Сконвертировано ${from} → ${res} ${to}` }));
  }

  if (msg.type === 'transfer') {
    const { toEmail, cur, amt } = msg;
    if (!CUR.includes(cur)) return ws.send(JSON.stringify({ type: 'error', message: 'Валюта не та' }));
    const v = Number(amt);
    if (!(v > 0)) return ws.send(JSON.stringify({ type: 'error', message: 'Сумма > 0' }));
    const target = await getUser(toEmail || '');
    if (!target) return ws.send(JSON.stringify({ type: 'error', message: 'Получатель не найден' }));
    if (target.email === me.email) return ws.send(JSON.stringify({ type: 'error', message: 'Нельзя себе' }));
    const m = toMinor(v, cur);
    const fee = cur === 'TTFBL' ? 0 : Math.floor(m * TX_FEE_PCT / 100);
    if (me.accounts[cur].bal < m + fee) return ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно (с комиссией)' }));
    await db.execute({ sql: 'UPDATE accounts SET bal = bal - ? WHERE email = ? AND currency = ?', args: [m + fee, me.email, cur] });
    await db.execute({ sql: 'UPDATE accounts SET bal = bal + ? WHERE email = ? AND currency = ?', args: [m, target.email, cur] });
    await db.execute({
      sql: 'INSERT INTO txs (from_email, to_email, cur, amt, fee, descr, date) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [me.email, target.email, cur, m, fee, 'Перевод', new Date().toLocaleString('ru-RU')],
    });
    await pushStateTo(ws, ws.userEmail);
    ws.send(JSON.stringify({ type: 'toast', message: `Переведено ${m} ${cur} → ${target.email}` }));
    await pushStateByEmail(target.email);
    for (const c of clients) {
      if (c.userEmail === target.email && c.readyState === 1) {
        c.send(JSON.stringify({ type: 'toast', message: `Получено ${m} ${cur} от ${me.email}` }));
      }
    }
    return;
  }

  if (msg.type === 'history') {
    const r = await db.execute({
      sql: `SELECT * FROM txs WHERE from_email = ? OR to_email = ? OR (from_email IS NULL AND to_email IS NULL) ORDER BY id DESC LIMIT 200`,
      args: [me.email, me.email],
    });
    return ws.send(JSON.stringify({ type: 'history', txs: r.rows }));
  }

  if (msg.type === 'admin_mint' || msg.type === 'admin_burn') {
    if (me.role !== 'admin') return ws.send(JSON.stringify({ type: 'error', message: 'Только админ' }));
    const { targetEmail, cur, amt } = msg;
    if (!CUR.includes(cur)) return ws.send(JSON.stringify({ type: 'error', message: 'Валюта не та' }));
    const target = await getUser(targetEmail || '');
    if (!target) return ws.send(JSON.stringify({ type: 'error', message: 'Пользователь не найден' }));
    const v = Number(amt);
    if (!(v > 0)) return ws.send(JSON.stringify({ type: 'error', message: 'Сумма > 0' }));
    const m = toMinor(v, cur);
    if (msg.type === 'admin_mint') {
      await db.execute({ sql: 'UPDATE accounts SET bal = bal + ? WHERE email = ? AND currency = ?', args: [m, target.email, cur] });
      await db.execute({
        sql: 'INSERT INTO txs (from_email, to_email, cur, amt, fee, descr, date) VALUES (NULL, ?, ?, ?, 0, ?, ?)',
        args: [target.email, cur, m, 'Админ: начисление', new Date().toLocaleString('ru-RU')],
      });
    } else {
      if (target.accounts[cur].bal < m) return ws.send(JSON.stringify({ type: 'error', message: 'У пользователя недостаточно' }));
      await db.execute({ sql: 'UPDATE accounts SET bal = bal - ? WHERE email = ? AND currency = ?', args: [m, target.email, cur] });
      await db.execute({
        sql: 'INSERT INTO txs (from_email, to_email, cur, amt, fee, descr, date) VALUES (?, NULL, ?, ?, 0, ?, ?)',
        args: [target.email, cur, m, 'Админ: списание', new Date().toLocaleString('ru-RU')],
      });
    }
    await pushStateTo(ws, ws.userEmail);
    await pushStateByEmail(target.email);
    return;
  }

  if (msg.type === 'admin_role') {
    if (me.role !== 'admin') return ws.send(JSON.stringify({ type: 'error', message: 'Только админ' }));
    const { targetEmail, role } = msg;
    if (role !== 'admin' && role !== 'user') return ws.send(JSON.stringify({ type: 'error', message: 'Роль не та' }));
    await db.execute({ sql: 'UPDATE users SET role = ? WHERE email = ?', args: [role, targetEmail] });
    await pushStateTo(ws, ws.userEmail);
    await pushStateByEmail(targetEmail);
    return;
  }

  if (msg.type === 'admin_allusers') {
    if (me.role !== 'admin') return ws.send(JSON.stringify({ type: 'error', message: 'Только админ' }));
    const users = await db.execute('SELECT email, name, role FROM users');
    const result = [];
    for (const row of users.rows) {
      const accs = await db.execute({ sql: 'SELECT * FROM accounts WHERE email = ?', args: [row.email] });
      const accounts = {};
      for (const a of accs.rows) accounts[a.currency] = { num: a.num, bal: Number(a.bal) };
      result.push({ email: row.email, name: row.name, role: row.role, accounts });
    }
    return ws.send(JSON.stringify({ type: 'admin_allusers', users: result }));
  }
}

// keep-alive для Render
setInterval(async () => {
  try { await db.execute('SELECT 1'); } catch (e) {}
}, 4 * 60 * 1000);

const PORT = process.env.PORT || 3000;
initSchema().then(() => {
  server.listen(PORT, () => console.log(`BANK OF BOBOR на :${PORT}`));
}).catch(e => {
  console.error('Ошибка инициализации:', e);
  process.exit(1);
});
