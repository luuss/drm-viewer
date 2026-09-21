FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/package.json web/package-lock.json* /app/web/
WORKDIR /app/web
RUN npm ci --no-audit --no-fund
COPY web /app/web
COPY convex /app/convex
ARG VITE_CONVEX_URL
ARG VITE_TILE_SERVICE_URL
ENV VITE_CONVEX_URL=$VITE_CONVEX_URL
ENV VITE_TILE_SERVICE_URL=$VITE_TILE_SERVICE_URL
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/web/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
