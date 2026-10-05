FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
RUN npm ci --workspace client
COPY client ./client
RUN npm --workspace client run build

FROM nginx:1.27-alpine
COPY --from=build /app/client/dist /usr/share/nginx/html
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
