FROM node:22-alpine
WORKDIR /app
COPY . .
ENV BANCO=/dados/rifas.db
VOLUME /dados
EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]
