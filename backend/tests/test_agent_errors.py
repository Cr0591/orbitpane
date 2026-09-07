from __future__ import annotations

from unittest import TestCase
from unittest.mock import patch

from backend.app.agents.base import AgentProvider, ProviderError, empty_output_error


class EmptyOutputErrorTests(TestCase):
    # The line the Antigravity CLI actually prints when print mode cannot ask
    # for a permission, captured from a failed run.
    DENIED = (
        'jetski: no output produced — a tool required the "command" permission '
        "that headless mode cannot prompt for, so it was auto-denied. Add an "
        "allow-rule under permissions.allow in settings.json (e.g. "
        "command(<target>)). Alternatively, re-run with "
        "--dangerously-skip-permissions to auto-approve all tools."
    )

    def test_denied_permission_is_classified_and_quoted(self) -> None:
        error = empty_output_error("Antigravity", self.DENIED, "workspace")

        self.assertEqual(error.code, "permission_required")
        # The remedy names the control the user has, and the CLI's own words
        # survive so the diagnosis is not lost behind our paraphrase.
        self.assertIn("完全访问", error.summary)
        self.assertIn("auto-denied", error.detail)
        # Readers that only ever see one string still get both halves.
        self.assertIn("完全访问", str(error))
        self.assertIn("auto-denied", str(error))

    def test_summary_stays_free_of_the_transcript(self) -> None:
        error = empty_output_error("Antigravity", self.DENIED, "workspace")

        self.assertNotIn("jetski", error.summary)
        self.assertNotIn("CLI 输出", error.summary)

    def test_remedy_differs_when_the_project_is_already_unrestricted(self) -> None:
        error = empty_output_error("Antigravity", self.DENIED, "unrestricted")

        self.assertEqual(error.code, "permission_required")
        self.assertIn("permissions.allow", str(error))
        self.assertNotIn("切换为「完全访问」", str(error))

    def test_unexplained_silence_keeps_the_generic_code(self) -> None:
        error = empty_output_error("Codex", "", "workspace")

        self.assertEqual(error.code, "provider_error")
        self.assertEqual(error.detail, "")
        self.assertIn("Codex", str(error))

    def test_unrelated_stderr_is_still_carried_into_the_message(self) -> None:
        error = empty_output_error("Codex", "upstream connection reset", "workspace")

        self.assertEqual(error.code, "provider_error")
        self.assertEqual(error.detail, "upstream connection reset")
        self.assertIn("upstream connection reset", str(error))

    def test_multi_line_noise_is_flattened_and_bounded(self) -> None:
        error = empty_output_error("Codex", "x" * 4000 + "\n\n  tail  \n", "workspace")

        self.assertEqual(len(error.detail), 1000)
        self.assertTrue(error.detail.endswith("tail"))


class StubProvider(AgentProvider):
    id = "stub"
    display_name = "Stub"

    @property
    def models(self) -> tuple[str, ...]:
        return ("gemini-3.8-flash-high", "gemini-3.7-flash-high")

    async def run(self, request, emit):  # pragma: no cover - not exercised
        raise NotImplementedError

    async def interrupt(self, conversation_id: int) -> None:  # pragma: no cover
        raise NotImplementedError


class ValidateModelTests(TestCase):
    def test_known_model_passes_through_silently(self) -> None:
        with patch("backend.app.agents.base.logger") as logger:
            self.assertEqual(
                StubProvider().validate_model("gemini-3.7-flash-high"),
                "gemini-3.7-flash-high",
            )
        logger.warning.assert_not_called()

    def test_substitution_is_logged(self) -> None:
        """Answering as a different model than requested must leave a trace."""
        with patch("backend.app.agents.base.logger") as logger:
            self.assertEqual(
                StubProvider().validate_model("gpt-5.6-luna"),
                "gemini-3.8-flash-high",
            )
        logger.warning.assert_called_once()

    def test_provider_without_models_raises(self) -> None:
        class Empty(StubProvider):
            @property
            def models(self) -> tuple[str, ...]:
                return ()

        with self.assertRaises(ProviderError):
            Empty().validate_model("anything")
