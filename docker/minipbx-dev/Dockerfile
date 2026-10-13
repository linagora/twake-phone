# Dev PBX = unmodified MiniPBX + a build-time overlay that adds what the Twake
# provider needs and MiniPBX deliberately leaves out of its MVP: WebRTC
# (WSS + DTLS-SRTP) and ARI. Used for development and CI only.
ARG MINIPBX_IMAGE=minipbx-base:local
FROM ${MINIPBX_IMAGE}

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY overlay/ /opt/twake-overlay/
RUN python3.12 /opt/twake-overlay/patch.py \
    && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
       -keyout /opt/twake-overlay/pbx.key -out /opt/twake-overlay/pbx.pem \
       -subj "/CN=pbx.twake.local" \
       -addext "subjectAltName=DNS:pbx.twake.local,DNS:localhost,IP:127.0.0.1" \
    && chmod 644 /opt/twake-overlay/pbx.key

EXPOSE 8088/tcp 8089/tcp
