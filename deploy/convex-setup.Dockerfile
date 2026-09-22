# Traegt die Umgebungswerte in das Convex-Backend ein, sobald es steht.
#
# Warum ein eigener Behaelter: das Backend haelt seine Werte in der eigenen
# Datenbank, erreichbar nur ueber den Admin-Schluessel. Weder Compose noch
# Dokploy koennen dort hineinschreiben. So bleiben alle Geheimnisse an einer
# Stelle — in der Umgebung des Stapels — statt zusaetzlich in GitHub.
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY convex ./convex
COPY scripts/convex-env-sichern.mjs ./scripts/

CMD ["node", "scripts/convex-env-sichern.mjs"]
