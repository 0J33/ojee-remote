FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY ui ./ui
COPY public ./public

ENV NODE_ENV=production \
    PORT=8200 \
    HOST=0.0.0.0 \
    DEVICES_FILE=/config/devices.json

# devices.json holds RDP/VNC credentials and agent tokens, so it is MOUNTED
# rather than baked in. A credential in an image layer survives every later
# deletion and travels wherever the image does.
VOLUME ["/config"]
EXPOSE 8200

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8200)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
