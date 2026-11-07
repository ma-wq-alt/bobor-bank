// cron.js — костыль для Render
// Этот файл будет запускать «будильник» на Render и держать сервер в тонусе
import fetch from 'node-fetch';

const URL = 'https://bobor-bank.onrender.com/api/health';

async function ping() {
  try {
    const r = await fetch(URL);
    console.log(`[${new Date().toISOString()}] Ping: ${r.status}`);
  } catch (e) {
    console.log(`[${new Date().toISOString()}] Ошибка пинга: ${e.message}`);
  }
}

// Пингуем каждые 10 минут
setInterval(ping, 10 * 60 * 1000);
ping();
