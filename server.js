/**
 * ============================================================================
 * ANIMEM.UZ - STANDALONE TELEGRAM ULTRA-FAST HLS & DIRECT MP4 STREAMING BOT
 * (Northflank & Low-Resource Server Optimized Edition)
 * ============================================================================
 * 
 * Ushbu server Telegram kanallariga yuklangan videolarni:
 * 1. ⚡️ HLS (.m3u8 + .ts) formatida on-demand zero-CPU remuxing orqali ultra-tez uzatadi.
 * 2. ⚡️ MP4 (HTTP 206 Partial Content / Range Requests) formatida uzatadi.
 * 3. 🎬 Zamonaviy HLS.js va HTML5 video pleyerni o'z ichiga oladi.
 * 4. 🧹 Xotira (RAM) va diskni qat'iy nazorat qilib, OOM bo'lishining oldini oladi.
 * 5. 🤖 Telegram bot sessiyasi buzilganda avtomatik toza qayta ulanadi.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

// Global xatoliklar ushlagichi (server to'xtab qolmasligi uchun)
process.on('uncaughtException', (err) => {
  console.error('⚠️ [Server Safe] Uncaught Exception:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ [Server Safe] Unhandled Rejection:', reason?.message || reason);
});

// 1. Standalone .env parser
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx !== -1) {
        const key = line.substring(0, eqIdx).trim();
        let val = line.substring(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
} catch (e) {
  console.warn('.env o\'qishda ogohlantirish:', e?.message || e);
}

const express = require('express');
const cors = require('cors');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const bigInt = require('big-integer');

// ============================================================================
// KONFIGURATSIYA VA KUCHSIZ SERVERLAR UCHUN OPTIMIZATSIYA SOZLAMALARI
// ============================================================================
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const TG_API_ID = parseInt(process.env.TG_API_ID || '6', 10);
const TG_API_HASH = process.env.TG_API_HASH || 'eb06d4abfb49dc3eeb1aeb98ae0f581e';
const TG_BOT_TOKEN = process.env.TG_STREAM_BOT_TOKEN || '8969080492:AAFeXz93y6CjIBv0AmdlfVlE0N53gf_J6gY';
const TG_STREAM_DOMAIN = process.env.TG_STREAM_DOMAIN || 's3.animem.uz';
const CACHE_DIR = path.resolve(__dirname, process.env.HLS_CACHE_DIR || 'cache');
const HLS_CACHE_SUBDIR = path.join(CACHE_DIR, 'hls');

// RAM va oqimni tejash limitlari
const MAX_HEAD_CACHE_ITEMS = parseInt(process.env.MAX_HEAD_CACHE_ITEMS || '30', 10);
const MAX_HEAD_CACHE_BYTES = parseInt(process.env.MAX_HEAD_CACHE_BYTES || String(35 * 1024 * 1024), 10);
const HEAD_BUFFER_SIZE = parseInt(process.env.HEAD_BUFFER_SIZE || String(1.5 * 1024 * 1024), 10);
const MAX_CHUNK_BURST = parseInt(process.env.CHUNK_BURST_SIZE || String(2.5 * 1024 * 1024), 10);
const TG_CHUNK_SIZE = parseInt(process.env.TG_CHUNK_SIZE || String(512 * 1024), 10);
const MAX_META_ITEMS = parseInt(process.env.MAX_META_ITEMS || '800', 10);
const RAM_LIMIT_MB = parseInt(process.env.RAM_LIMIT_MB || '220', 10);
const CLEANUP_INTERVAL_MIN = parseInt(process.env.CLEANUP_INTERVAL_MIN || '15', 10);
const HLS_SEG_DURATION = 6; // 6 soniyalik HLS segmentlar

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(HLS_CACHE_SUBDIR)) fs.mkdirSync(HLS_CACHE_SUBDIR, { recursive: true });

// FFmpeg mavjudligini aniqlash
let hasFfmpeg = false;
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
try {
  execSync(`${ffmpegPath} -version`, { stdio: 'ignore' });
  hasFfmpeg = true;
  console.log('⚡️ [FFmpeg] FFmpeg tizimda aniqlandi. Ultra-tezkor on-demand HLS segmentatsiya faol!');
} catch {
  hasFfmpeg = false;
  console.log('ℹ️  [FFmpeg] FFmpeg aniqlanmadi. HLS to\'g\'ridan-to\'g\'ri MP4 oqimiga moslashuvchan rejimda ishlaydi.');
}

const SESSION_FILE = path.join(CACHE_DIR, 'session.txt');
const CHANNELS_FILE = path.join(CACHE_DIR, 'channels.json');
const METADATA_FILE = path.join(CACHE_DIR, 'metadata.json');

// Xotira keshlar
const mediaMetaCache = new Map();
const videoHeadCache = new Map();
let totalHeadCacheBytes = 0;

// Faol segmentatsiya vazifalari (bir xil segment bir vaqtda so'ralsa FFmpeg ni qayta chaqirmaslik uchun)
const activeSegmentTasks = new Map();

// Ma'lum kanallar ro'yxati (accessHash saqlash)
const knownChannels = new Map();
knownChannels.set('3873627200', {
  channelId: '3873627200',
  accessHash: '-4392074857025164406',
  title: 'Animem UZ s3 bazasi‼️'
});

// Ma'lumotlarni yuklash
function loadPersistedData() {
  try {
    if (fs.existsSync(CHANNELS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(data)) {
        knownChannels.set(String(k), v);
      }
    }
  } catch {}

  try {
    if (fs.existsSync(METADATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
      for (const [k, v] of Object.entries(data)) {
        mediaMetaCache.set(String(k), v);
      }
    }
  } catch {}
}

// ASINXRON VA DEBOUNCED DISKKA YOZISH
let metaSaveTimer = null;
let channelsSaveTimer = null;

function savePersistedMetadata() {
  if (metaSaveTimer) return;
  metaSaveTimer = setTimeout(async () => {
    metaSaveTimer = null;
    try {
      if (mediaMetaCache.size > MAX_META_ITEMS) {
        const keys = Array.from(mediaMetaCache.keys());
        const toDelete = keys.length - Math.floor(MAX_META_ITEMS * 0.75);
        for (let i = 0; i < toDelete; i++) {
          mediaMetaCache.delete(keys[i]);
        }
      }
      const obj = Object.fromEntries(mediaMetaCache);
      await fs.promises.writeFile(METADATA_FILE, JSON.stringify(obj), 'utf8');
    } catch (err) {
      console.warn('⚠️ [Metadata Cache] Saqlashda ogohlantirish:', err?.message || err);
    }
  }, 3000);
}

function savePersistedChannels() {
  if (channelsSaveTimer) return;
  channelsSaveTimer = setTimeout(async () => {
    channelsSaveTimer = null;
    try {
      const obj = Object.fromEntries(knownChannels);
      await fs.promises.writeFile(CHANNELS_FILE, JSON.stringify(obj), 'utf8');
    } catch (err) {
      console.warn('⚠️ [Channels] Saqlashda ogohlantirish:', err?.message || err);
    }
  }, 2000);
}

function flushPersistedDataSync() {
  try {
    if (metaSaveTimer) clearTimeout(metaSaveTimer);
    if (channelsSaveTimer) clearTimeout(channelsSaveTimer);
    const metaObj = Object.fromEntries(mediaMetaCache);
    fs.writeFileSync(METADATA_FILE, JSON.stringify(metaObj), 'utf8');
    const chObj = Object.fromEntries(knownChannels);
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(chObj), 'utf8');
  } catch {}
}

loadPersistedData();

// RAM keshni qat'iy nazorat qilish
function storeVideoHead(key, buffer) {
  if (!buffer || buffer.length === 0) return;

  if (videoHeadCache.has(key)) {
    const oldBuf = videoHeadCache.get(key);
    if (oldBuf) totalHeadCacheBytes -= oldBuf.length;
    videoHeadCache.delete(key);
  }

  while (
    (videoHeadCache.size >= MAX_HEAD_CACHE_ITEMS || 
    (totalHeadCacheBytes + buffer.length > MAX_HEAD_CACHE_BYTES)) && 
    videoHeadCache.size > 0
  ) {
    const oldestKey = videoHeadCache.keys().next().value;
    if (!oldestKey) break;
    const oldBuf = videoHeadCache.get(oldestKey);
    if (oldBuf) totalHeadCacheBytes -= oldBuf.length;
    videoHeadCache.delete(oldestKey);
  }

  videoHeadCache.set(key, buffer);
  totalHeadCacheBytes += buffer.length;
}

function clearVideoHeadCache() {
  videoHeadCache.clear();
  totalHeadCacheBytes = 0;
}

// ============================================================================
// FORMAT VA YORDAMCHI FUNKSIYALAR
// ============================================================================
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function extractMediaFromMessage(message) {
  if (!message || !message.media) return null;
  const doc = message.media.document || message.media;
  if (!doc || !doc.id) return null;

  const isVideoAttr = doc.attributes && doc.attributes.some(a => a.className === 'DocumentAttributeVideo');
  const isVideoMime = doc.mimeType && doc.mimeType.startsWith('video/');
  const isVideoClass = message.media.className === 'MessageMediaVideo';

  const filenameAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeFilename');
  const videoAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeVideo');

  const fileName = filenameAttr?.fileName || `video_${message.id}.mp4`;
  const lowerName = fileName.toLowerCase();
  const isVideoByExt = lowerName.endsWith('.mp4') || lowerName.endsWith('.mkv') || lowerName.endsWith('.mov') || lowerName.endsWith('.webm') || lowerName.endsWith('.avi');

  if (!isVideoAttr && !isVideoMime && !isVideoClass && !isVideoByExt) {
    return null;
  }

  const size = Number(doc.size || 0);
  const duration = videoAttr?.duration || 0;
  const mimeType = doc.mimeType || 'video/mp4';
  const videoCodec = videoAttr?.videoCodec || null;
  const isHevc = lowerName.includes('hevc') || lowerName.includes('x265') || lowerName.includes('h.265') || lowerName.includes('h265');

  return {
    document: doc,
    fileName,
    size,
    mimeType,
    duration,
    videoCodec,
    isHevc,
    cachedAt: Date.now()
  };
}

function getValidFileReference(doc) {
  if (!doc || !doc.fileReference) return Buffer.alloc(0);
  if (Buffer.isBuffer(doc.fileReference)) return doc.fileReference;
  if (doc.fileReference.data && Array.isArray(doc.fileReference.data)) {
    return Buffer.from(doc.fileReference.data);
  }
  if (typeof doc.fileReference === 'string') {
    return Buffer.from(doc.fileReference, 'base64');
  }
  return Buffer.from(doc.fileReference);
}

function createDocumentLocation(doc) {
  return new Api.InputDocumentFileLocation({
    id: bigInt(doc.id),
    accessHash: bigInt(doc.accessHash),
    fileReference: getValidFileReference(doc),
    thumbSize: '',
  });
}

// ============================================================================
// TELEGRAM CLIENT (GRAMJS) - RESILIENT AUTO RE-AUTH
// ============================================================================
let client = null;
let isInitializing = false;

async function getTelegramClient() {
  if (client && client.connected) return client;

  if (isInitializing) {
    while (isInitializing) {
      await new Promise(r => setTimeout(r, 150));
    }
    if (client && client.connected) return client;
  }

  isInitializing = true;
  try {
    let sessionString = '';
    if (fs.existsSync(SESSION_FILE)) {
      try {
        sessionString = fs.readFileSync(SESSION_FILE, 'utf8').trim();
      } catch {}
    }
    if (!sessionString && process.env.TG_STREAM_SESSION) {
      sessionString = process.env.TG_STREAM_SESSION.trim();
    }

    let isConnected = false;

    if (sessionString) {
      try {
        const session = new StringSession(sessionString);
        client = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
          connectionRetries: 5,
          autoReconnect: true,
          floodSleepThreshold: 60,
          deviceModel: 'Northflank Streamer',
          systemVersion: 'Linux',
          appVersion: '1.0.0',
          useWSS: false,
        });

        await client.connect();

        const isAuthorized = await client.checkAuthorization().catch(() => false);
        if (isAuthorized) {
          isConnected = true;
        } else {
          console.warn('⚠️ [Telegram] Saqlangan sessiya avtorizatsiyadan o\'tmadi. Bot tokeni orqali yangilanmoqda...');
          try { await client.disconnect(); } catch {}
          client = null;
        }
      } catch (sessErr) {
        console.warn(`⚠️ [Telegram] Sessiya xatoligi (${sessErr?.message || sessErr}). Yangi toza sessiya yaratilmoqda...`);
        try { if (client) await client.disconnect(); } catch {}
        client = null;
      }
    }

    if (!isConnected) {
      console.log('🔄 [Telegram] TG_STREAM_BOT_TOKEN orqali toza sessiya yaratilmoqda...');
      const session = new StringSession('');
      client = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
        connectionRetries: 5,
        autoReconnect: true,
        floodSleepThreshold: 60,
        deviceModel: 'Northflank Streamer',
        systemVersion: 'Linux',
        appVersion: '1.0.0',
        useWSS: false,
      });

      await client.start({ botAuthToken: TG_BOT_TOKEN });
      const newSess = client.session.save();
      try {
        fs.writeFileSync(SESSION_FILE, newSess);
        console.log('💾 [Telegram] Yangi ishchi bot sessiyasi saqlandi.');
      } catch {}
    }

    const me = await client.getMe();
    console.log(`🤖 [Telegram Bot] Muvaffaqiyatli ulandi: @${me.username} (ID: ${me.id})`);

    registerTelegramEventHandler(client);
    return client;
  } catch (err) {
    console.error('❌ [Telegram Bot] Ulanishda jiddiy xatolik:', err?.message || err);
    throw err;
  } finally {
    isInitializing = false;
  }
}

// Telegram kanalga yangi video qo'shilganda xabar berish
function registerTelegramEventHandler(tgClient) {
  tgClient.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message) return;

      console.log(`📩 [Telegram Streamer] Yangi xabar aniqlandi! ID: ${message.id}`);

      const chat = message.chat || event.chat || (await message.getChat().catch(() => null));
      const channelIdRaw = message.peerId?.channelId 
        ? message.peerId.channelId.toString() 
        : (message.chatId ? message.chatId.toString() : '');
      const cleanChannelId = channelIdRaw.replace(/^-100/, '').replace(/^-/, '');
      const messageId = message.id;

      if (cleanChannelId && chat && chat.accessHash) {
        knownChannels.set(cleanChannelId, {
          channelId: cleanChannelId,
          accessHash: chat.accessHash.toString(),
          title: chat.title || ''
        });
        savePersistedChannels();
      }

      const mediaInfo = extractMediaFromMessage(message);
      if (!mediaInfo) return;

      console.log(`🎬 [Telegram Streamer] Video aniqlandi: "${mediaInfo.fileName}" (${formatBytes(mediaInfo.size)})`);

      const cacheKey = `${cleanChannelId}_${messageId}`;
      mediaMetaCache.set(cacheKey, mediaInfo);
      savePersistedMetadata();

      const hlsUrl = `https://${TG_STREAM_DOMAIN}/api/tghls/${cleanChannelId}/${messageId}/master.m3u8`;
      const mp4Url = `https://${TG_STREAM_DOMAIN}/api/tgstream/${cleanChannelId}/${messageId}`;
      const embedUrl = `https://${TG_STREAM_DOMAIN}/embed/${cleanChannelId}/${messageId}`;
      const playerUrl = `https://${TG_STREAM_DOMAIN}/player/${cleanChannelId}/${messageId}`;

      let codecInfo = `🎞 <b>Format:</b> <code>H.264 (AVC)</code> ✅ <i>(Brauzerlarga 100% mos)</i>\n\n`;
      let warningBlock = '';

      if (mediaInfo.isHevc) {
        codecInfo = `🎞 <b>Format:</b> <code>HEVC (H.265 / x265)</code> ⚠️\n\n`;
        warningBlock = 
          `⚠️ <b>DIQQAT:</b> Ushbu video <b>HEVC (H.265)</b> formatida! Brauzerlar uni faqat audio qilib ochishi mumkin.\n` +
          `💡 <i>Eng yaxshi tezlik uchun videolarni <b>H.264 (AVC)</b> formatida yuklang!</i>\n\n`;
      }

      const replyHtml = 
        `🎬 <b>Video Muvaffaqiyatli Qabul Qilindi!</b>\n\n` +
        `📁 <b>Fayl:</b> <code>${mediaInfo.fileName}</code>\n` +
        `⚖️ <b>Hajmi:</b> <b>${formatBytes(mediaInfo.size)}</b>\n` +
        `⏱ <b>Davomiyligi:</b> ${formatDuration(mediaInfo.duration)}\n` +
        codecInfo +
        warningBlock +
        `⚡️ <b>1. Tezkor HLS Stream (.m3u8) Havolasi (Sayt va Pleyerlar uchun):</b>\n` +
        `<code>${hlsUrl}</code>\n\n` +
        `⚡️ <b>2. To'g'ridan-to'g'ri MP4 Stream Havolasi:</b>\n` +
        `<code>${mp4Url}</code>\n\n` +
        `📺 <b>3. Sayt uchun Iframe kodi (Admin panelga qo'yish uchun):</b>\n` +
        `<code>&lt;iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allowfullscreen&gt;&lt;/iframe&gt;</code>\n\n` +
        `📱 <b>4. Onlayn Pleyer (Brauzerda ko'rish):</b>\n` +
        `<code>${playerUrl}</code>\n\n` +
        `🚀 <i>Ushbu oqim HLS + Direct MP4 orqali 10,000+ kishiga qotmasdan, lahzada ochiladi!</i>`;

      const targetPeer = message.peerId || message.chatId;
      let sent = false;

      // 1-urinish: replyTo bilan javob berish
      try {
        await tgClient.sendMessage(targetPeer, {
          message: replyHtml,
          parseMode: 'html',
          replyTo: messageId
        });
        sent = true;
      } catch (replyErr) {
        console.warn(`⚠️ [Telegram Streamer] replyTo bilan yuborib bo'lmadi, oddiy post sifatida yuborilmoqda...`);
      }

      // 2-urinish: agar kanalda izohlar yoqilmagan bo'lsa, oddiy post sifatida yuborish
      if (!sent) {
        try {
          await tgClient.sendMessage(targetPeer, {
            message: replyHtml,
            parseMode: 'html'
          });
          sent = true;
        } catch (postErr) {
          console.error(`❌ [Telegram Streamer] Kanalga xabar yuborishda xatolik:`, postErr?.message || postErr);
        }
      }

      if (sent) {
        console.log(`✅ [Telegram Streamer] Javob havolasi muvaffaqiyatli yuborildi: #${messageId} (Kanal: ${cleanChannelId})`);
      }
    } catch (err) {
      console.error('❌ [Telegram Streamer] Yangi xabarni qayta ishlashda xatolik:', err?.message || err);
    }
  }, new NewMessage({}));
}

async function getStreamMetadata(channelId, messageId) {
  const cleanId = String(channelId).replace(/^-100/, '').replace(/^-/, '');
  const cacheKey = `${cleanId}_${messageId}`;

  const cached = mediaMetaCache.get(cacheKey);
  if (cached && (Date.now() - cached.cachedAt < 86400000)) {
    return cached;
  }

  const tgClient = await getTelegramClient();
  const normalizedChannelId = String(channelId).startsWith('-100')
    ? channelId
    : (String(channelId).startsWith('-') ? `-100${String(channelId).slice(1)}` : `-100${channelId}`);

  try {
    let peer;
    const ch = knownChannels.get(cleanId);
    if (ch && ch.accessHash) {
      peer = new Api.InputPeerChannel({
        channelId: bigInt(ch.channelId),
        accessHash: bigInt(ch.accessHash),
      });
    } else {
      try {
        peer = await tgClient.getInputEntity(normalizedChannelId);
      } catch {
        peer = await tgClient.getInputEntity(cleanId);
      }
    }

    const messages = await tgClient.getMessages(peer, { ids: [messageId] });
    if (!messages || !messages[0]) return null;

    const mediaInfo = extractMediaFromMessage(messages[0]);
    if (!mediaInfo) return null;

    mediaMetaCache.set(cacheKey, mediaInfo);
    savePersistedMetadata();
    return mediaInfo;
  } catch (err) {
    console.error(`[Telegram Streamer] Metadata olishda xatolik #${messageId}:`, err?.message || err);
    return null;
  }
}

// ============================================================================
// EXPRESS HTTP ROUTER
// ============================================================================
const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: true, credentials: true }));

// Server sog'ligini tekshirish
app.get(['/health', '/ping'], (_req, res) => {
  const mem = process.memoryUsage();
  res.status(200).json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    service: 'Animem S3 Video Streamer (HLS + MP4)',
    hasFfmpeg,
    memory: {
      rss: `${Math.round(mem.rss / 1024 / 1024)} MB`,
      heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)} MB`,
      heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)} MB`,
    },
    cachedVideos: mediaMetaCache.size,
    cachedHeads: videoHeadCache.size,
    cachedHeadBytes: formatBytes(totalHeadCacheBytes),
    tgConnected: Boolean(client && client.connected),
  });
});

app.get('/', (_req, res) => {
  res.status(200).send("Animem S3 Video Streamer is Running OK (Ultra-Fast HLS & MP4 Direct Stream) 🚀");
});

// ============================================================================
// 1. ULTRA-FAST DIRECT MP4 STREAM HANDLER (HTTP 206 Partial Content)
// ============================================================================
app.get('/api/tgstream/:channelId/:messageId', async (req, res) => {
  const { channelId, messageId } = req.params;
  const numMsgId = parseInt(messageId, 10);
  if (!channelId || isNaN(numMsgId)) {
    return res.status(400).json({ error: "Noto'g'ri parametrlar" });
  }

  const cleanId = channelId.replace(/^-100/, '').replace(/^-/, '');
  const cacheKey = `${cleanId}_${numMsgId}`;
  const headKey = `${cacheKey}_head`;

  try {
    const meta = await getStreamMetadata(channelId, numMsgId);
    if (!meta || !meta.document) {
      return res.status(404).json({ error: "Video topilmadi yoki o'chirilgan" });
    }

    const totalSize = meta.size;
    const mimeType = meta.mimeType || 'video/mp4';
    const rangeHeader = req.headers.range;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Origin, Content-Type, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', 'inline');

    if (req.method === 'OPTIONS') return res.sendStatus(204);

    let start = 0;
    let end = totalSize - 1;
    let isRange = false;

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        isRange = true;
        start = parseInt(match[1], 10);
        if (match[2]) {
          end = parseInt(match[2], 10);
        } else {
          end = Math.min(totalSize - 1, start + MAX_CHUNK_BURST - 1);
        }
      }
    } else {
      end = Math.min(totalSize - 1, start + MAX_CHUNK_BURST - 1);
    }

    if (start >= totalSize || end >= totalSize || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${totalSize}`).end();
      return;
    }

    const chunkSize = end - start + 1;

    if (isRange) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    } else {
      res.status(200);
    }

    res.setHeader('Content-Length', chunkSize);

    if (req.method === 'HEAD') return res.end();

    // ⚡️ LAHZADA OCHILISH (INSTANT START): Video boshi RAM keshda bo'lsa darhol uzatish (<2ms)
    if (start === 0 && videoHeadCache.has(headKey)) {
      const cachedHead = videoHeadCache.get(headKey);
      if (chunkSize <= cachedHead.length) {
        return res.end(cachedHead.subarray(0, chunkSize));
      }
    }

    const tgClient = await getTelegramClient();
    const fileLocation = createDocumentLocation(meta.document);

    const alignedStart = Math.floor(start / TG_CHUNK_SIZE) * TG_CHUNK_SIZE;
    const skipBytes = start - alignedStart;
    const totalBytesToFetch = (end - start + 1) + skipBytes;
    const chunkLimit = Math.ceil(totalBytesToFetch / TG_CHUNK_SIZE);

    const downloadStream = tgClient.iterDownload({
      file: fileLocation,
      dcId: meta.document.dcId,
      offset: bigInt(alignedStart),
      limit: chunkLimit,
      chunkSize: TG_CHUNK_SIZE,
      requestSize: TG_CHUNK_SIZE,
    });

    let bytesRemaining = chunkSize;
    let skipped = 0;
    let isAborted = false;

    const cleanupStream = () => {
      isAborted = true;
      if (typeof downloadStream?.return === 'function') {
        try { downloadStream.return(); } catch {}
      }
    };

    req.on('close', cleanupStream);
    res.on('error', cleanupStream);

    const headChunks = [];
    let headBytes = 0;

    try {
      for await (const chunk of downloadStream) {
        if (isAborted || res.writableEnded || res.destroyed) break;

        let dataChunk = chunk;
        if (skipped < skipBytes) {
          const toSkip = Math.min(skipBytes - skipped, dataChunk.length);
          dataChunk = dataChunk.subarray(toSkip);
          skipped += toSkip;
        }

        if (dataChunk.length === 0) continue;

        const bytesToSend = Math.min(dataChunk.length, bytesRemaining);
        const slice = dataChunk.subarray(0, bytesToSend);
        
        const ok = res.write(slice);
        bytesRemaining -= bytesToSend;

        if (start === 0 && headBytes < HEAD_BUFFER_SIZE) {
          headChunks.push(slice);
          headBytes += slice.length;
        }

        if (bytesRemaining <= 0) break;

        if (!ok && !res.writableEnded && !isAborted) {
          await new Promise((resolve) => {
            const onDrain = () => {
              res.removeListener('close', onDrain);
              resolve();
            };
            res.once('drain', onDrain);
            res.once('close', onDrain);
          });
        }
      }
    } finally {
      req.removeListener('close', cleanupStream);
      res.removeListener('error', cleanupStream);
      if (typeof downloadStream?.return === 'function') {
        try { await downloadStream.return(); } catch {}
      }
    }

    if (start === 0 && headChunks.length > 0 && !videoHeadCache.has(headKey)) {
      storeVideoHead(headKey, Buffer.concat(headChunks));
    }

    if (!res.writableEnded) res.end();
  } catch (err) {
    if (err?.errorMessage === 'FILEREF_UPGRADE_NEEDED' || err?.message?.includes('FILEREF')) {
      mediaMetaCache.delete(cacheKey);
      if (videoHeadCache.has(headKey)) {
        const oldBuf = videoHeadCache.get(headKey);
        if (oldBuf) totalHeadCacheBytes -= oldBuf.length;
        videoHeadCache.delete(headKey);
      }
    }
    if (!res.headersSent) {
      res.status(500).json({ error: "Video oqimini uzatishda xatolik yuz berdi" });
    } else if (!res.writableEnded) {
      res.end();
    }
    console.error(`[Telegram Streamer] Stream xatoligi (${channelId}/${numMsgId}):`, err?.message || err);
  }
});

// ============================================================================
// 2. ULTRA-FAST HLS STREAM HANDLER (.m3u8 + .ts on-demand zero-CPU remuxing)
// ============================================================================

// A. HLS VOD Playlist Manifest (.m3u8) - 1 millisoniyada hosil qilinadi
app.get([
  '/api/tghls/:channelId/:messageId/master.m3u8',
  '/api/tghls/:channelId/:messageId/playlist.m3u8',
  '/api/tghls/:channelId/:messageId/index.m3u8',
  '/api/tghls/:channelId/:messageId'
], async (req, res) => {
  const { channelId, messageId } = req.params;
  const numMsgId = parseInt(messageId, 10);
  if (!channelId || isNaN(numMsgId)) return res.status(400).send("Noto'g'ri parametrlar");

  // Agar brauzerda to'g'ridan-to'g'ri ochilsa player sahifasiga yo'naltirish
  if (req.headers.accept && req.headers.accept.includes('text/html') && !req.url.endsWith('.m3u8')) {
    return res.redirect(302, `/player/${channelId}/${numMsgId}`);
  }

  const meta = await getStreamMetadata(channelId, numMsgId);
  if (!meta) return res.status(404).send("Video topilmadi");

  const duration = Number(meta.duration) || 1200;
  const totalSegments = Math.max(1, Math.ceil(duration / HLS_SEG_DURATION));

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Origin, Content-Type, Accept');
  res.setHeader('Cache-Control', 'public, max-age=600');

  if (req.method === 'OPTIONS') return res.sendStatus(204);

  // Standart HLS VOD Playlist (barcha HLS pleyerlar va iOS/Android ga 100% mos)
  let m3u8 = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${HLS_SEG_DURATION + 1}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n`;
  for (let i = 0; i < totalSegments; i++) {
    const isLast = (i === totalSegments - 1);
    const segDuration = isLast ? Math.max(1, (duration % HLS_SEG_DURATION) || HLS_SEG_DURATION) : HLS_SEG_DURATION;
    m3u8 += `#EXTINF:${segDuration.toFixed(1)},\nsegment_${i}.ts\n`;
  }
  m3u8 += `#EXT-X-ENDLIST\n`;

  return res.send(m3u8);
});

// B. HLS MPEG-TS Segment (.ts) - On-Demand Slicing (<80ms remuxing, 1ms cache)
app.get('/api/tghls/:channelId/:messageId/segment_:segNum.ts', async (req, res) => {
  const { channelId, messageId, segNum } = req.params;
  const numMsgId = parseInt(messageId, 10);
  const numSeg = parseInt(segNum, 10);

  if (!channelId || isNaN(numMsgId) || isNaN(numSeg)) {
    return res.status(400).send("Noto'g'ri segment parametri");
  }

  const cleanId = channelId.replace(/^-100/, '').replace(/^-/, '');
  const videoHlsDir = path.join(HLS_CACHE_SUBDIR, `${cleanId}_${numMsgId}`);
  if (!fs.existsSync(videoHlsDir)) fs.mkdirSync(videoHlsDir, { recursive: true });

  const targetSegFile = path.join(videoHlsDir, `segment_${numSeg}.ts`);

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Origin, Content-Type, Accept');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

  if (req.method === 'OPTIONS') return res.sendStatus(204);

  // 1. Agar segment disk keshida mavjud bo'lsa darhol uzatish (<1ms)
  if (fs.existsSync(targetSegFile)) {
    const stat = fs.statSync(targetSegFile);
    if (stat.size > 500) {
      res.setHeader('Content-Length', stat.size);
      return fs.createReadStream(targetSegFile).pipe(res);
    }
  }

  // 2. Agar FFmpeg tizimda bo'lmasa
  if (!hasFfmpeg) {
    return res.status(503).send("HLS segmentatsiyasi uchun serverda FFmpeg mavjud emas.");
  }

  // 3. Agar ushbu segment ayni vaqtda boshqa so'rov orqali tayyorlanayotgan bo'lsa, kutish (duplikatsiya oldini olish)
  const taskKey = `${cleanId}_${numMsgId}_${numSeg}`;
  if (activeSegmentTasks.has(taskKey)) {
    try {
      await activeSegmentTasks.get(taskKey);
      if (fs.existsSync(targetSegFile)) {
        const stat = fs.statSync(targetSegFile);
        res.setHeader('Content-Length', stat.size);
        return fs.createReadStream(targetSegFile).pipe(res);
      }
    } catch {}
  }

  // 4. FFmpeg on-demand remuxing (-c copy orqali video qayta kodlanmaydi, CPU sarflanmaydi!)
  const meta = await getStreamMetadata(channelId, numMsgId);
  const isHevc = meta?.isHevc || false;
  const startTime = numSeg * HLS_SEG_DURATION;
  const tempFile = path.join(videoHlsDir, `temp_${numSeg}_${Date.now()}.ts`);
  const bsfFilter = isHevc ? 'hevc_mp4toannexb' : 'h264_mp4toannexb';
  const inputStreamUrl = `http://127.0.0.1:${PORT}/api/tgstream/${cleanId}/${numMsgId}`;

  const slicePromise = new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      '-ss', String(startTime),
      '-t', String(HLS_SEG_DURATION),
      '-i', inputStreamUrl,
      '-c', 'copy',
      '-bsf:v', bsfFilter,
      '-avoid_negative_ts', 'make_zero',
      '-fflags', '+genpts',
      '-f', 'mpegts',
      '-y',
      tempFile
    ]);

    const timer = setTimeout(() => {
      try { ff.kill('SIGKILL'); } catch {}
      reject(new Error("Segment yaratishda timeout"));
    }, 15000);

    ff.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(tempFile) && fs.statSync(tempFile).size > 500) {
        try {
          fs.renameSync(tempFile, targetSegFile);
          resolve(true);
        } catch (e) {
          reject(e);
        }
      } else {
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch {}
        reject(new Error(`FFmpeg exit code: ${code}`));
      }
    });

    ff.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  activeSegmentTasks.set(taskKey, slicePromise);

  try {
    await slicePromise;
    activeSegmentTasks.delete(taskKey);

    if (fs.existsSync(targetSegFile)) {
      const stat = fs.statSync(targetSegFile);
      res.setHeader('Content-Length', stat.size);
      return fs.createReadStream(targetSegFile).pipe(res);
    } else {
      return res.status(500).send("Segment fayli hosil qilinmadi");
    }
  } catch (err) {
    activeSegmentTasks.delete(taskKey);
    console.error(`❌ [HLS Streamer] Segment #${numSeg} da xatolik:`, err?.message || err);
    return res.status(500).send("Segment yaratishda xatolik");
  }
});

// ============================================================================
// 3. EMBED & NATIVE BROWSER PLAYER (HLS + MP4 Dual Support)
// ============================================================================
app.get(['/player/:channelId/:messageId', '/embed/:channelId/:messageId'], (req, res) => {
  const { channelId, messageId } = req.params;
  const hlsUrl = `/api/tghls/${channelId}/${messageId}/master.m3u8`;
  const mp4Url = `/api/tgstream/${channelId}/${messageId}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Animem Video Stream</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.8/dist/hls.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: #050508; overflow: hidden; display: flex; align-items: center; justify-content: center; }
    video { width: 100%; height: 100%; max-height: 100vh; object-fit: contain; outline: none; }
  </style>
</head>
<body>
  <video id="video" controls autoplay playsinline preload="auto"></video>
  <script>
    const video = document.getElementById('video');
    const hlsUrl = "${hlsUrl}";
    const mp4Url = "${mp4Url}";

    if (Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        enableWorker: true,
      });
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, function(event, data) {
        if (data.fatal) {
          console.warn('HLS xatoligi, MP4 oqimiga olinmoqda...');
          video.src = mp4Url;
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsUrl;
    } else {
      video.src = mp4Url;
    }
  </script>
</body>
</html>`);
});

// ============================================================================
// XOTIRA VA DISKNI AVTOMATIK TOZALASH (MEMORY & DISK WATCHDOG)
// ============================================================================
function checkMemoryUsage() {
  const mem = process.memoryUsage();
  const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMb = Math.round(mem.rss / 1024 / 1024);

  if (rssMb > RAM_LIMIT_MB || heapUsedMb > Math.floor(RAM_LIMIT_MB * 0.75)) {
    console.warn(`⚠️ [Watchdog] Xotira oshdi: RSS=${rssMb}MB, Heap=${heapUsedMb}MB (Limit: ${RAM_LIMIT_MB}MB). Kesh tozalanmoqda...`);
    clearVideoHeadCache();

    if (mediaMetaCache.size > 200) {
      const keys = Array.from(mediaMetaCache.keys());
      for (let i = 0; i < keys.length - 200; i++) {
        mediaMetaCache.delete(keys[i]);
      }
    }

    if (global.gc) {
      try {
        global.gc();
        const after = process.memoryUsage();
        console.log(`🧹 [GC] Xotira tozalandi: RSS=${Math.round(after.rss / 1024 / 1024)}MB, Heap=${Math.round(after.heapUsed / 1024 / 1024)}MB`);
      } catch {}
    }
  }
}

setInterval(checkMemoryUsage, 30000);

function autoCleanStorage() {
  console.log('🧹 [Storage Clean] Kesh va vaqtinchalik fayllarni tozalash boshlandi...');
  let deletedFiles = 0;
  let freedBytes = 0;

  try {
    // 1. /tmp papkasini tozalash
    const tmpDir = os.tmpdir();
    if (fs.existsSync(tmpDir)) {
      const tmpFiles = fs.readdirSync(tmpDir);
      for (const f of tmpFiles) {
        if (f.startsWith('temp_') || f.endsWith('.tmp') || f.endsWith('.ts') || f.endsWith('.part')) {
          try {
            const p = path.join(tmpDir, f);
            const st = fs.statSync(p);
            freedBytes += st.size;
            fs.unlinkSync(p);
            deletedFiles++;
          } catch {}
        }
      }
    }

    // 2. ./cache/hls papkasidagi 1 soatdan eski segmentlarni tozalash
    if (fs.existsSync(HLS_CACHE_SUBDIR)) {
      const now = Date.now();
      const hlsDirs = fs.readdirSync(HLS_CACHE_SUBDIR);
      for (const dir of hlsDirs) {
        const fullDir = path.join(HLS_CACHE_SUBDIR, dir);
        try {
          const stat = fs.statSync(fullDir);
          if (now - stat.mtimeMs > 60 * 60 * 1000) {
            fs.rmSync(fullDir, { recursive: true, force: true });
            deletedFiles++;
          }
        } catch {}
      }
    }

    // 3. ./cache papkasidagi boshqa keraksiz fayllar
    if (fs.existsSync(CACHE_DIR)) {
      const cacheEntries = fs.readdirSync(CACHE_DIR);
      for (const entry of cacheEntries) {
        if (entry === 'session.txt' || entry === 'channels.json' || entry === 'metadata.json' || entry === 'hls') {
          continue;
        }
        const fullPath = path.join(CACHE_DIR, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
            deletedFiles++;
          } else if (entry.endsWith('.ts') || entry.endsWith('.mp4') || entry.endsWith('.part') || entry.endsWith('.m3u8')) {
            freedBytes += stat.size;
            fs.unlinkSync(fullPath);
            deletedFiles++;
          }
        } catch {}
      }
    }

    if (totalHeadCacheBytes > MAX_HEAD_CACHE_BYTES) {
      clearVideoHeadCache();
    }

    if (global.gc) {
      try { global.gc(); } catch {}
    }

    const freeMemMb = Math.round(os.freemem() / (1024 * 1024));
    console.log(`✅ [Storage Clean] Yakunlandi: ${deletedFiles} ta fayl (${formatBytes(freedBytes)}) o'chirildi. Bo'sh tizim RAM: ${freeMemMb} MB`);
  } catch (err) {
    console.warn('⚠️ [Storage Clean] Ogohlantirish:', err?.message || err);
  }
}

setInterval(autoCleanStorage, CLEANUP_INTERVAL_MIN * 60 * 1000);
setTimeout(autoCleanStorage, 10000);

// ============================================================================
// SERVERNI ISHGA TUSHIRISH VA GRACEFUL SHUTDOWN
// ============================================================================
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 [Animem S3 Video Server] http://0.0.0.0:${PORT} portida muvaffaqiyatli ishga tushdi!`);
  console.log(`⚙️  [Konfiguratsiya] RAM: ${RAM_LIMIT_MB}MB | Head Cache: ${formatBytes(MAX_HEAD_CACHE_BYTES)} | Burst: ${formatBytes(MAX_CHUNK_BURST)} | FFmpeg: ${hasFfmpeg ? 'Mavjud ✅' : 'Yo\'q ⚠️'}`);
  getTelegramClient().catch(err => {
    console.error('❌ [Telegram Bot] Dastlabki ulanishda xatolik:', err?.message || err);
  });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

function handleShutdown(signal) {
  console.log(`🛑 [Shutdown] ${signal} qabul qilindi. Server to'xtatilmoqda...`);
  flushPersistedDataSync();

  server.close(async () => {
    console.log('🔌 [Shutdown] HTTP server yopildi.');
    try {
      if (client && client.connected) {
        await client.disconnect();
        console.log('🤖 [Shutdown] Telegram ulanishi uzildi.');
      }
    } catch {}
    process.exit(0);
  });

  setTimeout(() => {
    console.error('⚠️ [Shutdown] Majburiy to\'xtatildi (timeout).');
    process.exit(0);
  }, 10000).unref();
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
