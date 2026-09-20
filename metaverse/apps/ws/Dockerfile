FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

COPY apps/ws/package*.json ./apps/ws/

COPY packages/db/package*.json ./packages/db/

RUN npm install -g npm@10.9.2 && npm install

COPY . .

RUN npm run build --workspace=@repo/db

WORKDIR /app/apps/ws

RUN npm run build

EXPOSE 8080

CMD ["npm", "start"]