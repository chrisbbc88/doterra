#!/bin/bash
# Doppelklick (macOS): startet Kathrins CRM und öffnet es im Browser.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display alert "Node.js fehlt" message "Bitte einmalig Node.js (LTS) von https://nodejs.org installieren und dann erneut starten."'
  exit 1
fi
PORT=${PORT:-8787}
if curl -s "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then
  open "http://127.0.0.1:$PORT"; exit 0
fi
(sleep 1.5 && open "http://127.0.0.1:$PORT") &
exec node server.mjs
