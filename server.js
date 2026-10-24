import express from 'express';
import { WebSocketServer } from 'ws';
import { createClient } from '@libsql/client';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
if (!TURSO_URL || !TURSO_TOKEN) { console.error('Нет TURSO_URL или TURSO_TOKEN'); process.exit(1); }
const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

const TTFBL_PER_RUB = 10, RUB_PER_TTFBL = 0.1;
const FIAT = { RUB: 1, USD: 90, TRY: 2.8, KZT: 0.2 };
const CUR = ['TTFBL', 'RUB', 'USD', 'TRY', 'KZT'];
const DEC = { RUB: 2, USD: 2, TRY: 2, KZT: 2, TTFBL: 0 };
const START_TTFBL = 3075;
const TX_FEE_PCT = 1;
const ADMIN_EMAIL = 'mar.maks999@gmail.com';
const ADMIN_PASS = '1495';
const NEWS_CHANNEL_ID = 'news_channel';

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
  // ВРЕМЕННЫЙ КОД: удаляем сломанную таблицу при запуске
  try { await db.execute('DROP TABLE IF EXISTS messages'); } catch(e) { console.log('drop messages:', e.message); }

  await db.batch([
    `CREATE TABLE IF NOT EXISTS users ...
    `CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, pwd TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', display_name TEXT, secret_word TEXT, last_bonus_date TEXT)`,
    `CREATE TABLE IF NOT EXISTS accounts (email TEXT NOT NULL, currency TEXT NOT NULL, num TEXT NOT NULL, bal INTEGER NOT NULL DEFAULT 0, vault_bal INTEGER DEFAULT 0, PRIMARY KEY (email, currency))`,
    `CREATE TABLE IF NOT EXISTS txs (id INTEGER PRIMARY KEY AUTOINCREMENT, from_email TEXT, to_email TEXT, cur TEXT NOT NULL, amt INTEGER NOT NULL, fee INTEGER NOT NULL DEFAULT 0, descr TEXT NOT NULL, date TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, from_email TEXT NOT NULL, to_email TEXT, text TEXT NOT NULL, date TEXT NOT NULL)`
  ]);

  try { await db.execute('ALTER TABLE users ADD COLUMN banned_until TEXT'); } catch(e) {}
  try { await db.execute('ALTER TABLE users ADD COLUMN display_name TEXT'); } catch(e) {}
  try { await db.execute('ALTER TABLE users ADD COLUMN secret_word TEXT'); } catch(e) {}
  try { await db.execute('ALTER TABLE users ADD COLUMN last_bonus_date TEXT'); } catch(e) {}
  try { await db.execute('ALTER TABLE accounts ADD COLUMN vault_bal INTEGER DEFAULT 0'); } catch(e) {}

  const admin = await db.execute({ sql: 'SELECT email FROM users WHERE email = ?', args: [ADMIN_EMAIL] });
  if (admin.rows.length === 0) {
    await createUser(ADMIN_EMAIL, ADMIN_PASS, 'hank', 'admin', 'hank', 'тсб');
  } else {
    await db.execute({ sql: "UPDATE users SET display_name = 'hank', secret_word = 'тсб' WHERE email = ?", args: [ADMIN_EMAIL] });
  }
}

async function createUser(email, pwd, name, role, display_name, secret_word) {
  await db.execute({
    sql: 'INSERT INTO users (email, pwd, name, role, display_name, secret_word, last_bonus_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [email, pwd, name, role, display_name, secret_word, new Date().toISOString()],
  });
  for (const c of CUR) {
    const start = (c === 'TTFBL') ? toMinor(START_TTFBL, 'TTFBL') : 0;
    await db.execute({
      sql: 'INSERT INTO accounts (email, currency, num, bal, vault_bal) VALUES (?, ?, ?, ?, 0)',
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
  for (const a of accs.rows) accounts[a.currency] = { num: a.num, bal: Number(a.bal), vault_bal: Number(a.vault_bal || 0) };
  return { email: u.email, name: u.name, display_name: u.display_name || u.name, role: u.role, banned_until: u.banned_until, accounts, has_secret: !!u.secret_word };
}

async function checkBonuses() {
  const users = await db.execute('SELECT email, last_bonus_date FROM users');
  const now = new Date();
  for (const user of users.rows) {
    const lastDate = new Date(user.last_bonus_date || 0);
    const diffDays = (now - lastDate) / (1000 * 60 * 60 * 24);
    if (diffDays >= 14) {
      await db.execute({ sql: 'UPDATE accounts SET bal = bal + ? WHERE email = ? AND currency = ?', args: [100, user.email, 'TTFBL'] });
      await db.execute({ sql: 'UPDATE users SET last_bonus_date = ? WHERE email = ?', args: [now.toISOString(), user.email] });
      await db.execute({ sql: 'INSERT INTO txs (from_email, to_email, cur, amt, fee, descr, date) VALUES (NULL, ?, ?, ?, 0, ?, ?)', args: [user.email, 'TTFBL', 100, 'Бонус: 100 TTFBL (раз в 2 недели)', now.toLocaleString('ru-RU')] });
    }
  }
}
setInterval(checkBonuses, 1000 * 60 * 60); 

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Set();

async function broadcastUsers() {
  const users = await db.execute('SELECT email, display_name, name FROM users');
  const onlineEmails = Array.from(clients).filter(c => c.userEmail).map(c => c.userEmail);
  
  const list = users.rows.map(r => ({ 
    email: r.email, 
    name: r.display_name || r.name,
    online: onlineEmails.includes(r.email)
  })).sort((a,b) => a.name.localeCompare(b.name));
  
  const data = JSON.stringify({ type: 'users_list', users: list });
  for (const c of clients) if (c.readyState === 1) c.send(data);
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.userEmail = null;
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return ws.send(JSON.stringify({ type: 'error', message: 'bad json' })); }
    try { await handle(ws, msg); } catch (e) { console.error(e); ws.send(JSON.stringify({ type: 'error', message: e.message || 'ошибка' })); }
  });
  ws.on('close', () => { clients.delete(ws); broadcastUsers(); });
});

async function pushStateTo(ws, email) {
  const u = await getUser(email);
  if (u) ws.send(JSON.stringify({ type: 'state', user: u, accounts: u.accounts }));
  return u;
}

async function handle(ws, msg) {
  if (msg.type === 'register') {
    const { email, pwd, name, secret } = msg;
    if (!email || email.indexOf('@') < 0) return ws.send(JSON.stringify({ type: 'error', message: 'Некорректный email' }));
    if (!pwd || pwd.length < 6) return ws.send(JSON.stringify({ type: 'error', message: 'Пароль мин. 6' }));
    if (!name || name.length < 2) return ws.send(JSON.stringify({ type: 'error', message: 'Введи имя' }));
    if (!secret || secret.length < 2) return ws.send(JSON.stringify({ type: 'error', message: 'Секретное слово мин. 2' }));
    if (await getUser(email)) return ws.send(JSON.stringify({ type: 'error', message: 'Email уже занят' }));
    await createUser(email.toLowerCase(), pwd, name, 'user', name, secret);
    ws.userEmail = email.toLowerCase();
    broadcastUsers();
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
    broadcastUsers();
    return pushStateTo(ws, ws.userEmail);
  }

  if (!ws.userEmail) return ws.send(JSON.stringify({ type: 'error', message: 'Не залогинен' }));
  const me = await getUser(ws.userEmail);
  if (!me) return ws.send(JSON.stringify({ type: 'error', message: 'Пользователь не найден' }));

  if (msg.type === 'refresh') return pushStateTo(ws, ws.userEmail);
  if (msg.type === 'get_users') return broadcastUsers();

  if (msg.type === 'logout') {
    ws.userEmail = null;
    broadcastUsers();
    return ws.send(JSON.stringify({ type: 'loggedout' }));
  }

  if (['convert','transfer','vault_deposit','vault_withdraw','send_msg'].includes(msg.type)) {
    if (me.banned_until && new Date(me.banned_until) > new Date()) {
      return ws.send(JSON.stringify({ type: 'error', message: 'Вы забанены до ' + new Date(me.banned_until).toLocaleString('ru-RU') }));
    }
  }

  if (msg.type === 'get_chat') {
    const { chat_id } = msg;
    const r = await db.execute({ sql: 'SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC LIMIT 100', args: [chat_id] });
    return ws.send(JSON.stringify({ type: 'chat_history', chat_id, messages: r.rows }));
  }

  if (msg.type === 'send_msg') {
    const { chat_id, to_email, text } = msg;
    if (!text || text.trim() === '') return;
    
    if (chat_id === NEWS_CHANNEL_ID && me.email !== ADMIN_EMAIL) {
      return ws.send(JSON.stringify({ type: 'error', message: 'Писать в канал может только владелец' }));
    }

    const now = new Date().toISOString();
    await db.execute({
      sql: 'INSERT INTO messages (chat_id, from_email, to_email, text, date) VALUES (?, ?, ?, ?, ?)',
      args: [chat_id, me.email, to_email || null, text.trim(), now]
    });

    const data = JSON.stringify({ type: 'new_message', chat_id, from_email: me.email, to_email: to_email || null, text: text.trim(), date: now, from_name: me.display_name });
    
    for (const c of clients) {
      if (c.readyState === 1) {
        if (chat_id === NEWS_CHANNEL_ID) c.send(data);
        else if (c.userEmail === me.email || c.userEmail === to_email) c.send(data);
      }
    }
    return;
  }

  if (msg.type === 'vault_deposit') {
    const { amt } = msg;
    const m = toMinor(amt, 'TTFBL');
    if (m <= 0) return ws.send(JSON.stringify({ type: 'error', message: 'Сумма > 0' }));
    if (me.accounts.TTFBL.bal < m) return ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно TTFBL' }));
    await db.execute({ sql: 'UPDATE accounts SET bal = bal - ? WHERE email = ? AND currency = ?', args: [m, me.email, 'TTFBL'] });
    await db.execute({ sql: 'UPDATE accounts SET vault_bal = vault_bal + ? WHERE email = ? AND currency = ?', args: [m, me.email, 'TTFBL'] });
    await pushStateTo(ws, ws.userEmail);
    return;
  }

  if (msg.type === 'vault_withdraw') {
    const { amt } = msg;
    const m = toMinor(amt, 'TTFBL');
    if (m <= 0) return ws.send(JSON.stringify({ type: 'error', message: 'Сумма > 0' }));
    if (me.accounts.TTFBL.vault_bal < m) return ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно на вкладе' }));
    await db.execute({ sql: 'UPDATE accounts SET bal = bal + ? WHERE email = ? AND currency = ?', args: [m, me.email, 'TTFBL'] });
    await db.execute({ sql: 'UPDATE accounts SET vault_bal = vault_bal - ? WHERE email = ? AND currency = ?', args: [m, me.email, 'TTFBL'] });
    await pushStateTo(ws, ws.userEmail);
    return;
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
    await db.execute({ sql: 'INSERT INTO txs (from_email, to_email, cur, amt, fee, descr, date) VALUES (?, ?, ?, ?, 0, ?, ?)', args: [null, null, `${from}→${to}`, m, `Конвертация ${from} → ${to}`, new Date().toLocaleString('ru-RU')] });
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
    await db.execute({ sql: 'INSERT INTO txs (from_email, to_email, cur, amt, fee, descr, date) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [me.email, target.email, cur, m, fee, 'Перевод', new Date().toLocaleString('ru-RU')] });
    await pushStateTo(ws, ws.userEmail);
    ws.send(JSON.stringify({ type: 'toast', message: `Переведено ${m} ${cur} → ${target.email}` }));
    
    for (const c of clients) {
      if (c.userEmail === target.email && c.readyState === 1) {
        pushStateTo(c, target.email);
        c.send(JSON.stringify({ type: 'toast', message: `Получено ${m} ${cur} от ${me.display_name}` }));
      }
    }
    return;
  }

  if (msg.type === 'history') {
    const r = await db.execute({ sql: `SELECT * FROM txs WHERE from_email = ? OR to_email = ? OR (from_email IS NULL AND to_email IS NULL) ORDER BY id DESC LIMIT 200`, args: [me.email, me.email] });
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
      await db.execute({ sql: 'INSERT INTO txs (from_email, to_email, cur, amt, fee, descr, date) VALUES (NULL, ?, ?, ?, 0, ?, ?)', args: [target.email, cur, m, 'Админ: начисление', new Date().toLocaleString('ru-RU')] });
    } else {
      if (target.accounts[cur].bal < m) return ws.send(JSON.stringify({ type: 'error', message: 'У пользователя недостаточно' }));
      await db.execute({ sql: 'UPDATE accounts SET bal = bal - ? WHERE email = ? AND currency = ?', args: [m, target.email, cur] });
      await db.execute({ sql: 'INSERT INTO txs (from_email, to_email, cur, amt, fee, descr, date) VALUES (?, NULL, ?, ?, 0, ?, ?)', args: [target.email, cur, m, 'Админ: списание', new Date().toLocaleString('ru-RU')] });
    }
    await pushStateTo(ws, ws.userEmail);
    for (const c of clients) if (c.userEmail === target.email) pushStateTo(c, target.email);
    return;
  }

  if (msg.type === 'admin_ban') {
    if (me.role !== 'admin') return;
    const { targetEmail, hours } = msg;
    let banned_until = null;
    if (hours > 0) {
      const d = new Date();
      d.setHours(d.getHours() + hours);
      banned_until = d.toISOString();
    }
    await db.execute({ sql: 'UPDATE users SET banned_until = ? WHERE email = ?', args: [banned_until, targetEmail] });
    for (const c of clients) if (c.userEmail === targetEmail) pushStateTo(c, targetEmail);
  }

  if (msg.type === 'admin_role') {
    if (me.role !== 'admin') return ws.send(JSON.stringify({ type: 'error', message: 'Только админ' }));
    const { targetEmail, role } = msg;
    if (role !== 'admin' && role !== 'user') return ws.send(JSON.stringify({ type: 'error', message: 'Роль не та' }));
    await db.execute({ sql: 'UPDATE users SET role = ? WHERE email = ?', args: [role, targetEmail] });
    await pushStateTo(ws, ws.userEmail);
  }

  if (msg.type === 'admin_allusers') {
    if (me.role !== 'admin') return ws.send(JSON.stringify({ type: 'error', message: 'Только админ' }));
    const users = await db.execute('SELECT email, name, display_name, role, banned_until FROM users');
    const result = [];
    for (const row of users.rows) {
      const accs = await db.execute({ sql: 'SELECT * FROM accounts WHERE email = ?', args: [row.email] });
      const accounts = {};
      for (const a of accs.rows) accounts[a.currency] = { num: a.num, bal: Number(a.bal), vault_bal: Number(a.vault_bal || 0) };
      result.push({ email: row.email, name: row.display_name || row.name, role: row.role, banned_until: row.banned_until, accounts });
    }
    return ws.send(JSON.stringify({ type: 'admin_allusers', users: result }));
  }
}

setInterval(async () => { try { await db.execute('SELECT 1'); } catch (e) {} }, 4 * 60 * 1000);

const PORT = process.env.PORT || 3000;
initSchema().then(() => server.listen(PORT, () => console.log(`BANK OF BOBOR на :${PORT}`))).catch(e => { console.error(e); process.exit(1); });

