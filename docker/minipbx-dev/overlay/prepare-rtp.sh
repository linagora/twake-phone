#!/bin/sh
# MiniPBX regenerates rtp.conf from a template at every apply, so ICE host-candidate
# mapping has to live in the template. Runs at each start, idempotent.
set -eu
TPL=/opt/minipbx/app/templates/asterisk/rtp.conf.j2
if [ -n "${ASTERISK_EXTERNAL_ADDRESS:-}" ]; then
  CONTAINER_IP="$(hostname -i | awk '{print $1}')"
  sed -i '/^icesupport=/d; /^\[ice_host_candidates\]/,$d' "$TPL"
  sed -i 's/^\[general\]$/[general]\nicesupport=yes/' "$TPL"
  printf '\n[ice_host_candidates]\n%s => %s\n' "$CONTAINER_IP" "$ASTERISK_EXTERNAL_ADDRESS" >> "$TPL"
fi
