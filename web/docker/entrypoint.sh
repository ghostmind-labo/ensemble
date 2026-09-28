#!/bin/sh
# Runs under varlock: PORT, PUBLIC_URL and DOCS_ROOT come from .env.schema.
cd /usr/app/app
if [ "$APP_ENV" = "prod" ]; then
  while true; do npm run start || echo "web exited ($?), restarting"; sleep 2; done
else
  exec npm run dev
fi
