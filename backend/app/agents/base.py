from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from ..models import Message

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class AgentRequest:
    run_id: str
    conversation_id: int
    working_directory: str
    prompt: str
    history: tuple[Message, ...]
    model: str
    permission_mode: str = "workspace"


@dataclass(frozen=True, slots=True)
class AgentEvent:
    type: str
    content: str = ""


@dataclass(frozen=True, slots=True)
class AgentResult:
    content: str
    thought: str = ""
    interrupted: bool = False


EmitEvent = Callable[[AgentEvent], Awaitable[None]]

_EFFORT_SUFFIXES = {
    "high": "High",
    "medium": "Medium",
    "low": "Low",
    "minimal": "Minimal",
    "thinking": "Thinking",
    "default": "Default",
}
_WORD_OVERRIDES = {
    "gpt": "GPT",
    "oss": "OSS",
    "gemini": "Gemini",
    "claude": "Claude",
    "codex": "Codex",
}


def humanize_model_id(model: str) -> str:
    """Best-effort label for a model id a provider gave us no name for.

    Providers that publish their own display names should use those; this is the
    fallback so a newly released model still reads sensibly in the UI instead of
    requiring a client release.
    """
    parts = [part for part in model.split("-") if part]
    if not parts:
        return model
    suffix = _EFFORT_SUFFIXES.get(parts[-1]) if len(parts) > 1 else None
    if suffix:
        parts.pop()

    words: list[str] = []
    version_run: list[str] = []
    for part in parts:
        if part.isdigit():
            # Consecutive numeric segments are a version: 4-6 -> "4.6".
            version_run.append(part)
            continue
        if version_run:
            words.append(".".join(version_run))
            version_run = []
        if part in _WORD_OVERRIDES:
            words.append(_WORD_OVERRIDES[part])
        elif any(character.isdigit() for character in part):
            # Parameter counts and sizes read better upper-cased: 120b -> 120B.
            words.append(part.upper())
        else:
            words.append(part.capitalize())
    if version_run:
        words.append(".".join(version_run))

    name = " ".join(words)
    # "GPT OSS" is a single product name, not two words.
    name = name.replace("GPT OSS", "GPT-OSS")
    return f"{name} ({suffix})" if suffix else name


class ProviderError(RuntimeError):
    """A failure worth explaining to the person who sent the prompt.

    `code` classifies the failure without naming the adapter that raised it, so
    the transport and the client can react to a *kind* of problem — a denied
    permission, say — without growing provider conditionals. `detail` holds raw
    CLI output, kept apart from the sentence addressed to the user so a client
    can fold it away; `str(exc)` still carries both, since the task list and the
    logs only ever see the one string.
    """

    def __init__(
        self, message: str, *, code: str = "provider_error", detail: str = ""
    ) -> None:
        super().__init__(f"{message}（CLI 输出：{detail}）" if detail else message)
        self.code = code
        #: The part written for the user, without the transcript.
        self.summary = message
        #: Verbatim provider output, or empty when there was none.
        self.detail = detail


def empty_output_error(
    provider_label: str, detail: str, permission_mode: str
) -> ProviderError:
    """Explain a run that ended successfully without printing an answer.

    Both CLIs exit 0 in this case and put the reason on stderr, and by far the
    most common reason is a tool needing a permission that print mode cannot
    prompt for — a project setting, not a fault. That line is the only thing
    separating it from a genuine failure, so it is carried into the message
    rather than replaced with a guess about what went wrong.
    """
    # The tail carries the CLI's closing diagnosis; anything earlier is
    # progress noise, and the whole thing has to fit in a chat bubble.
    detail = " ".join(detail.split())[-1000:].strip()
    if "permission" not in detail.lower():
        return ProviderError(
            f"{provider_label} 执行结束但没有输出任何内容。", detail=detail
        )
    remedy = (
        "该项目已是「完全访问」，请检查 CLI 自身的 permissions.allow 配置。"
        if permission_mode == "unrestricted"
        else "请在项目设置的「文件系统权限」中切换为「完全访问」后重试。"
    )
    return ProviderError(
        f"{provider_label} 请求的工具权限在非交互模式下无法确认，已被自动拒绝，"
        f"因此本次没有生成回答。{remedy}",
        code="permission_required",
        detail=detail,
    )


class AgentProvider(ABC):
    id: str
    display_name: str
    #: Badge colour family the client uses for this provider.
    tone: str = "default"

    @property
    @abstractmethod
    def models(self) -> tuple[str, ...]:
        raise NotImplementedError

    def model_display_name(self, model: str) -> str:
        """Label shown for a model id.

        Providers whose CLI publishes names should override this; otherwise the
        generic humanizer keeps new models readable without a client change.
        """
        return humanize_model_id(model)

    def model_catalog(self) -> list[dict[str, str]]:
        return [
            {"id": model, "display_name": self.model_display_name(model)}
            for model in self.models
        ]

    @property
    def available(self) -> bool:
        return True

    @abstractmethod
    async def run(self, request: AgentRequest, emit: EmitEvent) -> AgentResult:
        raise NotImplementedError

    @abstractmethod
    async def interrupt(self, conversation_id: int) -> None:
        raise NotImplementedError

    def validate_model(self, model: str) -> str:
        if not self.models:
            raise ProviderError(f"Provider {self.id} has no configured models")
        if model not in self.models:
            # Substituting keeps a queued run alive when a model is retired or
            # when a client sends another provider's id, but it answers as a
            # different model than the one that was asked for. Leave a trace so
            # the swap is diagnosable rather than mysterious.
            logger.warning(
                "Model %r is not offered by provider %s; falling back to %s",
                model,
                self.id,
                self.models[0],
            )
            return self.models[0]
        return model

    def describe(self) -> dict[str, object]:
        return {
            "id": self.id,
            "name": self.display_name,
            "tone": self.tone,
            "available": self.available,
            "models": self.model_catalog(),
        }
