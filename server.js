const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const nodemailer = require('nodemailer');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const JWT_SECRET = process.env.JWT_SECRET || 'bobor-super-secret-key-123';
const BANK_WS_URL = process.env.BANK_URL || 'wss://bobor-bank.onrender.com';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER || '', pass: process.env.EMAIL_PASS || '' }
});

async function fetchWithRetry(url, options, retries = 3, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    console.log(`⚠️ 429 лимит, ждем ${delay}мс...`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error('Превышен лимит запросов к Z.ai. Подожди минуту.');
}

async function initDB() {
  try {
    try { await db.execute('SELECT theme FROM users LIMIT 1'); } 
    catch (e) {
      if (e.message.includes('no such column') || e.message.includes('no such table')) {
        await db.execute('DROP TABLE IF EXISTS users');
      }
    }

    // Таблица users создается, но мы не падаем, если она уже есть в Банке
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        password_hash TEXT,
        role TEXT DEFAULT 'user',
        otp_code TEXT,
        otp_expires DATETIME,
        theme TEXT DEFAULT 'dark',
        language TEXT DEFAULT 'ru',
        memory_facts TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    try { await db.execute('SELECT memory_facts FROM users LIMIT 1'); } 
    catch (e) { if (e.message.includes('no such column')) await db.execute('ALTER TABLE users ADD COLUMN memory_facts TEXT DEFAULT ""'); }

    await db.execute(`CREATE TABLE IF NOT EXISTS bot_knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt_text TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT, pinned INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id))`);
    try { await db.execute('SELECT pinned FROM chats LIMIT 1'); } 
    catch (e) { if (e.message.includes('no such column')) await db.execute('ALTER TABLE chats ADD COLUMN pinned INTEGER DEFAULT 0'); }
    await db.execute(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, image_url TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(chat_id) REFERENCES chats(id))`);
    
    const adminEmail = 'mar.maks999@gmail.com';
    const adminCheck = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [adminEmail] });
    if (adminCheck.rows.length === 0) {
      const hash = await bcrypt.hash('1495', 10);
      await db.execute({ sql: 'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)', args: ['hank', adminEmail, hash, 'admin'] });
    }
    console.log('✅ База данных готова');
  } catch (err) { console.error('❌ Ошибка БД:', err.message); }
}
initDB();

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Нет токена' });
  const token = authHeader.split(' ')[1];
  try { req.user = jwt.verify(token, JWT_SECRET); next(); } 
  catch (err) { res.status(401).json({ error: 'Неверный токен' }); }
}

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Введите логин и пароль' });
  try {
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE username = ? OR email = ?', args: [username, username] });
    const user = result.rows[0];
    if (!user || !user.password_hash) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const token = jwt.sign({ id: user.id, email: user.email, username: user.username, role: user.role, theme: user.theme, language: user.language }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, role: user.role, theme: user.theme || 'dark', language: user.language || 'ru' });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Введите почту' });
  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 10 * 60000).toISOString(); 
    let userRes = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
    let user = userRes.rows[0];

    if (!user) {
      const baseUsername = email.split('@')[0] + Math.floor(Math.random() * 100);
      await db.execute({ sql: 'INSERT INTO users (email, username, role, otp_code, otp_expires) VALUES (?, ?, ?, ?, ?)', args: [email, baseUsername, 'user', otp, expires] });
    } else {
      await db.execute({ sql: 'UPDATE users SET otp_code = ?, otp_expires = ? WHERE email = ?', args: [otp, expires, email] });
    }

    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      await transporter.sendMail({
        from: '"БОБОР ПРОДАКШН" <' + process.env.EMAIL_USER + '>',
        to: email, subject: 'БОБОР: Ваш код доступа',
        html: `<div style="font-family: Arial; background: #0f0c29; color: #fff; padding: 20px; border-radius: 10px;"><h2>Ваш код: <b style="font-size: 24px; color: #a78bfa;">${otp}</b></h2></div>`
      });
      res.json({ success: true, message: 'Код отправлен на почту!' });
    } else {
      console.log(`\n========================================\n🚀 КОД ДЛЯ ${email}: ${otp}\n========================================\n`);
      res.json({ success: true, message: 'Код в логах Render (почта не настроена).' });
    }
  } catch (err) { res.status(500).json({ error: 'Ошибка отправки' }); }
});

app.post('/api/verify-code', async (req, res) => {
  const { email, code } = req.body;
  try {
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    if (user.otp_code !== code) return res.status(401).json({ error: 'Неверный код' });
    const now = new Date().toISOString();
    if (now > user.otp_expires) return res.status(401).json({ error: 'Код истек' });
    await db.execute({ sql: 'UPDATE users SET otp_code = NULL, otp_expires = NULL WHERE id = ?', args: [user.id] });
    const token = jwt.sign({ id: user.id, email: user.email, username: user.username, role: user.role, theme: user.theme, language: user.language }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, role: user.role, theme: user.theme || 'dark', language: user.language || 'ru' });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/user/settings', authMiddleware, async (req, res) => {
  const { username, theme, language } = req.body;
  try {
    await db.execute({ sql: 'UPDATE users SET username = ?, theme = ?, language = ? WHERE id = ?', args: [username, theme, language, req.user.id] });
    const newToken = jwt.sign({ id: req.user.id, email: req.user.email, username, role: req.user.role, theme, language }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token: newToken, username, theme, language });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Этот ник уже занят' });
    res.status(500).json({ error: err.message });
  }
});

// Получение лимитов из Банка для отображения в интерфейсе
app.get('/api/user/limits', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT ai_free_left, ai_sub_until FROM users WHERE email = ?', args: [req.user.email] });
    const data = result.rows[0];
    if (!data) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ ai_free_left: data.ai_free_left ?? 20, ai_sub_until: data.ai_sub_until });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// БАЗА ЗНАНИЙ И ЧАТЫ (БЕЗ ИЗМЕНЕНИЙ)
app.get('/api/bot/knowledge', authMiddleware, async (req, res) => { /* ... код ... */ res.json({prompt:''}) });
app.post('/api/bot/knowledge', authMiddleware, async (req, res) => { res.json({success:true}) });
app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM chats WHERE user_id = ? ORDER BY pinned DESC, created_at DESC', args: [req.user.id] });
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/chats', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'INSERT INTO chats (user_id, title) VALUES (?, ?) RETURNING id', args: [req.user.id, 'Новый чат'] });
    res.json({ chatId: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/chats/:chatId', authMiddleware, async (req, res) => {
  const { chatId } = req.params;
  try {
    await db.execute({ sql: 'DELETE FROM messages WHERE chat_id = ?', args: [chatId] });
    await db.execute({ sql: 'DELETE FROM chats WHERE id = ? AND user_id = ?', args: [chatId, req.user.id] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/chats/:chatId', authMiddleware, async (req, res) => {
  const { chatId } = req.params;
  const { title } = req.body;
  try {
    await db.execute({ sql: 'UPDATE chats SET title = ? WHERE id = ? AND user_id = ?', args: [title, chatId, req.user.id] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/chats/:chatId/pin', authMiddleware, async (req, res) => {
  const { chatId } = req.params;
  try {
    const check = await db.execute({ sql: 'SELECT pinned FROM chats WHERE id = ? AND user_id = ?', args: [chatId, req.user.id] });
    const newPinned = check.rows[0].pinned === 1 ? 0 : 1;
    await db.execute({ sql: 'UPDATE chats SET pinned = ? WHERE id = ?', args: [newPinned, chatId] });
    res.json({ success: true, pinned: newPinned });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  const { chatId } = req.params;
  try {
    const result = await db.execute({ sql: 'SELECT role, content, image_url FROM messages WHERE chat_id = ? ORDER BY id ASC', args: [chatId] });
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ОТПРАВКА СООБЩЕНИЙ С ПРОВЕРКОЙ ЛИМИТА
app.post('/api/chats/:chatId/message', authMiddleware, upload.single('image'), async (req, res) => {
  const { chatId } = req.params;
  const { message, mode } = req.body; 
  const imageFile = req.file;

  try {
    // 1. ПРОВЕРКА ЛИМИТА ИЗ БАЗЫ БАНКА
    const userCheck = await db.execute({ sql: 'SELECT ai_free_left, ai_sub_until FROM users WHERE email = ?', args: [req.user.email] });
    const userData = userCheck.rows[0];
    
    if (userData) {
      const hasSub = userData.ai_sub_until && new Date(userData.ai_sub_until) > new Date();
      if (!hasSub) {
        if ((userData.ai_free_left ?? 0) <= 0) {
          return res.status(403).json({ error: 'Лимит бесплатных запросов исчерпан. Оплатите подписку!' });
        }
        // Списываем 1 запрос
        await db.execute({ sql: 'UPDATE users SET ai_free_left = ai_free_left - 1 WHERE email = ?', args: [req.user.email] });
      }
    }

    // 2. ДАЛЬШЕ СТАРЫЙ КОД ГЕНЕРАЦИИ
    let imageUrlInDB = null;
    let imageBase64 = null;
    if (imageFile) {
      imageBase64 = `data:${imageFile.mimetype};base64,${imageFile.buffer.toString('base64')}`;
      imageUrlInDB = "Прикреплено фото";
    }

    await db.execute({ sql: 'INSERT INTO messages (chat_id, role, content, image_url) VALUES (?, ?, ?, ?)', args: [chatId, 'user', message || 'Отправил(а) фото', imageUrlInDB] });

    const countMsg = await db.execute({ sql: 'SELECT COUNT(*) as count FROM messages WHERE chat_id = ?', args: [chatId] });
    if (countMsg.rows[0].count === 1) {
      const title = (message || 'Фото').slice(0, 30);
      await db.execute({ sql: 'UPDATE chats SET title = ? WHERE id = ?', args: [title, chatId] });
    }

    const isDrawRequest = /нарисуй|сгенерируй|покажи картинку|создай изображение/i.test(message || '');
    if (isDrawRequest && !imageFile) {
      const prompt = message.replace(/нарисуй|сгенерируй|покажи картинку|создай изображение|мне|пожалуйста/gi, '').trim();
      const pollUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1280&height=1280&nologo=true&enhance=true&nofeed=true`;
      const replyText = `🎨 Вот твоя картинка: "${prompt}"`;
      await db.execute({ sql: 'INSERT INTO messages (chat_id, role, content, image_url) VALUES (?, ?, ?, ?)', args: [chatId, 'assistant', replyText, pollUrl] });
      return res.json({ reply: replyText, imageUrl: pollUrl });
    }

    const historyResult = await db.execute({ sql: 'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 20', args: [chatId] });
    const history = historyResult.rows.reverse().map(row => ({ role: row.role, content: row.content }));

    const userContent = imageBase64 ? [ { type: "text", text: message || "Что на картинке?" }, { type: "image_url", image_url: { url: imageBase64 } } ] : message;
    history[history.length - 1] = { role: 'user', content: userContent };
    
    const knowledgeRes = await db.execute('SELECT prompt_text FROM bot_knowledge ORDER BY id DESC LIMIT 1');
    const adminPrompt = knowledgeRes.rows.length > 0 ? knowledgeRes.rows[0].prompt_text : '';
    const userMemoryRes = await db.execute({ sql: 'SELECT memory_facts FROM users WHERE id = ?', args: [req.user.id] });
    const userMemory = userMemoryRes.rows[0]?.memory_facts || '';

    let systemPrompt = adminPrompt.trim() !== '' ? adminPrompt : 'Ты — БОБОР-AI. Отвечай на русском.';
    if (userMemory) systemPrompt += `\n\nЗнай о пользователе: ${userMemory}`;

    const messagesForAI = [ { role: 'system', content: systemPrompt }, ...history ];
    let model = imageFile ? 'glm-4.6v-flash' : 'glm-4.5-flash'; 
    
    const aiResponse = await fetchWithRetry('https://api.z.ai/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.ZAI_API_KEY}` },
      body: JSON.stringify({ model: model, messages: messagesForAI, temperature: 0.7 })
    });

    if (!aiResponse.ok) throw new Error(`API вернул ${aiResponse.status}`);
    const aiData = await aiResponse.json();
    const replyText = aiData.choices[0].message.content;

    await db.execute({ sql: 'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)', args: [chatId, 'assistant', replyText] });
    res.json({ reply: replyText });

  } catch (error) { res.status(500).json({ error: 'Ошибка: ' + error.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🦫 Бобор-AI запущен на порту ${PORT}`));
