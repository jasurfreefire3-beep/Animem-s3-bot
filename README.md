# 🚀 Animem S3 Video Streaming & Telegram Bot Server

Telegram kanallari orqali yuklangan videolarni to'g'ridan-to'g'ri internetda va **Animem.uz** saytida **YouTube tezligida**, 10,000+ kishiga qotmasdan **Ultra-Fast Direct MP4 (HTTP 206 Partial Content)** formatida stream qiluvchi yuqori unumdorlikdagi media serveri (Northflank, Wasmer Edge va VPS uchun moslashtirilgan).

---

## 🌟 Asosiy Imkoniyatlar

1. ⚡️ **Ultra-Tezkor Direct MP4 Stream (HTTP 206 Partial Content):**
   - 2.5 MB li aqlli burst oqimi: video bosilishi bilanoq 60-70 millisoniyada o'ynashni boshlaydi.
   - Pipelined parallel MTProto yuklovchi: orqa fonda 4 ta parallel oqim orqali videoni uzluksiz to'ldiradi.
   - 0-CPU va minimal RAM sarfi (FFmpeg talab qilinmaydi, butunlay toza oqim).

2. 🚀 **Video Boshi (Moov Atom) Avto-Kesh:**
   - Har qanday videoning dastlabki 2.5 MB li qismi RAM va diskka keshlanadi, bu esa keyingi tomoshabinlarga videoni 0 millisoniyada ochib beradi.

3. 🤖 **Kanalga Video Tashlanganda Avtomatik Yangi MP4 Havola:**
   - Bot admin qilingan kanalga video tashlanganda:
     - ⚡️ To'g'ridan-to'g'ri MP4 havola: `https://s3.animem.uz/api/medi/:channelId/:messageId.mp4`
     - 📱 Onlayn pleyer havolasi: `https://s3.animem.uz/player/:channelId/:messageId`
     - 📺 Sayt uchun iframe kodi: `<iframe src="..." ...></iframe>`

4. 🛡 **Anti-Leech va Xavfsizlik:**
   - Faqat `animem.uz`, uning subdomenlari va rasmiy pleyerlarga ruxsat berilgan.
   - Resilient MTProto avto-avtorizatsiya: sessiya eskirganda bot token orqali o'zini avtomatik tiklaydi.

---

## ☁️ Northflank da Joylashtirish (Tavsiya etiladi)

1. **Northflank (northflank.com) hisobingizga kiring.**
2. **Create New Service** -> **Combined Service** yoki **Deployment Service** ni tanlang.
3. Git Repository sifatida `https://github.com/jasurfreefire3-beep/Animem-s3-bot` ni ulang.
4. Build Type sifatida **Dockerfile** ni tanlang (loyihadagi `Dockerfile` avtomatik ishlatiladi).
5. **Port:** `3000` (HTTP) qilib belgilang.
6. **Environment Variables** bo'limiga quyidagilarni kiriting:
   - `PORT`: `3000`
   - `NODE_ENV`: `production`
   - `TG_API_ID`: `6`
   - `TG_API_HASH`: `eb06d4abfb49dc3eeb1aeb98ae0f581e`
   - `TG_STREAM_BOT_TOKEN`: `8969080492:AAFeXz93y6CjIBv0AmdlfVlE0N53gf_J6gY`
   - `TG_STREAM_DOMAIN`: `s3.animem.uz` (yoki Northflank taqdim etgan domain)
   - `HEAD_BUFFER_SIZE`: `2621440`
   - `CHUNK_BURST_SIZE`: `2621440`
   - `RAM_LIMIT_MB`: `450`
   - `ALLOWED_ORIGINS`: `https://animem.uz,https://www.animem.uz,http://localhost:5173,http://localhost:3000`
7. **Deploy Service** tugmasini bosing. Loyiha bir necha soniyada ishga tushadi!

---

## ⚙️ VPS Serverga O'rnatish (Ubuntu / Debian)

### 1-Usul: Node.js + PM2 orqali

1. **Node.js o'rnating va repozitoriyani yuklang:**
   ```bash
   git clone https://github.com/jasurfreefire3-beep/Animem-s3-bot.git
   cd Animem-s3-bot
   npm install --omit=dev
   ```

2. **PM2 orqali ishga tushiring:**
   ```bash
   pm2 start ecosystem.config.cjs
   pm2 save
   pm2 startup
   ```

### 2-Usul: Docker orqali
```bash
docker compose up -d --build
```
