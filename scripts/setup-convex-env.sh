#!/usr/bin/env bash
# Run AFTER `npx convex dev` has linked your deployment (one-time interactive).
# Sets all required env vars on your Convex deployment.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env.local ]]; then
  echo "Missing .env.local (created by 'npx convex dev'). Run that first."
  exit 1
fi

# Load shared env (tile service secret, etc.)
set -a
source .env
set +a

# Stripe — edit these or export before running
: "${STRIPE_SECRET_KEY:?export STRIPE_SECRET_KEY before running}"
: "${STRIPE_WEBHOOK_SECRET:?export STRIPE_WEBHOOK_SECRET before running}"
: "${APP_PUBLIC_URL:=http://localhost:5173}"

# Optional
RESEND_API_KEY="${RESEND_API_KEY:-}"
RESEND_FROM_EMAIL="${RESEND_FROM_EMAIL:-DRM Reader <onboarding@resend.dev>}"

npx convex env set STRIPE_SECRET_KEY "$STRIPE_SECRET_KEY"
npx convex env set STRIPE_WEBHOOK_SECRET "$STRIPE_WEBHOOK_SECRET"
npx convex env set APP_PUBLIC_URL "$APP_PUBLIC_URL"
npx convex env set TILE_SERVICE_SECRET "$TILE_SERVICE_SECRET"

if [[ -n "$RESEND_API_KEY" ]]; then
  npx convex env set RESEND_API_KEY "$RESEND_API_KEY"
  npx convex env set RESEND_FROM_EMAIL "$RESEND_FROM_EMAIL"
fi

echo "Done. Convex env configured."
npx convex env list
