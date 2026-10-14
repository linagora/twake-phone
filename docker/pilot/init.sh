#!/bin/sh
# Writes docker/pilot/.env for a pilot machine: the domain, how TLS is obtained, the media address, random secrets,
# and (with --demo) the settings of the demo identity provider and directory. Never overwrites an existing .env.
#
#   ./init.sh <domain> <email|internal> [--demo] [--public-ip <ip>]
#
# <email>: Let's Encrypt certificate under that contact (DOMAIN must resolve to this machine, ports 80 and 443 open).
# internal: Caddy's own CA, for a test where each browser is told to trust it (README, "Sans nom public").
set -eu
cd "$(dirname "$0")"

usage() { echo "usage: $0 <domain> <email|internal> [--demo] [--public-ip <ip>]" >&2; exit 2; }
[ $# -ge 2 ] || usage
domain=$1 tls=$2; shift 2
demo=0 public_ip=
while [ $# -gt 0 ]; do
  case $1 in
    --demo) demo=1 ;;
    --public-ip) [ $# -ge 2 ] || usage; public_ip=$2; shift ;;
    *) usage ;;
  esac
  shift
done
case $domain in *[!a-zA-Z0-9.-]*|'') echo "Not a domain name: $domain" >&2; exit 2 ;; esac
case $tls in internal|*@*) ;; *) echo "TLS must be an email (Let's Encrypt) or 'internal'" >&2; exit 2 ;; esac
[ ! -e .env ] || { echo ".env already exists: remove it to start over (the database keeps its password, see README)" >&2; exit 1; }

# The media address: rtpengine writes it in the SDP and the browsers send their audio there. The machine's own
# address towards the Internet, and the public one DOMAIN resolves to (or --public-ip): "<private>!<public>" when
# they differ (1:1 NAT of most cloud providers).
local_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' || true)
[ -n "$local_ip" ] || local_ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
[ -n "$public_ip" ] || public_ip=$(getent ahostsv4 "$domain" 2>/dev/null | awk 'NR==1{print $1}' || true)
[ -n "$local_ip" ] || local_ip=$public_ip
[ -n "$local_ip" ] || { echo "Cannot find this machine's IPv4 address: pass --public-ip" >&2; exit 1; }
if [ -z "$public_ip" ]; then
  echo "$domain does not resolve yet: using $local_ip for the media (pass --public-ip if the machine is behind a NAT)" >&2
  interface=$local_ip
elif [ "$public_ip" = "$local_ip" ]; then
  interface=$local_ip
else
  interface="$local_ip!$public_ip"
fi

secret() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
umask 077
{
  echo "# Written by init.sh on $(date -u +%Y-%m-%dT%H:%MZ). Secrets: keep this file on the machine only."
  echo "DOMAIN=$domain"
  echo "TLS=$tls"
  echo "RTPENGINE_INTERFACE=$interface"
  echo "POSTGRES_PASSWORD=$(secret 18)"
  echo "SECRETS_KEY=$(secret 32)"
  echo "HSTS_MAX_AGE=$( [ "$tls" = internal ] && echo || echo 31536000 )"
  if [ $demo = 1 ]; then
    echo
    echo "# Demo profile (docker compose --profile demo ...): Keycloak at https://$domain/auth, OpenLDAP on the loopback."
    echo "COMPOSE_PROFILES=demo"
    echo "DEMO_PASSWORD=$(secret 6)"
    echo "KEYCLOAK_ADMIN_PASSWORD=$(secret 12)"
    echo "LDAP_ADMIN_PASSWORD=$(secret 12)"
    ldap_reader=$(secret 12)
    echo "LDAP_READONLY_PASSWORD=$ldap_reader"
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
    echo
    echo "# Your identity provider (README, \"Identité\"): a public client with PKCE, whose access token is a JWT for the Gateway."
    echo "OIDC_AUTHORITY="
    echo "OIDC_CLIENT_ID=twakephone-web"
    echo "JWT_ISSUER="
    echo "JWT_JWKS_URL="
    echo "JWT_AUDIENCE=twakephone-gateway"
    echo "# Who administers: a role in the token (JWT_ROLES_CLAIM + ADMIN_ROLE) or a list of identifiers."
    echo "ADMIN_USERS="
    echo "# Your directory (README, \"Annuaire\"), or USER_EXTENSIONS=alice:101,bob:102 without one."
    echo "LDAP_URL="
    echo "LDAP_BASE_DN="
    echo "LDAP_BIND_DN="
    echo "LDAP_BIND_PASSWORD="
    echo "LDAP_ATTR_EXTENSION="
    echo "USER_EXTENSIONS="
  fi
} > .env
echo "Wrote $(pwd)/.env (media address $interface)."
[ $demo = 0 ] || echo "Demo accounts alice, bob and carole share the password in DEMO_PASSWORD; Keycloak's admin is 'admin' / KEYCLOAK_ADMIN_PASSWORD."
echo "Next: docker compose up -d --build --wait"
