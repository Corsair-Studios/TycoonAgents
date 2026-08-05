"""Tests for uefn_launcher.py's per-client MCP config snippet generator
(``build_client_config_snippet``, ~line 758) and its runtime discovery
helper (``_discover_server_and_bridge_dir``, ~line 675) -- added for
multi-AI-client MCP setup support (the "Copy config for selected client"
button in the MCP Bridge Commands window; client tuples ~line 421 now carry
a client_id, including a new "Antigravity IDE" row).

``build_client_config_snippet`` is pure (no unreal/tkinter calls of its
own -- see its own docstring), so every test below except the
``_discover_server_and_bridge_dir`` group calls it directly with hand-built
inputs. ``_discover_server_and_bridge_dir`` derives everything from
``os.path.dirname(os.path.abspath(__file__))`` (this MODULE's own
``__file__``, not a parameter) -- both shipped layouts (staged: server
alongside; standalone: server one level up) are exercised by temporarily
pointing ``uefn_launcher.__file__`` at a real, disposable temp-directory
tree shaped like each layout, restored in tearDown. This is the same
save-and-restore idiom test_tag_inspect.py uses throughout (e.g.
``tag_inspect.report_path``).

Loaded the same way test_uefn_launcher_mcp_panel.py loads uefn_launcher:
``stub_unreal()`` first (uefn_launcher.py does an UNGUARDED ``import
unreal`` at module scope), then a plain module import off
media/uefn-bridge on sys.path. No tkinter window is ever constructed here.
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import ensure_bridge_on_path, stub_unreal  # noqa: E402

ensure_bridge_on_path()
stub_unreal()
import uefn_launcher  # noqa: E402


# Every client_id build_client_config_snippet() accepts that shares the
# plain {"mcpServers": {"uefn": {...}}} shape (i.e. everything except
# codex-cli, which is TOML, and vscode-copilot, which uses "servers").
_MCP_SERVERS_JSON_CLIENTS = ("claude-code", "gemini-cli", "cursor", "windsurf", "antigravity")
_ALL_JSON_CLIENTS = _MCP_SERVERS_JSON_CLIENTS + ("vscode-copilot",)

# A Windows-style absolute path with backslashes -- the round-trip case
# this module's own docstring history (see PATH-DISCOVERY.md-adjacent
# concerns elsewhere in this repo) makes worth pinning explicitly: JSON
# string-escapes backslashes on the way out, and json.loads must recover
# the exact original string.
_SAMPLE_SERVER_PATH_MJS = r"C:\Users\dev\PowerTools\uefn-server.mjs"
_SAMPLE_SERVER_PATH_TS = r"C:\Users\dev\PowerTools\uefn-server.ts"
_SAMPLE_BRIDGE_DIR = r"C:\Users\dev\AppData\Local\Temp\uefn_bridge"


def _entry_for(parsed, client_id):
    key = "servers" if client_id == "vscode-copilot" else "mcpServers"
    return parsed[key]["uefn"]


# ---------------------------------------------------------------------------
# JSON clients (claude-code, gemini-cli, cursor, windsurf, antigravity,
# vscode-copilot) -- correct top-level key, vscode-copilot's extra "type",
# a Windows path surviving the json.loads round-trip exactly, and the env
# block carrying UEFN_BRIDGE_DIR.
# ---------------------------------------------------------------------------

class BuildClientConfigSnippetJsonClientsTests(unittest.TestCase):
    def test_each_mcpServers_client_parses_and_uses_the_mcpServers_key(self):
        for client_id in _MCP_SERVERS_JSON_CLIENTS:
            with self.subTest(client_id=client_id):
                snippet = uefn_launcher.build_client_config_snippet(
                    client_id, _SAMPLE_SERVER_PATH_MJS, _SAMPLE_BRIDGE_DIR,
                )
                parsed = json.loads(snippet)
                self.assertIn("mcpServers", parsed)
                self.assertNotIn("servers", parsed)
                self.assertIn("uefn", parsed["mcpServers"])

    def test_vscode_copilot_uses_servers_key_not_mcpServers_and_has_stdio_type(self):
        snippet = uefn_launcher.build_client_config_snippet(
            "vscode-copilot", _SAMPLE_SERVER_PATH_MJS, _SAMPLE_BRIDGE_DIR,
        )
        parsed = json.loads(snippet)
        self.assertIn("servers", parsed)
        self.assertNotIn("mcpServers", parsed)
        self.assertEqual(parsed["servers"]["uefn"]["type"], "stdio")

    def test_windows_backslash_path_survives_json_round_trip_exactly(self):
        for client_id in _ALL_JSON_CLIENTS:
            with self.subTest(client_id=client_id):
                snippet = uefn_launcher.build_client_config_snippet(
                    client_id, _SAMPLE_SERVER_PATH_MJS, _SAMPLE_BRIDGE_DIR,
                )
                parsed = json.loads(snippet)
                entry = _entry_for(parsed, client_id)
                self.assertIn(_SAMPLE_SERVER_PATH_MJS, entry["args"])
                self.assertEqual(entry["args"][-1], _SAMPLE_SERVER_PATH_MJS)

    def test_env_block_carries_bridge_dir_when_given(self):
        for client_id in _ALL_JSON_CLIENTS:
            with self.subTest(client_id=client_id):
                snippet = uefn_launcher.build_client_config_snippet(
                    client_id, _SAMPLE_SERVER_PATH_MJS, _SAMPLE_BRIDGE_DIR,
                )
                parsed = json.loads(snippet)
                entry = _entry_for(parsed, client_id)
                self.assertEqual(entry["env"]["UEFN_BRIDGE_DIR"], _SAMPLE_BRIDGE_DIR)


# ---------------------------------------------------------------------------
# codex-cli -- TOML, not JSON: [mcp_servers.uefn] table with command/args
# lines, plus a [mcp_servers.uefn.env] sub-table carrying UEFN_BRIDGE_DIR
# whenever a real bridge_dir is known (Codex CLI officially documents this
# sub-table form for stdio MCP servers: learn.chatgpt.com/docs/extend/mcp).
# No env sub-table -- and no shell-env guidance comment -- when bridge_dir
# is None (never a guessed/placeholder value written into config.toml).
# ---------------------------------------------------------------------------

class BuildClientConfigSnippetCodexTests(unittest.TestCase):
    def test_codex_snippet_has_the_toml_table_and_command_args_lines(self):
        snippet = uefn_launcher.build_client_config_snippet(
            "codex-cli", _SAMPLE_SERVER_PATH_MJS, _SAMPLE_BRIDGE_DIR,
        )
        self.assertIn("[mcp_servers.uefn]", snippet)
        self.assertIn('command = "node"', snippet)
        self.assertIn(_SAMPLE_SERVER_PATH_MJS.replace("\\", "\\\\"), snippet)

    def test_codex_snippet_emits_env_subtable_with_bridge_dir_when_given(self):
        # Corrected contract: Codex CLI DOES officially document env passing
        # for stdio MCP servers via a [mcp_servers.<name>.env] sub-table
        # (learn.chatgpt.com/docs/extend/mcp) -- the earlier "no env key"
        # behavior was a factual error, now fixed.
        snippet = uefn_launcher.build_client_config_snippet(
            "codex-cli", _SAMPLE_SERVER_PATH_MJS, _SAMPLE_BRIDGE_DIR,
        )
        self.assertIn("[mcp_servers.uefn]", snippet)
        self.assertIn("[mcp_servers.uefn.env]", snippet)
        self.assertIn(
            'UEFN_BRIDGE_DIR = "{}"'.format(_SAMPLE_BRIDGE_DIR.replace("\\", "\\\\")),
            snippet,
        )
        # [mcp_servers.uefn.env] must come after the main table, not before.
        self.assertLess(
            snippet.index("[mcp_servers.uefn]"),
            snippet.index("[mcp_servers.uefn.env]"),
        )

    def test_codex_snippet_env_subtable_backslash_escaping_is_sound(self):
        snippet = uefn_launcher.build_client_config_snippet(
            "codex-cli", _SAMPLE_SERVER_PATH_MJS, _SAMPLE_BRIDGE_DIR,
        )
        escaped_bridge_dir = _SAMPLE_BRIDGE_DIR.replace("\\", "\\\\")
        self.assertIn(
            'UEFN_BRIDGE_DIR = "{}"'.format(escaped_bridge_dir),
            snippet,
        )

    def test_codex_snippet_has_no_env_subtable_when_bridge_dir_is_none(self):
        snippet = uefn_launcher.build_client_config_snippet(
            "codex-cli", _SAMPLE_SERVER_PATH_MJS, None,
        )
        self.assertIn("[mcp_servers.uefn]", snippet)
        self.assertNotIn("[mcp_servers.uefn.env]", snippet)
        self.assertNotIn("UEFN_BRIDGE_DIR", snippet)
        # The removed shell-env guidance sentence/comment must be gone too.
        self.assertNotIn("shell", snippet.lower())

    def test_ts_path_routes_codex_through_npx_tsx_too(self):
        snippet = uefn_launcher.build_client_config_snippet(
            "codex-cli", _SAMPLE_SERVER_PATH_TS, _SAMPLE_BRIDGE_DIR,
        )
        self.assertIn('command = "npx"', snippet)
        self.assertIn("tsx", snippet)


# ---------------------------------------------------------------------------
# None server_path / bridge_dir -- explicit placeholder text, never a
# fabricated-looking real path.
# ---------------------------------------------------------------------------

class BuildClientConfigSnippetPlaceholderTests(unittest.TestCase):
    def test_none_server_path_and_bridge_dir_use_placeholders(self):
        snippet = uefn_launcher.build_client_config_snippet("claude-code", None, None)
        parsed = json.loads(snippet)
        entry = parsed["mcpServers"]["uefn"]
        self.assertEqual(entry["command"], "node")
        self.assertIn(uefn_launcher._PLACEHOLDER_SERVER_PATH, entry["args"])
        self.assertEqual(entry["env"]["UEFN_BRIDGE_DIR"], uefn_launcher._PLACEHOLDER_BRIDGE_DIR)

    def test_none_bridge_dir_alone_still_uses_the_bridge_placeholder(self):
        snippet = uefn_launcher.build_client_config_snippet(
            "gemini-cli", _SAMPLE_SERVER_PATH_MJS, None,
        )
        parsed = json.loads(snippet)
        entry = parsed["mcpServers"]["uefn"]
        self.assertEqual(entry["args"][-1], _SAMPLE_SERVER_PATH_MJS)  # real path still used
        self.assertEqual(entry["env"]["UEFN_BRIDGE_DIR"], uefn_launcher._PLACEHOLDER_BRIDGE_DIR)

    def test_codex_none_bridge_dir_omits_env_subtable_but_real_bridge_dir_adds_one(self):
        # Corrected contract: bridge_dir presence/absence now changes codex
        # output (the env sub-table appears only when a real value is
        # given) -- None and a real value must NOT be identical anymore.
        with_dir = uefn_launcher.build_client_config_snippet("codex-cli", None, _SAMPLE_BRIDGE_DIR)
        without_dir = uefn_launcher.build_client_config_snippet("codex-cli", None, None)
        self.assertNotEqual(with_dir, without_dir)
        self.assertIn("[mcp_servers.uefn.env]", with_dir)
        self.assertNotIn("[mcp_servers.uefn.env]", without_dir)


# ---------------------------------------------------------------------------
# Unknown client_id -- ValueError, never a silent empty string.
# ---------------------------------------------------------------------------

class BuildClientConfigSnippetUnknownClientTests(unittest.TestCase):
    def test_unknown_client_id_raises_value_error(self):
        with self.assertRaises(ValueError):
            uefn_launcher.build_client_config_snippet(
                "not-a-real-client", _SAMPLE_SERVER_PATH_MJS, _SAMPLE_BRIDGE_DIR,
            )


# ---------------------------------------------------------------------------
# .ts vs .mjs command routing (_resolve_command_and_args, exercised through
# the public build_client_config_snippet). Also the item-4 consistency
# anchor: INSTALL.md's own documented standalone-source swap (see
# scripts/powertools-assets/INSTALL.md's "swap the command ... for" block)
# says exactly {"command": "npx", "args": ["tsx", "<path-to>.ts"]} -- this
# pins the SAME shape from the generator's side; test/syncPowertoolsDocs
# .test.ts pins it from the doc's side independently.
# ---------------------------------------------------------------------------

class ResolveCommandAndArgsRoutingTests(unittest.TestCase):
    def test_ts_path_routes_through_npx_tsx(self):
        snippet = uefn_launcher.build_client_config_snippet(
            "claude-code", _SAMPLE_SERVER_PATH_TS, _SAMPLE_BRIDGE_DIR,
        )
        entry = json.loads(snippet)["mcpServers"]["uefn"]
        self.assertEqual(entry["command"], "npx")
        self.assertEqual(entry["args"], ["tsx", _SAMPLE_SERVER_PATH_TS])

    def test_mjs_path_routes_through_plain_node(self):
        snippet = uefn_launcher.build_client_config_snippet(
            "claude-code", _SAMPLE_SERVER_PATH_MJS, _SAMPLE_BRIDGE_DIR,
        )
        entry = json.loads(snippet)["mcpServers"]["uefn"]
        self.assertEqual(entry["command"], "node")
        self.assertEqual(entry["args"], [_SAMPLE_SERVER_PATH_MJS])


# ---------------------------------------------------------------------------
# _discover_server_and_bridge_dir -- exercises both shipped layouts by
# pointing uefn_launcher.__file__ at a disposable temp-directory tree
# shaped like each one (the function takes no parameters; it derives
# everything from its OWN module's __file__, per its docstring). Restored
# in tearDown on every test, matching this suite's other save-and-restore
# patches.
# ---------------------------------------------------------------------------

class DiscoverServerAndBridgeDirTests(unittest.TestCase):
    def setUp(self):
        self._orig_file = uefn_launcher.__file__

    def tearDown(self):
        uefn_launcher.__file__ = self._orig_file

    def test_staged_layout_finds_uefn_server_mjs_alongside(self):
        with tempfile.TemporaryDirectory() as staged_dir:
            open(os.path.join(staged_dir, "uefn-server.mjs"), "w").close()
            uefn_launcher.__file__ = os.path.join(staged_dir, "uefn_launcher.py")
            server_path, bridge_dir = uefn_launcher._discover_server_and_bridge_dir()

        self.assertIsNotNone(server_path)
        self.assertEqual(
            os.path.normpath(server_path),
            os.path.normpath(os.path.join(staged_dir, "uefn-server.mjs")),
        )
        self.assertIsNotNone(bridge_dir)  # resolves via _get_bridge_dir(), unrelated to __file__

    def test_standalone_layout_finds_uefn_server_ts_one_level_up(self):
        with tempfile.TemporaryDirectory() as repo_dir:
            open(os.path.join(repo_dir, "uefn-server.ts"), "w").close()
            python_dir = os.path.join(repo_dir, "python")
            os.makedirs(python_dir)
            uefn_launcher.__file__ = os.path.join(python_dir, "uefn_launcher.py")
            server_path, bridge_dir = uefn_launcher._discover_server_and_bridge_dir()

        self.assertIsNotNone(server_path)
        self.assertEqual(
            os.path.normpath(server_path),
            os.path.normpath(os.path.join(repo_dir, "uefn-server.ts")),
        )
        self.assertIsNotNone(bridge_dir)

    def test_staged_layout_is_preferred_over_standalone_when_both_present(self):
        # Mirrors the real function's own if/elif order (staged checked
        # before standalone).
        with tempfile.TemporaryDirectory() as repo_dir:
            python_dir = os.path.join(repo_dir, "python")
            os.makedirs(python_dir)
            open(os.path.join(python_dir, "uefn-server.mjs"), "w").close()
            open(os.path.join(repo_dir, "uefn-server.ts"), "w").close()
            uefn_launcher.__file__ = os.path.join(python_dir, "uefn_launcher.py")
            server_path, _bridge_dir = uefn_launcher._discover_server_and_bridge_dir()

        self.assertTrue(server_path.endswith(".mjs"), server_path)

    def test_unresolvable_layout_returns_none_not_a_wrong_guess(self):
        with tempfile.TemporaryDirectory() as empty_dir:
            uefn_launcher.__file__ = os.path.join(empty_dir, "uefn_launcher.py")
            server_path, _bridge_dir = uefn_launcher._discover_server_and_bridge_dir()

        self.assertIsNone(server_path)

    def test_unresolvable_server_path_still_yields_an_explicit_placeholder_via_the_generator(self):
        # End-to-end: an honest None from discovery must reach the
        # generator as the explicit placeholder, never a guessed real path.
        with tempfile.TemporaryDirectory() as empty_dir:
            uefn_launcher.__file__ = os.path.join(empty_dir, "uefn_launcher.py")
            server_path, bridge_dir = uefn_launcher._discover_server_and_bridge_dir()

        snippet = uefn_launcher.build_client_config_snippet("claude-code", server_path, bridge_dir)
        entry = json.loads(snippet)["mcpServers"]["uefn"]
        self.assertIn(uefn_launcher._PLACEHOLDER_SERVER_PATH, entry["args"])


if __name__ == "__main__":
    unittest.main()
