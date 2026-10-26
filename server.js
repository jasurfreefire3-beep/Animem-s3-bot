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
const { ConnectionTCPObfuscated } = require('telegram/network');
const bigInt = require('big-integer');

// ============================================================================
// KONFIGURATSIYA VA KUCHSIZ SERVERLAR UCHUN OPTIMIZATSIYA SOZLAMALARI
// ============================================================================
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const TG_API_ID = parseInt(process.env.TG_API_ID || '6', 10);
const TG_API_HASH = process.env.TG_API_HASH || 'eb06d4abfb49dc3eeb1aeb98ae0f581e';
const TG_BOT_TOKEN = process.env.TG_STREAM_BOT_TOKEN || '8969080492:AAFeXz93y6CjIBv0AmdlfVlE0N53gf_J6gY';
const TG_STREAM_DOMAIN = process.env.TG_STREAM_DOMAIN || 's3.animem.uz';
const CACHE_DIR = path.resolve(__dirname, process.env.CACHE_DIR || 'cache');

// RAM va oqimni tejash limitlari
const MAX_HEAD_CACHE_ITEMS = parseInt(process.env.MAX_HEAD_CACHE_ITEMS || '40', 10);
const MAX_HEAD_CACHE_BYTES = parseInt(process.env.MAX_HEAD_CACHE_BYTES || String(60 * 1024 * 1024), 10);
const HEAD_BUFFER_SIZE = parseInt(process.env.HEAD_BUFFER_SIZE || String(2.5 * 1024 * 1024), 10); // 2.5MB moov atom / head buffer
const MAX_CHUNK_BURST = parseInt(process.env.CHUNK_BURST_SIZE || String(2.5 * 1024 * 1024), 10);
const TG_CHUNK_SIZE = parseInt(process.env.TG_CHUNK_SIZE || String(512 * 1024), 10); // 512KB chunks (Telegram MTProto native limit)
const MAX_META_ITEMS = parseInt(process.env.MAX_META_ITEMS || '800', 10);
const RAM_LIMIT_MB = parseInt(process.env.RAM_LIMIT_MB || '450', 10);
const CLEANUP_INTERVAL_MIN = parseInt(process.env.CLEANUP_INTERVAL_MIN || '15', 10);

const HEADS_CACHE_SUBDIR = path.join(CACHE_DIR, 'heads');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(HEADS_CACHE_SUBDIR)) fs.mkdirSync(HEADS_CACHE_SUBDIR, { recursive: true });

const SESSION_FILE = path.join(CACHE_DIR, 'session.txt');
const CHANNELS_FILE = path.join(CACHE_DIR, 'channels.json');
const METADATA_FILE = path.join(CACHE_DIR, 'metadata.json');

// Xotira keshlar
const mediaMetaCache = new Map();
const videoHeadCache = new Map();
let totalHeadCacheBytes = 0;


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

// RAM va disk boshlang'ich keshini qat'iy nazorat qilish
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

  // Diskka ham saqlab qo'yish (keyingi so'rovlar uchun lahzada <1ms ochilishi uchun)
  try {
    const headFile = path.join(HEADS_CACHE_SUBDIR, `${key}.head`);
    fs.writeFile(headFile, buffer, () => {});
  } catch {}
}

function getVideoHead(key) {
  if (videoHeadCache.has(key)) {
    return videoHeadCache.get(key);
  }
  try {
    const headFile = path.join(HEADS_CACHE_SUBDIR, `${key}.head`);
    if (fs.existsSync(headFile)) {
      const buf = fs.readFileSync(headFile);
      if (buf && buf.length > 0) {
        storeVideoHead(key, buf);
        return buf;
      }
    }
  } catch {}
  return null;
}

function clearVideoHeadCache() {
  videoHeadCache.clear();
  totalHeadCacheBytes = 0;
}

// ⚡️ LAHZADA OCHILISH: Yangi video boshini RAM va diskka oldindan parallel keshlab qo'yish
async function prefetchVideoHead(channelId, messageId, meta) {
  try {
    if (!meta || !meta.document) return;
    const cleanId = String(channelId).replace(/^-100/, '').replace(/^-/, '');
    const headKey = `${cleanId}_${messageId}_head`;
    if (getVideoHead(headKey)) return;

    const tgClient = await getTelegramClient();
    const fileLocation = createDocumentLocation(meta.document);
    const chunkLimit = Math.ceil(HEAD_BUFFER_SIZE / TG_CHUNK_SIZE);
    const sender = await tgClient.getSender(meta.document.dcId);

    const promises = [];
    for (let i = 0; i < chunkLimit; i++) {
      promises.push(
        tgClient.invokeWithSender(
          new Api.upload.GetFile({
            location: fileLocation,
            offset: bigInt(i * TG_CHUNK_SIZE),
            limit: TG_CHUNK_SIZE,
          }),
          sender
        ).then(r => r ? r.bytes : null).catch(() => null)
      );
    }

    const chunks = await Promise.all(promises);
    const validChunks = chunks.filter(c => c && c.length > 0);
    if (validChunks.length > 0) {
      const fullHead = Buffer.concat(validChunks);
      storeVideoHead(headKey, fullHead);
      console.log(`⚡️ [Prefetch] Video boshlanishi ultra-tezkor keshlandi: #${messageId} (${formatBytes(fullHead.length)})`);
    }
  } catch (err) {
    console.warn(`⚠️ [Prefetch] Boshlang'ich kesh olishda ogohlantirish:`, err?.message || err);
  }
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
// ULTRA-FAST PIPELINED TELEGRAM STREAM DOWNLOADER
// ============================================================================
function createPipelinedDownloader({ tgClient, sender, fileLocation, alignedStart, chunkLimit, chunkSize = 524288, pipelineDepth = 4 }) {
  let isAborted = false;
  const inFlight = new Map();

  function triggerChunk(idx) {
    if (idx >= chunkLimit || isAborted) return;
    if (inFlight.has(idx)) return;

    const offset = bigInt(alignedStart).add(bigInt(idx * chunkSize));
    const reqPromise = tgClient.invokeWithSender(
      new Api.upload.GetFile({
        location: fileLocation,
        offset: offset,
        limit: chunkSize,
      }),
      sender
    ).then(res => (res ? res.bytes : null)).catch(err => {
      if (isAborted) return null;
      throw err;
    });

    inFlight.set(idx, reqPromise);
  }

  for (let i = 0; i < Math.min(pipelineDepth, chunkLimit); i++) {
    triggerChunk(i);
  }

  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < chunkLimit; i++) {
        if (isAborted) break;
        triggerChunk(i + pipelineDepth);

        const p = inFlight.get(i);
        inFlight.delete(i);
        if (!p) break;

        const chunk = await p;
        if (!chunk || chunk.length === 0 || isAborted) break;
        yield chunk;
      }
    },
    abort() {
      isAborted = true;
      inFlight.clear();
    }
  };
}

// ============================================================================
// TELEGRAM CLIENT (GRAMJS) - RESILIENT AUTO RE-AUTH & SELF-HEALING
// ============================================================================
let client = null;
let initPromise = null;
let currentSessionString = process.env.TG_STREAM_SESSION ? process.env.TG_STREAM_SESSION.trim() : '';

async function buildAndConnectClient(sessionStr) {
  let tg = null;
  let activeSession = sessionStr || '';

  // 1-bosqich: Mavjud sessiya bilan ulanishga urinish
  if (activeSession) {
    try {
      tg = new TelegramClient(new StringSession(activeSession), TG_API_ID, TG_API_HASH, {
        connectionRetries: 2,
        autoReconnect: true,
        floodSleepThreshold: 60,
        deviceModel: 'Animem Streamer',
        systemVersion: 'Linux',
        appVersion: '1.0.0',
        useWSS: false,
        connection: ConnectionTCPObfuscated,
      });

      await tg.connect();
      const isAuthorized = await tg.checkAuthorization().catch(() => false);
      if (isAuthorized) {
        return tg;
      }
      console.warn('⚠️ [Telegram] Sessiya avtorizatsiyadan o\'tmagan, bot token orqali yangilanadi...');
      try { await tg.disconnect(); } catch {}
      tg = null;
    } catch (err) {
      console.warn('⚠️ [Telegram] Mavjud sessiya bilan ulanishda xatolik:', err?.message || err);
      try { if (tg) await tg.disconnect(); } catch {}
      tg = null;
    }
  }

  // 2-bosqich: Toza yangi sessiya yaratish (botAuthToken orqali)
  if (TG_BOT_TOKEN) {
    console.log('🔄 [Telegram] Bot token orqali yangi toza sessiya yaratilmoqda...');
    tg = new TelegramClient(new StringSession(''), TG_API_ID, TG_API_HASH, {
      connectionRetries: 3,
      autoReconnect: true,
      floodSleepThreshold: 60,
      deviceModel: 'Animem Streamer',
      systemVersion: 'Linux',
      appVersion: '1.0.0',
      useWSS: false,
      connection: ConnectionTCPObfuscated,
    });

    await tg.start({ botAuthToken: TG_BOT_TOKEN });
    const newSess = tg.session.save();
    currentSessionString = newSess;
    try {
      fs.writeFileSync(SESSION_FILE, newSess);
      console.log('💾 [Telegram] Yangi ishchi bot sessiyasi saqlandi.');
    } catch {}
    return tg;
  }

  throw new Error('Telegram bot token (TG_STREAM_BOT_TOKEN) mavjud emas va sessiya yaroqsiz!');
}

async function getTelegramClient() {
  if (client && client.connected) return client;
  if (client && !client.connected) {
    try {
      await client.connect();
      if (client.connected) return client;
    } catch {}
  }
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      if (!currentSessionString && fs.existsSync(SESSION_FILE)) {
        try {
          const s = fs.readFileSync(SESSION_FILE, 'utf8').trim();
          if (s) currentSessionString = s;
        } catch {}
      }

      if (client) {
        try { await client.disconnect(); } catch {}
      }

      client = await buildAndConnectClient(currentSessionString);

      const me = await client.getMe().catch(() => null);
      if (me) {
        console.log(`🤖 [Telegram Bot] Muvaffaqiyatli ulandi: @${me.username} (ID: ${me.id})`);
      }

      registerTelegramEventHandler(client);
      return client;
    } catch (err) {
      console.error('❌ [Telegram Bot] Ulanishda jiddiy xatolik:', err?.message || err);
      throw err;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

// Telegram kanalga yangi video qo'shilganda xabar berish
const processedTelegramMessages = new Set();
let isEventHandlerRegistered = false;

function registerTelegramEventHandler(tgClient) {
  if (isEventHandlerRegistered) return;
  isEventHandlerRegistered = true;

  tgClient.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message) return;
      if (message.out) return; // Botning o'z xabarlariga javob bermaslik

      const channelIdRaw = message.peerId?.channelId 
        ? message.peerId.channelId.toString() 
        : (message.chatId ? message.chatId.toString() : '');
      const cleanChannelId = channelIdRaw.replace(/^-100/, '').replace(/^-/, '');
      const messageId = message.id;

      if (!cleanChannelId || !messageId) return;

      // Agar xabar kanalga bog'langan guruhdagi avto-forward bo'lsa, tashlab ketish (faqat asosiy kanal postiga javob beriladi)
      if (message.fwdFrom) {
        return;
      }

      // Takroriy xabar yuborishning qat'iy oldini olish (Deduplication)
      const dedupeKey = `${cleanChannelId}_${messageId}`;
      if (processedTelegramMessages.has(dedupeKey)) {
        return;
      }

      const mediaInfo = extractMediaFromMessage(message);
      if (!mediaInfo) return;

      // Qayta ishlangan deb belgilash
      processedTelegramMessages.add(dedupeKey);
      if (processedTelegramMessages.size > 2000) {
        const oldest = processedTelegramMessages.values().next().value;
        processedTelegramMessages.delete(oldest);
      }

      console.log(`🎬 [Telegram Streamer] Yangi video aniqlandi: "${mediaInfo.fileName}" (${formatBytes(mediaInfo.size)}) - Post #${messageId}`);

      const chat = message.chat || event.chat || (await message.getChat().catch(() => null));
      if (cleanChannelId && chat && chat.accessHash) {
        knownChannels.set(cleanChannelId, {
          channelId: cleanChannelId,
          accessHash: chat.accessHash.toString(),
          title: chat.title || ''
        });
        savePersistedChannels();
      }

      const cacheKey = `${cleanChannelId}_${messageId}`;
      mediaMetaCache.set(cacheKey, mediaInfo);
      savePersistedMetadata();

      // ⚡️ LAHZADA OCHILISH: Yangi video tushishi bilan birinchi 2MB ni orqa fonda keshlab qo'yish (<1ms start)
      prefetchVideoHead(cleanChannelId, messageId, mediaInfo).catch(() => {});

      const directUrl = `https://${TG_STREAM_DOMAIN}/api/medi/${cleanChannelId}/${messageId}.mp4`;
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

      const streamLinksBlock = 
        `⚡️ <b>1. To'g'ridan-to'g'ri MP4 havola:</b>\n` +
        `<code>${directUrl}</code>\n\n` +
        `📱 <b>2. Onlayn pleyer (brauzerda ko'rish):</b>\n` +
        `<code>${playerUrl}</code>\n\n` +
        `📺 <b>3. Iframe kodi (saytga joylash uchun):</b>\n` +
        `<code>&lt;iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allowfullscreen&gt;&lt;/iframe&gt;</code>\n\n`;

      const replyHtml = 
        `🎬 <b>Video muvaffaqiyatli qabul qilindi!</b>\n\n` +
        `📁 <b>Fayl:</b> <code>${mediaInfo.fileName}</code>\n` +
        `⚖️ <b>Hajmi:</b> <b>${formatBytes(mediaInfo.size)}</b>\n` +
        `⏱ <b>Davomiyligi:</b> ${formatDuration(mediaInfo.duration)}\n\n` +
        codecInfo +
        warningBlock +
        streamLinksBlock +
        `🚀 <i>Animem.uz ultra-tezkor MP4 oqim tizimi.</i>`;

      const targetPeer = message.peerId || message.chatId;

      // Xabarni AYNAN 1 MARTA yuborish
      try {
        await tgClient.sendMessage(targetPeer, {
          message: replyHtml,
          parseMode: 'html',
          replyTo: messageId
        });
        console.log(`✅ [Telegram Streamer] Javob havolasi yuborildi: #${messageId} (Kanal: ${cleanChannelId})`);
      } catch (replyErr) {
        try {
          await tgClient.sendMessage(targetPeer, {
            message: replyHtml,
            parseMode: 'html'
          });
          console.log(`✅ [Telegram Streamer] Javob post sifatida yuborildi: #${messageId}`);
        } catch (postErr) {
          console.error(`❌ [Telegram Streamer] Kanalga xabar yuborishda xatolik:`, postErr?.message || postErr);
        }
      }
    } catch (err) {
      console.error('❌ [Telegram Streamer] Yangi xabarni qayta ishlashda xatolik:', err?.message || err);
    }
  }, new NewMessage({}));
}

async function getStreamMetadata(channelId, messageId) {
  const cleanId = String(channelId).replace(/^-100/, '').replace(/^-/, '');
  const cacheKey = `${cleanId}_${messageId}`;

  // 1. RAM kesh
  const cached = mediaMetaCache.get(cacheKey);
  if (cached && (Date.now() - cached.cachedAt < 7 * 86400000)) {
    return cached;
  }

  // 2. Disk kesh (metadata.json)
  if (fs.existsSync(METADATA_FILE)) {
    try {
      const fileData = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
      if (fileData[cacheKey]) {
        mediaMetaCache.set(cacheKey, fileData[cacheKey]);
        return fileData[cacheKey];
      }
    } catch {}
  }

  // 3. Telegram MTProto orqali olish (2 marta urinish)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const tgClient = await Promise.race([
        getTelegramClient(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("TG connect timeout (15s)")), 15000))
      ]);

      const normalizedChannelId = String(channelId).startsWith('-100')
        ? channelId
        : (String(channelId).startsWith('-') ? `-100${String(channelId).slice(1)}` : `-100${channelId}`);

      let peer;
      const ch = knownChannels.get(cleanId) || knownChannels.get(channelId);
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
      if (!messages || !messages[0]) {
        if (attempt === 1) {
          await new Promise(r => setTimeout(r, 600));
          continue;
        }
        return null;
      }

      const mediaInfo = extractMediaFromMessage(messages[0]);
      if (!mediaInfo) return null;

      mediaMetaCache.set(cacheKey, mediaInfo);
      savePersistedMetadata();
      return mediaInfo;
    } catch (err) {
      console.error(`[Telegram Streamer] Metadata olishda urinish #${attempt} xatolik #${messageId}:`, err?.message || err);
      const msg = String(err?.message || '');
      if (msg.includes('AUTH_KEY') || msg.includes('SESSION_REVOKED')) {
        client = null;
        currentSessionString = '';
      }
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  return null;
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
    service: 'Animem S3 Video Streamer (Ultra-Fast MP4 Engine)',
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

// ============================================================================
// ANIMEM.UZ S3 MEDIA ENGINE LANDING PAGE (UI)
// ============================================================================
function renderLandingPageHtml() {
  return `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Animem.uz | S3 Video Storage & High-Speed Media Engine</title>
  <link rel="icon" href="https://animem.uz/favicon.ico" type="image/x-icon">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #07080f;
      --card-bg: rgba(15, 17, 28, 0.7);
      --card-border: rgba(139, 92, 246, 0.18);
      --primary: #8b5cf6;
      --cyan: #06b6d4;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      overflow-x: hidden;
      position: relative;
    }
    .glow-1 {
      position: absolute;
      top: -150px;
      left: 50%;
      transform: translateX(-50%);
      width: 700px;
      height: 450px;
      background: radial-gradient(circle, rgba(139, 92, 246, 0.22) 0%, rgba(6, 182, 212, 0.08) 50%, transparent 70%);
      filter: blur(80px);
      pointer-events: none;
      z-index: 0;
    }
    .glow-2 {
      position: absolute;
      bottom: 50px;
      right: -100px;
      width: 500px;
      height: 400px;
      background: radial-gradient(circle, rgba(236, 72, 153, 0.12) 0%, transparent 70%);
      filter: blur(90px);
      pointer-events: none;
      z-index: 0;
    }
    .grid-overlay {
      position: absolute;
      inset: 0;
      background-image: 
        linear-gradient(to right, rgba(255, 255, 255, 0.03) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
      background-size: 40px 40px;
      mask-image: radial-gradient(ellipse at center, black 40%, transparent 80%);
      -webkit-mask-image: radial-gradient(ellipse at center, black 40%, transparent 80%);
      pointer-events: none;
      z-index: 0;
    }
    .container {
      max-width: 1040px;
      margin: 0 auto;
      padding: 40px 24px;
      position: relative;
      z-index: 1;
      width: 100%;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 40px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      text-decoration: none;
      color: inherit;
    }
    .logo-badge {
      background: linear-gradient(135deg, #8b5cf6, #3b82f6);
      color: #fff;
      font-weight: 800;
      font-size: 16px;
      padding: 8px 14px;
      border-radius: 12px;
      letter-spacing: 1px;
      box-shadow: 0 4px 20px rgba(139, 92, 246, 0.4);
    }
    .logo-text {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .logo-sub {
      font-size: 11px;
      color: var(--cyan);
      font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase;
      letter-spacing: 1.5px;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.3);
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      color: #34d399;
      font-family: 'JetBrains Mono', monospace;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      background-color: #10b981;
      border-radius: 50%;
      box-shadow: 0 0 10px #10b981;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
      70% { transform: scale(1.05); box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }
    .hero {
      text-align: center;
      padding: 60px 0 50px 0;
    }
    .hero-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(139, 92, 246, 0.12);
      border: 1px solid rgba(139, 92, 246, 0.3);
      padding: 6px 16px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      color: #c084fc;
      margin-bottom: 24px;
    }
    .hero-title {
      font-size: clamp(32px, 5vw, 54px);
      font-weight: 800;
      line-height: 1.15;
      letter-spacing: -1.5px;
      margin-bottom: 20px;
    }
    .gradient-text {
      background: linear-gradient(135deg, #ffffff 30%, #c084fc 70%, #38bdf8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .hero-desc {
      font-size: clamp(16px, 2vw, 19px);
      color: var(--text-muted);
      max-width: 680px;
      margin: 0 auto 36px auto;
      line-height: 1.6;
    }
    .cta-group {
      display: flex;
      justify-content: center;
      gap: 16px;
      flex-wrap: wrap;
    }
    .btn-primary {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      background: linear-gradient(135deg, #8b5cf6, #6366f1);
      color: #ffffff;
      padding: 16px 36px;
      border-radius: 14px;
      font-size: 16px;
      font-weight: 700;
      text-decoration: none;
      box-shadow: 0 10px 25px rgba(124, 58, 237, 0.35);
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      border: 1px solid rgba(255, 255, 255, 0.15);
    }
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 16px 35px rgba(124, 58, 237, 0.5);
      background: linear-gradient(135deg, #9333ea, #4f46e5);
    }
    .btn-secondary {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(255, 255, 255, 0.05);
      color: #e2e8f0;
      padding: 16px 28px;
      border-radius: 14px;
      font-size: 15px;
      font-weight: 600;
      text-decoration: none;
      border: 1px solid rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(10px);
      transition: all 0.2s ease;
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #ffffff;
      border-color: rgba(255, 255, 255, 0.2);
    }
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
      margin: 40px 0;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      padding: 28px;
      backdrop-filter: blur(16px);
      transition: all 0.3s ease;
    }
    .card:hover {
      transform: translateY(-3px);
      border-color: rgba(139, 92, 246, 0.4);
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.4);
    }
    .card-icon {
      width: 48px;
      height: 48px;
      border-radius: 12px;
      background: rgba(139, 92, 246, 0.15);
      border: 1px solid rgba(139, 92, 246, 0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      margin-bottom: 18px;
    }
    .card h3 {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 8px;
      letter-spacing: -0.3px;
    }
    .card p {
      font-size: 14px;
      color: var(--text-muted);
      line-height: 1.5;
    }
    footer {
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      padding: 24px;
      text-align: center;
      font-size: 13px;
      color: #64748b;
      position: relative;
      z-index: 1;
    }
    footer a { color: #94a3b8; text-decoration: none; }
    footer a:hover { color: #c084fc; }
  </style>
</head>
<body>
  <div class="glow-1"></div>
  <div class="glow-2"></div>
  <div class="grid-overlay"></div>

  <div class="container">
    <header>
      <a href="https://animem.uz" class="brand">
        <div class="logo-badge">ANIMEM</div>
        <div>
          <div class="logo-text">Animem.uz</div>
          <div class="logo-sub">S3 Media Storage</div>
        </div>
      </a>
      <div class="status-pill">
        <div class="status-dot"></div>
        <span>SERVER ISHLAMOQDA</span>
      </div>
    </header>

    <main class="hero">
      <div class="hero-tag">
        <span>⚡️ Animem.uz Rasmiy Video Infratuzilmasi</span>
      </div>
      <h1 class="hero-title">
        Yuqori Tezlikdagi <span class="gradient-text">Video Serveri</span>
      </h1>
      <p class="hero-desc">
        Ushbu klaster <b>Animem.uz</b> portali uchun maxsus ajratilgan S3 video saqlash va ultra-tezkor to'g'ridan-to'g'ri MP4 oqim (HTTP 206) tizimidir. Barcha animelar qotmasdan, lahzada ochiladi.
      </p>
      <div class="cta-group">
        <a href="https://animem.uz" class="btn-primary">
          <span>Saytga kirish</span>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>
        </a>
        <a href="https://t.me/AnimemUzb" target="_blank" rel="noopener" class="btn-secondary">
          <span>Telegram kanalimiz</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
        </a>
      </div>
    </main>

    <section class="cards-grid">
      <div class="card">
        <div class="card-icon">⚡️</div>
        <h3>Ultra-Tezkor Oqim</h3>
        <p>1080p Full HD sifat va 0-buferlash. Apparat tezlanishi orqali videolarni lahzada o'ynatish.</p>
      </div>
      <div class="card">
        <div class="card-icon">🛡</div>
        <h3>Ishonchli S3 Klaster</h3>
        <p>Telegram MTProto xavfsiz tarmog'i bilan uzviy bog'langan global saqlash arxitekturasi.</p>
      </div>
      <div class="card">
        <div class="card-icon">🚀</div>
        <h3>Keng O'tkazuvchanlik</h3>
        <p>10,000+ bir vaqtdagi tomoshabinlar uchun qotmasdan, kechikishsiz uzluksiz video oqimi.</p>
      </div>
    </section>
  </div>

  <footer>
    <p>&copy; 2026 <a href="https://animem.uz">Animem.uz</a>. Barcha huquqlar himoyalangan. | S3 Media Engine</p>
  </footer>
</body>
</html>`;
}

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderLandingPageHtml());
});

// ============================================================================
// 1. ULTRA-FAST DIRECT MP4 STREAM HANDLER (HTTP 206 Partial Content)
// Yangi havola: /api/medi/:channelId/:messageId.mp4
// Eski havolalar: /api/tgstream/:channelId/:messageId va /api/media/...
// ============================================================================

app.get([
  '/api/medi/:channelId/:messageId',
  '/api/media/:channelId/:messageId',
  '/api/tgstream/:channelId/:messageId'
], async (req, res) => {
  let { channelId, messageId } = req.params;
  const cleanMessageId = messageId ? String(messageId).replace(/\.mp4$/i, '') : '';
  const numMsgId = parseInt(cleanMessageId, 10);
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

    // ⚡️ LAHZADA OCHILISH (INSTANT START): Video boshi RAM yoki disk keshda bo'lsa darhol uzatish (<1ms)
    let bytesSentFromHead = 0;
    if (start === 0) {
      const cachedHead = getVideoHead(headKey);
      if (cachedHead && cachedHead.length > 0) {
        if (chunkSize <= cachedHead.length) {
          return res.end(cachedHead.subarray(0, chunkSize));
        } else {
          res.write(cachedHead);
          bytesSentFromHead = cachedHead.length;
        }
      }
    }

    const effectiveStart = start + bytesSentFromHead;
    const effectiveBytesRemaining = chunkSize - bytesSentFromHead;

    if (effectiveBytesRemaining <= 0) {
      return res.end();
    }

    const tgClient = await getTelegramClient();
    const fileLocation = createDocumentLocation(meta.document);
    const sender = await tgClient.getSender(meta.document.dcId);

    const alignedStart = Math.floor(effectiveStart / TG_CHUNK_SIZE) * TG_CHUNK_SIZE;
    const skipBytes = effectiveStart - alignedStart;
    const totalBytesToFetch = effectiveBytesRemaining + skipBytes;
    const chunkLimit = Math.ceil(totalBytesToFetch / TG_CHUNK_SIZE);

    const downloader = createPipelinedDownloader({
      tgClient,
      sender,
      fileLocation,
      alignedStart,
      chunkLimit,
      chunkSize: TG_CHUNK_SIZE,
      pipelineDepth: 4
    });

    const cleanupStream = () => {
      downloader.abort();
    };

    req.on('close', cleanupStream);
    res.on('error', cleanupStream);

    let bytesRemaining = effectiveBytesRemaining;
    let skipped = 0;
    const headChunks = [];
    let headBytes = 0;
    let headStored = false;

    try {
      for await (const chunk of downloader) {
        if (res.writableEnded || res.destroyed) break;

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

        if (start === 0 && bytesSentFromHead === 0 && !headStored) {
          headChunks.push(slice);
          headBytes += slice.length;
          if (headBytes >= HEAD_BUFFER_SIZE) {
            storeVideoHead(headKey, Buffer.concat(headChunks));
            headStored = true;
          }
        }

        if (bytesRemaining <= 0) break;

        if (!ok && !res.writableEnded) {
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
    } catch (streamErr) {
      console.error(`❌ [Streamer] Oqim uzatishda xatolik (#${numMsgId}):`, streamErr?.message || streamErr);
    } finally {
      cleanupStream();
      req.removeListener('close', cleanupStream);
      res.removeListener('error', cleanupStream);
    }

    if (start === 0 && bytesSentFromHead === 0 && !headStored && headChunks.length > 0) {
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
    const errText = String(err?.message || '');
    if (errText.includes('AUTH_KEY') || errText.includes('SESSION_REVOKED')) {
      client = null;
      currentSessionString = '';
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
// 2. LEGACY HLS REDIRECT (Avvalgi HLS havolalarni to'g'ridan-to'g'ri yangi MP4 ga yo'naltirish)
// ============================================================================
app.get([
  '/api/tghls/:channelId/:messageId/master.m3u8',
  '/api/tghls/:channelId/:messageId/playlist.m3u8',
  '/api/tghls/:channelId/:messageId/index.m3u8',
  '/api/tghls/:channelId/:messageId/segment_:segNum.ts',
  '/api/tghls/:channelId/:messageId'
], (req, res) => {
  const { channelId, messageId } = req.params;
  const cleanId = channelId ? channelId.replace(/^-100/, '').replace(/^-/, '') : '';
  const cleanMsgId = messageId ? messageId.replace(/\.mp4$/i, '') : '';
  return res.redirect(301, `/api/medi/${cleanId}/${cleanMsgId}.mp4`);
});

// ============================================================================
// 3. EMBED & NATIVE BROWSER PLAYER (Ultra-Fast Hardware Accelerated Play)
// ============================================================================
app.get(['/player/:channelId/:messageId', '/embed/:channelId/:messageId'], (req, res) => {
  const { channelId, messageId } = req.params;
  const cleanId = channelId ? channelId.replace(/^-100/, '').replace(/^-/, '') : '';
  const cleanMsgId = messageId ? messageId.replace(/\.mp4$/i, '') : '';
  const mp4Url = `/api/medi/${cleanId}/${cleanMsgId}.mp4`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Animem Video Stream</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: #050508; overflow: hidden; display: flex; align-items: center; justify-content: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .video-wrap { position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: #000; }
    video { width: 100%; height: 100%; max-height: 100vh; object-fit: contain; outline: none; }
    .badge { position: absolute; top: 12px; right: 12px; background: rgba(5, 5, 8, 0.85); backdrop-filter: blur(8px); color: #38bdf8; padding: 5px 12px; border-radius: 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; pointer-events: none; z-index: 10; border: 1px solid rgba(56,189,248,0.3); box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
  </style>
</head>
<body>
  <div class="video-wrap">
    <div id="badge" class="badge">🚀 ANIMEM MP4</div>
    <video id="video" src="${mp4Url}" controls autoplay playsinline preload="auto"></video>
  </div>
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

    // 2. ./cache papkasidagi kesh fayllar (session, channels, metadata va heads daxlsiz saqlanadi)
    if (fs.existsSync(CACHE_DIR)) {
      const cacheEntries = fs.readdirSync(CACHE_DIR);
      for (const entry of cacheEntries) {
        if (entry === 'session.txt' || entry === 'channels.json' || entry === 'metadata.json' || entry === 'heads') {
          continue;
        }
        const fullPath = path.join(CACHE_DIR, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
            deletedFiles++;
          } else if (entry.endsWith('.ts') || entry.endsWith('.mp4') || entry.endsWith('.part') || entry.endsWith('.tmp')) {
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
  console.log(`⚙️  [Konfiguratsiya] RAM: ${RAM_LIMIT_MB}MB | Head Cache: ${formatBytes(MAX_HEAD_CACHE_BYTES)} | Rejim: Ultra-Fast Direct MP4 Engine 🚀`);
  setTimeout(() => {
    getTelegramClient().catch(err => {
      console.warn('⚠️ [Telegram Bot] Dastlabki ulanishda ogohlantirish:', err?.message || err);
    });
  }, 3000);
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
