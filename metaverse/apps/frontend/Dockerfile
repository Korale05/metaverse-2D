FROM node:22-alpine AS  build

WORKDIR /app

COPY package*.json ./
COPY apps/frontend/package*.json ./apps/frontend/
COPY packages/db/package*.json ./packages/db/

RUN npm install -g npm@10.9.2 && npm install

COPY . .

RUN npm run build --workspace=@repo/db

WORKDIR /app/apps/frontend

RUN npm run build

# Stage 2: Serve with Nginx

FROM nginx:alpine

COPY --from=build /app/apps/frontend/dist /usr/share/nginx/html

COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD [ "nginx","-g","daemon off;" ]

