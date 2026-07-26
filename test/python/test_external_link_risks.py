"""Tests for moderation_scanner.collect_external_link_risks /
_scan_text_for_external_link_risks (Rule 1.12 "Keep It on the Island"
detection) — the largest, most regression-prone surface in this scanner.

Ported from this session's scratchpad harnesses: test_link_risks_prod.py
(positives + explicit negatives), test_defects.py (the 79%-false-positive
Verse corpus fix), test_review_fixes.py (the false-BLOCKER short-host/slug
regression), and test_followup.py's re-run of the negative baseline.
"""
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import import_moderation_scanner, REPO_ROOT  # noqa: E402

ms = import_moderation_scanner()


def _scan(asset_surfaces=None, verse_surfaces=None, text_fields=None, image_paths=None, audio=None):
    return ms.collect_external_link_risks(
        asset_surfaces=asset_surfaces or [],
        verse_surfaces=verse_surfaces or [],
        text_metadata={"fields": text_fields or []},
        image_paths=image_paths or [],
        audio_surfaces={"audio": audio or []},
    )


class PositiveCasesTests(unittest.TestCase):
    """Genuine external-link risk shapes must fire, one per documented
    real-world surface."""

    def test_qr_token_asset_name_fires(self):
        r = _scan(asset_surfaces=[{
            "display_name": "discord_QR",
            "object_path": "/Game/UI/discord_QR.discord_QR",
            "package_name": "/Game/UI/discord_QR",
        }])
        self.assertTrue(any(i["kind"] == "scannable_code_token" for i in r["items"]), r["items"])
        self.assertTrue(r["note"])  # unconditional vision caveat, never omitted

    def test_bare_url_in_verse_string_fires(self):
        r = _scan(verse_surfaces=[{
            "file": "x.verse", "line": 12, "kind": "string_literal",
            "text": 'Print("https://example.com/x")',
        }])
        self.assertTrue(any(i["kind"] == "url" for i in r["items"]), r["items"])

    def test_genuine_short_link_on_real_tld_fires(self):
        r = _scan(verse_surfaces=[{
            "file": "x.verse", "line": 5, "kind": "string_literal",
            "text": "Join us at somehost.gg/abc123 for more",
        }])
        self.assertTrue(any(i["kind"] in ("invite_path", "domain") for i in r["items"]), r["items"])

    def test_handle_in_text_metadata_fires(self):
        r = _scan(text_fields=[{"file": "meta.json", "key": "description", "value": "Follow @somehandle for updates"}])
        self.assertTrue(any(i["kind"] == "handle" for i in r["items"]), r["items"])


class ExplicitNegativeAssetTests(unittest.TestCase):
    """Ordinary UE asset display names / object paths must never fire —
    these are the exact non-link shapes the detector must ignore."""

    def test_ordinary_assets_and_verse_produce_zero_hits(self):
        negative_assets = [
            {"display_name": "SM_Rock_01", "object_path": "/Game/Meshes/SM_Rock_01.SM_Rock_01", "package_name": "/Game/Meshes/SM_Rock_01"},
            {"display_name": "Foo", "object_path": "/Game/Meshes/Foo.Foo", "package_name": "/Game/Meshes/Foo"},
            {"display_name": "Instance", "object_path": "Material.Instance", "package_name": "Material"},
            {"display_name": "BP_Thing_C", "object_path": "BP_Thing.BP_Thing_C", "package_name": "BP_Thing"},
        ]
        negative_verse = [{"file": "x.verse", "line": 1, "kind": "comment_line", "text": 'Print("Score: {X}")'}]
        r = _scan(asset_surfaces=negative_assets, verse_surfaces=negative_verse)
        self.assertEqual(r["total_count"], 0, r["items"])


class VerseFalsePositiveCorpusTests(unittest.TestCase):
    """The 79%-false-positive-rate fix: three real Verse shapes that
    structurally collide with link detection but are not links, scoped
    ONLY to the "verse" surface (text_metadata must stay fully sensitive —
    see RecallCaseTests below)."""

    FALSE_POSITIVE_SHAPES = [
        "using { /Fortnite.com/Devices }",
        "using { /Fortnite.com/Characters }",
        "@editable",
        "@author",
        "Stats.fr",
        "VendorItem.Name",
    ]

    GENUINE_SHAPES = [
        "patreon.com/ShalevFNC/shop",
        "github.com/ZeroYaHero/StormBox/tree/main",
        "https://fn.gg/z38",
    ]

    def _verse_scan(self, text, kind="comment_line"):
        return _scan(verse_surfaces=[{"file": "x.verse", "line": 1, "kind": kind, "text": text}])

    def test_verse_syntax_shapes_produce_zero_hits(self):
        for text in self.FALSE_POSITIVE_SHAPES:
            with self.subTest(text=text):
                r = self._verse_scan(text)
                self.assertEqual(r["total_count"], 0, r["items"])

    def test_genuine_links_in_verse_still_fire(self):
        for text in self.GENUINE_SHAPES:
            with self.subTest(text=text):
                r = self._verse_scan(text)
                self.assertGreaterEqual(r["total_count"], 1, r["items"])

    def test_text_metadata_handle_detection_unaffected_by_verse_suppression(self):
        r = _scan(text_fields=[{"file": "meta.json", "key": "description", "value": "Follow @somehandle for updates"}])
        self.assertEqual(r["total_count"], 1)
        self.assertEqual(r["items"][0]["kind"], "handle")

    def test_synthetic_corpus_hit_rate_matches_fix_not_pre_fix_regression(self):
        """Reproduces the reported-live-project shape: 69 module-path FPs +
        86 @attribute FPs + 30 field-accessor FPs + 48 genuine hits. Before
        the fix this landed ~233 (nearly everything); after the fix it must
        land close to the 48 genuine hits, never anywhere near 233."""
        random.seed(42)
        module_paths = [f"using {{ /Fortnite.com/{seg} }}" for seg in
                         ["Devices", "Characters", "Colors", "FloatingText", "Slate", "Diagnostics",
                          "UI", "Sound", "Playspaces", "Vehicles", "Animation", "Explosives"]]
        attributes = ["@editable", "@author", "@computes", "@overrides", "@final", "@native"]
        field_accessors = ["Stats.fr", "VendorItem.Name", "PlayerData.co", "Settings.me",
                            "ScoreBoard.us", "Config.to", "GameMode.tv", "Inventory.cc"]
        corpus = (
            [random.choice(module_paths) for _ in range(69)]
            + [random.choice(attributes) for _ in range(86)]
            + [random.choice(field_accessors) for _ in range(30)]
            + [random.choice(self.GENUINE_SHAPES) for _ in range(48)]
        )
        random.shuffle(corpus)

        total_hits = sum(self._verse_scan(text)["total_count"] for text in corpus)
        self.assertLessEqual(total_hits, 55, f"false-positive noise not suppressed (got {total_hits})")
        self.assertGreaterEqual(total_hits, 40, f"suspiciously low — genuine hits may be over-suppressed (got {total_hits})")


class FalseBlockerShortHostSlugTests(unittest.TestCase):
    """The false-BLOCKER regression: a short file-extension-shaped host
    followed by "/slug" (readme.md/section1 etc.) must never be treated as
    an invite-shaped short link, while a genuine curated-TLD short link
    (somehost.gg/abc123) still must."""

    FALSE_BLOCKER_TEXTS = [
        "See readme.md/section1 for details",
        "Uses logo.png/v2 as the icon",
        "Check notes.txt/part2 before continuing",
    ]

    def test_file_extension_shaped_hosts_produce_zero_hits(self):
        for text in self.FALSE_BLOCKER_TEXTS:
            with self.subTest(text=text):
                r = _scan(verse_surfaces=[{"file": "x.verse", "line": 1, "kind": "comment_line", "text": text}])
                self.assertEqual(r["total_count"], 0, r["items"])

    def test_genuine_curated_tld_short_link_still_fires(self):
        r = _scan(verse_surfaces=[{"file": "x.verse", "line": 1, "kind": "comment_line", "text": "join at somehost.gg/abc123"}])
        self.assertEqual(r["total_count"], 1)
        self.assertIn(r["items"][0]["kind"], ("invite_path", "domain"))

    def test_asset_name_and_object_path_shapes_stay_negative(self):
        neg_assets = [
            {"display_name": "SM_Rock_01", "object_path": "/Game/Meshes/SM_Rock_01.SM_Rock_01", "package_name": "/Game/Meshes/SM_Rock_01"},
            {"display_name": "BP_Thing_C", "object_path": "BP_Thing.BP_Thing_C", "package_name": "BP_Thing"},
        ]
        r = _scan(asset_surfaces=neg_assets)
        self.assertEqual(r["total_count"], 0, r["items"])

    def test_realistic_asset_name_slug_pairs_produce_zero_false_positives(self):
        """Same corpus used in the original harness: 65 ordinary asset-shaped
        names, each with a common file extension + "/slugN" tail appended, to
        specifically exercise the short-host-slug rule (plain names alone
        never had a "/" so they always passed even pre-fix)."""
        realistic_names = [
            "SM_Rock_01", "SM_Tree_Pine_02", "T_Grass_Diffuse", "T_Grass_Normal",
            "M_Wood_Master", "MI_Wood_Red", "BP_PlayerController", "BP_GameMode",
            "WBP_MainMenu", "WBP_HUD", "A_Footstep_Grass", "A_Music_Theme01",
            "NS_Fire_Small", "NS_Smoke_Puff", "Info", "Manager", "Team",
            "GameManager", "TeamData", "PlayerInfo", "InventoryComponent",
            "HealthComponent", "DamageHandler", "SpawnController", "WaveManager",
            "ScoreBoard", "Leaderboard", "Checkpoint01", "Checkpoint_Start",
            "Level_01", "Level_Design_Doc", "HLOD0_Cell_01", "Mat_Base",
            "SK_Character01", "Anim_Idle", "Anim_Run_Fwd", "Sound_Cue_Explosion",
            "UI_Icon_Coin", "UI_Icon_Gem", "Prop_Barrel_Wood", "Device_Trigger01",
            "Verb_Interact", "Const_MaxHealth", "Enum_GameState", "Struct_PlayerData",
            "Interface_Damageable", "Base_Weapon", "Factory_Enemy", "Utils_Math",
            "Config_Difficulty", "Settings_Audio", "System_Save", "Object_Pickup",
            "Actor_NPC", "Asset_Currency", "Widget_Timer", "Panel_Inventory",
            "Window_Settings", "View_Shop", "Model_Enemy", "State_Combat",
            "Type_Weapon", "Class_Rogue", "App_Core", "Dev_Testing",
        ]
        exts = ["md", "png", "txt", "json", "uasset", "py", "cs", "cpp", "log", "wav"]
        false_positives = 0
        for i, name in enumerate(realistic_names):
            text = f"{name}.{exts[i % len(exts)]}/section{i}"
            r = _scan(verse_surfaces=[{"file": "x.verse", "line": 1, "kind": "comment_line", "text": text}])
            if r["total_count"] > 0:
                false_positives += 1
        self.assertEqual(false_positives, 0)


class RecallCaseTests(unittest.TestCase):
    """The recall regression a precision fix once broke: collect_verse_surfaces
    emits one string/comment/label per entry with no paired URL in the same
    snippet, so a genuine player-visible promo line ("Follow @mystudio for
    updates!") was being silently dropped by the verse link-context gate.
    string_literal is the ONE Verse surface kind that can be player-visible
    text, so it must stay fully sensitive (no verse_mode suppression, no
    link-context gate on handles) — while the identical text shape on any
    CODE kind (comment_line etc.) keeps the existing suppression."""

    TEXT = "Follow @mystudio for updates!"

    def test_string_literal_kind_fires(self):
        r = _scan(verse_surfaces=[{"file": "x.verse", "line": 1, "kind": "string_literal", "text": self.TEXT}])
        self.assertTrue(any(i["kind"] == "handle" for i in r["items"]), r["items"])

    def test_same_shape_on_code_surface_does_not_fire(self):
        r = _scan(verse_surfaces=[{"file": "x.verse", "line": 1, "kind": "comment_line", "text": self.TEXT}])
        self.assertEqual(r["total_count"], 0, r["items"])


class RunModerationScanWiringTests(unittest.TestCase):
    """Sanity: external_link_risks is wired end-to-end into
    run_moderation_scan and both summary renderers, offline (no `unreal`)."""

    @classmethod
    def setUpClass(cls):
        cls.result = ms.run_moderation_scan(project_dir=REPO_ROOT)

    def test_external_link_risks_key_present(self):
        self.assertIn("external_link_risks", self.result)
        self.assertIn("total_count", self.result["external_link_risks"])

    def test_compact_summary_mentions_external_link(self):
        summary = ms._format_compact_summary(self.result)
        self.assertIn("External link", summary)

    def test_raw_surfaces_mentions_external_link(self):
        raw = ms._format_raw_surfaces(self.result)
        self.assertIn("External link", raw)


if __name__ == "__main__":
    unittest.main()
