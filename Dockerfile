# Nommera -- microservice de pre-controle EPUB (Etape 1)
# EPUBCheck (Java) + Ace by DAISY (Electron). Voir README.md pour le
# deploiement sur Render, et la memoire projet nommera_epub_precheck pour
# le contexte complet (tests de charge deja faits, resultats, decisions).

FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        openjdk-17-jre-headless \
        wget unzip ca-certificates \
        xvfb dbus-x11 xauth \
        fonts-liberation \
        libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
        libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libglib2.0-0 \
        libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
        libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
        libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 \
        libxss1 libxtst6 \
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

# Ace ouvre par defaut 4 fenetres Chromium EN PARALLELE pour analyser les
# documents d'un EPUB (CONCURRENT_INSTANCES, code en dur, aucune option CLI
# ni variable d'environnement pour le changer -- verifie en lisant le
# paquet). Sur les 512 Mo du plan Free de Render, 4 rendus Chromium
# simultanes (meme sans GPU) depassent tres probablement la limite memoire
# et le noyau tue silencieusement des processus -- d'ou l'echec observe
# (did-fail-load: -3 / ERR_ABORTED) apres avoir deja resolu xauth, les
# librairies systeme et le GPU. On repasse ce paquet installe en analyse
# sequentielle (1 fenetre a la fois) : plus lent, mais tient dans la RAM
# disponible. A revoir a la hausse si le plan Render change.
RUN sed -i 's/const CONCURRENT_INSTANCES = 4;/const CONCURRENT_INSTANCES = 1;/' \
        node_modules/@daisy/ace-axe-runner-electron/lib/cli.js \
    && grep -q 'const CONCURRENT_INSTANCES = 1;' \
        node_modules/@daisy/ace-axe-runner-electron/lib/cli.js

COPY server.js ./

# Ace/Electron refuse de tourner en root ("Running as root without
# --no-sandbox is not supported") -- trouvaille de l'Etape 0. L'image
# node officielle fournit deja un utilisateur non-root "node".
# (Le dossier d'upload temporaire est cree par server.js au demarrage,
# PAS ici au build -- voir le commentaire dans server.js : /tmp est
# remonte vide au demarrage reel du conteneur sur Render.)
RUN chown -R node:node /opt/precheck
USER node

ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
