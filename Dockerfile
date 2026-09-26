# Multi-stage build: compile TypeScript, then ship a slim runtime image.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Run as a non-root user.
RUN useradd --create-home appuser && chown -R appuser:appuser /app
USER appuser
EXPOSE 3000
CMD ["node", "dist/index.js"]
