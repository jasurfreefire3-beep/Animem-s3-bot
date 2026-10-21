FROM node:22-alpine

WORKDIR /app

# Kuchsiz konteynerlar (Northflank Micro/Free tier) uchun xotira va GC sozlamalari
ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_OPTIONS="--max-old-space-size=256 --expose-gc"

# Faqat ishlab chiqarish (production) paketlarini o'rnatish
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Loyiha fayllarini nusxalash (.dockerignore orqali ortiqcha fayllar filtrlanadi)
COPY . .

# Kesh jildini yaratish
RUN mkdir -p /app/cache

EXPOSE 3000

# V8 xotira cheklovini yoqish orqali OOM (Out Of Memory) xatoligining oldi olinadi
CMD ["node", "--expose-gc", "--max-old-space-size=256", "server.js"]
