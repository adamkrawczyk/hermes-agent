"""Per-task delegation model pool.

Covers the new `delegation.model_pool` config key and the `model` param on
delegate_task (top-level and per-task):

- pool unset   -> any model string accepted (backward compatible)
- pool set     -> out-of-pool choice refused BEFORE any child is built
- per-task model beats the pin; unset task keeps the pin
- empty-string model is refused, not silently swallowed
- schema exposes the `model` param and the pool in its description

These are unit-level: they patch `_build_child_preserving_parent_tools` and
`_load_config` in the module under test, so no real subagent, no network.
"""
from __future__ import annotations

import contextlib
import json
import unittest
from unittest.mock import MagicMock, patch

import tools.delegate_tool as dt
from tools.delegate_tool import (
    DELEGATE_TASK_SCHEMA,
    _build_dynamic_schema_overrides,
    _check_delegation_model_choice,
    _delegation_model_pool,
    delegate_task,
)


def _parent(depth=0):
    parent = MagicMock()
    parent.base_url = "https://openrouter.ai/api/v1"
    parent.api_key = "test-key"
    parent.provider = "openrouter"
    parent.api_mode = "chat_completions"
    parent.model = "anthropic/claude-sonnet-4"
    parent._delegate_depth = depth
    parent._active_children = []
    parent._active_children_lock = __import__("threading").Lock()
    parent._print_fn = None
    parent.tool_progress_callback = None
    parent.thinking_callback = None
    return parent


PIN = "claude-sonnet-5"


class TestModelPoolHelpers(unittest.TestCase):
    def test_pool_absent_means_open(self):
        with patch.object(dt, "_load_config", return_value={"model": PIN}):
            self.assertEqual(_delegation_model_pool(), [])

    def test_pool_reads_config(self):
        with patch.object(dt, "_load_config", return_value={
            "model_pool": ["a", " b ", ""]}):
            self.assertEqual(_delegation_model_pool(), ["a", "b"])

    def test_non_list_pool_is_treated_as_absent(self):
        with patch.object(dt, "_load_config", return_value={"model_pool": "oops"}):
            self.assertEqual(_delegation_model_pool(), [])

    def test_check_passes_when_no_pool(self):
        with patch.object(dt, "_load_config", return_value={}):
            _check_delegation_model_choice("anything", "Task 0")  # no raise

    def test_check_refuses_out_of_pool(self):
        with patch.object(dt, "_load_config", return_value={
            "model_pool": ["claude-haiku-4-5", "claude-sonnet-5"]}):
            with self.assertRaises(ValueError) as ctx:
                _check_delegation_model_choice("claude-opus-5", "Task 0")
            msg = str(ctx.exception)
            self.assertIn("claude-opus-5", msg)
            self.assertIn("claude-haiku-4-5", msg)  # allowed list surfaced
            self.assertIn("model_pool", msg)

    def test_check_allows_pool_member(self):
        with patch.object(dt, "_load_config", return_value={
            "model_pool": ["claude-haiku-4-5"]}):
            _check_delegation_model_choice("claude-haiku-4-5", "Task 0")

    def test_check_ignores_none(self):
        with patch.object(dt, "_load_config", return_value={
            "model_pool": ["claude-haiku-4-5"]}):
            _check_delegation_model_choice(None, "Task 0")  # pin path


class _NoAgentRun:
    """Patch the child runner so no conversation ever executes."""
    def __init__(self):
        self.run = MagicMock()

    def __enter__(self):
        # _run_single_child returns a structured result dict; the batch
        # aggregation loop reads entry["task_index"], so the mock must echo
        # the positional task_index exactly as the real function does.
        def fake_run(task_index, goal, *a, **k):
            return {
                "task_index": task_index,
                "status": "completed",
                "summary": "ok",
                "final_response": "ok",
                "completed": True,
                "api_calls": 1,
                "duration_seconds": 0.0,
            }
        self._p1 = patch.object(dt, "_run_single_child", side_effect=fake_run)
        self._p2 = patch("run_agent.AIAgent")
        self._p1.start(); self._p2.start()
        return self

    def __exit__(self, *exc):
        self._p1.stop(); self._p2.stop()
        return False


class TestModelPoolDispatch(unittest.TestCase):
    def _cfg(self, pool=None, pin=PIN):
        cfg = {"model": pin, "provider": "openrouter",
               "base_url": "https://openrouter.ai/api/v1",
               "api_key": "***", "api_mode": "chat_completions"}
        if pool is not None:
            cfg["model_pool"] = pool
        return cfg

    def _creds(self, pin=PIN):
        return {"model": pin, "provider": "openrouter",
                "base_url": "https://openrouter.ai/api/v1",
                "api_key": "***", "api_mode": "chat_completions",
                "request_overrides": None, "max_output_tokens": None,
                "command": None, "args": []}

    def _run_single(self, cfg, parent, **kwargs):
        """Drive delegate_task() to child construction; capture model kwargs.

        Returns (model_list, result_text).
        """
        captured = []

        def fake_build(*args, **kw):
            captured.append(kw.get("model"))
            child = MagicMock()
            child.model = kw.get("model")
            return child

        with _NoAgentRun(), \
                patch.object(dt, "_load_config", return_value=cfg), \
                patch.object(dt, "_resolve_delegation_credentials",
                             return_value=self._creds()), \
                patch.object(dt, "_build_child_preserving_parent_tools",
                             side_effect=fake_build) as b:
            result = delegate_task(parent_agent=parent, **kwargs)
        return captured, result

    def test_unset_model_uses_pin(self):
        parent = _parent()
        models, result = self._run_single(
            self._cfg(), parent, goal="do the thing", background=False)
        self.assertEqual(models, [PIN])

    def test_top_level_model_overrides_pin(self):
        parent = _parent()
        models, result = self._run_single(
            self._cfg(pool=["claude-haiku-4-5", PIN]),
            parent, goal="do the thing", model="claude-haiku-4-5",
            background=False)
        self.assertEqual(models, ["claude-haiku-4-5"])

    def test_out_of_pool_refused_before_any_child(self):
        parent = _parent()
        models, result = self._run_single(
            self._cfg(pool=["claude-haiku-4-5", PIN]),
            parent, goal="do the thing", model="claude-opus-5",
            background=False)
        self.assertEqual(models, [])  # nothing built
        self.assertIn("model_pool", result)
        self.assertIn("claude-opus-5", result)

    def test_empty_model_string_refused(self):
        parent = _parent()
        models, result = self._run_single(
            self._cfg(pool=["claude-haiku-4-5"]),
            parent, goal="do the thing", model="   ", background=False)
        self.assertEqual(models, [])
        self.assertIn("empty 'model'", result)

    def test_per_task_model_overrides_and_pin_fallback(self):
        parent = _parent()
        models, result = self._run_single(
            self._cfg(pool=["claude-haiku-4-5", PIN]),
            parent,
            tasks=[
                {"goal": "refactor the auth module", "model": "claude-haiku-4-5"},
                {"goal": "write integration tests"},  # -> pin
            ],
            background=False)
        self.assertEqual(models, ["claude-haiku-4-5", PIN])

    def test_no_pool_any_model_accepted(self):
        parent = _parent()
        # A qualified (provider/model) name is accepted even with no pool.
        # It resolves to an UNqualified model + its named provider, so the
        # build receives "glm-5.2" (the provider travels via the override).
        models, result = self._run_single(
            self._cfg(),  # no pool
            parent, goal="do the thing", model="zai/glm-5.2",
            background=False)
        self.assertEqual(models, ["glm-5.2"])

    def test_batch_out_of_pool_refused_whole_call(self):
        parent = _parent()
        models, result = self._run_single(
            self._cfg(pool=["claude-haiku-4-5"]),
            parent,
            tasks=[{"goal": "task A"}, {"goal": "task B", "model": "nope"}],
            background=False)
        self.assertEqual(models, [])
        self.assertIn("Task 1", result)
        self.assertIn("model_pool", result)


class TestModelPoolSchema(unittest.TestCase):
    def test_top_level_model_param_present(self):
        self.assertIn("model", DELEGATE_TASK_SCHEMA["parameters"]["properties"])
        self.assertEqual(
            DELEGATE_TASK_SCHEMA["parameters"]["properties"]["model"]["type"],
            "string")

    def test_per_task_model_param_present(self):
        items = DELEGATE_TASK_SCHEMA["parameters"]["properties"]["tasks"]["items"]
        self.assertIn("model", items["properties"])

    def test_dynamic_override_surfaces_pool(self):
        with patch.object(dt, "_load_config", return_value={
            "model": PIN, "model_pool": ["claude-haiku-4-5", "zai/glm-5.2"]}):
            overrides = _build_dynamic_schema_overrides()
        desc = overrides["parameters"]["properties"]["model"]["description"]
        self.assertIn("claude-haiku-4-5", desc)
        self.assertIn("zai/glm-5.2", desc)
        self.assertIn(PIN, desc)  # pin named as the fallback
        t_desc = (overrides["parameters"]["properties"]["tasks"]["items"]
                  ["properties"]["model"]["description"])
        self.assertIn("claude-haiku-4-5", t_desc)

    def test_dynamic_override_open_when_no_pool(self):
        with patch.object(dt, "_load_config", return_value={"model": PIN}):
            overrides = _build_dynamic_schema_overrides()
        desc = overrides["parameters"]["properties"]["model"]["description"]
        self.assertIn("no pool", desc)


class TestModelPoolQualifiedProvider(unittest.TestCase):
    """A provider-qualified pool entry (zai/glm-5.2) re-resolves credentials
    for that provider instead of inheriting the pin's (Anthropic) transport."""

    PIN = "claude-sonnet-5"

    def _parent(self):
        parent = MagicMock()
        parent._delegate_depth = 0
        parent._active_children = []
        parent._active_children_lock = __import__("threading").Lock()
        parent._print_fn = None
        return parent

    def test_qualified_entry_routes_to_named_provider(self):
        def fake_runtime(requested=None, target_model=None, **kw):
            self.assertEqual(requested, "zai")
            self.assertEqual(target_model, "glm-5.2")
            return {
                "provider": "zai", "model": "glm-5.2",
                "base_url": "https://api.z.ai/v1",
                "api_key": "zai-key", "api_mode": "chat_completions",
                "request_overrides": {}, "max_output_tokens": None,
                "command": None, "args": [],
            }

        creds = {"model": self.PIN, "provider": "anthropic",
                 "base_url": "https://api.anthropic.com", "api_key": "k",
                 "api_mode": "anthropic_messages",
                 "request_overrides": None, "max_output_tokens": None,
                 "command": None, "args": []}

        with patch("hermes_cli.runtime_provider.resolve_runtime_provider",
                side_effect=fake_runtime):
            out = dt._resolve_pool_entry("zai/glm-5.2", creds)
        self.assertEqual(out["model"], "glm-5.2")
        self.assertEqual(out["provider"], "zai")
        self.assertEqual(out["api_mode"], "chat_completions")  # not anthropic_messages

    def test_bare_entry_inherits_pin_transport(self):
        creds = {"model": self.PIN, "provider": "anthropic",
                 "base_url": "u", "api_key": "k",
                 "api_mode": "anthropic_messages", "args": []}
        out = dt._resolve_pool_entry("claude-haiku-4-5", creds)
        self.assertEqual(out["model"], "claude-haiku-4-5")
        self.assertEqual(out["provider"], "anthropic")  # pin's provider kept
        self.assertEqual(out["api_mode"], "anthropic_messages")

    def test_split_qualified(self):
        self.assertEqual(dt._split_qualified_model("zai/glm-5.2"),
                         ("zai", "glm-5.2"))
        self.assertEqual(dt._split_qualified_model("claude-opus-5"),
                         (None, "claude-opus-5"))
        self.assertEqual(dt._split_qualified_model(""), (None, ""))
        # Leading/trailing slash -> not qualified (one side empty).
        self.assertEqual(dt._split_qualified_model("/glm"), (None, "/glm"))
        self.assertEqual(dt._split_qualified_model("zai/"), (None, "zai/"))

    def test_split_keeps_slashes_inside_model_id(self):
        """REGRESSION: model ids contain slashes.

        `custom:hetzner/Qwen/Qwen3.6-35B-A3B-FP8` is provider
        `custom:hetzner` + model `Qwen/Qwen3.6-35B-A3B-FP8`. The first
        implementation required exactly one slash, so this entry parsed as
        UNqualified and silently inherited the pin's Anthropic transport: it
        passed the pool check, then would have died at the first API call
        against the wrong endpoint. Split on the FIRST slash only.
        """
        self.assertEqual(
            dt._split_qualified_model("custom:hetzner/Qwen/Qwen3.6-35B-A3B-FP8"),
            ("custom:hetzner", "Qwen/Qwen3.6-35B-A3B-FP8"))
        self.assertEqual(
            dt._split_qualified_model("custom:qwen38-local/qwen3.8-27b-heretic"),
            ("custom:qwen38-local", "qwen3.8-27b-heretic"))

    def test_multislash_entry_does_not_fall_back_to_pin(self):
        """The end-to-end shape of the same bug: a multi-slash entry must not
        come back on the pin's provider."""
        def fake_runtime(requested=None, target_model=None, **kw):
            return {"provider": "custom", "model": target_model,
                    "base_url": "https://inference.hetzner.com/api/v1",
                    "api_key": "hz", "api_mode": "chat_completions",
                    "request_overrides": {}, "max_output_tokens": None,
                    "command": None, "args": []}

        pin = {"model": "claude-sonnet-5", "provider": "anthropic",
               "base_url": "https://api.anthropic.com", "api_key": "k",
               "api_mode": "anthropic_messages", "request_overrides": None,
               "max_output_tokens": None, "command": None, "args": []}

        with patch("hermes_cli.runtime_provider.resolve_runtime_provider",
                   side_effect=fake_runtime):
            out = dt._resolve_pool_entry(
                "custom:hetzner/Qwen/Qwen3.6-35B-A3B-FP8", pin)
        self.assertEqual(out["model"], "Qwen/Qwen3.6-35B-A3B-FP8")
        self.assertNotEqual(out["provider"], "anthropic")
        self.assertNotEqual(out["base_url"], "https://api.anthropic.com")


if __name__ == "__main__":
    unittest.main()


class TestTopLevelModelAppliesToTasksBatch(unittest.TestCase):
    """Regression coverage for the bug where the top-level `model` kwarg was
    silently ignored whenever the caller also passed `tasks=[...]`.

    Precedence contract (from the schema description at
    _build_dynamic_schema_overrides): per-task model > top-level model >
    configured pin (delegation.model) > parent inheritance.
    """

    def _cfg(self, pool=None, pin=PIN):
        cfg = {"model": pin, "provider": "openrouter",
               "base_url": "https://openrouter.ai/api/v1",
               "api_key": "***", "api_mode": "chat_completions"}
        if pool is not None:
            cfg["model_pool"] = pool
        return cfg

    def _creds(self, pin=PIN):
        return {"model": pin, "provider": "openrouter",
                "base_url": "https://openrouter.ai/api/v1",
                "api_key": "***", "api_mode": "chat_completions",
                "request_overrides": None, "max_output_tokens": None,
                "command": None, "args": []}

    def _run(self, cfg, parent, **kwargs):
        captured = []

        def fake_build(*args, **kw):
            captured.append(kw.get("model"))
            child = MagicMock()
            child.model = kw.get("model")
            return child

        with _NoAgentRun(), \
                patch.object(dt, "_load_config", return_value=cfg), \
                patch.object(dt, "_resolve_delegation_credentials",
                             return_value=self._creds()), \
                patch.object(dt, "_build_child_preserving_parent_tools",
                             side_effect=fake_build):
            result = delegate_task(parent_agent=parent, **kwargs)
        return captured, result

    def test_top_level_model_applies_to_every_task_in_batch(self):
        """The core bug: top-level `model` + `tasks=[...]` must NOT run on
        the pin. Before the fix, `task_list = tasks` never consulted
        `model`, so both children silently ran on PIN instead of the
        requested pool member."""
        parent = _parent()
        models, result = self._run(
            self._cfg(pool=["claude-haiku-4-5", PIN]),
            parent,
            model="claude-haiku-4-5",
            tasks=[
                {"goal": "review the auth module thoroughly"},
                {"goal": "review the payments module thoroughly"},
            ],
            background=False,
        )
        self.assertEqual(models, ["claude-haiku-4-5", "claude-haiku-4-5"])

    def test_per_task_model_overrides_top_level_in_batch(self):
        parent = _parent()
        models, result = self._run(
            self._cfg(pool=["claude-haiku-4-5", "claude-opus-5", PIN]),
            parent,
            model="claude-haiku-4-5",
            tasks=[
                {"goal": "refactor the auth module code", "model": "claude-opus-5"},  # per-task wins
                {"goal": "write integration test suite"},  # falls back to top-level model
            ],
            background=False,
        )
        self.assertEqual(models, ["claude-opus-5", "claude-haiku-4-5"])

    def test_top_level_model_outside_pool_rejected_before_any_child_in_batch(self):
        parent = _parent()
        models, result = self._run(
            self._cfg(pool=["claude-haiku-4-5", PIN]),
            parent,
            model="claude-opus-5",  # not in pool
            tasks=[
                {"goal": "refactor the auth module code"},
                {"goal": "write integration test suite"},
            ],
            background=False,
        )
        self.assertEqual(models, [])  # nothing built
        self.assertIn("model_pool", result)
        self.assertIn("claude-opus-5", result)

    def test_top_level_qualified_model_in_batch_resolves_full_bundle(self):
        """A provider-qualified top-level model (zai/glm-5.3-flash) must
        re-resolve the FULL credential bundle for that provider via
        _resolve_pool_entry — not just swap the model name onto the pin's
        (e.g. Anthropic) bundle. Verifies this holds when the model comes
        from the TOP LEVEL, not just per-task."""
        parent = _parent()

        def fake_runtime(requested=None, target_model=None, **kw):
            self.assertEqual(requested, "zai")
            self.assertEqual(target_model, "glm-5.3-flash")
            return {
                "provider": "zai", "model": "glm-5.3-flash",
                "base_url": "https://api.z.ai/v1",
                "api_key": "zai-key", "api_mode": "chat_completions",
                "request_overrides": {}, "max_output_tokens": None,
                "command": None, "args": [],
            }

        captured_providers = []
        captured_base_urls = []

        def fake_build(*args, **kw):
            captured_providers.append(kw.get("override_provider"))
            captured_base_urls.append(kw.get("override_base_url"))
            child = MagicMock()
            child.model = kw.get("model")
            return child

        with _NoAgentRun(), \
                patch.object(dt, "_load_config",
                             return_value=self._cfg(
                                 pool=["claude-haiku-4-5", "zai/glm-5.3-flash", PIN])), \
                patch.object(dt, "_resolve_delegation_credentials",
                             return_value=self._creds()), \
                patch("hermes_cli.runtime_provider.resolve_runtime_provider",
                      side_effect=fake_runtime), \
                patch.object(dt, "_build_child_preserving_parent_tools",
                             side_effect=fake_build):
            result = delegate_task(
                parent_agent=parent,
                model="zai/glm-5.3-flash",
                tasks=[
                    {"goal": "refactor the auth module code"},
                    {"goal": "write integration test suite"},
                ],
                background=False,
            )
        # Both children must have gone through the zai transport, not the
        # openrouter/anthropic pin bundle.
        self.assertEqual(captured_providers, ["zai", "zai"])
        self.assertEqual(captured_base_urls,
                          ["https://api.z.ai/v1", "https://api.z.ai/v1"])

    def test_unset_model_in_batch_unchanged_uses_pin(self):
        """No regression: when `model` is unset, batch tasks still fall
        through to the pin exactly as before."""
        parent = _parent()
        models, result = self._run(
            self._cfg(pool=["claude-haiku-4-5", PIN]),
            parent,
            tasks=[
                {"goal": "refactor the auth module code"},
                {"goal": "write integration test suite"},
            ],
            background=False,
        )
        self.assertEqual(models, [PIN, PIN])

