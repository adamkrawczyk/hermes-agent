"""Generic loader for user-supplied classic-CLI widgets (``$HERMES_HOME/cli-widgets/*.py``).

Each file exposes ``create(api) -> prompt_toolkit Container``; the containers are mounted by the
default ``CLITuiMixin._get_extra_tui_widgets`` above the composer. ``api`` is read-only:

* ``api.snapshot()``  -> dict of the CLI's own state (see ``CliWidgetAPI.snapshot``).
* ``api.request_repaint(min_interval)`` -> throttled ``cli._invalidate``; a NO-OP while the agent
  is idle unless ``display.cli_widgets.idle_repaint`` is true (core forbids idle timer repaints:
  they fight tmux/Ghostty/cmux viewport restoration).

Isolation: any exception in load/create/render disables that widget with ONE log line.
Off switch: ``display.cli_widgets.enabled`` (default true when the directory exists).
"""

from __future__ import annotations

import importlib.util
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DIRNAME = "cli-widgets"


def _settings(cli: Any) -> dict:
    try:
        from cli import CLI_CONFIG
        raw = (CLI_CONFIG.get("display") or {}).get("cli_widgets")
    except Exception:
        return {}
    if isinstance(raw, bool):
        return {"enabled": raw}
    return raw if isinstance(raw, dict) else {}


def widgets_dir() -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home()) / _DIRNAME


class CliWidgetAPI:
    """Read-only view of the classic CLI handed to each widget."""

    def __init__(self, cli: Any, idle_repaint: bool = False):
        self._cli = cli
        self._idle_repaint = bool(idle_repaint)

    def snapshot(self) -> dict:
        c = self._cli
        busy = bool(getattr(c, "_agent_running", False))
        tool_name = None
        labels = c.__dict__.get("_running_tool_labels") or {}
        if busy and labels:
            tool_name = next(reversed(labels))
        phase = None
        if busy:
            phase = "tool" if (tool_name or getattr(c, "_tool_start_time", 0)) else "thinking"
        pending = None
        for attr, name in (("_approval_state", "approval"), ("_clarify_state", "clarify"),
                           ("_sudo_state", "sudo"), ("_secret_state", "secret")):
            if getattr(c, attr, None):
                pending = name
                break
        try:
            size = os.get_terminal_size()
            cols, rows = size.columns, size.lines
        except OSError:
            cols, rows = 80, 24
        app = getattr(c, "_app", None)
        try:
            out_size = app.output.get_size() if app is not None else None
            if out_size is not None:
                cols, rows = out_size.columns, out_size.rows
        except Exception:
            pass
        return {
            "session_id": getattr(c, "session_id", None),
            "busy": busy,
            "phase": phase,
            "tool_name": tool_name,
            "pending": pending,
            "last_error_kind": getattr(c, "_last_error_kind", None),
            "cols": cols,
            "rows": rows,
            "in_tmux": bool(os.environ.get("TMUX")),
        }

    def request_repaint(self, min_interval: float = 0.25) -> None:
        if not self._idle_repaint and not getattr(self._cli, "_agent_running", False):
            return
        try:
            self._cli._invalidate(min_interval=min_interval)
        except Exception:
            pass


def _make_safe_container_class():
    from prompt_toolkit.layout.containers import Container, Window

    class _SafeContainer(Container):
        """Delegates to ``inner``; a failure in any layout/render call blanks the widget forever."""

        def __init__(self, inner, name, state, disable):
            self.inner, self.name, self.state, self._disable = inner, name, state, disable
            self._blank = Window(height=0)

        def _call(self, meth, *a, default=None, **kw):
            if self.state["dead"]:
                return default
            try:
                return getattr(self.inner, meth)(*a, **kw)
            except Exception as exc:
                self._disable(exc)
                return default

        def reset(self):
            self._call("reset")

        def preferred_width(self, max_available_width):
            return self._call("preferred_width", max_available_width,
                              default=self._blank.preferred_width(max_available_width))

        def preferred_height(self, width, max_available_height):
            return self._call("preferred_height", width, max_available_height,
                              default=self._blank.preferred_height(width, max_available_height))

        def write_to_screen(self, screen, mouse_handlers, write_position, parent_style,
                            erase_bg, z_index):
            if self.state["dead"]:
                return
            # A failure mid-render disables the widget; it is blanked from the next frame on.
            try:
                self.inner.write_to_screen(screen, mouse_handlers, write_position, parent_style,
                                           erase_bg, z_index)
            except Exception as exc:
                self._disable(exc)

        def is_modal(self):
            return bool(self._call("is_modal", default=False))

        def get_key_bindings(self):
            return self._call("get_key_bindings", default=None)

        def get_children(self):
            return [] if self.state["dead"] else self._call("get_children", default=[])

    return _SafeContainer


_SafeContainer = None  # built lazily so importing this module never imports prompt_toolkit


def load_cli_widgets(cli: Any) -> list:
    """Load ``$HERMES_HOME/cli-widgets/*.py`` (sorted). Never raises."""
    global _SafeContainer
    try:
        d = widgets_dir()
        if not d.is_dir():  # zero-cost path: one stat, nothing else imported
            return []
        cfg = _settings(cli)
        if cfg.get("enabled", True) is False:
            return []
        files = sorted(p for p in d.glob("*.py") if not p.name.startswith("_"))
        if not files:
            return []
        if _SafeContainer is None:
            _SafeContainer = _make_safe_container_class()
        api = CliWidgetAPI(cli, idle_repaint=bool(cfg.get("idle_repaint", False)))
    except Exception as exc:
        logger.warning("cli-widgets disabled: %s", exc)
        return []
    out = []
    for path in files:
        try:
            spec = importlib.util.spec_from_file_location(f"hermes_cli_widget_{path.stem}", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            container = mod.create(api)
            if container is None:
                raise ValueError("create() returned None")
            from prompt_toolkit.layout.containers import ConditionalContainer
            from prompt_toolkit.filters import Condition
            state = {"dead": False}
            inner = _SafeContainer(container, path.name, state, _make_disabler(path.name, state))
            out.append(ConditionalContainer(inner, Condition(lambda s=state: not s["dead"])))
        except Exception as exc:
            logger.warning("cli-widget %s disabled: %s", path.name, exc)
    return out


def _make_disabler(name: str, state: dict):
    def _disable(exc: BaseException) -> None:
        if not state["dead"]:
            state["dead"] = True
            logger.warning("cli-widget %s disabled: render failed: %s", name, exc)
    return _disable
