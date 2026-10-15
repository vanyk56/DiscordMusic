FROM node:22-slim

# Устанавливаем системные утилиты и ffmpeg для Discord Voice
RUN apt-get update && apt-get install -y \
    ffmpeg \
    openssl \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Копируем манифесты зависимостей
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install

# Копируем весь исходный код проекта
COPY . .

# Собираем проект через esbuild
RUN npm run build

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

# Запуск бота и веб-сервера
CMD ["npm", "run", "start"]
