FROM oven/bun:1.2.15

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY index.ts ./
COPY src ./src
COPY sounds ./sounds

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER bun
CMD ["bun", "run", "index.ts"]
