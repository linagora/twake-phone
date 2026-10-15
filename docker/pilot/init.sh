#!/bin/sh
# Writes docker/pilot/.env for a pilot machine: the domain, how TLS is obtained, the media address, random secrets,
# and (with --demo) the settings of the demo identity provider and directory. Never overwrites an existing .env, and
# refuses while the kit's volumes exist: new secrets over old data break the kit (README, "Repartir de zéro").
#
#   ./init.sh <domain> <email|internal> [--demo] [--public-ip <ip>] [--media-ip <address>]
#
# <email>: Let's Encrypt certificate under that contact (DOMAIN must resolve to this machine, ports 80 and 443 open).
# internal: Caddy's own CA, for a test where each browser is told to trust it (README, "Sans nom public").
# --public-ip: the machine's public IPv4 when DOMAIN does not resolve to it yet.
# --media-ip: the media address as is (rtpengine's interface, "<private>!<public>" behind a NAT), for a local test.
set -eu
cd "$(dirname "$0")"

usage() { echo "usage: $0 <domain> <email|internal> [--demo] [--public-ip <ip>] [--media-ip <address>]" >&2; exit 2; }
fail() { echo "$*" >&2; exit 1; }
[ $# -ge 2 ] || usage
# Host names are case-insensitive and the browser sends them in lower case: the redirect URIs must match it.
domain=$(printf %s "$1" | tr 'A-Z' 'a-z' | sed 's/\.$//') tls=$2; shift 2
demo=0 public_ip= media_ip=
while [ $# -gt 0 ]; do
  case $1 in
    --demo) demo=1 ;;
    --public-ip) [ $# -ge 2 ] || usage; public_ip=$2; shift ;;
    --media-ip) [ $# -ge 2 ] || usage; media_ip=$2; shift ;;
    *) usage ;;
  esac
  shift
done

is_ipv4() {
  case $1 in *[!0-9.]*|.*|*.|*..*|'') return 1 ;; esac
  [ "$(printf %s "$1" | tr -cd . | wc -c)" -eq 3 ] || return 1
  for octet in $(printf %s "$1" | tr . ' '); do [ "$octet" -le 255 ] || return 1; done
}
# Loopback, private (RFC 1918), shared (CGNAT) and link-local addresses: never what the Internet reaches.
is_internal() {
  case $1 in
    127.*|10.*|192.168.*|169.254.*|0.*) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
    100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) return 0 ;;
  esac
  return 1
}

case $domain in *[!a-z0-9.-]*|''|.*|-*) fail "Not a domain name: $domain" ;; esac
is_ipv4 "$domain" && fail "Give a domain name, not an address: browsers need a certificate for a name"
case $domain in *.*) ;; *) fail "Not a fully qualified domain name: $domain" ;; esac
case $tls in
  internal) ;;
  *[!A-Za-z0-9@._+-]*|*@*@*|@*|*@) fail "TLS must be an email address (Let's Encrypt) or 'internal'" ;;
  *@*.*) ;;
  *) fail "TLS must be an email address (Let's Encrypt) or 'internal'" ;;
esac
[ -z "$public_ip" ] || is_ipv4 "$public_ip" || fail "--public-ip: not an IPv4 address: $public_ip"
case $media_ip in *[!0-9.!]*) fail "--media-ip: an IPv4 address, or <private>!<public>" ;; esac
[ "$(uname -m)" = x86_64 ] || fail "The kit's images are built for x86_64 (amd64) only; this machine is $(uname -m)"
[ ! -e .env ] || fail ".env already exists. To start over: docker compose down -v && rm .env (README, \"Repartir de zéro\")"
if docker volume inspect twakephone_postgres-data >/dev/null 2>&1; then
  fail "The kit's data volumes exist and hold the secrets of the previous .env. Start over with docker compose down -v, or restore that .env"
fi

# The media address: rtpengine writes it in the SDP and the browsers send their audio there. The machine's own
# address towards the Internet, and the public one DOMAIN resolves to (or --public-ip): "<private>!<public>" when
# they differ (1:1 NAT of most cloud providers).
if [ -n "$media_ip" ]; then
  interface=$media_ip
else
  local_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' || true)
  [ -n "$local_ip" ] || local_ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  if [ -z "$public_ip" ]; then
    # getent reads /etc/hosts first: a 127.0.1.1 written there by cloud-init is not the answer.
    public_ip=$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | while read -r ip; do is_internal "$ip" || { echo "$ip"; break; }; done || true)
  fi
  [ -n "$public_ip" ] || {
    is_internal "${local_ip:-127.0.0.1}" && fail "$domain does not resolve to a public address and this machine's own ($local_ip) is private: pass --public-ip <its public IPv4>"
    public_ip=$local_ip
  }
  is_internal "$public_ip" && fail "--public-ip $public_ip is not a public address"
  # The address the machine goes out with, when it can tell: a mismatch is a stale DNS record or a proxying CDN.
  seen=$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
  if is_ipv4 "${seen:-x}" && [ "$seen" != "$public_ip" ]; then
    fail "$domain resolves to $public_ip but this machine reaches the Internet as $seen (stale DNS record, or a proxy such as Cloudflare's: DNS only). Fix the DNS, or pass --public-ip"
  fi
  if [ -z "$local_ip" ] || [ "$local_ip" = "$public_ip" ]; then interface=$public_ip; else interface="$local_ip!$public_ip"; fi
fi

secret() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
alice=$(secret 6) bob=$(secret 6) carole=$(secret 6) ldap_reader=$(secret 12)
umask 077
{
  echo "# Written by init.sh on $(date -u +%Y-%m-%dT%H:%MZ). Secrets: keep this file on the machine, and in every backup:"
  echo "# the database is useless without SECRETS_KEY."
  echo "DOMAIN=$domain"
  echo "TLS=$tls"
  echo "RTPENGINE_INTERFACE=$interface"
  echo "POSTGRES_PASSWORD=$(secret 18)"
  echo "SECRETS_KEY=$(secret 32)"
  echo "HSTS_MAX_AGE=$( [ "$tls" = internal ] && echo || echo 31536000 )"
  echo
  echo "# Demo profile: Keycloak at https://$domain/auth, OpenLDAP on the loopback, three people. Its secrets are written"
  echo "# whatever the profile, so that starting it by mistake never leaves an empty or default password."
  [ $demo = 0 ] || echo "COMPOSE_PROFILES=demo"
  echo "ALICE_PASSWORD=$alice"
  echo "BOB_PASSWORD=$bob"
  echo "CAROLE_PASSWORD=$carole"
  echo "KEYCLOAK_ADMIN_PASSWORD=$(secret 12)"
  echo "LDAP_ADMIN_PASSWORD=$(secret 12)"
  echo "LDAP_READONLY_PASSWORD=$ldap_reader"
  echo
  if [ $demo = 1 ]; then
    echo "OIDC_AUTHORITY=https://$domain/auth/realms/twakephone"
    echo "OIDC_CLIENT_ID=twakephone-web"
    # Keycloak issues a refresh token without offline_access: no consent page.
    echo "OIDC_SCOPE=\"openid profile email\""
    echo "OIDC_PROMPT="
    echo "JWT_ISSUER=https://$domain/auth/realms/twakephone"
    echo "JWT_JWKS_URL=http://127.0.0.1:8180/auth/realms/twakephone/protocol/openid-connect/certs"
    echo "JWT_AUDIENCE=twakephone-gateway"
    echo "ADMIN_USERS=alice"
    echo "LDAP_URL=ldap://127.0.0.1:3890"
    echo "LDAP_BASE_DN=ou=people,dc=twakephone,dc=demo"
    echo "LDAP_BIND_DN=cn=readonly,dc=twakephone,dc=demo"
    echo "LDAP_BIND_PASSWORD=$ldap_reader"
    echo "LDAP_ATTR_EXTENSION=employeeNumber"
  else
    echo "# Your identity provider (README, \"Votre SSO et votre annuaire\"): a public client with PKCE, whose access"
    echo "# token is a JWT for the Gateway."
    echo "OIDC_AUTHORITY="
    echo "OIDC_CLIENT_ID=twakephone-web"
    echo "JWT_ISSUER="
    echo "JWT_JWKS_URL="
    echo "JWT_AUDIENCE=twakephone-gateway"
    echo "# Who administers: a role in the token (JWT_ROLES_CLAIM + ADMIN_ROLE) or a list of identifiers."
    echo "ADMIN_USERS="
    echo "# Your directory, or USER_EXTENSIONS=alice:101,bob:102 without one."
    echo "LDAP_URL="
    echo "LDAP_BASE_DN="
    echo "LDAP_BIND_DN="
    echo "LDAP_BIND_PASSWORD="
    echo "LDAP_ATTR_EXTENSION="
    echo "USER_EXTENSIONS="
  fi
} > .env
echo "Wrote $(pwd)/.env (media address $interface)."
[ $demo = 0 ] || echo "Demo accounts alice (administrator), bob and carole: their passwords are ALICE_PASSWORD, BOB_PASSWORD and CAROLE_PASSWORD in .env."
echo "Next: docker compose up -d --build --wait --wait-timeout 600"
