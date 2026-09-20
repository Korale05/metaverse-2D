FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
COPY apps/http/package*.json ./apps/http/
COPY packages/db/package*.json ./packages/db/

RUN npm install -g npm@10.9.2 && npm install

COPY . .

RUN npm run build --workspace=@repo/db

WORKDIR /app/apps/http

RUN npm run build

EXPOSE 3000

CMD [ "npm","start" ]