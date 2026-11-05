# Imagen de producción: un solo proceso sirve el chat (web/) y la API (src/server.ts).
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "src/server.ts"]
