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
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync, execSync } = require('child_process');
const { EventEmitter } = require('events');

// 1. Standalone .env parser (Tashqi 'dotenv' kutubxonasisiz mustaqil o'qish)
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

// 2. Agar node_modules hali o'rnatilmagan bo'lsa, avtomatik o'rnatish!
if (!fs.existsSync(path.join(__dirname, 'node_modules', 'express')) || !fs.existsSync(path.join(__dirname, 'node_modules', 'telegram'))) {
  console.log('📦 VPS da kerakli kutubxonalar topilmadi. Avtomatik "npm install" bajarilmoqda, iltimos kuting...');
  try {
    execSync('npm install --production', { cwd: __dirname, stdio: 'inherit' });
    console.log('✅ Barcha kerakli kutubxonalar muvaffaqiyatli o\'rnatildi!');
  } catch (err) {
    console.error('❌ Avtomatik npm install da xatolik. Terminalda "npm install" ni qo\'lda bajaring:', err?.message || err);
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
const TG_STREAM_DOMAIN = process.env.TG_STREAM_DOMAIN || 's3.animem.uz.animem.uz';
const HLS_SEGMENT_DURATION = 6; // 6 soniyalik segmentlar
const HLS_MAX_CACHE_ITEMS = 800; // RAM dagi kesh limiti (~1GB)
const HLS_CACHE_DIR = process.env.HLS_CACHE_DIR || path.join(__dirname, 'cache');

if (!fs.existsSync(HLS_CACHE_DIR)) {
  fs.mkdirSync(HLS_CACHE_DIR, { recursive: true });
}

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

// In-memory keshlash
const mediaMetaCache = new Map();
const videoHeadCache = new Map();
const hlsSegmentCache = new Map();
const activeVideoDownloads = new Map();

// 7 kundan eski kesh papkalarini avtomatik tozalash (har soatda)
function cleanOldHlsCache() {
  try {
    if (!fs.existsSync(HLS_CACHE_DIR)) return;
    const entries = fs.readdirSync(HLS_CACHE_DIR);
    const now = Date.now();
    for (const entry of entries) {
      const fullPath = path.join(HLS_CACHE_DIR, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory() && (now - stat.mtimeMs > 7 * 86400 * 1000)) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
    }
  } catch {}
}
setInterval(cleanOldHlsCache, 3600000);

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
    const session = new StringSession(process.env.TG_STREAM_SESSION || '');
    if (!process.env.TG_STREAM_SESSION) {
      session.setDC(2, '149.154.167.41', 443);
    }
    client = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
      connectionRetries: 5,
      autoReconnect: true,
      floodSleepThreshold: 60,
    });

    await client.start({ botAuthToken: TG_BOT_TOKEN });
    const me = await client.getMe();
    console.log(`🤖 [Telegram Bot] Muvaffaqiyatli ulandi: @${me.username}`);

    registerTelegramEventHandler(client);
    return client;
  } catch (err) {
    console.error('❌ [Telegram Bot] Ulanishda xatolik:', err);
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

      const mediaInfo = extractMediaFromMessage(message);
      if (!mediaInfo) return;

      const cleanChannelId = String(message.chatId || message.peerId?.channelId || '')
        .replace(/^-100/, '')
        .replace(/^-/, '');
      const messageId = message.id;
      const cacheKey = `${cleanChannelId}_${messageId}`;

      mediaMetaCache.set(cacheKey, mediaInfo);

      const mp4Url = `https://${TG_STREAM_DOMAIN}/api/tgstream/${cleanChannelId}/${messageId}`;
      const hlsUrl = `https://${TG_STREAM_DOMAIN}/api/tghls/${cleanChannelId}/${messageId}/master.m3u8`;

      let codecInfo = `🎞 <b>Format:</b> <code>H.264 (AVC)</code> ✅ <i>(Brauzerlarga 100% mos)</i>\n\n`;
      let warningBlock = '';

      if (mediaInfo.isHevc) {
        codecInfo = `🎞 <b>Format:</b> <code>HEVC (H.265 / x265)</code> ⚠️\n\n`;
        warningBlock = 
          `⚠️ <b>DIQQAT (Format Ogohlantirishi):</b>\n` +
          `Ushbu video <b>HEVC (H.265)</b> formatida! Brauzerlar (ayniqsa kompyuterdagi Chrome/Firefox) H.265 kodeki litsenziyasi yo'qligi sababli bu videoni <b>faqat audio</b> qilib ochadi.\n` +
          `💡 <i>Saytda barcha foydalanuvchilarda video to'liq va qotmasdan ochilishi uchun videolarni <b>H.264 (x264 / AVC)</b> formatida yuklang!</i>\n\n`;
      }

      const replyHtml = 
        `🎬 <b>Video Muvaffaqiyatli Qabul Qilindi!</b>\n\n` +
        `📁 <b>Fayl:</b> <code>${mediaInfo.fileName}</code>\n` +
        `⚖️ <b>Hajmi:</b> <b>${formatBytes(mediaInfo.size)}</b>\n` +
        `⏱ <b>Davomiyligi:</b> ${formatDuration(mediaInfo.duration)}\n` +
        codecInfo +
        warningBlock +
        `⚡️ <b>1. HLS Stream URL (YouTube Tezligida & 10,000+ kishiga):</b>\n` +
        `<code>${hlsUrl}</code>\n\n` +
        `🔗 <b>2. To'g'ridan-to'g'ri MP4 URL (Direct MP4 Stream):</b>\n` +
        `<code>${mp4Url}</code>\n\n` +
        `🛡 <b>Xavfsizlik:</b> Faqat Animem.uz saytida va rasmiy brauzer pleyerida ishlaydi.\n\n` +
        `💡 <i>Sayt Admin panelidagi qism "video_url" maydoniga <b>HLS (.m3u8)</b> havolasini qo'yish tavsiya etiladi. 10,000 odam bir vaqtda kirganda ham video qotmasdan, YouTube kabi bir zumda ochiladi!</i>`;

      await tgClient.sendMessage(message.chatId, {
        message: replyHtml,
        parseMode: 'html',
        replyTo: messageId
      });

      console.log(`[Telegram Streamer] Replied with stream URLs for message #${messageId} in channel ${cleanChannelId}`);

      // Kanalga video tashlangan zahoti orqa fonda HLS ga bo'lib tayyorlashni boshlash!
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
  if (cached && (Date.now() - cached.cachedAt < 3600000)) {
    return cached;
  }

  const tgClient = await getTelegramClient();
  const normalizedChannelId = String(channelId).startsWith('-100')
    ? channelId
    : (String(channelId).startsWith('-') ? `-100${String(channelId).slice(1)}` : `-100${channelId}`);

  try {
    let peer;
    try {
      peer = await tgClient.getInputEntity(normalizedChannelId);
    } catch {
      peer = await tgClient.getEntity(normalizedChannelId);
    }

    const messages = await tgClient.getMessages(peer, { ids: [messageId] });
    if (!messages || !messages[0]) return null;

    const mediaInfo = extractMediaFromMessage(messages[0]);
    if (!mediaInfo) return null;

    mediaMetaCache.set(cacheKey, mediaInfo);
    return mediaInfo;
  } catch (err) {
    console.error(`[Telegram Streamer] Fetch message #${messageId} error:`, err?.message || err);
    return null;
  }
}

// ============================================================================
// HLS STREAMING VA ORQA FONDA SEGMENTATSIYA MOTORLARI
// ============================================================================

function sliceSegmentSync(inputFile, videoFolder, segIdx, isHevc = false) {
  const targetSegFile = path.join(videoFolder, `segment_${segIdx}.ts`);
  if (fs.existsSync(targetSegFile) && fs.statSync(targetSegFile).size > 1000) return true;

  const tempSegFile = path.join(videoFolder, `temp_seg_${segIdx}_${Date.now()}.ts`);
  const ffmpegBin = getFfmpegBinary();
  const startTime = segIdx * HLS_SEGMENT_DURATION;
  const bsfFilter = isHevc ? 'hevc_mp4toannexb' : 'h264_mp4toannexb';

  // 1. Tezkor stream copy
  const res = spawnSync(ffmpegBin, [
    '-ss', String(startTime),
    '-i', inputFile,
    '-t', String(HLS_SEGMENT_DURATION),
    '-c', 'copy',
    '-bsf:v', bsfFilter,
    '-f', 'mpegts',
    '-y',
    tempSegFile
  ], { timeout: 10000 });

  if (res.status === 0 && fs.existsSync(tempSegFile) && fs.statSync(tempSegFile).size > 1000) {
    try {
      fs.renameSync(tempSegFile, targetSegFile);
      const buf = fs.readFileSync(targetSegFile);
      const cacheKey = `${path.basename(videoFolder)}_seg_${segIdx}`;
      hlsSegmentCache.set(cacheKey, buf);
      return true;
    } catch {
      return false;
    }
  }

  // 2. Fallback: AAC audiosiga o'tkazish
  const fb = spawnSync(ffmpegBin, [
    '-ss', String(startTime),
    '-i', inputFile,
    '-t', String(HLS_SEGMENT_DURATION),
    '-c:v', 'copy',
    '-bsf:v', bsfFilter,
    '-c:a', 'aac',
    '-f', 'mpegts',
    '-y',
    tempSegFile
  ], { timeout: 15000 });

  if (fb.status === 0 && fs.existsSync(tempSegFile) && fs.statSync(tempSegFile).size > 1000) {
    try {
      fs.renameSync(tempSegFile, targetSegFile);
      const buf = fs.readFileSync(targetSegFile);
      const cacheKey = `${path.basename(videoFolder)}_seg_${segIdx}`;
      hlsSegmentCache.set(cacheKey, buf);
      return true;
    } catch {
      return false;
    }
  }

  if (fs.existsSync(tempSegFile)) {
    try { fs.unlinkSync(tempSegFile); } catch {}
  }
  return false;
}

async function ensureVideoProcessing(channelId, messageId) {
  const cleanId = String(channelId).replace(/^-100/, '').replace(/^-/, '');
  const key = `${cleanId}_${messageId}`;
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

  // Orqa fonda yuklab olish va HLS ga o'tkazish
  (async () => {
    try {
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

      const writeStream = fs.createWriteStream(partFile, { flags: startOffset > 0 ? 'a' : 'w' });

      const downloadStream = tgClient.iterDownload({
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
        state.emitter.emit('progress', state.bytesDownloaded);

        // Birinchi 3 MB tushgandayoq segment 0 ni kesib qo'yish (<1s tezkor start!)
        if (!seg0Done && state.bytesDownloaded >= Math.min(meta.size, 3 * 1024 * 1024)) {
          sliceSegmentSync(partFile, videoFolder, 0, meta.isHevc);
          seg0Done = true;
          state.emitter.emit('segment_ready', 0);
        }

        // 6 MB tushganda segment 1 ni kesib qo'yish
        if (!seg1Done && state.bytesDownloaded >= Math.min(meta.size, 6 * 1024 * 1024)) {
          sliceSegmentSync(partFile, videoFolder, 1, meta.isHevc);
          seg1Done = true;
          state.emitter.emit('segment_ready', 1);
        }
      }

      await new Promise(resolve => writeStream.end(resolve));

      // Yuklab olish tugadi: .part ni .mp4 ga o'tkazish
      if (fs.existsSync(partFile)) {
        try { fs.renameSync(partFile, sourceFile); } catch {}
      }

      // Butun videoni birdaniga to'liq HLS segmentlariga bo'lib chiqish (atigi 1-2 soniya)
      const ffmpegBin = getFfmpegBinary();
      const bsfFilter = meta.isHevc ? 'hevc_mp4toannexb' : 'h264_mp4toannexb';
      const hlsRes = spawnSync(ffmpegBin, [
        '-i', sourceFile,
        '-c', 'copy',
        '-bsf:v', bsfFilter,
        '-f', 'hls',
        '-hls_time', String(HLS_SEGMENT_DURATION),
        '-hls_list_size', '0',
        '-hls_segment_filename', path.join(videoFolder, 'segment_%d.ts'),
        '-y',
        indexFile
      ], { timeout: 60000 });

      if (hlsRes.status !== 0) {
        spawnSync(ffmpegBin, [
          '-i', sourceFile,
          '-c:v', 'copy',
          '-bsf:v', bsfFilter,
          '-c:a', 'aac',
          '-f', 'hls',
          '-hls_time', String(HLS_SEGMENT_DURATION),
          '-hls_list_size', '0',
          '-hls_segment_filename', path.join(videoFolder, 'segment_%d.ts'),
          '-y',
          indexFile
        ], { timeout: 120000 });
      }

      state.isCompleted = true;
      state.emitter.emit('completed');

      // Segmentlar tayyor bo'lgach, diskni tejash uchun xom source.mp4 ni o'chirish
      if (fs.existsSync(sourceFile) && fs.existsSync(indexFile)) {
        try { fs.unlinkSync(sourceFile); } catch {}
      }

      console.log(`✅ [HLS Streamer] Video to'liq segmentlarga bo'lindi (${key})!`);
    } catch (err) {
      console.warn(`[HLS Streamer] Background process error (${key}):`, err?.message || err);
      state.error = err?.message || String(err);
      state.emitter.emit('error', state.error);
    } finally {
      activeVideoDownloads.delete(key);
    }
  })();

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

// 1. Direct MP4 Stream Handler
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
      return res.status(416).setHeader('Content-Range', `bytes */${totalSize}`).end();
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

    if (req.method === 'HEAD') {
      return res.end();
    }

    // Fast-start: RAM keshi (birinchi 4 MB)
    const HEAD_BUFFER_SIZE = 4 * 1024 * 1024;
    if (start < HEAD_BUFFER_SIZE && videoHeadCache.has(headKey)) {
      const cachedHead = videoHeadCache.get(headKey);
      if (end < cachedHead.length) {
        return res.end(cachedHead.subarray(start, end + 1));
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
    const TG_ALIGN = 4096;
    const alignedStart = Math.floor(start / TG_ALIGN) * TG_ALIGN;
    const skipBytes = start - alignedStart;
    const chunkLimit = Math.ceil((chunkSize + skipBytes) / TG_CHUNK_SIZE);

    let isAborted = false;
    req.on('close', () => { isAborted = true; });

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
    const headChunks = [];
    let headBytes = 0;

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

// 2. HLS Master Playlist
app.get('/api/tghls/:channelId/:messageId/master.m3u8', async (req, res) => {
  const { channelId, messageId } = req.params;
  const numMsgId = parseInt(messageId, 10);
  if (!channelId || isNaN(numMsgId)) {
    return res.status(400).json({ error: "Noto'g'ri parametrlar" });
  }

  const authCheck = isAuthorizedStreamRequest(req);
  if (!authCheck.allowed) {
    return res.status(403).json({ error: "Kirish taqiqlangan" });
  }

  // Pre-process in background
  ensureVideoProcessing(channelId, numMsgId).catch(() => {});

  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'public, max-age=3600');

  const cleanId = channelId.replace(/^-100/, '').replace(/^-/, '');
  const playlist = 
    `#EXTM3U\n` +
    `#EXT-X-VERSION:3\n` +
    `#EXT-X-INDEPENDENT-SEGMENTS\n` +
    `#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080,NAME="1080p Full HD"\n` +
    `/api/tghls/${cleanId}/${numMsgId}/index.m3u8\n`;

  res.status(200).send(playlist);
});

// 3. HLS Media Playlist
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
  const videoFolder = path.join(HLS_CACHE_DIR, `${cleanId}_${numMsgId}`);
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
      content = content.replace(/(segment_\d+\.ts)/g, `/api/tghls/${cleanId}/${numMsgId}/$1`);
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

// 4. HLS Segment Delivery
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
  const cacheKey = `${cleanId}_${numMsgId}_seg_${numSeg}`;
  const videoFolder = path.join(HLS_CACHE_DIR, `${cleanId}_${numMsgId}`);
  const segmentFilePath = path.join(videoFolder, `segment_${numSeg}.ts`);

  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.setHeader('Content-Type', 'video/MP2T');
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable'); // 30 kunlik CDN kesh

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

  // 3. Orqa fonda yuklash va kesishni tekshirish
  const state = await ensureVideoProcessing(channelId, numMsgId);

  const partFile = path.join(videoFolder, 'source.mp4.part');
  const sourceFile = path.join(videoFolder, 'source.mp4');
  const availableInput = fs.existsSync(sourceFile) ? sourceFile : (fs.existsSync(partFile) ? partFile : null);

  if (availableInput) {
    const meta = await getStreamMetadata(channelId, numMsgId);
    const ok = sliceSegmentSync(availableInput, videoFolder, numSeg, meta?.isHevc);
    if (ok && fs.existsSync(segmentFilePath) && fs.statSync(segmentFilePath).size > 1000) {
      const data = await fs.promises.readFile(segmentFilePath);
      hlsSegmentCache.set(cacheKey, data);
      res.setHeader('Content-Length', data.length);
      return res.status(200).end(data);
    }
  }

  // 4. Agar hali yetib kelmagan bo'lsa, yuklash oqimini kutish (maksimum 8 soniya)
  if (state && !state.isCompleted) {
    const meta = await getStreamMetadata(channelId, numMsgId);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 8000);
      const onProgress = () => {
        const currentInput = fs.existsSync(sourceFile) ? sourceFile : (fs.existsSync(partFile) ? partFile : null);
        if (currentInput) {
          if (sliceSegmentSync(currentInput, videoFolder, numSeg, meta?.isHevc)) {
            clearTimeout(timer);
            state.emitter.off('progress', onProgress);
            state.emitter.off('completed', onCompleted);
            resolve();
          }
        }
      };
      const onCompleted = () => {
        clearTimeout(timer);
        state.emitter.off('progress', onProgress);
        state.emitter.off('completed', onCompleted);
        resolve();
      };
      state.emitter.on('progress', onProgress);
      state.emitter.on('completed', onCompleted);
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
