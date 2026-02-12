FROM node:20-alpine

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY . .

RUN npm run build

ENV MODE=api

CMD ["sh", "-c", "if [ \"$MODE\" = \"worker\" ]; then npm run worker; else npm run api; fi"]
