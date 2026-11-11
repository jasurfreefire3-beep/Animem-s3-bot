FROM node:22-alpine

WORKDIR /app

# Railway va bulutli konteynerlar uchun xotira va port sozlamalari
ENV NODE_ENV=production
ENV PORT=8080
ENV NODE_OPTIONS="--max-old-space-size=512 --expose-gc"

# Faqat ishlab chiqarish paketlarini o'rnatish
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Loyiha fayllarini nusxalash (.dockerignore orqali filtrlanadi)
COPY . .

# Kesh jildlarini yaratish
RUN mkdir -p /app/cache/heads

EXPOSE 8080
EXPOSE 3000

# V8 xotira cheklovini yoqish orqali yuqori tezlikdagi to'g'ridan-to'g'ri MP4 oqimini ishga tushirish
CMD ["node", "--expose-gc", "--max-old-space-size=512", "server.js"]
