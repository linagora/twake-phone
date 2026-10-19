# LinTO STT for the development and CI stack (step 11b, ADR 0023): the official image of its Kaldi engine, pinned by
# digest, with the smallest French model built in (Vosk's small French model 0.22, Apache 2.0, about 41 MB zipped):
# what transcribes a message of a few seconds in a second or two on a CI runner, without a GPU. A deployment chooses
# its own model (a larger one, LinTO's own), mounted at MODEL_PATH.
FROM lintoai/linto-stt-kaldi:2.1.1@sha256:fc9dce8b9fce5beca6f5eefadf0f8f6599dc99c8c154ba505164800f64891d2b

# The model, checked against its SHA-256 before it is unpacked: the build fails on any other file. Taken from
# model-cache/ when it is there (the CI keeps it between runs: its publisher's site down or slow stops no build),
# else downloaded, in the same step: the archive is in no layer of the image. Another model takes both build
# arguments. The SHA-256 is trusted on first use (docker/README.md).
ARG VOSK_MODEL=vosk-model-small-fr-0.22
ARG VOSK_MODEL_SHA256=cabf6180e177eb9b3a9a9d43a437bd5e549f3a7d09525e5d69a3fed787be12ad
RUN --mount=type=bind,source=fetch-model.py,target=/tmp/fetch-model.py \
    --mount=type=bind,source=model-cache,target=/tmp/model-cache \
    python -B /tmp/fetch-model.py --install /tmp/model-cache "${VOSK_MODEL}" "${VOSK_MODEL_SHA256}"

# Its HTTP API (POST /transcribe, GET /healthcheck), on the loopback of the host only (docker-compose.sip.yml).
ENV STT_ENGINE=kaldi SERVICE_MODE=http MODEL_TYPE=vosk MODEL_PATH=/opt/model IP=127.0.0.1 PORT=8090
