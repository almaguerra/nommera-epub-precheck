# Nommera -- microservice de pre-controle EPUB (Etape 1)
# EPUBCheck (Java) + Ace by DAISY (Electron). Voir README.md pour le
# deploiement sur Render, et la memoire projet nommera_epub_precheck pour
# le contexte complet (tests de charge deja faits, resultats, decisions).

FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        openjdk-17-jre-headless \
        wget unzip ca-certificates \
        xvfb dbus-x11 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/precheck

# EPUBCheck 5.1.0 (meme version que testee lors de l'Etape 0)
RUN wget -q https://github.com/w3c/epubcheck/releases/download/v5.1.0/epubcheck-5.1.0.zip \
    && unzip -q epubcheck-5.1.0.zip \
    && mv epubcheck-5.1.0 epubcheck \
    && rm epubcheck-5.1.0.zip

# Ace embarque son propre Electron -- pas besoin de Chromium systeme.
# PUPPETEER_SKIP_DOWNLOAD evite un telechargement inutile d'un Chrome que
# ace n'utilise pas (Puppeteer n'est qu'une dependance transitive annexe).
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

# Ace/Electron refuse de tourner en root ("Running as root without
# --no-sandbox is not supported") -- trouvaille de l'Etape 0. L'image
# node officielle fournit deja un utilisateur non-root "node".
RUN mkdir -p /tmp/precheck-uploads \
    && chown -R node:node /opt/precheck /tmp/precheck-uploads
ENV TMPDIR=/tmp/precheck-uploads
USER node

ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
