# Node 22 is required: see src/db.ts for why the ws transport fix exists
# even with this pinned.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
# video_edit renders the cut with ffmpeg. The font it burns captions with
# comes from the dejavu-fonts-ttf package rather than an OS path, so it ships
# with node_modules and cannot drift with a base-image change.
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 8787
USER node
CMD ["node", "dist/server.js"]
