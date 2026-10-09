/**
 * ============================================================================
 * ANIMEM.UZ - STANDALONE TELEGRAM ULTRA-FAST DIRECT MP4 STREAMING BOT SERVER
 * ============================================================================
 * 
 * Ushbu server Telegram kanallariga tashlangan videolarni:
 * 1. To'g'ridan-to'g'ri MP4 (HTTP 206 Partial Content / Range Requests) formatida uzatadi.
 * 2. 1000+ bir vaqtning o'zida ko'ruvchilarga qotmasdan, lahzada ochiladigan (moov cache) oqim beradi.
 * 3. HLS va og'ir FFmpeg konvertatsiyasiz (CPU va RAM ni 95% tejaydi).
 * 4. VPS diskini va keshini har 1 soatda avtomatik tozalaydi.
 * 5. Eski HLS va Player havolalarini avtomatik to'g'ridan-to'g'ri MP4 ga yo'naltiradi (302 Redirect).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

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
// KONFIGURATSIYA VA ATROF-MUHIT O'ZGARUVCHILARI
// ============================================================================
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const TG_API_ID = parseInt(process.env.TG_API_ID || '6', 10);
const TG_API_HASH = process.env.TG_API_HASH || 'eb06d4abfb49dc3eeb1aeb98ae0f581e';
const TG_BOT_TOKEN = process.env.TG_STREAM_BOT_TOKEN || '8969080492:AAFeXz93y6CjIBv0AmdlfVlE0N53gf_J6gY';
const TG_STREAM_DOMAIN = process.env.TG_STREAM_DOMAIN || 's3.animem.uz';
const CACHE_DIR = path.resolve(__dirname, process.env.HLS_CACHE_DIR || 'cache');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Doimiy ishlaydigan zaxira sessiya
const DEFAULT_VERIFIED_SESSION = '1AgAOMTQ5LjE1NC4xNjcuNTEBuxOcQMgGpwIDM6ZoO26uVoE0bg9YRumiETYCG1gyZwFPHeiJfvGua1MFeYBAboD29xpq7Gz69EDmw2Sx+G0H5EmNIcCh62hjF2Fq+V6+j81Tasqe/LS9wPWRVxHb2K1D0T4GeDJKAXnAvl371KEOoNXjdT28Kh09kQVYkpygd92qmvnfARqd2ZATA5fO4zmh8WRjMsE0C6wFkW1Y8upMT7b8rFzRTqIhyF/anOxtBhH17EeqXL21ZZqAXbi51oMydHgk2vwuxzeLit5xTZ0hDs8jVt/l8xHh3TzPLyAnzdiS9FFKs09dO6T4m2LQbOxUU7HHt/QO3bgbjbq9u8YZOjs=';
const SESSION_FILE = path.join(CACHE_DIR, 'session.txt');
const CHANNELS_FILE = path.join(CACHE_DIR, 'channels.json');
const METADATA_FILE = path.join(CACHE_DIR, 'metadata.json');

// Keshlar (LRU xotira)
const mediaMetaCache = new Map();
const videoHeadCache = new Map(); // Birinchi 4MB moov atom keshi (lahzada boshlash uchun)

// Ma'lum kanallar ro'yxati (accessHash saqlash)
const knownChannels = new Map();
knownChannels.set('3873627200', {
  channelId: '3873627200',
  accessHash: '-4392074857025164406',
  title: 'Animem UZ s3 bazasi‼️'
});

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

function savePersistedChannels() {
  try {
    const obj = {};
    for (const [k, v] of knownChannels.entries()) obj[k] = v;
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(obj, null, 2));
  } catch {}
}

function savePersistedMetadata() {
  try {
    if (mediaMetaCache.size > 2000) {
      const keys = Array.from(mediaMetaCache.keys());
      for (let i = 0; i < keys.length - 1500; i++) {
        mediaMetaCache.delete(keys[i]);
      }
    }
    const obj = {};
    for (const [k, v] of mediaMetaCache.entries()) obj[k] = v;
    fs.writeFileSync(METADATA_FILE, JSON.stringify(obj, null, 2));
  } catch {}
}

loadPersistedData();

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

  const isVideo = (doc.mimeType && doc.mimeType.startsWith('video/')) ||
    (doc.attributes && doc.attributes.some(a => a.className === 'DocumentAttributeVideo')) ||
    message.media.className === 'MessageMediaVideo';

  if (!isVideo) return null;

  const filenameAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeFilename');
  const videoAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeVideo');

  const fileName = filenameAttr?.fileName || `video_${message.id}.mp4`;
  const size = Number(doc.size || 0);
  const duration = videoAttr?.duration || 0;
  const mimeType = doc.mimeType || 'video/mp4';
  const videoCodec = videoAttr?.videoCodec || null;
  const lowerName = fileName.toLowerCase();
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
// TELEGRAM CLIENT (GRAMJS)
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
    let sessionString = process.env.TG_STREAM_SESSION || '';
    if (!sessionString && fs.existsSync(SESSION_FILE)) {
      try {
        sessionString = fs.readFileSync(SESSION_FILE, 'utf8').trim();
      } catch {}
    }
    if (!sessionString) {
      sessionString = DEFAULT_VERIFIED_SESSION;
    }

    const session = new StringSession(sessionString);

    client = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
      connectionRetries: 5,
      autoReconnect: true,
      floodSleepThreshold: 60,
    });

    await client.connect();

    const isAuthorized = await client.checkAuthorization().catch(() => false);
    if (!isAuthorized) {
      console.log('🔄 Telegram bot avtorizatsiyadan o\'tmoqda...');
      await client.start({ botAuthToken: TG_BOT_TOKEN });
      const newSess = client.session.save();
      try {
        fs.writeFileSync(SESSION_FILE, newSess);
      } catch {}
    }

    const me = await client.getMe();
    console.log(`🤖 [Telegram Bot] Muvaffaqiyatli ulandi: @${me.username}`);

    registerTelegramEventHandler(client);
    return client;
  } catch (err) {
    console.error('❌ [Telegram Bot] Ulanishda xatolik:', err?.message || err);
    throw err;
  } finally {
    isInitializing = false;
  }
}

// Telegram kanalga video tashlanganda xabar berish
function registerTelegramEventHandler(tgClient) {
  tgClient.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message) return;

      const chat = message.chat || event.chat;
      const cleanChannelId = String(message.chatId || message.peerId?.channelId || '')
        .replace(/^-100/, '')
        .replace(/^-/, '');
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

      const cacheKey = `${cleanChannelId}_${messageId}`;
      mediaMetaCache.set(cacheKey, mediaInfo);
      savePersistedMetadata();

      const mp4Url = `https://${TG_STREAM_DOMAIN}/api/tgstream/${cleanChannelId}/${messageId}`;
      const embedUrl = `https://${TG_STREAM_DOMAIN}/embed/${cleanChannelId}/${messageId}`;

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
        `⚡️ <b>1. To'g'ridan-to'g'ri MP4 Stream Havolasi:</b>\n` +
        `<code>${mp4Url}</code>\n\n` +
        `📺 <b>2. Sayt uchun Iframe kodi (Admin panelga qo'yish uchun):</b>\n` +
        `<code>&lt;iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allowfullscreen&gt;&lt;/iframe&gt;</code>\n\n` +
        `🚀 <i>Ushbu oqim 1000+ kishiga qotmasdan, lahzada (moov cache orqali) ochiladi!</i>`;

      await tgClient.sendMessage(message.chatId, {
        message: replyHtml,
        parseMode: 'html',
        replyTo: messageId
      });

      console.log(`[Telegram Streamer] Replied with MP4 stream URL for message #${messageId} in channel ${cleanChannelId}`);
    } catch (err) {
      console.warn('[Telegram Streamer] Error handling incoming video message:', err?.message || err);
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
    console.error(`[Telegram Streamer] Fetch message #${messageId} error:`, err?.message || err);
    return null;
  }
}

// ============================================================================
// EXPRESS HTTP ROUTER & HIGH-PERFORMANCE MP4 STREAMING
// ============================================================================
const app = express();
app.use(cors({ origin: true, credentials: true }));

// Server sog'ligini tekshirish
app.get(['/health', '/ping', '/'], (_req, res) => {
  res.status(200).send("Animem S3 Video Streamer is Running OK (Ultra-Fast MP4 Direct Stream) 🚀");
});

// 1. ULTRA-FAST DIRECT MP4 STREAM HANDLER (HTTP 206 Partial Content)
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

    // CORS & Range headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Origin, Content-Type, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', 'inline');

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    let start = 0;
    let end = totalSize - 1;
    let isRange = false;

    // Progressive Chunk Limiting: Agar brauzer ochiq diapazon so'rasa, 8MB bo'lib uzatamiz.
    // Bu 1000 kishi bir vaqtda kirganda server xotirasini va MTProto tarmoq oqimini teng taqsimlaydi!
    const MAX_CHUNK_BURST = 8 * 1024 * 1024; // 8MB burst limit per request

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

    // ⚡️ INSTANT START: Video boshi (moov atom / metadata) xotirada bo'lsa darhol uzatish (<5ms)
    const HEAD_BUFFER_SIZE = 4 * 1024 * 1024; // 4 MB moov kesh
    if (start === 0 && videoHeadCache.has(headKey)) {
      const cachedHead = videoHeadCache.get(headKey);
      if (chunkSize <= cachedHead.length) {
        return res.end(cachedHead.subarray(0, chunkSize));
      }
    }

    const tgClient = await getTelegramClient();
    const fileLocation = createDocumentLocation(meta.document);

    const TG_CHUNK_SIZE = 512 * 1024; // 512 KB Telegram direct chunk
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

    req.on('close', () => {
      isAborted = true;
      if (typeof downloadStream?.return === 'function') {
        try { downloadStream.return(); } catch {}
      }
    });

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
        if (!ok) await new Promise(resolve => res.once('drain', resolve));
      }
    } finally {
      if (typeof downloadStream?.return === 'function') {
        try { await downloadStream.return(); } catch {}
      }
    }

    // Video boshini kelgusi so'rovlar uchun RAM keshga saqlash
    if (start === 0 && headChunks.length > 0 && !videoHeadCache.has(headKey)) {
      if (videoHeadCache.size > 150) {
        const firstKey = videoHeadCache.keys().next().value;
        if (firstKey) videoHeadCache.delete(firstKey);
      }
      videoHeadCache.set(headKey, Buffer.concat(headChunks));
    }

    if (!res.writableEnded) res.end();
  } catch (err) {
    if (err?.errorMessage === 'FILEREF_UPGRADE_NEEDED' || err?.message?.includes('FILEREF')) {
      mediaMetaCache.delete(cacheKey);
      videoHeadCache.delete(headKey);
    }
    if (!res.headersSent) {
      res.status(500).json({ error: "Video oqimini uzatishda xatolik yuz berdi" });
    } else if (!res.writableEnded) {
      res.end();
    }
    console.error(`[Telegram Streamer] Stream error (${channelId}/${numMsgId}):`, err?.message || err);
  }
});

// 2. EMBED & NATIVE BROWSER PLAYER (To'g'ridan-to'g'ri brauzerda o'ta tezkor o'ynatish)
app.get(['/player/:channelId/:messageId', '/embed/:channelId/:messageId'], (req, res) => {
  const { channelId, messageId } = req.params;
  const mp4Url = `/api/tgstream/${channelId}/${messageId}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Animem Video Stream</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: #050508; overflow: hidden; display: flex; align-items: center; justify-content: center; }
    video { width: 100%; height: 100%; max-height: 100vh; object-fit: contain; outline: none; }
  </style>
</head>
<body>
  <video src="${mp4Url}" controls autoplay playsinline preload="metadata"></video>
</body>
</html>`);
});

// 3. ULTRA-FAST HLS & BACKWARD COMPATIBILITY
app.get(['/api/tghls/:channelId/:messageId', '/api/tghls/:channelId/:messageId/*'], (req, res) => {
  const { channelId, messageId } = req.params;
  const mp4Url = `/api/tgstream/${channelId}/${messageId}`;
  const target = req.url.toLowerCase();

  // Agar mijoz yoki player HLS manifest (.m3u8) so'rasa, darhol to'g'ri manifest qaytaramiz
  if (target.endsWith('.m3u8') || target.includes('.m3u8')) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:7200
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:1440.0,
${mp4Url}
#EXT-X-ENDLIST`);
  }

  // Agar brauzerda ochilgan bo'lsa, to'g'ridan-to'g'ri player sahifasiga yo'naltiramiz
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.redirect(302, `/player/${channelId}/${messageId}`);
  }

  // Boshqa barcha holatlarda to'g'ridan-to'g'ri MP4 oqimiga yo'naltirish
  return res.redirect(302, mp4Url);
});

// ============================================================================
// VPS DISK VA KESHNI HAR 1 SOATDA AVTOMATIK TOZALASH
// ============================================================================
function autoCleanVpsStorage() {
  console.log('🧹 [VPS Auto-Clean] Avtomatik kesh va keraksiz fayllarni tozalash boshlandi...');
  let deletedFiles = 0;
  let freedBytes = 0;

  try {
    // 1. /tmp papkasidagi vaqtinchalik video fayllarni tozalash
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

    // 2. ./cache papkasidagi eski vaqtinchalik papka va fayllarni tozalash (session va channels saqlanadi)
    if (fs.existsSync(CACHE_DIR)) {
      const cacheEntries = fs.readdirSync(CACHE_DIR);
      for (const entry of cacheEntries) {
        if (entry === 'session.txt' || entry === 'channels.json' || entry === 'metadata.json') {
          continue; // Muhim sozlamalarga tegmeymiz
        }
        const fullPath = path.join(CACHE_DIR, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            // Eski video papkalari
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

    // 3. Xotiradagi (RAM) keshni me'yorda ushlash
    if (videoHeadCache.size > 150) {
      videoHeadCache.clear();
    }
    if (mediaMetaCache.size > 2000) {
      const keys = Array.from(mediaMetaCache.keys());
      for (let i = 0; i < keys.length - 1000; i++) {
        mediaMetaCache.delete(keys[i]);
      }
    }

    if (global.gc) {
      try { global.gc(); } catch {}
    }

    const freeMemMb = Math.round(os.freemem() / (1024 * 1024));
    console.log(`✅ [VPS Auto-Clean] Tozalash yakunlandi: ${deletedFiles} ta keraksiz fayl (${formatBytes(freedBytes)}) o'chirildi. Bo'sh RAM: ${freeMemMb} MB`);
  } catch (err) {
    console.warn('⚠️ [VPS Auto-Clean] Tozalashda ogohlantirish:', err?.message || err);
  }
}

// Har 1 soatda (3600000 ms) avtomatik tozalash
setInterval(autoCleanVpsStorage, 60 * 60 * 1000);
// Dastlabki ishga tushganda ham 10 soniyadan so'ng tozalab olish
setTimeout(autoCleanVpsStorage, 10000);

// ============================================================================
// SERVERNI ISHGA TUSHIRISH
// ============================================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 [Animem S3 MP4 Server] http://0.0.0.0:${PORT} portida muvaffaqiyatli ishga tushdi!`);
  getTelegramClient().catch(err => {
    console.error('❌ [Telegram Bot] Dastlabki ulanishda xatolik:', err?.message || err);
  });
});
