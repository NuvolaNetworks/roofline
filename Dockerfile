# Base images come from the ECR Public mirror, not Docker Hub: unauthenticated
# Hub pulls are rate-limited and 429 mid-build (hit 2026-08-06).
FROM public.ecr.aws/docker/library/node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

FROM public.ecr.aws/docker/library/node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# Migrations are read from disk at boot (migrate-on-boot runner); the
# standalone trace doesn't know about them.
COPY --from=build /app/migrations ./migrations
RUN mkdir -p data
EXPOSE 3000
CMD ["node", "server.js"]
