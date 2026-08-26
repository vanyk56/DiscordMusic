FROM node:22-slim

# Устанавливаем системные утилиты, необходимые для голосового модуля Discord (ffmpeg, openssl, python3, build-essential)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    openssl \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Включаем corepack и устанавливаем pnpm
RUN npm install -g pnpm@9

WORKDIR /app

# Копируем файлы манифестов
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* .npmrc* ./
COPY artifacts ./artifacts
COPY lib ./lib
COPY scripts ./scripts
COPY tsconfig*.json ./

# Устанавливаем зависимости без блокировки версий
RUN pnpm install --no-frozen-lockfile

# Собираем библиотеки и API сервер
RUN pnpm run build

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

# Запуск бота и веб-сервера
CMD ["pnpm", "run", "start"]
