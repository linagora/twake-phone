#!/bin/bash
# Starts the Twake Workplace dev stack with Twake Phone, the Telephony Gateway and the dev PBX.
# Run it yourself in a terminal: it asks for your sudo password for three host changes
# (loopback alias, /etc/hosts, trusting the stack's root CA), each explained below.
# Re-runnable: every step is idempotent.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STACK="$ROOT/references/twake-workplace-docker"
BIND=127.0.0.2   # Traefik listens here: nginx already owns 127.0.0.1:80/443 on this machine
DOMAIN=twake.local
USERS="user1 user2 user3"

step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

step "0/8 Reference repositories and patches"
"$ROOT/scripts/setup-references.sh"

step "1/8 Host changes (sudo)"
sudo -v
if ! ifconfig lo0 | grep -q "inet $BIND "; then
  echo "  adding loopback alias $BIND (lost at reboot; rerun this script after one)"
  sudo ifconfig lo0 alias "$BIND" up
fi
if ! grep -q "# twake-phone-dev" /etc/hosts; then
  names="auth manager ldap-rest traefik meet livekit oauthcallback telephony pbx"
  for u in $USERS; do
    for app in "" -home -drive -settings -notes -dataproxy -phone -chat -mail; do names="$names $u$app"; done
  done
  echo "  adding $BIND entries for *.$DOMAIN to /etc/hosts"
  { echo "# twake-phone-dev"; for n in $names; do printf '%s %s.%s\n' "$BIND" "$n" "$DOMAIN"; done; echo "# /twake-phone-dev"; } | sudo tee -a /etc/hosts >/dev/null
fi
if ! security find-certificate -c "Twake" /Library/Keychains/System.keychain >/dev/null 2>&1; then
  echo "  trusting the stack's root CA (needed for https://*.$DOMAIN)"
  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$STACK/twake_auth/traefik/ssl/root-ca.crt"
fi

step "2/8 Docker network"
docker network inspect twake-network >/dev/null 2>&1 || docker network create twake-network --subnet=172.27.0.0/16

step "3/8 Building Phone and the telephony packages"
( cd "$ROOT" && yarn install --frozen-lockfile && yarn build )
( cd "$ROOT/apps/phone" && yarn install --ignore-engines --frozen-lockfile && npx rsbuild build )

step "4/8 Twake stack: data, auth, cozy (Phone mounted as a dev app)"
for repo in twake_db twake_auth cozy_stack; do
  ( cd "$STACK/$repo" && ./compose-wrapper.sh up -d )
done
until [[ "$(docker exec cozyt cozy-stack status 2>/dev/null || true)" == *OK* ]]; do sleep 3; done

step "5/8 Demo users"
cd "$STACK"
# Capture first: `grep -q` closing the pipe early would trip pipefail.
listing="$(scripts/twake users list 2>/dev/null || true)"
for u in $USERS; do
  if ! grep -qw "$u" <<<"$listing"; then
    scripts/twake users add "$u" --email "$u@$DOMAIN" --given-name "User" --family-name "$u" --password "$u"
  fi
done
echo "$listing"

step "6/8 Installing Phone on each instance"
for u in $USERS; do
  until docker exec cozyt cozy-stack apps show home --domain "$u.$DOMAIN" >/dev/null 2>&1; do sleep 3; done
  cozy_stack/scripts/install-dev-app.sh --slug phone --domain "$u.$DOMAIN"
  # Dev identity sent to the Gateway (real OIDC validation is not implemented yet).
  scripts/twake flags set "$u" "phone.dev-user=$u"
done

step "7/8 PBX and Telephony Gateway"
docker build -f "$ROOT/references/minipbx/docker/Dockerfile" -t minipbx-base:local "$ROOT/references/minipbx"
( cd "$ROOT/docker" && BASE_DOMAIN=$DOMAIN ASTERISK_EXTERNAL_ADDRESS=127.0.0.1 docker compose -f docker-compose.dev.yml up -d --build )

step "8/8 Ready"
cat <<MSG

  Open https://user1.$DOMAIN  (login user1 / password user1) then the app Phone,
  and https://user2.$DOMAIN in another browser profile or private window (user2 / user2).
  Phone direct links:  https://user1-phone.$DOMAIN   https://user2-phone.$DOMAIN
  Extensions: user1=101  user2=102  user3=103.
  Stop: (cd references/twake-workplace-docker/cozy_stack && ./compose-wrapper.sh down) and docker compose -f docker/docker-compose.dev.yml down
MSG
