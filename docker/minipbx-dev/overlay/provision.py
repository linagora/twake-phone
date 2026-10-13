"""Provisioning API for the Twake Gateway: sets the SIP secret of an extension.

MiniPBX has no machine API (its web UI is session + CSRF protected), so the dev overlay runs this tiny
second server next to it. It reuses MiniPBX's own models and config generator, so the secret ends up
where the admin UI shows it and survives restarts. Protected by a shared token; not published outside
the Docker network.
"""
import hmac
import os
import re
import threading

import uvicorn
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from app.config import get_settings
from app.database import SessionLocal
from app.models import Extension
from app.services.asterisk import apply_revision, generate_config

TOKEN = os.environ.get("TWAKE_PROVISION_TOKEN", "")
SECRET_RE = re.compile(r"^[A-Za-z0-9]{16,64}$")
lock = threading.Lock()
app = FastAPI(title="Twake provisioning", docs_url=None, redoc_url=None, openapi_url=None)


class Secret(BaseModel):
    secret: str


@app.put("/extensions/{number}/secret", status_code=204)
def set_secret(number: str, body: Secret, x_provision_token: str = Header(default="")):
    if not TOKEN or not hmac.compare_digest(x_provision_token, TOKEN):
        raise HTTPException(status_code=401)
    if not SECRET_RE.match(body.secret):
        raise HTTPException(status_code=422, detail="secret must be 16-64 alphanumeric characters")
    with lock:
        db = SessionLocal()
        try:
            extension = db.query(Extension).filter_by(number=number).first()
            if not extension:
                raise HTTPException(status_code=404)
            extension.sip_secret = body.secret
            db.commit()
            settings = get_settings()
            apply_revision(db, generate_config(db, settings), settings, reload_asterisk=True)
        finally:
            db.close()


@app.get("/health")
def health():
    return {"ok": True}


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("TWAKE_PROVISION_TOKEN not set: provisioning API disabled")
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("TWAKE_PROVISION_PORT", "18081")), log_level="warning")
