"""Seeds the dev PBX once: admin, PBX settings and three extensions (101-103)."""
import os

from app.database import SessionLocal, init_db
from app.models import Extension
from app.services.auth import create_admin, has_admin
from app.services.pbx_settings import save_pbx_settings

init_db()
db = SessionLocal()
try:
    if not has_admin(db):
        create_admin(db, "admin", os.environ.get("MINIPBX_ADMIN_PASSWORD", "admin-dev-password"))
        save_pbx_settings(
            db,
            network_mode="bridge",
            sip_port=int(os.environ.get("ASTERISK_SIP_PORT", "5080")),
            rtp_start=int(os.environ.get("ASTERISK_RTP_START", "10000")),
            rtp_end=int(os.environ.get("ASTERISK_RTP_END", "10100")),
            external_address=os.environ.get("ASTERISK_EXTERNAL_ADDRESS", ""),
            local_net=os.environ.get("ASTERISK_LOCAL_NET", "172.27.0.0/16"),
        )
        # Dev-only secrets, never used outside this throwaway PBX.
        secret = os.environ.get("DEV_SIP_SECRET", "dev-sip-secret")
        # 101-103: the demo users. 104-105: reserved for automated tests, so they never steal the
        # single SIP contact of a person testing by hand.
        for number, name in (("101", "user1"), ("102", "user2"), ("103", "user3"), ("104", "test1"), ("105", "test2")):
            db.add(
                Extension(
                    number=number,
                    display_name=name,
                    sip_username=number,
                    sip_secret=secret,
                    voicemail_enabled=False,
                )
            )
        db.commit()
        print("Twake dev seed: admin + extensions 101-105 created.")
finally:
    db.close()
