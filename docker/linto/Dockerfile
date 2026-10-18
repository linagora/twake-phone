# LinTO STT for the development and CI stack (step 11b, ADR 0023): the official image of its Kaldi engine, pinned by
# digest, with the smallest French model built in (Vosk's small French model 0.22, Apache 2.0, about 41 MB zipped):
# what transcribes a message of a few seconds in a second or two on a CI runner, without a GPU. A deployment chooses
# its own model (a larger one, LinTO's own), mounted at MODEL_PATH.
FROM lintoai/linto-stt-kaldi:2.1.1@sha256:fc9dce8b9fce5beca6f5eefadf0f8f6599dc99c8c154ba505164800f64891d2b

# The model, checked against its print before it is unpacked.
ARG VOSK_MODEL=vosk-model-small-fr-0.22
ADD https://alphacephei.com/vosk/models/${VOSK_MODEL}.zip /tmp/model.zip
RUN python -c "import hashlib; print('${VOSK_MODEL}.zip sha256', hashlib.sha256(open('/tmp/model.zip', 'rb').read()).hexdigest())" \
 && python -c "import zipfile; zipfile.ZipFile('/tmp/model.zip').extractall('/opt')" \
 && mv /opt/${VOSK_MODEL} /opt/model \
 && rm /tmp/model.zip

# Its HTTP API (POST /transcribe, GET /healthcheck), on the loopback of the host only (docker-compose.sip.yml).
ENV STT_ENGINE=kaldi SERVICE_MODE=http MODEL_TYPE=vosk MODEL_PATH=/opt/model IP=127.0.0.1 PORT=8090
