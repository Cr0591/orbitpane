"""Generate persistent Web Push credentials: python3 -m backend.setup_push."""
import argparse
import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from backend.app.config import PROJECT_ROOT, Settings
from backend.app.database import Database
from backend.app.notifications import PushNotifications


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--subject", help="Public HTTPS site URL or mailto: contact")
    args = parser.parse_args()
    settings = Settings.from_env()
    if settings.push_vapid_private_key:
        PushNotifications(settings, Database(settings.database_path))
        print("Web Push is already configured; existing key preserved.")
        return
    subject = args.subject or settings.webauthn_origin
    if not subject:
        parser.error("Set --subject to your public HTTPS URL or mailto: contact")
    key = ec.generate_private_key(ec.SECP256R1())
    encoded = base64.urlsafe_b64encode(key.private_bytes(
        serialization.Encoding.DER, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )).decode().rstrip("=")
    from dataclasses import replace
    PushNotifications(replace(settings, push_vapid_private_key=encoded, push_vapid_subject=subject),
                      Database(settings.database_path))
    path = settings.resolve_allowed_path(str(PROJECT_ROOT / ".env"), must_exist=False)
    existing = path.read_text() if path.exists() else ""
    # Replace empty template entries too: dotenv intentionally keeps the first
    # value, so appending alone would leave a copied .env.example disabled.
    names = {"ORBITPANE_PUSH_VAPID_PRIVATE_KEY", "ORBITPANE_PUSH_VAPID_SUBJECT"}
    lines = [line for line in existing.splitlines()
             if line.removeprefix("export ").split("=", 1)[0].strip() not in names]
    lines += [f"ORBITPANE_PUSH_VAPID_PRIVATE_KEY={encoded}", f"ORBITPANE_PUSH_VAPID_SUBJECT={subject}"]
    path.touch(mode=0o600, exist_ok=True)
    path.chmod(0o600)
    path.write_text("\n".join(lines) + "\n")
    print("Web Push credentials saved to .env; private key was not printed.")


if __name__ == "__main__":
    main()
