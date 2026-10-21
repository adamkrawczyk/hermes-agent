"""Tests for the generic classic-CLI widget loader (``$HERMES_HOME/cli-widgets/*.py``)."""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

from hermes_cli import cli_widgets
from hermes_cli.cli_tui_mixin import CLITuiMixin


GOOD = '''
from prompt_toolkit.layout.containers import Window
from prompt_toolkit.layout.controls import FormattedTextControl
SEEN = []
def create(api):
    SEEN.append(api)
    return Window(content=FormattedTextControl("hello-{n}"), height=1)
'''


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("TMUX", raising=False)
    return tmp_path


@pytest.fixture
def cfg(monkeypatch):
    import cli as cli_mod
    display = {}
    monkeypatch.setitem(cli_mod.CLI_CONFIG, "display", display)
    return display


def _put(home, name, body):
    d = home / "cli-widgets"
    d.mkdir(exist_ok=True)
    (d / name).write_text(body)


def _fake_cli(**kw):
    state = dict(session_id="s1", _agent_running=False, _tool_start_time=0.0, _app=None,
                 _approval_state=None, _clarify_state=None, _sudo_state=None, _secret_state=None,
                 _last_error_kind=None, invalidations=[])
    state.update(kw)
    cli = SimpleNamespace(**state)
    cli._invalidate = lambda min_interval=0.25: cli.invalidations.append(min_interval)
    return cli


def _render(container):
    from prompt_toolkit.layout.screen import Screen, WritePosition
    from prompt_toolkit.layout.mouse_handlers import MouseHandlers
    screen = Screen()
    container.write_to_screen(screen, MouseHandlers(), WritePosition(0, 0, 40, 1), "", True, None)
    return screen


def test_no_dir_returns_empty(home, cfg):
    assert cli_widgets.load_cli_widgets(_fake_cli()) == []


def test_loads_sorted_and_skips_underscore(home, cfg):
    _put(home, "b.py", GOOD.replace("{n}", "b"))
    _put(home, "a.py", GOOD.replace("{n}", "a"))
    _put(home, "_skip.py", "raise RuntimeError('must not load')")
    out = cli_widgets.load_cli_widgets(_fake_cli())
    assert len(out) == 2
    texts = []
    for w in out:
        screen = _render(w)
        texts.append("".join(screen.data_buffer[0][i].char for i in range(7)))
    assert texts == ["hello-a", "hello-b"]


def test_default_hook_returns_widgets_and_is_cached(home, cfg):
    _put(home, "a.py", GOOD.replace("{n}", "a"))
    cli = CLITuiMixin.__new__(CLITuiMixin)
    first = cli._get_extra_tui_widgets()
    assert len(first) == 1
    assert cli._get_extra_tui_widgets()[0] is first[0]  # loaded once


def test_subclass_override_unaffected(home, cfg):
    _put(home, "a.py", GOOD.replace("{n}", "a"))

    class Sub(CLITuiMixin):
        def _get_extra_tui_widgets(self):
            return ["mine"]

    assert Sub.__new__(Sub)._get_extra_tui_widgets() == ["mine"]


def test_disabled_by_config(home, cfg):
    _put(home, "a.py", GOOD.replace("{n}", "a"))
    cfg["cli_widgets"] = {"enabled": False}
    assert cli_widgets.load_cli_widgets(_fake_cli()) == []
    cfg["cli_widgets"] = False
    assert cli_widgets.load_cli_widgets(_fake_cli()) == []


def test_import_and_create_errors_isolated_one_line(home, cfg, caplog):
    _put(home, "a_syntax.py", "def (:")
    _put(home, "b_create.py", "def create(api):\n    raise ValueError('boom')")
    _put(home, "c_none.py", "def create(api):\n    return None")
    _put(home, "d_ok.py", GOOD.replace("{n}", "ok"))
    with caplog.at_level(logging.WARNING, logger="hermes_cli.cli_widgets"):
        out = cli_widgets.load_cli_widgets(_fake_cli())
    assert len(out) == 1
    msgs = [r.getMessage() for r in caplog.records if "cli-widget" in r.getMessage()]
    assert len(msgs) == 3  # one line per broken widget


def test_render_error_disables_widget_once(home, cfg, caplog):
    _put(home, "a.py", '''
from prompt_toolkit.layout.containers import Window
from prompt_toolkit.layout.controls import FormattedTextControl
def _text():
    raise RuntimeError("render-boom")
def create(api):
    return Window(content=FormattedTextControl(_text), height=1)
''')
    (w,) = cli_widgets.load_cli_widgets(_fake_cli())
    with caplog.at_level(logging.WARNING, logger="hermes_cli.cli_widgets"):
        _render(w)
        _render(w)
        _render(w)
    msgs = [r.getMessage() for r in caplog.records if "render-boom" in r.getMessage()]
    assert len(msgs) == 1


def test_idle_repaint_is_noop_by_default(home, cfg):
    cli = _fake_cli()
    api = cli_widgets.CliWidgetAPI(cli, idle_repaint=False)
    api.request_repaint(0.5)
    assert cli.invalidations == []


def test_idle_repaint_opt_in(home, cfg):
    cli = _fake_cli()
    cli_widgets.CliWidgetAPI(cli, idle_repaint=True).request_repaint(0.5)
    assert cli.invalidations == [0.5]


def test_busy_repaint_routes_through_invalidate(home, cfg):
    cli = _fake_cli(_agent_running=True)
    cli_widgets.CliWidgetAPI(cli).request_repaint(0.1)
    assert cli.invalidations == [0.1]


def test_idle_repaint_config_reaches_api(home, cfg):
    _put(home, "a.py", GOOD.replace("{n}", "a").replace("    SEEN.append(api)", "    api.request_repaint(0.2)"))
    cfg["cli_widgets"] = {"idle_repaint": True}
    cli = _fake_cli()
    cli_widgets.load_cli_widgets(cli)  # widget asks for a repaint while idle
    assert cli.invalidations == [0.2]
    cfg["cli_widgets"] = {}
    cli2 = _fake_cli()
    cli_widgets.load_cli_widgets(cli2)
    assert cli2.invalidations == []


def test_snapshot_fields_across_fake_turn(home, cfg, monkeypatch):
    cli = _fake_cli()
    api = cli_widgets.CliWidgetAPI(cli)
    snap = api.snapshot()
    assert set(snap) == {"session_id", "busy", "phase", "tool_name", "pending",
                         "last_error_kind", "cols", "rows", "in_tmux"}
    assert snap["session_id"] == "s1"
    assert (snap["busy"], snap["phase"], snap["tool_name"], snap["pending"]) == (False, None, None, None)

    cli._agent_running = True  # model is thinking
    assert api.snapshot()["phase"] == "thinking"

    cli._tool_start_time = 1.0  # a tool started
    cli.__dict__["_running_tool_labels"] = {"terminal": ["⚡ ls"]}
    s = api.snapshot()
    assert (s["phase"], s["tool_name"]) == ("tool", "terminal")

    cli._approval_state = {"x": 1}
    assert api.snapshot()["pending"] == "approval"
    cli._approval_state, cli._clarify_state = None, {"q": 1}
    assert api.snapshot()["pending"] == "clarify"
    cli._clarify_state, cli._sudo_state = None, {"q": 1}
    assert api.snapshot()["pending"] == "sudo"
    cli._sudo_state, cli._secret_state = None, {"q": 1}
    assert api.snapshot()["pending"] == "secret"

    cli._secret_state, cli._agent_running, cli._last_error_kind = None, False, "rate_limit"
    cli.__dict__.pop("_running_tool_labels")
    s = api.snapshot()
    assert (s["busy"], s["phase"], s["last_error_kind"]) == (False, None, "rate_limit")

    monkeypatch.setenv("TMUX", "/tmp/tmux-1/default,1,0")
    assert api.snapshot()["in_tmux"] is True
