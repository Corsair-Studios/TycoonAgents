"""Drift-detection pin for p4-t3: list_commands (p4-t1,
media/uefn-bridge/uefn_bridge.py ~1740-1810) must derive its output from
``_METHODS`` (the real dispatch table, ~line 1822) at call time via
``inspect.getsource`` + ``_PARAMS_GET_RE`` -- never a hand-typed literal
list that can silently drift out of sync with the table it claims to
describe.

A snapshot test ("output equals these 30 names") would itself become the
kind of stale hand-maintained list this feature exists to prevent. These
tests instead pin the PROPERTY: (1) bidirectional completeness against the
live ``_METHODS`` dict, and (2) a runtime-injected fake dispatch entry
appearing in the output with zero other code change -- proving the
derivation is live, not cached or hand-copied.

Mocking approach: ``_bridge_helpers.import_uefn_bridge()`` stubs `unreal`
and imports uefn_bridge, identical to every other dispatch test in this
directory (see test_dispatch_layer_param_forwarding.py).
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import import_uefn_bridge  # noqa: E402

uefn_bridge = import_uefn_bridge()


def _commands_by_name():
    result = uefn_bridge._handle_list_commands({})
    return {entry["command"]: entry for entry in result["commands"]}, result


class BidirectionalCompletenessTests(unittest.TestCase):
    """The core drift-detection property: every key in the live _METHODS
    dispatch table appears in list_commands output, and vice versa -- no
    extras, no omissions. Both sides read the same live dict, so this
    stays true forever unless someone breaks the derivation itself (e.g.
    reverts to a hand-typed list), which is exactly the regression this
    test exists to catch."""

    def test_methods_and_list_commands_match_exactly(self):
        by_name, result = _commands_by_name()
        method_names = set(uefn_bridge._METHODS.keys())
        listed_names = set(by_name.keys())

        missing_from_output = method_names - listed_names
        extra_in_output = listed_names - method_names

        self.assertEqual(
            missing_from_output, set(),
            f"_METHODS entries missing from list_commands output: {missing_from_output}",
        )
        self.assertEqual(
            extra_in_output, set(),
            f"list_commands output has entries not in _METHODS: {extra_in_output}",
        )
        self.assertEqual(result["count"], len(uefn_bridge._METHODS))
        self.assertEqual(len(result["commands"]), len(uefn_bridge._METHODS))


class DriftInjectionTests(unittest.TestCase):
    """Proves the completeness property dynamically rather than "by
    inspection": inject a fake entry directly into the live _METHODS dict
    at test runtime, with no other code change, and assert it appears in
    list_commands output. Then remove it and assert it's gone. If
    list_commands ever regresses to a hand-typed/cached list, this test
    fails even though BidirectionalCompletenessTests might not (a stale
    hand list could coincidentally still match _METHODS at the moment the
    other test runs)."""

    FAKE_NAME = "zz_test_fake_command"

    def tearDown(self):
        uefn_bridge._METHODS.pop(self.FAKE_NAME, None)

    def test_injected_fake_entry_appears_and_disappears(self):
        by_name_before, _ = _commands_by_name()
        self.assertNotIn(self.FAKE_NAME, by_name_before)

        def _fake_handler(params):
            """Fake handler injected purely for drift-detection testing."""
            return None

        try:
            uefn_bridge._METHODS[self.FAKE_NAME] = _fake_handler
            by_name, result = _commands_by_name()
            self.assertIn(self.FAKE_NAME, by_name)
            self.assertEqual(
                by_name[self.FAKE_NAME]["description"],
                "Fake handler injected purely for drift-detection testing.",
            )
        finally:
            uefn_bridge._METHODS.pop(self.FAKE_NAME, None)

        by_name_after, _ = _commands_by_name()
        self.assertNotIn(self.FAKE_NAME, by_name_after)


class KnownCommandsPresentTests(unittest.TestCase):
    def test_batch_location_present(self):
        by_name, _ = _commands_by_name()
        self.assertIn("batch_location", by_name)

    def test_list_commands_itself_present(self):
        by_name, _ = _commands_by_name()
        self.assertIn("list_commands", by_name)


class PaginationFlagHonestyTests(unittest.TestCase):
    def test_batch_get_supports_pagination(self):
        by_name, _ = _commands_by_name()
        self.assertTrue(by_name["batch_get"]["supports_pagination"])

    def test_batch_location_supports_pagination(self):
        by_name, _ = _commands_by_name()
        self.assertTrue(by_name["batch_location"]["supports_pagination"])

    def test_tag_inspect_supports_pagination(self):
        by_name, _ = _commands_by_name()
        self.assertTrue(by_name["tag_inspect"]["supports_pagination"])

    def test_status_does_not_support_pagination(self):
        by_name, _ = _commands_by_name()
        entry = by_name["status"]
        self.assertFalse(entry.get("supports_pagination"))


class HonestFallbackTests(unittest.TestCase):
    def test_docstring_less_handler_yields_no_fabricated_description(self):
        by_name, _ = _commands_by_name()
        entry = by_name["asset_sweep"]
        self.assertIsNone(entry["description"])


if __name__ == "__main__":
    unittest.main()
