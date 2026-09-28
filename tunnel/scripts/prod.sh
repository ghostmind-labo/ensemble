#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose -p ensemble -f docker/compose.prod.yaml up --build -d
