from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlsplit
import base64
import binascii

from cryptography.hazmat.primitives.asymmetric import ec
from pydantic import BaseModel, Field, field_validator


class PushEndpoint(BaseModel):
    endpoint: str = Field(min_length=1, max_length=2048)

    @field_validator("endpoint")
    @classmethod
    def validate_endpoint(cls, value: str) -> str:
        # A subscription is an outbound request destination. Only browser push
        # services are allowed, never arbitrary URLs supplied by a client.
        try:
            url = urlsplit(value)
            host = url.hostname or ""
            trusted = (
                host == "web.push.apple.com" or host.endswith(".push.apple.com")
                or host == "fcm.googleapis.com"
                or host == "updates.push.services.mozilla.com"
                or host.endswith(".notify.windows.com")
            )
            valid = (url.scheme == "https" and trusted and url.port in (None, 443)
                     and not url.username and not url.password and not url.fragment
                     and bool(url.path) and not any(c.isspace() for c in value))
        except ValueError:
            valid = False
        if not valid:
            raise ValueError("Unsupported push service endpoint")
        return value


class PushKeys(BaseModel):
    p256dh: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+=*$")
    auth: str = Field(min_length=1, max_length=30, pattern=r"^[A-Za-z0-9_-]+=*$")

    @field_validator("p256dh", "auth")
    @classmethod
    def validate_key(cls, value: str, info) -> str:
        try:
            raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
            if info.field_name == "p256dh":
                if len(raw) != 65:
                    raise ValueError()
                ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
            elif len(raw) != 16:
                raise ValueError()
        except (ValueError, binascii.Error):
            raise ValueError("Invalid push encryption key") from None
        return value


class PushSubscription(PushEndpoint):
    keys: PushKeys
    application_server_key: str = Field(min_length=1, max_length=100)


@dataclass(frozen=True, slots=True)
class Conversation:
    id: int
    name: str
    path: str
    created_at: str
    provider: str = "antigravity"
    is_pinned: bool = False
    is_archived: bool = False
    preferred_model: str = ""
    permission_mode: str = "workspace"
    draft: str = ""
    active_summary_id: int | None = None


@dataclass(frozen=True, slots=True)
class Message:
    id: int
    role: str
    content: str
    thought: str
    timestamp: str
    model: str
    provider: str = "antigravity"
    duration: float = 0.0
    run_id: str = ""
    input_chars: int = 0
    output_chars: int = 0
    context_chars: int = 0
    feedback: str = ""


class LoginRequest(BaseModel):
    pin: str = Field(min_length=1, max_length=256)


class PasskeyResponse(BaseModel):
    credential: dict


class ConversationCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    path: str = Field(min_length=1, max_length=4096)
    provider: str = Field(default="antigravity", min_length=1, max_length=40)
    preferred_model: str = Field(default="", max_length=120)
    # Sandboxed by default: unrestricted skips approvals entirely, so it has to
    # be an explicit choice rather than something a client can omit into.
    permission_mode: Literal["workspace", "unrestricted"] = "workspace"


class ConversationUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    path: str | None = Field(default=None, min_length=1, max_length=4096)
    provider: str | None = Field(default=None, min_length=1, max_length=40)
    is_pinned: bool | None = None
    is_archived: bool | None = None
    preferred_model: str | None = Field(default=None, max_length=120)
    permission_mode: Literal["workspace", "unrestricted"] | None = None
    draft: str | None = Field(default=None, max_length=200_000)


class ChatMessage(BaseModel):
    request_id: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    content: str = Field(min_length=1, max_length=200_000)
    model: str | None = Field(default=None, max_length=120)
    provider: str | None = Field(default=None, max_length=40)


class QueueUpdate(BaseModel):
    content: str | None = Field(default=None, min_length=1, max_length=200_000)
    model: str | None = Field(default=None, max_length=120)


class QueueReorder(BaseModel):
    run_ids: list[str] = Field(max_length=100)


class SummaryUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    content: str | None = Field(default=None, min_length=1, max_length=200_000)
    active: bool | None = None


class ShareCreate(BaseModel):
    """Options chosen when a conversation snapshot is published."""

    # The agent's internal reasoning quotes file paths, command output and tool
    # arguments the sender never typed and is unlikely to have re-read, so a
    # public copy only carries it when it was asked for explicitly.
    include_thoughts: bool = False
    #: None keeps the link working until it is revoked.
    expires_in_days: int | None = Field(default=None, ge=1, le=365)


class MessageFeedbackUpdate(BaseModel):
    #: Empty string clears an existing rating.
    feedback: Literal["up", "down", ""]
