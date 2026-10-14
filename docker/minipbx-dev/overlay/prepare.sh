#!/bin/sh
# Runs inside MiniPBX's entrypoint, after it wrote modules.conf and before Asterisk starts.
set -eu
: "${ARI_USER:=twake}"
: "${ARI_PASSWORD:=twake-dev}"

cat >> /etc/asterisk/modules.conf <<'MODS'
load => res_http_websocket.so
load => res_pjsip_transport_websocket.so
load => res_srtp.so
load => res_crypto.so
load => codec_opus_open_source.so
load => res_format_attr_opus.so
load => res_stasis.so
load => app_stasis.so
load => res_stasis_answer.so
load => res_stasis_device_state.so
load => res_stasis_playback.so
load => res_stasis_recording.so
load => res_stasis_snoop.so
load => res_ari.so
load => res_ari_model.so
load => res_ari_applications.so
load => res_ari_asterisk.so
load => res_ari_bridges.so
load => res_ari_channels.so
load => res_ari_device_states.so
load => res_ari_endpoints.so
load => res_ari_events.so
load => res_ari_playbacks.so
load => res_ari_recordings.so
load => res_ari_sounds.so
MODS

# TLS certificate: the Twake stack's wildcard (trusted by its root CA) when mounted, else a self-signed one.
TLS_CERT=/opt/twake-overlay/pbx.pem
TLS_KEY=/opt/twake-overlay/pbx.key
if [ -f /run/pbx-tls/fullchain.pem ] && [ -f /run/pbx-tls/key.pem ]; then
  mkdir -p /etc/asterisk/keys
  cp /run/pbx-tls/fullchain.pem /etc/asterisk/keys/fullchain.pem
  cp /run/pbx-tls/key.pem /etc/asterisk/keys/key.pem
  chown -R "${MINIPBX_RUNTIME_USER:-asterisk}" /etc/asterisk/keys
  chmod 600 /etc/asterisk/keys/key.pem
  TLS_CERT=/etc/asterisk/keys/fullchain.pem
  TLS_KEY=/etc/asterisk/keys/key.pem
fi

cat > /etc/asterisk/http.conf <<HTTP
[general]
enabled=yes
bindaddr=0.0.0.0
bindport=8088
tlsenable=yes
tlsbindaddr=0.0.0.0:8089
tlscertfile=${TLS_CERT}
tlsprivatekey=${TLS_KEY}
HTTP

cat > /etc/asterisk/ari.conf <<ARI
[general]
enabled=yes
allowed_origins=*

[${ARI_USER}]
type=user
read_only=no
password=${ARI_PASSWORD}
password_format=plain
ARI


# Ring-all dialplan context, included after MiniPBX's own extensions.
cp /opt/twake-overlay/extensions_twake.conf /etc/asterisk/extensions_twake.conf
touch /etc/asterisk/extensions.conf
grep -q extensions_twake /etc/asterisk/extensions.conf || printf '\n#include extensions_twake.conf\n' >> /etc/asterisk/extensions.conf

# LiveKit SIP trunk (Meet): endpoint matched by IP.
cp /opt/twake-overlay/pjsip_twake.conf /etc/asterisk/pjsip_twake.conf
touch /etc/asterisk/pjsip.conf
grep -q pjsip_twake /etc/asterisk/pjsip.conf || printf '\n#include pjsip_twake.conf\n' >> /etc/asterisk/pjsip.conf
