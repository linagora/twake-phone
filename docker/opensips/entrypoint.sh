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
: "${TLS_CERT:=/etc/opensips/tls/cert.pem}"
: "${TLS_KEY:=/etc/opensips/tls/key.pem}"
: "${CFG_TEMPLATE:=/etc/opensips/opensips.cfg.tpl}"
: "${CFG_OUT:=/etc/opensips/opensips.cfg}"
: "${OPENSIPS_BIN:=/usr/sbin/opensips}"
export SIP_DOMAIN LISTEN_IP SIP_PORT WS_PORT WSS_PORT OPENSIPS_DB_URL RTPENGINE_SOCK OPENSIPS_LOG_LEVEL OPENSIPS_MPATH MI_FIFO TLS_CERT TLS_KEY

if [ ! -f "$TLS_CERT" ] || [ ! -f "$TLS_KEY" ]; then
  echo "No certificate at $TLS_CERT: making a self-signed one for $SIP_DOMAIN (dev and CI only)" >&2
  mkdir -p "$(dirname "$TLS_CERT")" "$(dirname "$TLS_KEY")"
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=$SIP_DOMAIN" \
    -addext "subjectAltName=DNS:$SIP_DOMAIN,DNS:localhost,IP:127.0.0.1" \
    -keyout "$TLS_KEY" -out "$TLS_CERT" 2>/dev/null
fi

# Only the listed variables are substituted: a "$avp(...)" of the script must stay as it is.
envsubst '$SIP_DOMAIN $LISTEN_IP $SIP_PORT $WS_PORT $WSS_PORT $OPENSIPS_DB_URL $RTPENGINE_SOCK $OPENSIPS_LOG_LEVEL $OPENSIPS_MPATH $MI_FIFO $TLS_CERT $TLS_KEY' \
  < "$CFG_TEMPLATE" > "$CFG_OUT"

"$OPENSIPS_BIN" -C -f "$CFG_OUT"
exec "$OPENSIPS_BIN" -F -f "$CFG_OUT" "$@"
