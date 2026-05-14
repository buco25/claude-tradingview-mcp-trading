FROM node:20-alpine

WORKDIR /app

# Kopiraj package.json i instaliraj dependencije
COPY package*.json ./
RUN npm ci --omit=dev

# Kopiraj ostatak projekta
COPY . .

# Railway injectira env varijable u runtime — NE koristimo ARG/ENV za tajne
EXPOSE 3000

CMD ["node", "dashboard.js"]
