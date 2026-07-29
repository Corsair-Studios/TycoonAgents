"""Tests for uefn_bridge.py's three level-editing handlers: spawn_actor,
duplicate_actor, set_transform (media/uefn-bridge/uefn_bridge.py, roughly
lines 1112-1425: `_scoped_transaction`, `_spawn_via_editor_actor_subsystem`,
`_spawn_via_editor_level_library`, `_handle_spawn_actor`,
`_handle_duplicate_actor`, `_handle_set_transform`, and the `spawn_actor` /
`duplicate_actor` / `set_transform` keys in `_METHODS`).

Unlike every read-only handler covered elsewhere in this suite, these three
mutate the open level, so every test here fakes the `unreal` surface deeply
enough to observe what got written, not just that a call happened:

- `unreal.Vector`/`unreal.Rotator` are wired as `MagicMock(side_effect=...)`
  around real `_FakeVector`/`_FakeRotator` classes — this gives tests BOTH
  a real object with real `.x`/`.y`/`.z`/`.pitch`/`.yaw`/`.roll` attributes
  to read back (needed for set_transform's before/after snapshots and
  duplicate_actor's offset math) AND `call_args`/`call_args.kwargs`
  inspection on the mock itself (needed for the Rotator axis-mapping
  guard below).
- `_FakeActor` is a minimal actor double implementing exactly the methods
  these three handlers call (get/set label, location, rotation, scale,
  get_class().get_name()), recording every mutating call so tests can
  assert e.g. "rotation was never touched" for a location-only
  set_transform.

Rotator axis-mapping guard: `unreal.Rotator` takes `pitch`/`yaw`/`roll` as
KEYWORD args, and uefn_bridge.py's params use the same three names — a
transposition here (e.g. constructing `Rotator(roll=pitch_value, ...)`)
would compile and run without ever raising, silently swapping which axis a
creator's spawn/set_transform request actually rotates. The dedicated
Rotator-kwargs tests below construct with three DISTINCT values
(pitch=1, yaw=2, roll=3) and assert each landed under its own keyword in
`unreal.Rotator.call_args.kwargs`, which a positional-order bug would not
survive.

`unreal` is a single MagicMock shared across the whole `unittest discover`
process (see `_bridge_helpers.stub_unreal`) — every attribute this file
touches (EditorAssetLibrary, get_editor_subsystem, EditorLevelLibrary,
Vector, Rotator, ScopedEditorTransaction) is snapshotted in setUp and
restored in tearDown so nothing leaks into other test_*.py files.
"""
import contextlib
import os
import sys
import types
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bridge_helpers import import_uefn_bridge, stub_unreal  # noqa: E402

bridge = import_uefn_bridge()
_unreal = stub_unreal()


# --- Fakes -------------------------------------------------------------

class _FakeVector:
    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x = x
        self.y = y
        self.z = z


class _FakeRotator:
    def __init__(self, pitch=0.0, yaw=0.0, roll=0.0):
        self.pitch = pitch
        self.yaw = yaw
        self.roll = roll


class _FakeActor:
    """Minimal actor double covering exactly what spawn_actor/
    duplicate_actor/set_transform touch. Records every mutating call so
    tests can assert e.g. "scale was never touched" for a location-only
    set_transform."""

    def __init__(self, label="Actor", cls_name="StaticMeshActor", location=None, rotation=None, scale=None):
        self._label = label
        self._cls_name = cls_name
        self._location = location if location is not None else _FakeVector(0.0, 0.0, 0.0)
        self._rotation = rotation if rotation is not None else _FakeRotator(0.0, 0.0, 0.0)
        self._scale = scale if scale is not None else _FakeVector(1.0, 1.0, 1.0)
        self.scale_calls = []
        self.label_calls = []
        self.location_calls = []
        self.rotation_calls = []

    def set_actor_scale3d(self, v):
        self.scale_calls.append(v)
        self._scale = v

    def set_actor_label(self, label):
        self.label_calls.append(label)
        self._label = label

    def get_actor_label(self):
        return self._label

    def get_class(self):
        m = MagicMock()
        m.get_name.return_value = self._cls_name
        return m

    def get_actor_location(self):
        return self._location

    def set_actor_location(self, v, *_args, **_kwargs):
        self.location_calls.append(v)
        self._location = v

    def get_actor_rotation(self):
        return self._rotation

    def set_actor_rotation(self, v, *_args, **_kwargs):
        self.rotation_calls.append(v)
        self._rotation = v

    def get_actor_scale3d(self):
        return self._scale


_UNREAL_ATTRS_UNDER_TEST = (
    "EditorAssetLibrary",
    "get_editor_subsystem",
    "EditorLevelLibrary",
    "Vector",
    "Rotator",
    "ScopedEditorTransaction",
)


class _LevelEditTestCase(unittest.TestCase):
    def setUp(self):
        self._saved = {name: getattr(_unreal, name) for name in _UNREAL_ATTRS_UNDER_TEST}
        _unreal.EditorAssetLibrary = MagicMock()
        _unreal.EditorLevelLibrary = MagicMock()
        _unreal.Vector = MagicMock(side_effect=_FakeVector)
        _unreal.Rotator = MagicMock(side_effect=_FakeRotator)
        # None -> _scoped_transaction falls back to contextlib.nullcontext(),
        # which never swallows an exception raised inside the `with` block
        # (a bare MagicMock's auto-configured __exit__ WOULD, since its
        # default return value is truthy) -- see _scoped_transaction's own
        # dedicated tests below for the fallback behavior itself.
        _unreal.ScopedEditorTransaction = None
        _unreal.get_editor_subsystem = MagicMock()

    def tearDown(self):
        for name, value in self._saved.items():
            setattr(_unreal, name, value)

    def _set_subsystem(self, actors=(), **methods):
        subsystem = MagicMock()
        subsystem.get_all_level_actors = MagicMock(return_value=list(actors))
        for name, value in methods.items():
            setattr(subsystem, name, value)
        _unreal.get_editor_subsystem = MagicMock(return_value=subsystem)
        return subsystem


# --- _METHODS dispatch table --------------------------------------------

class MethodsDispatchTests(unittest.TestCase):
    def test_new_keys_map_to_correct_handlers(self):
        self.assertIs(bridge._METHODS["spawn_actor"], bridge._handle_spawn_actor)
        self.assertIs(bridge._METHODS["duplicate_actor"], bridge._handle_duplicate_actor)
        self.assertIs(bridge._METHODS["set_transform"], bridge._handle_set_transform)


# --- spawn_actor ----------------------------------------------------------

class SpawnActorTests(_LevelEditTestCase):
    def test_missing_asset_path_raises_value_error(self):
        with self.assertRaises(ValueError):
            bridge._handle_spawn_actor({})

    def test_nonexistent_asset_error_names_exact_path_and_uefn_list_assets(self):
        _unreal.EditorAssetLibrary.does_asset_exist = MagicMock(return_value=False)
        with self.assertRaises(ValueError) as ctx:
            bridge._handle_spawn_actor({"asset_path": "/Game/Nope/Missing"})
        msg = str(ctx.exception)
        self.assertIn("/Game/Nope/Missing", msg)
        self.assertIn("uefn_list_assets", msg)

    def test_happy_path_via_editor_actor_subsystem(self):
        _unreal.EditorAssetLibrary.does_asset_exist = MagicMock(return_value=True)
        _unreal.EditorAssetLibrary.load_asset = MagicMock(return_value=MagicMock(name="asset"))
        fake_actor = _FakeActor(cls_name="StaticMeshActor", location=_FakeVector(1.0, 2.0, 3.0))
        self._set_subsystem(spawn_actor_from_object=MagicMock(return_value=fake_actor))

        result = bridge._handle_spawn_actor({"asset_path": "/Game/Meshes/SM_Rock", "label": "MyRock"})

        self.assertEqual(result["success"], True)
        self.assertEqual(result["label"], "MyRock")
        self.assertEqual(result["class"], "StaticMeshActor")
        self.assertEqual(result["location"], {"x": 1.0, "y": 2.0, "z": 3.0})

    def test_falls_back_to_editor_level_library_when_subsystem_lacks_method(self):
        _unreal.EditorAssetLibrary.does_asset_exist = MagicMock(return_value=True)
        _unreal.EditorAssetLibrary.load_asset = MagicMock(return_value=MagicMock(name="asset"))
        # SimpleNamespace (not MagicMock) so it genuinely lacks
        # spawn_actor_from_object -- a MagicMock would auto-create the
        # attribute and defeat this test.
        _unreal.get_editor_subsystem = MagicMock(return_value=types.SimpleNamespace())
        fake_actor = _FakeActor(label="Legacy", location=_FakeVector(0.0, 0.0, 0.0))
        legacy_spawn = MagicMock(return_value=fake_actor)
        _unreal.EditorLevelLibrary.spawn_actor_from_object = legacy_spawn

        result = bridge._handle_spawn_actor({"asset_path": "/Game/X"})

        self.assertEqual(result["label"], "Legacy")
        legacy_spawn.assert_called_once()

    def test_raises_runtime_error_naming_both_paths_when_neither_available(self):
        _unreal.EditorAssetLibrary.does_asset_exist = MagicMock(return_value=True)
        _unreal.EditorAssetLibrary.load_asset = MagicMock(return_value=MagicMock(name="asset"))
        _unreal.get_editor_subsystem = MagicMock(return_value=types.SimpleNamespace())
        _unreal.EditorLevelLibrary.spawn_actor_from_object = None

        with self.assertRaises(RuntimeError) as ctx:
            bridge._handle_spawn_actor({"asset_path": "/Game/X"})
        msg = str(ctx.exception)
        self.assertIn("EditorActorSubsystem.spawn_actor_from_object", msg)
        self.assertIn("EditorLevelLibrary.spawn_actor_from_object", msg)

    def test_rotator_kwargs_mapped_to_correct_axes(self):
        _unreal.EditorAssetLibrary.does_asset_exist = MagicMock(return_value=True)
        _unreal.EditorAssetLibrary.load_asset = MagicMock(return_value=MagicMock(name="asset"))
        fake_actor = _FakeActor(location=_FakeVector(0.0, 0.0, 0.0))
        self._set_subsystem(spawn_actor_from_object=MagicMock(return_value=fake_actor))
        _unreal.Rotator.reset_mock()

        bridge._handle_spawn_actor({
            "asset_path": "/Game/X",
            "rotation": {"pitch": 1.0, "yaw": 2.0, "roll": 3.0},
        })

        kwargs = _unreal.Rotator.call_args.kwargs
        self.assertEqual(kwargs["pitch"], 1.0)
        self.assertEqual(kwargs["yaw"], 2.0)
        self.assertEqual(kwargs["roll"], 3.0)


# --- duplicate_actor --------------------------------------------------------

class DuplicateActorTests(_LevelEditTestCase):
    def test_missing_actor_label_raises_value_error(self):
        with self.assertRaises(ValueError):
            bridge._handle_duplicate_actor({})

    def test_default_offset_100_100_0_applied_to_copy_location(self):
        source = _FakeActor(label="Widget1", location=_FakeVector(10.0, 20.0, 30.0))
        new_actor = _FakeActor(label="Widget1")
        self._set_subsystem(actors=[source], duplicate_actor=MagicMock(return_value=new_actor))

        result = bridge._handle_duplicate_actor({"actor_label": "Widget1"})

        self.assertEqual(result["location"], {"x": 110.0, "y": 120.0, "z": 30.0})

    def test_new_label_applied_to_copy(self):
        source = _FakeActor(label="Widget1", location=_FakeVector(0.0, 0.0, 0.0))
        new_actor = _FakeActor(label="Widget1")
        self._set_subsystem(actors=[source], duplicate_actor=MagicMock(return_value=new_actor))

        result = bridge._handle_duplicate_actor({"actor_label": "Widget1", "new_label": "Widget1_Copy"})

        self.assertEqual(result["label"], "Widget1_Copy")

    def test_raises_runtime_error_naming_duplicate_actor_when_symbol_missing(self):
        source = _FakeActor(label="Widget1")
        # SimpleNamespace so duplicate_actor is genuinely absent, not just
        # unset on a MagicMock (which would auto-create it).
        subsystem = types.SimpleNamespace(get_all_level_actors=lambda: [source])
        _unreal.get_editor_subsystem = MagicMock(return_value=subsystem)

        with self.assertRaises(RuntimeError) as ctx:
            bridge._handle_duplicate_actor({"actor_label": "Widget1"})
        self.assertIn("EditorActorSubsystem.duplicate_actor", str(ctx.exception))


# --- set_transform -----------------------------------------------------------

class SetTransformTests(_LevelEditTestCase):
    def test_no_components_raises_value_error_mentioning_all_three(self):
        with self.assertRaises(ValueError) as ctx:
            bridge._handle_set_transform({"actor_label": "Widget1"})
        msg = str(ctx.exception)
        for word in ("location", "rotation", "scale"):
            self.assertIn(word, msg)

    def test_location_only_leaves_rotation_and_scale_untouched(self):
        actor = _FakeActor(
            label="Widget1",
            location=_FakeVector(1.0, 1.0, 1.0),
            rotation=_FakeRotator(10.0, 20.0, 30.0),
            scale=_FakeVector(2.0, 2.0, 2.0),
        )
        self._set_subsystem(actors=[actor])

        result = bridge._handle_set_transform({
            "actor_label": "Widget1",
            "location": {"x": 5, "y": 6, "z": 7},
        })

        self.assertEqual(result["after"]["location"], {"x": 5.0, "y": 6.0, "z": 7.0})
        self.assertEqual(result["after"]["rotation"], result["before"]["rotation"])
        self.assertEqual(result["after"]["scale"], result["before"]["scale"])
        self.assertEqual(actor.rotation_calls, [])
        self.assertEqual(actor.scale_calls, [])

    def test_partial_location_dict_merges_with_current_values(self):
        actor = _FakeActor(label="Widget1", location=_FakeVector(1.0, 2.0, 3.0))
        self._set_subsystem(actors=[actor])

        result = bridge._handle_set_transform({
            "actor_label": "Widget1",
            "location": {"z": 50},
        })

        self.assertEqual(result["after"]["location"], {"x": 1.0, "y": 2.0, "z": 50.0})

    def test_result_carries_before_and_after_snapshots(self):
        actor = _FakeActor(
            label="Widget1",
            location=_FakeVector(1.0, 2.0, 3.0),
            rotation=_FakeRotator(4.0, 5.0, 6.0),
            scale=_FakeVector(1.0, 1.0, 1.0),
        )
        self._set_subsystem(actors=[actor])

        result = bridge._handle_set_transform({
            "actor_label": "Widget1",
            "scale": {"x": 2, "y": 2, "z": 2},
        })

        for snapshot_key in ("before", "after"):
            self.assertIn(snapshot_key, result)
            for component in ("location", "rotation", "scale"):
                self.assertIn(component, result[snapshot_key])
        self.assertEqual(result["before"]["scale"], {"x": 1.0, "y": 1.0, "z": 1.0})
        self.assertEqual(result["after"]["scale"], {"x": 2.0, "y": 2.0, "z": 2.0})

    def test_rotator_kwargs_mapped_to_correct_axes(self):
        actor = _FakeActor(label="Widget1", rotation=_FakeRotator(0.0, 0.0, 0.0))
        self._set_subsystem(actors=[actor])
        _unreal.Rotator.reset_mock()

        bridge._handle_set_transform({
            "actor_label": "Widget1",
            "rotation": {"pitch": 1.0, "yaw": 2.0, "roll": 3.0},
        })

        kwargs = _unreal.Rotator.call_args.kwargs
        self.assertEqual(kwargs["pitch"], 1.0)
        self.assertEqual(kwargs["yaw"], 2.0)
        self.assertEqual(kwargs["roll"], 3.0)


# --- _scoped_transaction ----------------------------------------------------

class ScopedTransactionTests(unittest.TestCase):
    def setUp(self):
        self._saved = _unreal.ScopedEditorTransaction

    def tearDown(self):
        _unreal.ScopedEditorTransaction = self._saved

    def test_nullcontext_when_symbol_absent(self):
        _unreal.ScopedEditorTransaction = None
        result = bridge._scoped_transaction("TycoonAgents: Test")
        self.assertIsInstance(result, contextlib.nullcontext)

    def test_nullcontext_when_construction_raises(self):
        _unreal.ScopedEditorTransaction = MagicMock(side_effect=Exception("boom"))
        result = bridge._scoped_transaction("TycoonAgents: Test")
        self.assertIsInstance(result, contextlib.nullcontext)


if __name__ == "__main__":
    unittest.main()
