import express from 'express';
import { WebSocketServer } from 'ws';
import { createClient } from '@libsql/client';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import webpush from 'web-push';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
if (!TURSO_URL || !TURSO_TOKEN) { console.error('Нет TURSO_URL или TURSO_TOKEN'); process.exit(1); }
const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:mar.maks999@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const TTFBL_PER_RUB = 10, RUB_PER_TTFBL = 0.1;
const FIAT = { RUB: 1, USD: 90, TRY: 2.8, KZT: 0.2 };
const CUR = ['TTFBL', 'RUB', 'USD', 'TRY', 'KZT'];
const DEC = { RUB: 2, USD: 2, TRY: 2, KZT: 2, TTFBL: 0 };
const START_TTFBL = 3075;
const TX_FEE_PCT = 1;
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
    `CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, pwd TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', display_name TEXT, secret_word TEXT, last_bonus_date TEXT, last_vault_date TEXT, avatar TEXT, ai_sub_until TEXT, ai_sub_bought_at TEXT, ai_free_left INTEGER DEFAULT 20)`,
    `CREATE TABLE IF NOT EXISTS accounts (email TEXT NOT NULL, currency TEXT NOT NULL, num TEXT NOT NULL, bal INTEGER NOT NULL DEFAULT 0, vault_bal INTEGER DEFAULT 0, PRIMARY KEY (email, currency))`,
    `CREATE TABLE IF NOT EXISTS txs (id INTEGER PRIMARY KEY AUTOINCREMENT, from_email TEXT, to_email TEXT, cur TEXT NOT NULL, amt INTEGER NOT NULL, fee INTEGER NOT NULL DEFAULT 0, descr TEXT NOT NULL, date TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS push_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
  ]);

  try { await db.execute('ALTER TABLE users ADD COLUMN banned_until TEXT'); } catch(e) {}
  try { await db.execute('ALTER TABLE users ADD COLUMN display_name TEXT'); } catch(e) {}
  try { await db.execute('ALTER TABLE users ADD COLUMN secret_word TEXT'); } catch(e) {}
  try { await db.execute('ALTER TABLE users ADD COLUMN last_bonus_date TEXT'); } catch(e) {}
  try { await db.execute('ALTER TABLE users ADD COLUMN last_vault_date TEXT'); } catch(e) {}
  try { await db.execute('ALTER TABLE users ADD COLUMN avatar TEXT'); } catch(e) {}
  try { await db.execute('ALTER TABLE users ADD COLUMN ai_sub_until TEXT'); } catch(e) {}
  try { await db.execute('ALTER TABLE users ADD COLUMN ai_sub_bought_at TEXT'); } catch(e) {}
  try { await db.execute('ALTER TABLE users ADD COLUMN ai_free_left INTEGER DEFAULT 20'); } catch(e) {}
  try { await db.execute('ALTER TABLE accounts ADD COLUMN vault_bal INTEGER DEFAULT 0'); } catch(e) {}

  try {
    const check = await db.execute({ sql: 'SELECT email FROM users WHERE email = ?', args: [ADMIN_EMAIL] });
    if (check.rows.length === 0) {
      await db.execute({
        sql: 'INSERT INTO users (email, pwd, name, role, display_name, secret_word) VALUES (?, ?, ?, ?, ?, ?)',
        args: [ADMIN_EMAIL, ADMIN_PASS, 'hank', 'admin', 'hank', 'тсб']
      });
      for (const c of CUR) {
        const start = (c === 'TTFBL') ? toMinor(50000, 'TTFBL') : 0;
        await db.execute({
          sql: 'INSERT INTO accounts (email, currency, num, bal, vault_bal) VALUES (?, ?, ?, ?, 0)',
          args: [ADMIN_EMAIL, c, genNum(), start]
        });
      }
    } else {
      await db.execute({ sql: "UPDATE users SET pwd = ?, secret_word = ?, role = 'admin' WHERE email = ?", args: [ADMIN_PASS, 'тсб', ADMIN_EMAIL] });
    }
  } catch(e) {}
}

async function createUser(email, pwd, name, role, display_name, secret_word) {
  const now = new Date().toISOString();
  await db.execute({
    sql: 'INSERT INTO users (email, pwd, name, role, display_name, secret_word, last_bonus_date, last_vault_date, ai_free_left) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 20)',
    args: [email, pwd, name, role, display_name, secret_word, now, now],
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
  return { email: u.email, name: u.name, display_name: u.display_name || u.name, role: u.role, banned_until: u.banned_until, accounts, has_secret: !!u.secret_word, pwd: u.pwd, secret: u.secret_word, avatar: u.avatar, ai_sub_until: u.ai_sub_until, ai_sub_bought_at: u.ai_sub_bought_at, ai_free_left: u.ai_free_left };
}

const clients = new Set();

function notifyUser(email, text) {
  for (const c of clients) {
    if (c.userEmail === email && c.readyState === 1) {
      c.send(JSON.stringify({ type: 'notify', text: text }));
    }
  }
}

async function sendPushToUser(email, title, body) {
  try {
    const result = await db.execute({
      sql: 'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE email = ?',
      args: [email]
    });
    const subscriptions = result.rows;
    if (subscriptions.length === 0) return;
    const payload = JSON.stringify({ title, body });

    for (const sub of subscriptions) {
      const pushSubscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
      try {
        await webpush.sendNotification(pushSubscription, payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await db.execute({ sql: 'DELETE FROM push_subscriptions WHERE endpoint = ?', args: [sub.endpoint] });
        }
      }
    }
  } catch (err) { console.error('sendPushToUser error:', err); }
}

async function checkBonusesAndVaults() {
  const users = await db.execute('SELECT email, last_bonus_date, last_vault_date FROM users');
  const now = new Date();
  
  for (const user of users.rows) {
    const lastBonusDate = new Date(user.last_bonus_date || 0);
    if ((now - lastBonusDate) / (1000 * 60 * 60 * 24) >= 21) {
      await db.execute({ sql: 'UPDATE accounts SET bal = bal + ? WHERE email = ? AND currency = ?', args: [100, user.email, 'TTFBL'] });
      await db.execute({ sql: 'UPDATE users SET last_bonus_date = ? WHERE email = ?', args: [now.toISOString(), user.email] });
      await db.execute({ sql: 'INSERT INTO txs (from_email, to_email, cur, amt, fee, descr, date) VALUES (NULL, ?, ?, ?, 0, ?, ?)', args: [user.email, 'TTFBL', 100, 'Бонус: 100 TTFBL (раз в 3 недели)', now.toLocaleString('ru-RU')] });
      notifyUser(user.email, '🎁 Вам начислен бонус: 100 TTFBL (раз в 3 недели)!');
      sendPushToUser(user.email, '🎁 Бонус!', 'Вам начислен бонус: 100 TTFBL!');
    }

    const lastVaultDate = new Date(user.last_vault_date || 0);
    if ((now - lastVaultDate) / (1000 * 60 * 60 * 24) >= 7) {
      const vaultAcc = await db.execute({ sql: 'SELECT vault_bal FROM accounts WHERE email = ? AND currency = ?', args: [user.email, 'TTFBL'] });
      const vaultBal = Number(vaultAcc.rows[0]?.vault_bal || 0);
      
      if (vaultBal > 0) {
        const interest = 5;
        await db.execute({ sql: 'UPDATE accounts SET vault_bal = vault_bal + ? WHERE email = ? AND currency = ?', args: [interest, user.email, 'TTFBL'] });
        await db.execute({ sql: 'INSERT INTO txs (from_email, to_email, cur, amt, fee, descr, date) VALUES (NULL, ?, ?, ?, 0, ?, ?)', args: [user.email, 'TTFBL', interest, 'Начисление процентов на вклад', now.toLocaleString('ru-RU')] });
        notifyUser(user.email, `💸 Начислены проценты на вклад: ${interest} TTFBL!`);
        sendPushToUser(user.email, '💸 Проценты на вклад', `Вам начислено ${interest} TTFBL за вклад!`);
      }
      await db.execute({ sql: 'UPDATE users SET last_vault_date = ? WHERE email = ?', args: [now.toISOString(), user.email] });
    }
  }
}
setInterval(checkBonusesAndVaults, 1000 * 60 * 60); 

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.post('/api/push/subscribe', async (req, res) => {
  const { email, subscription } = req.body;
  if (!email || !subscription?.endpoint || !subscription?.keys) return res.status(400).json({ error: 'Invalid payload' });
  try {
    await db.execute({
      sql: `INSERT INTO push_subscriptions (email, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET email = excluded.email, p256dh = excluded.p256dh, auth = excluded.auth`,
      args: [email, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'DB error' }); }
});

// API для оплаты подписки из ИИ
app.post('/api/buy_sub', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, error: 'Email обязателен' });

  try {
    const user = await getUser(email);
    if (!user) return res.status(404).json({ success: false, error: 'Пользователь не найден' });

    const cost = 100;
    if (user.accounts.TTFBL.bal < cost) {
      return res.status(400).json({ success: false, error: 'Недостаточно TTFBL' });
    }

    await db.execute({ sql: 'UPDATE accounts SET bal = bal - ? WHERE email = ? AND currency = ?', args: [cost, user.email, 'TTFBL'] });
    await db.execute({ sql: 'INSERT INTO txs (from_email, to_email, cur, amt, fee, descr, date) VALUES (?, ?, ?, ?, 0, ?, ?)', args: [user.email, null, 'TTFBL', cost, 'Оплата подписки на ИИ (30 дней)', new Date().toLocaleString('ru-RU')] });

    const currentDate = await db.execute({ sql: 'SELECT ai_sub_until FROM users WHERE email = ?', args: [user.email] });
    let baseDate = new Date();
    const dbDate = currentDate.rows[0]?.ai_sub_until;
    if (dbDate && new Date(dbDate) > new Date()) baseDate = new Date(dbDate);
    baseDate.setDate(baseDate.getDate() + 30);
    const newUntil = baseDate.toISOString();

    await db.execute({ sql: 'UPDATE users SET ai_sub_until = ?, ai_sub_bought_at = ? WHERE email = ?', args: [newUntil, new Date().toISOString(), user.email] });

    res.json({ success: true, message: 'Подписка продлена на 30 дней' });
  } catch (err) {
    console.error('Ошибка API buy_sub:', err);
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

async function broadcastUsers() {
  const users = await db.execute('SELECT email, display_name, name, avatar FROM users');
  const onlineEmails = Array.from(clients).filter(c => c.userEmail).map(c => c.userEmail);
  const list = users.rows.map(r => ({ email: r.email, name: r.display_name || r.name, online: onlineEmails.includes(r.email), avatar: r.avatar })).sort((a,b) => a.name.localeCompare(b.name));
  const data = JSON.stringify({ type: 'users_list', users: list });
  for (const c of clients) if (c.readyState === 1) c.send(data);
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.userEmail = null;
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return ws.send(JSON.stringify({ type: 'error', message: 'bad json' })); }
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
    if (!auto) sendPushToUser(u.email, '🔐 Вход в аккаунт', 'Выполнен вход в ваш аккаунт с нового устройства.');
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

  if (['convert','transfer','vault_deposit','vault_withdraw'].includes(msg.type)) {
    if (me.banned_until && new Date(me.banned_until) > new Date()) {
      return ws.send(JSON.stringify({ type: 'error', message: 'Вы забанены до ' + new Date(me.banned_until).toLocaleString('ru-RU') }));
    }
  }

  // === ПОДПИСКА НА ИИ ===
  if (msg.type === 'buy_sub_ai') {
    const cost = 100;
    if (me.accounts.TTFBL.bal < cost) {
      return ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно TTFBL. Нужно 100.' }));
    }

    await db.execute({ sql: 'UPDATE accounts SET bal = bal - ? WHERE email = ? AND currency = ?', args: [cost, me.email, 'TTFBL'] });
    await db.execute({ sql: 'INSERT INTO txs (from_email, to_email, cur, amt, fee, descr, date) VALUES (?, ?, ?, ?, 0, ?, ?)', args: [me.email, null, 'TTFBL', cost, 'Оплата подписки на ИИ (30 дней)', new Date().toLocaleString('ru-RU')] });

    const currentDate = await db.execute({ sql: 'SELECT ai_sub_until FROM users WHERE email = ?', args: [me.email] });
    let baseDate = new Date();
    const dbDate = currentDate.rows[0]?.ai_sub_until;
    if (dbDate && new Date(dbDate) > new Date()) baseDate = new Date(dbDate);
    baseDate.setDate(baseDate.getDate() + 30);
    const newUntil = baseDate.toISOString();

    await db.execute({ sql: 'UPDATE users SET ai_sub_until = ?, ai_sub_bought_at = ? WHERE email = ?', args: [newUntil, new Date().toISOString(), me.email] });
    
    await pushStateTo(ws, ws.userEmail);
    return ws.send(JSON.stringify({ type: 'toast', message: '✅ Подписка на ИИ оплачена и активна 30 дней!' }));
  }

  if (msg.type === 'cancel_sub_ai') {
    const chk = await db.execute({ sql: 'SELECT ai_sub_bought_at FROM users WHERE email = ?', args: [me.email] });
    const boughtAt = chk.rows[0]?.ai_sub_bought_at;
    const canRefund = boughtAt && (new Date() - new Date(boughtAt)) < 10 * 60 * 1000; // 10 минут

    if (canRefund) {
      await db.execute({ sql: 'UPDATE accounts SET bal = bal + ? WHERE email = ? AND currency = ?', args: [100, me.email, 'TTFBL'] });
      await db.execute({ sql: 'INSERT INTO txs (from_email, to_email, cur, amt, fee, descr, date) VALUES (NULL, ?, ?, ?, 0, ?, ?)', args: [me.email, 'TTFBL', 100, 'Возврат за отмену подписки ИИ', new Date().toLocaleString('ru-RU')] });
      await db.execute({ sql: 'UPDATE users SET ai_sub_until = NULL, ai_sub_bought_at = NULL WHERE email = ?', args: [me.email] });
      await pushStateTo(ws, ws.userEmail);
      return ws.send(JSON.stringify({ type: 'toast', message: '✅ Подписка отменена. 100 TTFBL возвращены на баланс.' }));
    } else {
      await db.execute({ sql: 'UPDATE users SET ai_sub_until = NULL, ai_sub_bought_at = NULL WHERE email = ?', args: [me.email] });
      await pushStateTo(ws, ws.userEmail);
      return ws.send(JSON.stringify({ type: 'toast', message: '✅ Подписка отменена. Возврат недоступен (прошло больше 10 минут).' }));
    }
  }

  if (msg.type === 'change_pwd') {
    const { oldPwd, newPwd, secret } = msg;
    const chk = await db.execute({ sql: 'SELECT pwd, secret_word FROM users WHERE email = ?', args: [me.email] });
    if (chk.rows[0].pwd !== oldPwd) return ws.send(JSON.stringify({ type: 'error', message: 'Неверный старый пароль' }));
    if (chk.rows[0].secret_word !== secret) return ws.send(JSON.stringify({ type: 'error', message: 'Неверное секретное слово' }));
    if (newPwd.length < 6) return ws.send(JSON.stringify({ type: 'error', message: 'Новый пароль мин. 6' }));
    await db.execute({ sql: 'UPDATE users SET pwd = ? WHERE email = ?', args: [newPwd, me.email] });
    return ws.send(JSON.stringify({ type: 'toast', message: '✅ Пароль успешно изменен' }));
  }

  if (msg.type === 'change_secret') {
    const { pwd, newSecret, oldSecret } = msg;
    const chk = await db.execute({ sql: 'SELECT pwd, secret_word FROM users WHERE email = ?', args: [me.email] });
    if (chk.rows[0].pwd !== pwd) return ws.send(JSON.stringify({ type: 'error', message: 'Неверный пароль' }));
    if (chk.rows[0].secret_word !== oldSecret) return ws.send(JSON.stringify({ type: 'error', message: 'Неверное старое секретное слово' }));
    if (newSecret.length < 2) return ws.send(JSON.stringify({ type: 'error', message: 'Новый секрет мин. 2' }));
    await db.execute({ sql: 'UPDATE users SET secret_word = ? WHERE email = ?', args: [newSecret, me.email] });
    return ws.send(JSON.stringify({ type: 'toast', message: '✅ Секретное слово изменено' }));
  }

  if (msg.type === 'set_avatar') {
    const { avatar } = msg;
    await db.execute({ sql: 'UPDATE users SET avatar = ? WHERE email = ?', args: [avatar, me.email] });
    await pushStateTo(ws, me.email);
    broadcastUsers();
    return ws.send(JSON.stringify({ type: 'toast', message: '✅ Аватарка обновлена' }));
  }

  if (msg.type === 'vault_deposit') {
    const { amt } = msg;
    const m = toMinor(amt, 'TTFBL');
    if (m <= 0) return ws.send(JSON.stringify({ type: 'error', message: 'Сумма > 0' }));
    if (me.accounts.TTFBL.bal < m) return ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно TTFBL' }));
    
    await db.execute({ sql: 'UPDATE accounts SET bal = bal - ? WHERE email = ? AND currency = ?', args: [m, me.email, 'TTFBL'] });
    await db.execute({ sql: 'UPDATE accounts SET vault_bal = vault_bal + ? WHERE email = ? AND currency = ?', args: [m, me.email, 'TTFBL'] });
    await pushStateTo(ws, ws.userEmail);
    notifyUser(me.email, `✅ На вклад положено ${fromMinor(m, 'TTFBL')} TTFBL`);
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
    notifyUser(me.email, `✅ С вклада снято ${fromMinor(m, 'TTFBL')} TTFBL`);
    return;
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
    
    notifyUser(target.email, `💰 Вам перевели ${fromMinor(m, cur)} ${cur} от ${me.display_name}!`);
    sendPushToUser(target.email, '💸 Получен перевод', `Вам зачислено ${fromMinor(m, cur)} ${cur} от ${me.display_name}!`);

    await db.execute({ sql: 'INSERT INTO txs (from_email, to_email, cur, amt, fee, descr, date) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [me.email, target.email, cur, m, fee, 'Перевод', new Date().toLocaleString('ru-RU')] });
    await pushStateTo(ws, ws.userEmail);
    ws.send(JSON.stringify({ type: 'toast', message: `Переведено ${m} ${cur} → ${target.email}` }));
    
    for (const c of clients) if (c.userEmail === target.email && c.readyState === 1) pushStateTo(c, target.email);
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
    notifyUser(me.email, `🔄 Сконвертировано ${from} → ${res} ${to}`);
    return ws.send(JSON.stringify({ type: 'toast', message: `Сконвертировано ${from} → ${res} ${to}` }));
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
      notifyUser(target.email, `👑 Админ начислил вам ${fromMinor(m, cur)} ${cur}!`);
      sendPushToUser(target.email, '👑 Начисление', `Админ начислил вам ${fromMinor(m, cur)} ${cur}!`);
    } else {
      if (target.accounts[cur].bal < m) return ws.send(JSON.stringify({ type: 'error', message: 'У пользователя недостаточно' }));
      await db.execute({ sql: 'UPDATE accounts SET bal = bal - ? WHERE email = ? AND currency = ?', args: [m, target.email, cur] });
      await db.execute({ sql: 'INSERT INTO txs (from_email, to_email, cur, amt, fee, descr, date) VALUES (?, NULL, ?, ?, 0, ?, ?)', args: [target.email, cur, m, 'Админ: списание', new Date().toLocaleString('ru-RU')] });
      notifyUser(target.email, `⚠️ Админ списал у вас ${fromMinor(m, cur)} ${cur}.`);
      sendPushToUser(target.email, '⚠️ Списание', `Админ списал у вас ${fromMinor(m, cur)} ${cur}.`);
    }
    await pushStateTo(ws, ws.userEmail);
    for (const c of clients) if (c.userEmail === target.email) pushStateTo(c, target.email);
    return;
  }

  if (msg.type === 'admin_push_all') {
    if (me.role !== 'admin') return;
    const { text } = msg;
    console.log(`[PUSH] Админ ${me.email} начал рассылку: "${text}"`);
    
    try {
      const subs = await db.execute('SELECT email, endpoint, p256dh, auth FROM push_subscriptions');
      console.log(`[PUSH] Найдено подписок в базе: ${subs.rows.length}`);
      
      const payload = JSON.stringify({ title: '📢 Объявление от Банка', body: text });
      let successCount = 0;
      let errorCount = 0;

      for (const sub of subs.rows) {
        const pushSubscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
        try { 
          await webpush.sendNotification(pushSubscription, payload); 
          successCount++;
          console.log(`[PUSH] Успешно отправлено на ${sub.email}`);
        } catch (err) { 
          errorCount++;
          console.error(`[PUSH] Ошибка отправки на ${sub.email}: ${err.statusCode} - ${err.message}`);
          if (err.statusCode === 410 || err.statusCode === 404) {
            await db.execute({ sql: 'DELETE FROM push_subscriptions WHERE endpoint = ?', args: [sub.endpoint] });
            console.log(`[PUSH] Удалена устаревшая подписка ${sub.email}`);
          }
        }
      }
      console.log(`[PUSH] Итог: Успешно ${successCount}, Ошибок ${errorCount}`);

      const bannerData = JSON.stringify({ type: 'announcement', text: text });
      let bannerCount = 0;
      for (const c of clients) {
        if (c.readyState === 1) {
          c.send(bannerData);
          bannerCount++;
        }
      }
      console.log(`[BANNER] Отправлен баннер ${bannerCount} активным клиентам.`);

      return ws.send(JSON.stringify({ type: 'toast', message: `✅ Рассылка завершена. Успешно: ${successCount}, Ошибок: ${errorCount}` }));
    } catch (globalErr) {
      console.error('[PUSH] Критическая ошибка при рассылке:', globalErr);
      return ws.send(JSON.stringify({ type: 'error', message: 'Ошибка сервера при рассылке' }));
    }
  }

  if (msg.type === 'admin_ban') {
    if (me.role !== 'admin') return;
    const { targetEmail, minutes } = msg;
    let banned_until = null;
    if (minutes > 0) {
      const d = new Date(); d.setMinutes(d.getMinutes() + minutes);
      banned_until = d.toISOString();
      sendPushToUser(targetEmail, '🚫 Вы забанены!', `Админ ограничил ваш доступ на ${minutes} мин.`);
    } else {
      sendPushToUser(targetEmail, '✅ Вы разбанены!', 'Админ снял с вас ограничения.');
    }
    await db.execute({ sql: 'UPDATE users SET banned_until = ? WHERE email = ?', args: [banned_until, targetEmail] });
    for (const c of clients) if (c.userEmail === targetEmail) pushStateTo(c, targetEmail);
    return;
  }

  if (msg.type === 'admin_allusers') {
    if (me.role !== 'admin') return ws.send(JSON.stringify({ type: 'error', message: 'Только админ' }));
    const users = await db.execute('SELECT email, name, display_name, role, banned_until, pwd, secret_word, avatar FROM users');
    const result = [];
    for (const row of users.rows) {
      const accs = await db.execute({ sql: 'SELECT * FROM accounts WHERE email = ?', args: [row.email] });
      const accounts = {};
      for (const a of accs.rows) accounts[a.currency] = { num: a.num, bal: Number(a.bal), vault_bal: Number(a.vault_bal || 0) };
      result.push({ email: row.email, name: row.display_name || row.name, role: row.role, banned_until: row.banned_until, accounts, pwd: row.pwd, secret: row.secret_word, avatar: row.avatar });
    }
    return ws.send(JSON.stringify({ type: 'admin_allusers', users: result }));
  }
}

const PORT = process.env.PORT || 3000;
initSchema().then(() => {
  server.listen(PORT, () => console.log(`🏦 BANK OF BOBOR на :${PORT}`));
}).catch(e => { console.error(e); process.exit(1); });
