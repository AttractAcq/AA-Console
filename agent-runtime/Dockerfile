# Node 22 is required: see src/db.ts for why the ws transport fix exists
# even with this pinned.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json tsconfig.build.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 8787
CMD ["npm", "start"]
