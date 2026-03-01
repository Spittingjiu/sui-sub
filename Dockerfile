FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/data

ENV PORT=8780
EXPOSE 8780

CMD ["npm", "start"]
