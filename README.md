# 🚀 Animem S3 Video Streaming & Telegram Bot Server

Telegram kanallari orqali yuklangan videolarni to'g'ridan-to'g'ri internetda va **Animem.uz** saytida **YouTube tezligida**, 10,000+ kishiga qotmasdan **HLS (`.m3u8`)** va **MP4** formatida stream qiluvchi mustaqil VPS serveri.

---

## 🌟 Asosiy Imkoniyatlar

1. ⚡️ **HLS (HTTP Live Streaming) + Edge CDN:**
   - 6 soniyalik avtomatik bo'lingan MPEG-TS segmentlar.
   - 30 kunlik Cloudflare CDN kesh sarlavhalari (`Cache-Control: immutable`).
   - 10,000+ tomoshabin bir vaqtda kirsa ham serveringiz qotmaydi, oqim to'g'ridan-to'g'ri CDN'dan o'tadi.

2. 🚀 **0 Soniyali Tezkor Start (Zero-Buffering):**
   - Video yuklanganda birinchi 3 MB tushishi bilanoq `segment_0.ts` atigi 80ms ichida kesilib, pleyerga uzatiladi.

3. 🤖 **Kanalga Video Tashlanganda Avtomatik Javob & Pre-Segmentation:**
   - Bot admin qilingan kanalga anime videosi tashlanganda:
     - ⚡️ HLS URL (`master.m3u8`)
     - 🔗 MP4 Direct Stream URL beradi.
   - Orqa fonda videoni avtomatik tarzda HLS segmentlariga bo'lib, diskka keshlab qo'yadi.

4. 🛡 **Anti-Leech (Begona Saytlardan Himoya):**
   - Faqat `animem.uz`, uning subdomenlari va rasmiy brauzer pleyerlariga ruxsat berilgan.
   - Begona saytlar o'g'irlab iframe orqali qo'yganda avtomatik ravishda `403 Forbidden` bilan bloklanadi.

5. 🎞 **Direct MP4 Stream (HTTP 206 Partial Content):**
   - Telegram MTProto 4096-baytli aniq tekislash va bo'shliqlarsiz tezkor seek (oldinga-orqaga surish) qo'llab-quvvatlanadi.

---

## ⚙️ VPS Serverga O'rnatish (Ubuntu / Debian)

### 1-Usul: Node.js + PM2 orqali (Tavsiya etiladi)

1. **VPS paketlarini yangilang va kerakli dasturlarni o'rnating:**
   ```bash
   sudo apt update && sudo apt upgrade -y
   sudo apt install -y curl git ffmpeg
   ```

2. **Node.js (v20 yoki v22 LTS) o'rnating:**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs
   sudo npm install -g pm2
   ```

3. **Repozitoriyani klon qiling:**
   ```bash
   git clone https://github.com/jasurfreefire3-beep/Animem-s3-bot.git
   cd Animem-s3-bot
   ```

4. **Kutubxonalarni o'rnating:**
   ```bash
   npm install --production
   ```

5. **.env sozlamalarini tekshiring:**
   `.env` faylida barcha bot tokenlari va API kalitlari allaqachon to'ldirilgan.
   Agar VPS domeningiz boshqa bo'lsa, `TG_STREAM_DOMAIN` ni o'zgartirishingiz mumkin:
   ```bash
   nano .env
   ```

6. **PM2 orqali orqa fonda (24/7) ishga tushiring:**
   ```bash
   pm2 start ecosystem.config.cjs
   pm2 save
   pm2 startup
   ```

---

### 2-Usul: Docker & Docker Compose orqali

1. **Docker va Docker Compose o'rnatilgan VPS da:**
   ```bash
   git clone https://github.com/jasurfreefire3-beep/Animem-s3-bot.git
   cd Animem-s3-bot
   docker compose up -d --build
   ```

2. **Loglarni kuzatish:**
   ```bash
   docker compose logs -f
   ```

---

## 🌐 Nginx Reverse Proxy & SSL (Domain sozlash)

Agar serveringizga domen ulamoqchi bo'lsangiz (masalan `s3.animem.uz`):

1. **Nginx o'rnating:**
   ```bash
   sudo apt install -y nginx certbot python3-certbot-nginx
   ```

2. **Nginx konfiguratsiyasini yarating (`/etc/nginx/sites-available/s3.animem.uz`):**
   ```nginx
   server {
       server_name s3.animem.uz;

       client_max_body_size 0;
       proxy_read_timeout 600s;
       proxy_send_timeout 600s;

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```

3. **Saytni faollashtiring va bepul SSL o'rnating:**
   ```bash
   sudo ln -s /etc/nginx/sites-available/s3.animem.uz /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl restart nginx
   sudo certbot --nginx -d s3.animem.uz
   ```

---

## 🤖 Telegram Botdan Foydalanish

1. `@auplodaprivatebot` ni Telegram kanalingizga **Admin** qilib qo'shing (Xabarlarni o'qish va yozish ruxsati bilan).
2. Kanalga istalgan video (MP4 / MKV) yuklang.
3. Bot 1 soniya ichida videoga reply qilib, HLS va MP4 havolalarini yuboradi.
4. Ushbu HLS havolani **Animem.uz Admin Paneli**ga kiritishingiz mumkin!
