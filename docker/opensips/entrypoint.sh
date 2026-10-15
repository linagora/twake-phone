#!/bin/sh
# Renders opensips.cfg from the template and the environment, makes a throwaway certificate when none is given,
# then runs OpenSIPS in the foreground. Every variable has a value fit for a local or CI stack.
set -eu

: "${SIP_DOMAIN:=127.0.0.1}"
: "${LISTEN_IP:=127.0.0.1}"
: "${SIP_PORT:=5060}"
: "${WS_PORT:=8088}"
: "${WSS_PORT:=8089}"
: "${OPENSIPS_DB_URL:=postgres://twake:twake@127.0.0.1:54320/twake}"
: "${RTPENGINE_SOCK:=udp:127.0.0.1:22222}"
: "${OPENSIPS_LOG_LEVEL:=2}"
: "${OPENSIPS_MPATH:=/usr/lib/x86_64-linux-gnu/opensips/modules/}"
: "${MI_FIFO:=/tmp/opensips_fifo}"
: "${MI_LISTEN_IP:=127.0.0.1}"
: "${MI_PORT:=8880}"
: "${MI_ALLOW_PUBLIC:=0}"
: "${TLS_CERT:=/etc/opensips/tls/cert.pem}"
: "${TLS_KEY:=/etc/opensips/tls/key.pem}"
: "${CFG_TEMPLATE:=/etc/opensips/opensips.cfg.tpl}"
: "${CFG_OUT:=/etc/opensips/opensips.cfg}"
: "${OPENSIPS_BIN:=/usr/sbin/opensips}"
export SIP_DOMAIN LISTEN_IP SIP_PORT WS_PORT WSS_PORT OPENSIPS_DB_URL RTPENGINE_SOCK OPENSIPS_LOG_LEVEL OPENSIPS_MPATH MI_FIFO MI_LISTEN_IP MI_PORT TLS_CERT TLS_KEY

# The MI socket (mi_datagram) has no authentication: whoever reaches it can stop OpenSIPS, drop registrations, end
# calls, read who is registered and subscribe to the events (who calls whom). It listens on its own address, the
# loopback by default, never on LISTEN_IP because SIP is opened to a network: a private address (the Gateway on
# another host of an internal network) is accepted, any other one only with MI_ALLOW_PUBLIC=1.
# A dotted IPv4 address: four numbers from 0 to 255, nothing else.
is_ipv4() {
  case "$1" in
    '' | *[!0-9.]* | .* | *. | *..*) return 1 ;;
  esac
  saved_ifs=$IFS
  IFS=.
  # Split on the dots (no glob character can be left after the check above).
  # shellcheck disable=SC2086
  set -- $1
  IFS=$saved_ifs
  [ "$#" -eq 4 ] || return 1
  for octet in "$@"; do
    case "$octet" in
      ? | ?? | ???) ;;
      *) return 1 ;;
    esac
    [ "$octet" -le 255 ] || return 1
  done
}
mi_address_is_private() {
  is_ipv4 "$1" || return 1
  case "$1" in
    127.* | 10.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].* | 169.254.*) return 0 ;;
    *) return 1 ;;
  esac
}
if ! mi_address_is_private "$MI_LISTEN_IP" && [ "$MI_ALLOW_PUBLIC" != "1" ]; then
  echo "MI_LISTEN_IP=$MI_LISTEN_IP is not a loopback or private IPv4 address: the MI has no authentication." >&2
  echo "Keep it on 127.0.0.1 (or the private network the Gateway reaches it on), or set MI_ALLOW_PUBLIC=1 behind a firewall." >&2
  exit 1
fi

if [ ! -f "$TLS_CERT" ] || [ ! -f "$TLS_KEY" ]; then
  echo "No certificate at $TLS_CERT: making a self-signed one for $SIP_DOMAIN (dev and CI only)" >&2
  mkdir -p "$(dirname "$TLS_CERT")" "$(dirname "$TLS_KEY")"
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=$SIP_DOMAIN" \
    -addext "subjectAltName=DNS:$SIP_DOMAIN,DNS:localhost,IP:127.0.0.1" \
    -keyout "$TLS_KEY" -out "$TLS_CERT" 2>/dev/null
fi

# Only the listed variables are substituted: a "$avp(...)" of the script must stay as it is.
envsubst '$SIP_DOMAIN $LISTEN_IP $SIP_PORT $WS_PORT $WSS_PORT $OPENSIPS_DB_URL $RTPENGINE_SOCK $OPENSIPS_LOG_LEVEL $OPENSIPS_MPATH $MI_FIFO $MI_LISTEN_IP $MI_PORT $TLS_CERT $TLS_KEY' \
  < "$CFG_TEMPLATE" > "$CFG_OUT"

"$OPENSIPS_BIN" -C -f "$CFG_OUT"
exec "$OPENSIPS_BIN" -F -f "$CFG_OUT" "$@"
