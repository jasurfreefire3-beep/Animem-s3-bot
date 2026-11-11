# 🚀 Animem S3 Video Streaming & Telegram Bot Server
## (Zero-CPU HLS .m3u8 + Direct MP4 + Neon PostgreSQL Edition)

Telegram kanallari orqali yuklangan videolarni to'g'ridan-to'g'ri internetda va **Animem.uz** saytida **YouTube va Netflix tezligida**, 10,000+ kishiga qotmasdan **HLS (.m3u8 + .ts) va Direct MP4 (HTTP 206 Partial Content)** formatida stream qiluvchi yuqori unumdorlikdagi media serveri (Railway, Northflank va VPS uchun to'liq moslashtirilgan).

---

## 🌟 Asosiy Imkoniyatlar

1. ⚡️ **Zero-CPU Ultra-Tezkor HLS Streaming (.m3u8 + .ts):**
   - Video 4–5 soniyali MPEG-TS bo'laklariga ajratiladi.
   - Pleyer `master.m3u8` ro'yxatini 10 millisekundda yuklaydi, 0-segment 0.5 soniyada boshlanadi.
   - FFmpeg stream-copy (`-c copy`) rejimi orqali CPU sarflamaydi (0% CPU!).
   - **Pre-Fetch tizimi:** Foydalanuvchi bir segmentni tomosha qilayotgan paytda, server keyingi segmentlarni avtomatik ravishda disk keshiga tayyorlab qo'yadi (0ms bufering).

2. 🐘 **Neon Tech PostgreSQL (JSON Metama'lumotlar):**
   - Barcha video ma'lumotlari (`document_id`, `access_hash`, `size`, `mimeType`, `duration`) Neon bazasiga JSON formatda saqlanadi.
   - Telegram MTProto API'ni ortiqcha so'rovlar bilan bezovta qilmaydi (0 ta FLOOD_WAIT xavfi).
   - Qidiruv tezligi: RAM keshdan <0.01 ms, Neon bazasidan ~15 ms!

3. 🚀 **Direct MP4 Stream (HTTP 206 Partial Content) & Video Boshi Kesh:**
   - 2.5 MB li aqlli burst oqimi: video bosilishi bilanoq lahzada o'ynashni boshlaydi.
   - Pipelined parallel MTProto yuklovchi: orqa fonda 4 ta parallel oqim orqali uzluksiz to'ldiradi.

4. 🤖 **Kanalga Video Tashlanganda Avtomatik Havolalar:**
   - Bot admin qilingan kanalga video tashlanganda darhol 4 xil havola yuboriladi:
     - ⚡️ HLS (.m3u8) havolasi: `https://animem-s3-bot-production.up.railway.app/api/tghls/:channelId/:messageId/master.m3u8`
     - ⚡️ To'g'ridan-to'g'ri MP4 havola: `https://animem-s3-bot-production.up.railway.app/api/medi/:channelId/:messageId.mp4`
     - 📱 Onlayn pleyer (Hls.js): `https://animem-s3-bot-production.up.railway.app/player/:channelId/:messageId`
     - 📺 Sayt uchun Iframe kodi: `<iframe src="..." ...></iframe>`

5. 🛡 **Dual-Port Auto-Listening (8080 & 3000):**
   - Railway va bulutli proksilar uchun bir vaqtning o'zida ham 8080, ham 3000 portlarda eshitadi (502 Bad Gateway xatolarining oldini oladi).

---

## ☁️ Railway da Joylashtirish

Railway boshqaruv panelida **Variables** -> **Raw Editor** ga quyidagilarni joylashtiring:

```env
PORT="8080"
NODE_ENV="production"
DATABASE_URL="postgresql://neondb_owner:npg_3flhqk6ucYVz@ep-patient-boat-bd57ty6m-pooler.c-8.us-east-2.aws.neon.tech/neondb?sslmode=require"
TG_API_ID="6"
TG_API_HASH="eb06d4abfb49dc3eeb1aeb98ae0f581e"
TG_STREAM_BOT_TOKEN="9041641962:AAEispd_h1HyoJ0-VWz0Uo6CrItfMLjNBXQ"
TG_STREAM_SESSION="1AgAOMTQ5LjE1NC4xNjcuNTEBu2IRIcg4cNKEveFXVx/vQ3IbNH+H1/BF23cEzFCCc+Thvyf7BaMbE5elBmNF5SnZz5pjp23LAg0hPX1VAe5jPbLfsUHh92NGVw5umtUcI3sQ19fLCWPjWFl9ANPRb2HdyIzg9C+RRJkmaGH4S60xec6JJAAaQfH/m70HuxirPoXgW4AQGx25N6n0o9qBi08Di4NWHMhtSut4/aRTkVKZwEhtrmVQIvuojO4hOFUKcvjlXDH5+5CPgkU1/O+qOOSf+xrl2lB0gT/jIoaEqpUt9ier2D9r+sH4jzk7UDQhYxII3TJ6n+bgKJgb8KZduJ+VMMO6z0OA/oFh1LIIHD+tvcc="
TG_STREAM_DOMAIN="animem-s3-bot-production.up.railway.app"
TG_CHUNK_SIZE="524288"
HEAD_BUFFER_SIZE="2621440"
CHUNK_BURST_SIZE="2621440"
RAM_LIMIT_MB="220"
MAX_HEAD_CACHE_BYTES="36700160"
CLEANUP_INTERVAL_MIN="15"
HLS_CACHE_DIR="./cache/hls"
HLS_SEG_DURATION="5"
FFMPEG_PATH="ffmpeg"
ALLOWED_ORIGINS="https://animem.uz,https://www.animem.uz,http://localhost:5173,http://localhost:3000,https://animem-s3-bot-production.up.railway.app"
```
