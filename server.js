/**
 * ============================================================================
 * ANIMEM.UZ - STANDALONE TELEGRAM HLS & MP4 VIDEO STREAMING BOT SERVER
 * ============================================================================
 * 
 * Ushbu server Telegram kanallariga tashlangan videolarni to'g'ridan-to'g'ri:
 * 1. HLS (.m3u8) formatida YouTube tezligida, 10,000+ kishiga qotmasdan stream qiladi.
 * 2. MP4 (HTTP 206 Partial Content) formatida to'g'ridan-to'g'ri uzatadi.
 * 3. Anti-leech (begona saytlardan o'g'irlab qo'yishdan) himoya qiladi.
 * 4. Kanalga video yuklanganda orqa fonda avtomatik HLS ga bo'lib tayyorlab qo'yadi.
 * 5. VPS diskini va keshini har 1 soatda avtomatik tozalaydi.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const { EventEmitter } = require('events');

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

// 2. Kutubxonalar tekshiruvi
if (!fs.existsSync(path.join(__dirname, 'node_modules', 'express')) || !fs.existsSync(path.join(__dirname, 'node_modules', 'telegram'))) {
  console.log('📦 VPS da kerakli kutubxonalar topilmadi. Avtomatik "npm install" bajarilmoqda...');
  try {
    execSync('npm install --production', { cwd: __dirname, stdio: 'inherit' });
    console.log('✅ Barcha kerakli kutubxonalar muvaffaqiyatli o\'rnatildi!');
  } catch (err) {
    console.error('❌ Avtomatik npm install da xatolik:', err?.message || err);
  }
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
const HLS_SEGMENT_DURATION = 6; // 6 soniyalik HLS segmentlar
const HLS_MAX_CACHE_ITEMS = 120; // RAM kesh limiti (segmentlar soni)
const HLS_CACHE_DIR = process.env.HLS_CACHE_DIR || path.join(__dirname, 'cache');

if (!fs.existsSync(HLS_CACHE_DIR)) {
  fs.mkdirSync(HLS_CACHE_DIR, { recursive: true });
}

// Doimiy ishlaydigan zaxira sessiya (AUTH_KEY_UNREGISTERED va FLOOD_WAIT ning oldini oladi)
const DEFAULT_VERIFIED_SESSION = '1AgAOMTQ5LjE1NC4xNjcuNDEBuywqrlzOPyU0sP4U6A7NVpWC/gLSpY2bbRYaFBIdHRVsJnd86O8OKpuUir7VATMWKi+wk8YIDcRixe3pTEFv+inxUOXKMfsagtr55/PXSTSSR3nxiFAcSB/E/doUP4nrBIfzMtipBUi47UyXxYgT+4yQgRENmHAfZqSQQ2YPdIA7VxX7xwBW6rOSl782FIRRLRdosyE6QRaxqssV9pAqtM2z4FNXAhMQg5ILwsw12Prxs5RMey+7I5kqOrJ89ZVgqY/ivh5QWetHupZ5pTBjBPLgLwHnSAJhJLpYXrfyFBs8OvZ+pgPMyEnFLKfO2CPrffPFAo8O4AFmzllGCjGGNxY=';
const SESSION_FILE = path.join(HLS_CACHE_DIR, 'session.txt');
const CHANNELS_FILE = path.join(HLS_CACHE_DIR, 'channels.json');
const METADATA_FILE = path.join(HLS_CACHE_DIR, 'metadata.json');

// FFmpeg binar faylini aniqlash
function getFfmpegBinary() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  const candidatePaths = [
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/home/kali/.bun/install/cache/@ffmpeg-installer/linux-x64@4.1.0@@@1/ffmpeg',
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
}

// In-memory va doimiy keshlash
const mediaMetaCache = new Map();
const videoHeadCache = new Map();
const hlsSegmentCache = new Map();
const activeVideoDownloads = new Map();
const videoAccessMap = new Map();

// Ma'lum kanallar ro'yxati (MTProto da accessHash bo'lmasa entity topilmaydi)
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
    const obj = {};
    for (const [k, v] of mediaMetaCache.entries()) obj[k] = v;
    fs.writeFileSync(METADATA_FILE, JSON.stringify(obj, null, 2));
  } catch {}
}

loadPersistedData();

function touchVideoAccess(key) {
  videoAccessMap.set(key, Date.now());
}

// ============================================================================
// KESH VA DISKNI AVTOMATIK TOZALASH (HAR 1 SOATDA)
// ============================================================================
function cleanDiskSpace() {
  try {
    if (!fs.existsSync(HLS_CACHE_DIR)) return;
    const now = Date.now();
    const entries = fs.readdirSync(HLS_CACHE_DIR);
    const folderStats = [];
    let totalCacheBytes = 0;

    for (const entry of entries) {
      const fullPath = path.join(HLS_CACHE_DIR, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          // Ayni paytda faol yuklanayotgan videoni o'chirib yubormaslik
          if (activeVideoDownloads.has(entry)) {
            continue;
          }

          let dirSize = 0;
          let latestTime = stat.mtimeMs;
          const lastAccessed = videoAccessMap.get(entry) || stat.mtimeMs;
          const files = fs.readdirSync(fullPath);

          for (const f of files) {
            const fPath = path.join(fullPath, f);
            try {
              const fStat = fs.statSync(fPath);
              dirSize += fStat.size;
              if (fStat.mtimeMs > latestTime) latestTime = fStat.mtimeMs;

              // 30 daqiqadan eski chala .part fayllarni tozalash (yuklash uzilib qolgan bo'lsa)
              if (f.endsWith('.part') && (now - fStat.mtimeMs > 30 * 60 * 1000)) {
                try { fs.unlinkSync(fPath); } catch {}
              }
              // 10 daqiqadan eski vaqtinchalik temp_seg fayllarni tozalash
              if (f.startsWith('temp_seg_') && (now - fStat.mtimeMs > 10 * 60 * 1000)) {
                try { fs.unlinkSync(fPath); } catch {}
              }
            } catch {}
          }

          const effectiveTime = Math.max(latestTime, lastAccessed);

          // 24 soatdan ortiq foydalanilmagan kesh papkalarini o'chirish
          if (now - effectiveTime > 24 * 3600 * 1000) {
            try { fs.rmSync(fullPath, { recursive: true, force: true }); } catch {}
            videoAccessMap.delete(entry);
            continue;
          }

          totalCacheBytes += dirSize;
          folderStats.push({ path: fullPath, size: dirSize, time: effectiveTime, key: entry });
        }
      } catch {}
    }

    // Disk keshining umumiy hajmi 2.5 GB dan oshsa, eng eski foydalanilmagan papkalarni o'chirish
    const MAX_CACHE_BYTES = 2.5 * 1024 * 1024 * 1024;
    const TARGET_CACHE_BYTES = 1.2 * 1024 * 1024 * 1024;
    if (totalCacheBytes > MAX_CACHE_BYTES) {
      folderStats.sort((a, b) => a.time - b.time);
      for (const item of folderStats) {
        if (totalCacheBytes <= TARGET_CACHE_BYTES) break;
        // Oxirgi 4 soat ichida ko'rilgan videolarni o'chirmaslik
        if (now - item.time < 4 * 3600 * 1000) continue;
        try {
          fs.rmSync(item.path, { recursive: true, force: true });
          videoAccessMap.delete(item.key);
          totalCacheBytes -= item.size;
        } catch {}
      }
    }

    // Bo'sh qolgan papkalarni tozalash
    const remainingEntries = fs.readdirSync(HLS_CACHE_DIR);
    for (const entry of remainingEntries) {
      const fullPath = path.join(HLS_CACHE_DIR, entry);
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
          const inner = fs.readdirSync(fullPath);
          if (inner.length === 0) {
            fs.rmdirSync(fullPath);
          }
        }
      } catch {}
    }

    // RAM keshini tozalash (xotira toshishining oldini olish)
    if (hlsSegmentCache.size > HLS_MAX_CACHE_ITEMS) {
      hlsSegmentCache.clear();
    }
  } catch (err) {
    console.warn('[Disk Cleaner] Tozalashda ogohlantirish:', err?.message || err);
  }
}

// Har 1 soatda avtomatik tozalab turish (3600000 ms)
setInterval(cleanDiskSpace, 3600000);
// Server ishga tushishi bilan bir marta tozalash
cleanDiskSpace();

// ============================================================================
// YORDAMCHI FUNKSIYALAR
// ============================================================================
function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return 'Noma\'lum';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Anti-Leech: Faqat Animem.uz va rasmiy brauzer pleyerlariga ruxsat berish
function isAuthorizedStreamRequest(req) {
  const referer = req.headers.referer || req.headers.referrer;
  const origin = req.headers.origin;

  if (referer) {
    try {
      const refUrl = new URL(referer);
      const host = refUrl.hostname.toLowerCase();
      const isAllowedHost = 
        host === 'animem.uz' || 
        host.endsWith('.animem.uz') || 
        host.endsWith('.telegram.org') || 
        host === 'telegram.org' || 
        host === 't.me' || 
        host === 'localhost' || 
        host === '127.0.0.1';
      if (!isAllowedHost) {
        return { allowed: false, reason: `Ruxsat etilmagan referer: ${host}` };
      }
    } catch {
      return { allowed: true };
    }
  }

  if (origin) {
    try {
      const origUrl = new URL(origin);
      const host = origUrl.hostname.toLowerCase();
      const isAllowedHost = 
        host === 'animem.uz' || 
        host.endsWith('.animem.uz') || 
        host.endsWith('.telegram.org') || 
        host === 'telegram.org' || 
        host === 't.me' || 
        host === 'localhost' || 
        host === '127.0.0.1';
      if (!isAllowedHost) {
        return { allowed: false, reason: `Ruxsat etilmagan origin: ${host}` };
      }
    } catch {
      return { allowed: true };
    }
  }

  return { allowed: true };
}

// Telegram xabaridan video ma'lumotlarini ajratish
function extractMediaFromMessage(message) {
  if (!message || !message.media) return null;
  const doc = message.media.document || message.media.video;
  if (!doc) return null;

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

// ============================================================================
// TELEGRAM MIJOZI (GRAMJS) VA XABARLARNI TINGLASH
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
    session.setDC(2, '149.154.167.41', 443);

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

      // Agar chat mavjud bo'lsa va uning accessHash bor bo'lsa, saqlab qo'yamiz
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

      const hlsUrl = `https://${TG_STREAM_DOMAIN}/api/tghls/${cleanChannelId}/${messageId}/master.m3u8`;
      const playerUrl = `https://${TG_STREAM_DOMAIN}/player/${cleanChannelId}/${messageId}`;
      const mp4Url = `https://${TG_STREAM_DOMAIN}/api/tgstream/${cleanChannelId}/${messageId}`;

      let codecInfo = `🎞 <b>Format:</b> <code>H.264 (AVC)</code> ✅ <i>(Brauzerlarga 100% mos)</i>\n\n`;
      let warningBlock = '';

      if (mediaInfo.isHevc) {
        codecInfo = `🎞 <b>Format:</b> <code>HEVC (H.265 / x265)</code> ⚠️\n\n`;
        warningBlock = 
          `⚠️ <b>DIQQAT (Format Ogohlantirishi):</b>\n` +
          `Ushbu video <b>HEVC (H.265)</b> formatida! Brauzerlar (ayniqsa kompyuterlarda) bu videoni <b>faqat audio</b> qilib ochishi mumkin.\n` +
          `💡 <i>Saytda barcha foydalanuvchilarda video to'liq ochilishi uchun videolarni <b>H.264 (x264 / AVC)</b> formatida yuklang!</i>\n\n`;
      }

      const replyHtml = 
        `🎬 <b>Video Muvaffaqiyatli Qabul Qilindi!</b>\n\n` +
        `📁 <b>Fayl:</b> <code>${mediaInfo.fileName}</code>\n` +
        `⚖️ <b>Hajmi:</b> <b>${formatBytes(mediaInfo.size)}</b>\n` +
        `⏱ <b>Davomiyligi:</b> ${formatDuration(mediaInfo.duration)}\n` +
        codecInfo +
        warningBlock +
        `⚡️ <b>1. HLS Stream Havolasi (Sayt va Pleyer uchun eng tezkori):</b>\n` +
        `<code>${hlsUrl}</code>\n\n` +
        `▶️ <b>2. Onlayn Pleyer (Brauzerda to'g'ridan-to'g'ri ko'rish):</b>\n` +
        `<code>${playerUrl}</code>\n\n` +
        `🔗 <b>3. To'g'ridan-to'g'ri MP4 URL (Zaxira oqim):</b>\n` +
        `<code>${mp4Url}</code>\n\n` +
        `🛡 <b>Xavfsizlik:</b> Faqat Animem.uz saytida va rasmiy brauzer pleyerida ishlaydi.\n\n` +
        `💡 <i>Sayt Admin panelidagi "video_url" maydoniga <b>HLS (.m3u8)</b> havolasini qo'ying. Video hech qanday qotishlarsiz, YouTube kabi bir zumda ochiladi va oxirigacha to'liq o'ynaydi!</i>`;

      await tgClient.sendMessage(message.chatId, {
        message: replyHtml,
        parseMode: 'html',
        replyTo: messageId
      });

      console.log(`[Telegram Streamer] Replied with HLS stream URLs for message #${messageId} in channel ${cleanChannelId}`);

      // Kanalga video tashlangan zahoti orqa fonda darhol HLS ga bo'lib tayyorlashni boshlash!
      ensureVideoProcessing(cleanChannelId, messageId).catch(err => {
        console.warn(`[HLS Streamer] Auto pre-processing note (${cleanChannelId}/${messageId}):`, err?.message || err);
      });
    } catch (err) {
      console.warn('[Telegram Streamer] Error handling incoming video message:', err?.message || err);
    }
  }, new NewMessage({}));
}

async function getStreamMetadata(channelId, messageId) {
  const cleanId = String(channelId).replace(/^-100/, '').replace(/^-/, '');
  const cacheKey = `${cleanId}_${messageId}`;

  const cached = mediaMetaCache.get(cacheKey);
  if (cached && (Date.now() - cached.cachedAt < 86400000)) { // 24 soatlik xotira
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
// ASINXRON HLS SEGMENTATSIYA MOTORLARI (EVENT-LOOP QOTMAYDI)
// ============================================================================

function sliceSegmentAsync(inputFile, videoFolder, segIdx, isHevc = false) {
  const targetSegFile = path.join(videoFolder, `segment_${segIdx}.ts`);
  if (fs.existsSync(targetSegFile) && fs.statSync(targetSegFile).size > 1000) return Promise.resolve(true);

  const tempSegFile = path.join(videoFolder, `temp_seg_${segIdx}_${Date.now()}.ts`);
  const ffmpegBin = getFfmpegBinary();
  const startTime = segIdx * HLS_SEGMENT_DURATION;
  const bsfFilter = isHevc ? 'hevc_mp4toannexb' : 'h264_mp4toannexb';

  return new Promise((resolve) => {
    const ff = spawn(ffmpegBin, [
      '-ss', String(startTime),
      '-i', inputFile,
      '-t', String(HLS_SEGMENT_DURATION),
      '-c', 'copy',
      '-bsf:v', bsfFilter,
      '-avoid_negative_ts', 'make_zero',
      '-fflags', '+genpts',
      '-f', 'mpegts',
      '-y',
      tempSegFile
    ]);

    const timer = setTimeout(() => {
      try { ff.kill('SIGKILL'); } catch {}
      resolve(false);
    }, 12000);

    ff.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(tempSegFile) && fs.statSync(tempSegFile).size > 1000) {
        try {
          fs.renameSync(tempSegFile, targetSegFile);
          const buf = fs.readFileSync(targetSegFile);
          const cacheKey = `${path.basename(videoFolder)}_seg_${segIdx}`;
          hlsSegmentCache.set(cacheKey, buf);
          return resolve(true);
        } catch {
          return resolve(false);
        }
      }

      // Fallback: AAC audiosiga o'tkazish
      const fb = spawn(ffmpegBin, [
        '-ss', String(startTime),
        '-i', inputFile,
        '-t', String(HLS_SEGMENT_DURATION),
        '-c:v', 'copy',
        '-bsf:v', bsfFilter,
        '-c:a', 'aac',
        '-avoid_negative_ts', 'make_zero',
        '-fflags', '+genpts',
        '-f', 'mpegts',
        '-y',
        tempSegFile
      ]);

      const fbTimer = setTimeout(() => {
        try { fb.kill('SIGKILL'); } catch {}
        resolve(false);
      }, 15000);

      fb.on('close', (fbCode) => {
        clearTimeout(fbTimer);
        if (fbCode === 0 && fs.existsSync(tempSegFile) && fs.statSync(tempSegFile).size > 1000) {
          try {
            fs.renameSync(tempSegFile, targetSegFile);
            const buf = fs.readFileSync(targetSegFile);
            const cacheKey = `${path.basename(videoFolder)}_seg_${segIdx}`;
            hlsSegmentCache.set(cacheKey, buf);
            return resolve(true);
          } catch {}
        }
        if (fs.existsSync(tempSegFile)) {
          try { fs.unlinkSync(tempSegFile); } catch {}
        }
        resolve(false);
      });

      fb.on('error', () => {
        clearTimeout(fbTimer);
        resolve(false);
      });
    });

    ff.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function convertSourceToHlsAsync(sourceFile, videoFolder, indexFile, isHevc = false) {
  const ffmpegBin = getFfmpegBinary();
  const bsfFilter = isHevc ? 'hevc_mp4toannexb' : 'h264_mp4toannexb';

  return new Promise((resolve) => {
    const ff = spawn(ffmpegBin, [
      '-i', sourceFile,
      '-c', 'copy',
      '-bsf:v', bsfFilter,
      '-avoid_negative_ts', 'make_zero',
      '-fflags', '+genpts',
      '-f', 'hls',
      '-hls_time', String(HLS_SEGMENT_DURATION),
      '-hls_list_size', '0',
      '-hls_flags', 'independent_segments',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(videoFolder, 'segment_%d.ts'),
      '-y',
      indexFile
    ]);

    const timer = setTimeout(() => {
      try { ff.kill('SIGKILL'); } catch {}
      resolve(false);
    }, 180000);

    ff.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(indexFile)) {
        return resolve(true);
      }

      // Fallback
      const fb = spawn(ffmpegBin, [
        '-i', sourceFile,
        '-c:v', 'copy',
        '-bsf:v', bsfFilter,
        '-c:a', 'aac',
        '-avoid_negative_ts', 'make_zero',
        '-fflags', '+genpts',
        '-f', 'hls',
        '-hls_time', String(HLS_SEGMENT_DURATION),
        '-hls_list_size', '0',
        '-hls_flags', 'independent_segments',
        '-hls_playlist_type', 'vod',
        '-hls_segment_filename', path.join(videoFolder, 'segment_%d.ts'),
        '-y',
        indexFile
      ]);

      const fbTimer = setTimeout(() => {
        try { fb.kill('SIGKILL'); } catch {}
        resolve(false);
      }, 240000);

      fb.on('close', (fbCode) => {
        clearTimeout(fbTimer);
        resolve(fbCode === 0 && fs.existsSync(indexFile));
      });

      fb.on('error', () => {
        clearTimeout(fbTimer);
        resolve(false);
      });
    });

    ff.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// ============================================================================
// HLS ISHLOV BERISH VA YUKLASH NAVBATI
// ============================================================================
const MAX_CONCURRENT_PROCESSING = 2; // Bir vaqtda 2 tagacha video yuklanadi
let currentProcessingCount = 0;
const processingQueue = [];

function enqueueVideoTask(taskFn) {
  if (currentProcessingCount < MAX_CONCURRENT_PROCESSING) {
    currentProcessingCount++;
    taskFn().finally(() => {
      currentProcessingCount--;
      if (processingQueue.length > 0) {
        const nextTask = processingQueue.shift();
        enqueueVideoTask(nextTask);
      }
    });
  } else {
    processingQueue.push(taskFn);
  }
}

async function ensureVideoProcessing(channelId, messageId) {
  const cleanId = String(channelId).replace(/^-100/, '').replace(/^-/, '');
  const key = `${cleanId}_${messageId}`;
  touchVideoAccess(key);

  const videoFolder = path.join(HLS_CACHE_DIR, key);
  const partFile = path.join(videoFolder, 'source.mp4.part');
  const sourceFile = path.join(videoFolder, 'source.mp4');
  const indexFile = path.join(videoFolder, 'index.m3u8');

  if (fs.existsSync(indexFile)) return null;
  if (activeVideoDownloads.has(key)) return activeVideoDownloads.get(key);

  const meta = await getStreamMetadata(channelId, messageId);
  if (!meta || !meta.document) return null;

  if (!fs.existsSync(videoFolder)) {
    fs.mkdirSync(videoFolder, { recursive: true });
  }

  const emitter = new EventEmitter();
  emitter.setMaxListeners(200);
  emitter.on('error', () => {});

  const state = {
    channelId: cleanId,
    messageId,
    videoFolder,
    partFile,
    sourceFile,
    indexFile,
    bytesDownloaded: fs.existsSync(partFile) ? fs.statSync(partFile).size : 0,
    totalSize: meta.size,
    isCompleted: false,
    emitter,
  };

  activeVideoDownloads.set(key, state);

  enqueueVideoTask(async () => {
    let writeStream = null;
    let downloadStream = null;
    try {
      cleanDiskSpace();

      const tgClient = await getTelegramClient();
      const fileLocation = new Api.InputDocumentFileLocation({
        id: meta.document.id,
        accessHash: meta.document.accessHash,
        fileReference: meta.document.fileReference,
        thumbSize: '',
      });

      const TG_CHUNK_SIZE = 512 * 1024;
      let startOffset = state.bytesDownloaded;
      startOffset = Math.floor(startOffset / TG_CHUNK_SIZE) * TG_CHUNK_SIZE;
      state.bytesDownloaded = startOffset;

      const remainingBytes = meta.size - startOffset;
      const chunkLimit = Math.ceil(remainingBytes / TG_CHUNK_SIZE);

      writeStream = fs.createWriteStream(partFile, { flags: startOffset > 0 ? 'a' : 'w' });

      downloadStream = tgClient.iterDownload({
        file: fileLocation,
        dcId: meta.document.dcId,
        offset: bigInt(startOffset),
        limit: chunkLimit,
        chunkSize: TG_CHUNK_SIZE,
        requestSize: TG_CHUNK_SIZE,
      });

      let seg0Done = fs.existsSync(path.join(videoFolder, 'segment_0.ts'));
      let seg1Done = fs.existsSync(path.join(videoFolder, 'segment_1.ts'));

      for await (const chunk of downloadStream) {
        writeStream.write(chunk);
        state.bytesDownloaded += chunk.length;
        touchVideoAccess(key);
        state.emitter.emit('progress', state.bytesDownloaded);

        // Birinchi 2.5 MB tushgandayoq segment 0 ni kesib qo'yish (<1s tezkor start)
        if (!seg0Done && state.bytesDownloaded >= Math.min(meta.size, 2.5 * 1024 * 1024)) {
          sliceSegmentAsync(partFile, videoFolder, 0, meta.isHevc).then(ok => {
            if (ok) {
              seg0Done = true;
              state.emitter.emit('segment_ready', 0);
            }
          });
        }

        // 5 MB tushganda segment 1 ni kesib qo'yish
        if (!seg1Done && state.bytesDownloaded >= Math.min(meta.size, 5 * 1024 * 1024)) {
          sliceSegmentAsync(partFile, videoFolder, 1, meta.isHevc).then(ok => {
            if (ok) {
              seg1Done = true;
              state.emitter.emit('segment_ready', 1);
            }
          });
        }
      }

      await new Promise(resolve => writeStream.end(resolve));

      // Yuklab olish tugadi: .part ni .mp4 ga o'tkazish
      if (fs.existsSync(partFile)) {
        try { fs.renameSync(partFile, sourceFile); } catch {}
      }

      // Butun videoni birdaniga to'liq HLS segmentlariga bo'lib chiqish (asinxron, 1-2 soniya)
      console.log(`[HLS Streamer] Converting full video to HLS VOD playlist (${key})...`);
      const hlsOk = await convertSourceToHlsAsync(sourceFile, videoFolder, indexFile, meta.isHevc);

      state.isCompleted = true;
      state.emitter.emit('completed');

      // Segmentlar tayyor bo'lgach, diskni tejash uchun xom source.mp4 ni o'chirish
      if (hlsOk && fs.existsSync(sourceFile) && fs.existsSync(indexFile)) {
        try { fs.unlinkSync(sourceFile); } catch {}
      }

      console.log(`✅ [HLS Streamer] Video to'liq va muvaffaqiyatli HLS ga o'tkazildi (${key})!`);
    } catch (err) {
      console.warn(`[HLS Streamer] Background process error (${key}):`, err?.message || err);
      state.error = err?.message || String(err);
      state.emitter.emit('error', state.error);
    } finally {
      if (writeStream && !writeStream.destroyed) {
        try { writeStream.destroy(); } catch {}
      }
      if (typeof downloadStream?.return === 'function') {
        try { await downloadStream.return(); } catch {}
      }
      activeVideoDownloads.delete(key);
    }
  });

  return state;
}

// ============================================================================
// EXPRESS HTTP ROUTER & STREAMING HANDLERS
// ============================================================================
const app = express();
app.use(cors({ origin: true, credentials: true }));

// Server sog'ligini tekshirish (Health Check)
app.get(['/health', '/ping', '/'], (_req, res) => {
  res.status(200).send("Animem S3 Video Streamer is Running OK ✅");
});

// 1. Direct MP4 Stream Handler (Range Requests)
app.get('/api/tgstream/:channelId/:messageId', async (req, res) => {
  const { channelId, messageId } = req.params;
  const numMsgId = parseInt(messageId, 10);
  if (!channelId || isNaN(numMsgId)) {
    return res.status(400).json({ error: "Noto'g'ri parametrlar" });
  }

  const authCheck = isAuthorizedStreamRequest(req);
  if (!authCheck.allowed) {
    return res.status(403).json({ error: "Kirish taqiqlangan", detail: authCheck.reason });
  }

  const cleanId = channelId.replace(/^-100/, '').replace(/^-/, '');
  const cacheKey = `${cleanId}_${numMsgId}`;
  touchVideoAccess(cacheKey);
  const headKey = `${cacheKey}_head`;

  try {
    const meta = await getStreamMetadata(channelId, numMsgId);
    if (!meta || !meta.document) {
      return res.status(404).json({ error: "Video topilmadi yoki o'chirilgan" });
    }

    const totalSize = meta.size;
    const mimeType = meta.mimeType || 'video/mp4';
    const rangeHeader = req.headers.range;

    const origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');

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
          end = totalSize - 1;
        }
      }
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
    res.setHeader('Content-Type', mimeType);

    if (req.method === 'HEAD') return res.end();

    const HEAD_BUFFER_SIZE = 2 * 1024 * 1024;
    if (start === 0 && videoHeadCache.has(headKey)) {
      const cachedHead = videoHeadCache.get(headKey);
      if (chunkSize <= cachedHead.length) {
        return res.end(cachedHead.subarray(0, chunkSize));
      }
    }

    const tgClient = await getTelegramClient();
    const fileLocation = new Api.InputDocumentFileLocation({
      id: meta.document.id,
      accessHash: meta.document.accessHash,
      fileReference: meta.document.fileReference,
      thumbSize: '',
    });

    const TG_CHUNK_SIZE = 512 * 1024;
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

    req.on('close', () => { isAborted = true; });

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

    if (start === 0 && headChunks.length > 0 && !videoHeadCache.has(headKey)) {
      if (videoHeadCache.size > 200) {
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

// Helper: Brauzerda ochilganda YouTube uslubidagi Hls.js pleyerini chizish
function renderBrowserPlayerHtml(channelId, messageId, m3u8Url, mp4Url) {
  return `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Animem.uz - HLS Video Player</title>
  <link rel="icon" href="https://animem.uz/favicon.ico">
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #0b0c0f;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    .header {
      height: 52px;
      background: #14151a;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
      border-bottom: 1px solid #23252b;
      z-index: 10;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      color: #ff006a;
      font-weight: 800;
      font-size: 18px;
      letter-spacing: -0.5px;
    }
    .badge {
      background: rgba(255, 0, 106, 0.15);
      color: #ff006a;
      border: 1px solid rgba(255, 0, 106, 0.3);
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .btn {
      background: #23252b;
      color: #e0e0e0;
      border: 1px solid #33363f;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn:hover {
      background: #2d3039;
      color: #fff;
      border-color: #ff006a;
    }
    .btn-primary {
      background: #ff006a;
      border-color: #ff006a;
      color: #fff;
    }
    .btn-primary:hover {
      background: #e6005f;
    }
    .player-container {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #000;
      position: relative;
    }
    video {
      width: 100%;
      height: 100%;
      max-height: calc(100vh - 52px);
      outline: none;
      background: #000;
    }
    .loading-overlay {
      position: absolute;
      inset: 0;
      background: rgba(0,0,0,0.6);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 14px;
      z-index: 5;
      transition: opacity 0.3s ease;
    }
    .loading-overlay.hidden {
      opacity: 0;
      pointer-events: none;
    }
    .spinner {
      width: 44px;
      height: 44px;
      border: 4px solid rgba(255, 0, 106, 0.2);
      border-top-color: #ff006a;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .status-text {
      font-size: 13px;
      color: #bbb;
      font-weight: 500;
    }
  </style>
</head>
<body>
  <div class="header">
    <a href="https://animem.uz" class="logo" target="_blank">
      ANIMEM.UZ <span class="badge">HLS PRO STREAM</span>
    </a>
    <div class="actions">
      <a href="${mp4Url}" class="btn" title="To'g'ridan-to'g'ri MP4 oqimi">Direct MP4</a>
      <button class="btn" onclick="copyM3u8()" id="copyBtn">📋 Havolani olish</button>
      <a href="https://animem.uz" class="btn btn-primary" target="_blank">Animem.uz Sayti</a>
    </div>
  </div>

  <div class="player-container">
    <div class="loading-overlay" id="loader">
      <div class="spinner"></div>
      <div class="status-text" id="statusText">Video yuklanmoqda...</div>
    </div>
    <video id="video" controls autoplay playsinline preload="auto"></video>
  </div>

  <script>
    const m3u8Url = '${m3u8Url}';
    const mp4Url = '${mp4Url}';
    const video = document.getElementById('video');
    const loader = document.getElementById('loader');
    const statusText = document.getElementById('statusText');

    function hideLoader() {
      if (loader) loader.classList.add('hidden');
    }

    function showStatus(text) {
      if (statusText) statusText.innerText = text;
      if (loader) loader.classList.remove('hidden');
    }

    function copyM3u8() {
      const fullUrl = window.location.origin + m3u8Url.replace('?raw=1', '');
      navigator.clipboard.writeText(fullUrl).then(() => {
        const btn = document.getElementById('copyBtn');
        btn.innerText = '✅ Nusxa olindi!';
        setTimeout(() => { btn.innerText = '📋 Havolani olish'; }, 2000);
      });
    }

    window.addEventListener('keydown', (e) => {
      if (['Space', 'KeyK'].includes(e.code)) {
        e.preventDefault();
        video.paused ? video.play() : video.pause();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 5);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
      } else if (e.code === 'ArrowUp') {
        e.preventDefault();
        video.volume = Math.min(1, video.volume + 0.1);
      } else if (e.code === 'ArrowDown') {
        e.preventDefault();
        video.volume = Math.max(0, video.volume - 0.1);
      } else if (e.code === 'KeyF') {
        e.preventDefault();
        if (!document.fullscreenElement) {
          video.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
      } else if (e.code === 'KeyM') {
        e.preventDefault();
        video.muted = !video.muted;
      }
    });

    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 90,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        startFragPrefetch: true
      });

      hls.loadSource(m3u8Url);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        hideLoader();
        video.play().catch(() => {});
      });

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        hideLoader();
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        console.warn('HLS Event Error:', data);
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              showStatus("Tarmoq xatosi, qayta ulanmoqda...");
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              showStatus("Video tiklanmoqda...");
              hls.recoverMediaError();
              break;
            default:
              console.warn("Fatal error, falling back to MP4...");
              hls.destroy();
              video.src = mp4Url;
              video.play().catch(() => {});
              hideLoader();
              break;
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = m3u8Url;
      video.addEventListener('loadedmetadata', () => {
        hideLoader();
        video.play().catch(() => {});
      });
    } else {
      video.src = mp4Url;
      hideLoader();
      video.play().catch(() => {});
    }

    video.addEventListener('playing', hideLoader);
    video.addEventListener('canplay', hideLoader);
  </script>
</body>
</html>`;
}

// 2. HLS Master Playlist & Browser Player
app.get(['/api/tghls/:channelId/:messageId/master.m3u8', '/player/:channelId/:messageId'], async (req, res) => {
  const { channelId, messageId } = req.params;
  const numMsgId = parseInt(messageId, 10);
  if (!channelId || isNaN(numMsgId)) {
    return res.status(400).json({ error: "Noto'g'ri parametrlar" });
  }

  const authCheck = isAuthorizedStreamRequest(req);
  if (!authCheck.allowed) {
    return res.status(403).json({ error: "Kirish taqiqlangan" });
  }

  const cleanId = channelId.replace(/^-100/, '').replace(/^-/, '');
  touchVideoAccess(`${cleanId}_${numMsgId}`);
  const isHtmlRequest = req.headers.accept && req.headers.accept.includes('text/html') && !req.query.raw;

  // Agar brauzerda to'g'ridan-to'g'ri ochilsa, Hls.js pleyerini ko'rsatish
  if (isHtmlRequest) {
    const rawM3u8Url = `/api/tghls/${cleanId}/${numMsgId}/master.m3u8?raw=1`;
    const mp4FallbackUrl = `/api/tgstream/${cleanId}/${numMsgId}`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(renderBrowserPlayerHtml(cleanId, numMsgId, rawM3u8Url, mp4FallbackUrl));
  }

  // Pre-process in background
  ensureVideoProcessing(channelId, numMsgId).catch(() => {});

  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'public, max-age=3600');

  const playlist = 
    `#EXTM3U\n` +
    `#EXT-X-VERSION:3\n` +
    `#EXT-X-INDEPENDENT-SEGMENTS\n` +
    `#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080,NAME="1080p Full HD"\n` +
    `/api/tghls/${cleanId}/${numMsgId}/index.m3u8\n`;

  res.status(200).send(playlist);
});

// 3. HLS Media Playlist (VOD Oxirigacha O'ynatish)
app.get('/api/tghls/:channelId/:messageId/index.m3u8', async (req, res) => {
  const { channelId, messageId } = req.params;
  const numMsgId = parseInt(messageId, 10);
  if (!channelId || isNaN(numMsgId)) {
    return res.status(400).json({ error: "Noto'g'ri parametrlar" });
  }

  const authCheck = isAuthorizedStreamRequest(req);
  if (!authCheck.allowed) {
    return res.status(403).json({ error: "Kirish taqiqlangan" });
  }

  const cleanId = channelId.replace(/^-100/, '').replace(/^-/, '');
  const key = `${cleanId}_${numMsgId}`;
  touchVideoAccess(key);

  const isHtmlRequest = req.headers.accept && req.headers.accept.includes('text/html') && !req.query.raw;
  if (isHtmlRequest) {
    return res.redirect(`/api/tghls/${cleanId}/${numMsgId}/master.m3u8`);
  }

  const videoFolder = path.join(HLS_CACHE_DIR, key);
  const indexFile = path.join(videoFolder, 'index.m3u8');

  ensureVideoProcessing(channelId, numMsgId).catch(() => {});

  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'public, max-age=60');

  if (fs.existsSync(indexFile)) {
    try {
      let content = await fs.promises.readFile(indexFile, 'utf8');
      content = content.replace(/(^|[^/])(segment_\d+\.ts)/gm, `$1/api/tghls/${cleanId}/${numMsgId}/$2`);
      return res.status(200).send(content);
    } catch {}
  }

  const meta = await getStreamMetadata(channelId, numMsgId);
  if (!meta) {
    return res.status(404).json({ error: "Video topilmadi" });
  }

  const duration = (meta.duration && meta.duration > 0) 
    ? meta.duration 
    : (meta.size ? Math.max(60, Math.ceil(meta.size / (250 * 1024))) : 1440);

  const totalSegments = Math.max(1, Math.ceil(duration / HLS_SEGMENT_DURATION));

  let playlist = `#EXTM3U\n`;
  playlist += `#EXT-X-VERSION:3\n`;
  playlist += `#EXT-X-TARGETDURATION:${HLS_SEGMENT_DURATION + 1}\n`;
  playlist += `#EXT-X-MEDIA-SEQUENCE:0\n`;
  playlist += `#EXT-X-PLAYLIST-TYPE:VOD\n\n`;

  for (let i = 0; i < totalSegments; i++) {
    const isLast = i === totalSegments - 1;
    const segDuration = isLast ? (duration - (i * HLS_SEGMENT_DURATION)) : HLS_SEGMENT_DURATION;
    const durFormatted = Math.max(0.5, segDuration).toFixed(3);
    playlist += `#EXTINF:${durFormatted},\n`;
    playlist += `/api/tghls/${cleanId}/${numMsgId}/segment_${i}.ts\n`;
  }
  playlist += `#EXT-X-ENDLIST\n`;

  res.status(200).send(playlist);
});

// 4. HLS Segment Delivery (Fast non-blocking async with CDN caching)
app.get('/api/tghls/:channelId/:messageId/segment_:segmentNum.ts', async (req, res) => {
  const { channelId, messageId, segmentNum } = req.params;
  const numMsgId = parseInt(messageId, 10);
  const numSeg = parseInt(segmentNum, 10);
  if (!channelId || isNaN(numMsgId) || isNaN(numSeg)) {
    return res.status(400).json({ error: "Noto'g'ri segment parametri" });
  }

  const authCheck = isAuthorizedStreamRequest(req);
  if (!authCheck.allowed) {
    return res.status(403).json({ error: "Kirish taqiqlangan" });
  }

  const cleanId = channelId.replace(/^-100/, '').replace(/^-/, '');
  const key = `${cleanId}_${numMsgId}`;
  touchVideoAccess(key);

  const cacheKey = `${cleanId}_${numMsgId}_seg_${numSeg}`;
  const videoFolder = path.join(HLS_CACHE_DIR, key);
  const segmentFilePath = path.join(videoFolder, `segment_${numSeg}.ts`);

  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.setHeader('Content-Type', 'video/MP2T');
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable'); // 30 kunlik Cloudflare CDN kesh

  if (req.method === 'HEAD') return res.end();

  // 1. RAM keshi (0.1ms)
  if (hlsSegmentCache.has(cacheKey)) {
    const data = hlsSegmentCache.get(cacheKey);
    res.setHeader('Content-Length', data.length);
    return res.status(200).end(data);
  }

  // 2. Disk keshi (1ms)
  if (fs.existsSync(segmentFilePath) && fs.statSync(segmentFilePath).size > 1000) {
    try {
      const data = await fs.promises.readFile(segmentFilePath);
      if (hlsSegmentCache.size >= HLS_MAX_CACHE_ITEMS) {
        const oldestKey = hlsSegmentCache.keys().next().value;
        if (oldestKey) hlsSegmentCache.delete(oldestKey);
      }
      hlsSegmentCache.set(cacheKey, data);
      res.setHeader('Content-Length', data.length);
      return res.status(200).end(data);
    } catch {}
  }

  // 3. Orqa fonda yuklash va asinxron kesishni tekshirish
  const state = await ensureVideoProcessing(channelId, numMsgId);

  const partFile = path.join(videoFolder, 'source.mp4.part');
  const sourceFile = path.join(videoFolder, 'source.mp4');
  const availableInput = fs.existsSync(sourceFile) ? sourceFile : (fs.existsSync(partFile) ? partFile : null);

  if (availableInput) {
    const meta = await getStreamMetadata(channelId, numMsgId);
    const ok = await sliceSegmentAsync(availableInput, videoFolder, numSeg, meta?.isHevc);
    if (ok && fs.existsSync(segmentFilePath) && fs.statSync(segmentFilePath).size > 1000) {
      const data = await fs.promises.readFile(segmentFilePath);
      hlsSegmentCache.set(cacheKey, data);
      res.setHeader('Content-Length', data.length);
      return res.status(200).end(data);
    }
  }

  // 4. Agar hali yetib kelmagan bo'lsa, yuklash oqimini asinxron kutish (maksimum 12 soniya)
  if (state && !state.isCompleted) {
    const meta = await getStreamMetadata(channelId, numMsgId);
    await new Promise((resolve) => {
      let resolved = false;
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        state.emitter.off('progress', onProgress);
        state.emitter.off('completed', onCompleted);
        state.emitter.off('error', onError);
        resolve();
      };

      const timer = setTimeout(cleanup, 12000);
      const onProgress = async () => {
        const currentInput = fs.existsSync(sourceFile) ? sourceFile : (fs.existsSync(partFile) ? partFile : null);
        if (currentInput) {
          const ok = await sliceSegmentAsync(currentInput, videoFolder, numSeg, meta?.isHevc);
          if (ok) cleanup();
        }
      };
      const onCompleted = () => { cleanup(); };
      const onError = () => { cleanup(); };

      state.emitter.on('progress', onProgress);
      state.emitter.on('completed', onCompleted);
      state.emitter.on('error', onError);
    });
  }

  if (fs.existsSync(segmentFilePath) && fs.statSync(segmentFilePath).size > 1000) {
    try {
      const data = await fs.promises.readFile(segmentFilePath);
      hlsSegmentCache.set(cacheKey, data);
      res.setHeader('Content-Length', data.length);
      return res.status(200).end(data);
    } catch {}
  }

  res.status(503).json({ error: "Segment tayyorlanmoqda, iltimos qaytadan urining" });
});

// ============================================================================
// SERVERNI ISHGA TUSHIRISH
// ============================================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 [Animem S3 Server] http://0.0.0.0:${PORT} portida ishga tushdi!`);
  getTelegramClient().catch(err => {
    console.error('❌ [Telegram Bot] Dastlabki ulanishda xatolik:', err?.message || err);
  });
});
