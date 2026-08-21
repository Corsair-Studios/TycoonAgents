# UEFN native toolset registration: not currently possible from Python

**Snapshot: 2026-08-20.** Measured against one Epic UEFN build via four live
probes run inside UEFN's Python console. This is not a permanent claim about
Epic's roadmap — re-run these probes against a future build before trusting
the conclusion unchanged.

## VERIFIED: this build is hours old

**VERIFIED (user-confirmed):** the machine these probes ran on is on **UEFN
42.00**, which Epic is officially calling **Unreal Engine 6**, released the
night of **2026-08-19/20**. Every probe in this document was run against a
release that was hours old at the time.

That reframes the whole document. Every wall hit below is plausibly a
day-one rough edge of a brand-new major version rather than settled,
long-term Epic policy:

- the dynamic Python lifecycle (`Engine.Python.IsPythonLifeCycleDynamic=True`,
  `IsEnabledByDefault=False`, `IsPythonInRestrictiveMode=True` — Epic's own
  help text calls restrictive mode "still a work in progress");
- third-party `init_unreal.py` no longer auto-running;
- installed builds carrying no `.uplugin` manifests for Epic's own toolset
  plugins;
- the toolset registry accepting a class and then not registering it (see
  the four probes below, and the correction in the "Three-tier registry
  state" section further down).

A document about a day-old major engine release is a snapshot of a moving
target, not a settled read of Epic's intent. The "revisit when Epic
documents this" trigger at the bottom of this file is now much more likely
to fire soon — this is closer to launch-week turbulence than to a
deliberate, stable gate.

## The question

Could Trashbyrd's Power Tools register as a native UEFN toolset — appearing
in Epic's own `list_toolsets`/`call_tool` MCP surface (see
`docs/UEFN-MCP-COMPARISON.md`) — instead of running as a separate stdio MCP
server? If yes, registration would sidestep our server's startup problem
entirely: no separate process, no discovery round trip, tools show up
alongside `EntityToolset` and `DeviceToolset` for free.

**Answer: not currently possible from Python.** Not "impossible" — the API
surface exists and is clearly headed toward third-party use — but every path
tried in this build dead-ends before a registered toolset becomes
discoverable or callable.

## What works

- `import toolset_registry` succeeds.
- `unreal.ToolsetDefinition` and `unreal.ToolsetRegistry` are exposed to
  Python.
- A subclass with `@toolset_registry.tool_call`-decorated static methods can
  be declared and instantiated without error.
- Epic ships a working example at
  `Engine/Plugins/Experimental/ToolsetRegistry/Content/Python/toolset_registry/tests/demo_toolset.py`,
  which documents schema generation from `unreal.ustruct` properties carrying
  `ToolTip`, `ClampMin`, `ClampMax` metadata.

None of this is in question. The registration *API* is real and reachable.

## What does not work

The toolset never becomes discoverable through `list_toolsets`/
`describe_toolset`, and never becomes callable through `call_tool`. The
published schema count returned by the registry stayed pinned at **29**
across every probe, in every configuration tried — declaring the toolset
never moved that number.

## The four probes

### Probe 1 — console-defined toolset

Declared and registered `PythonTypes.TrashbyrdProbeToolset` directly in the
UEFN Python console:

```
LogToolsetRegistry: Display: Registering Toolset PythonTypes.TrashbyrdProbeToolset
TRASHBYRD_PROBE toolset_registry_importable = True
TRASHBYRD_PROBE has_ToolsetDefinition = True
TRASHBYRD_PROBE has_ToolsetRegistry = True
TRASHBYRD_PROBE register_returned = True
TRASHBYRD_PROBE registration_error = None
```

Every signal here reads as success. Then, from *outside* — over MCP, the
same channel Epic's own tools are discovered through:

- `list_toolsets` did **not** include it.
- `describe_toolset` returned `"Toolset 'PythonTypes.TrashbyrdProbeToolset'
  not found."`

The log line and the boolean flags were all attempt-side. The MCP surface
never saw it.

### Probe 2 — registry API surface

Enumerated the registry's own method set: `execute_tool`,
`get_all_toolset_json_schemas`, `is_toolset_class_registered`,
`is_toolset_registered`, `register_toolset_class`, `unregister_toolset_class`.
This is where `is_toolset_class_registered` was found — the one method that,
per Probe 3 below, turned out to tell the truth. Class path for this probe
was `/Engine/PythonTypes.TrashbyrdProbe2`, package `/Engine/PythonTypes`.

### Probe 3 — checking the truthful method

```
TB3 register() = True
TB3 is_toolset_class_registered = False
TB3 schema_count = 29
TB3 trashbyrd_in_schemas = []
TB3 execute_tool = <Object '/Engine/Transient.ToolCallAsyncResultString_0' ...>
```

`register()` still returned `True`. `is_toolset_class_registered()`,
checked immediately after, returned `False` — contradicting it. The schema
count was still 29, and the toolset was absent from the published schema
list. `execute_tool` returned what looked like a live async result object —
during the investigation this was initially misread as evidence the call
had gone through. It had not; see Probe 4.

### Probe 4 — decisive: real module, not console

Hypothesis going in: maybe console-defined classes are second-class, and a
class defined in a real `.py` module (matching how Epic's own toolsets are
presumably built) would register properly. Defined the toolset class in an
actual module file and repeated the sequence:

```
TB4 value =                      (empty)
TB4 error = Toolset not found
TB4 is_complete = True
TB4 module_class_path = /Engine/PythonTypes.TrashbyrdTools_0x947B36E2
TB4 module_register = True
TB4 module_is_registered = False
TB4 schema_count_now = 29
TB4 trashbyrd_in_schemas_now = []
```

Resolving the `execute_tool` async result this time gave the real answer:
`error = "Toolset not found"`, `value` empty. That is what Probe 3's
"successful-looking" async object actually resolves to — it is not evidence
of execution, only evidence that a call was *attempted*.

The module-vs-console hypothesis is also disproven by this probe:
`@unreal.uclass()` places all Python classes under `/Engine/PythonTypes`
with a hash suffix (`TrashbyrdTools_0x947B36E2`) regardless of which module
defined them. There is no console/module distinction at the class-path
level. `module_register = True`, `module_is_registered = False` — same
pattern as every other attempt. Schema count: still 29.

## The false signals

This is the part worth remembering before anyone re-runs this investigation.
Four things looked like success and were not:

1. **`LogToolsetRegistry: Display: Registering Toolset ...` is logged on the
   attempt, not on success.** It fires whether or not registration actually
   takes hold. Do not treat this log line as confirmation of anything.

2. **`register()` returning `True` only means the registry was available —
   not that registration succeeded.** The source, in
   `toolset_registry/registration.py`, is:

   ```
   if not self._registry.is_available():
       return False
   ```

   followed by a loop calling `register_toolset_class` for each tool and
   returning `True` unconditionally at the end. It never checks the outcome
   of `register_toolset_class` — it can only report the negative case
   (registry unavailable), never confirm the positive one.

3. **`execute_tool` returning a `ToolCallAsyncResultString` object looks like
   a live execution handle.** It is returned whether or not the toolset
   exists. Resolving it is required to see the real outcome
   (`error = "Toolset not found"`, empty `value`). This was initially
   misread as success during the investigation, before the result was
   actually resolved.

4. **Only `is_toolset_class_registered()` told the truth.** It returned
   `False` on the very first check across every probe that called it, and
   never once agreed with `register()`'s `True`.

The pattern across all four: every signal on the *declaring* side of the API
is either always-true-on-attempt or unconditionally-true-on-return. The only
signal that reflects reality lives on the *query* side
(`is_toolset_class_registered`, `list_toolsets`, `describe_toolset`,
resolving the async result), and every one of those returned negative, every
time.

## Hypotheses tested and disproven

- **Console-defined vs. module-defined class is the gate.** Disproven by
  Probe 4 — module definition produces the identical failure pattern, and
  `@unreal.uclass()` collapses both into the same `/Engine/PythonTypes`
  namespace regardless of origin.

## What remains unknown

What actually gates registration was not determined. Candidates, explicitly
**unverified**:

- A C++-side allowlist checked at registration time.
- A requirement that the owning class come from a compiled plugin module
  (not pure Python at all), rather than merely living in a `.py` file.
- Per-toolset `Enable` CVars. These are real and precedented — e.g.
  `AutomationTestToolset.Enable`, whose help text reads: "Enable or disable
  AutomationTestToolset registration. When disabled, its tools will not
  appear in the MCP tool list." Whether an equivalent gate exists for
  Python-declared toolsets, and if so what it's named, was not determined.

No probe isolated which of these (or something else entirely) is the actual
gate. Treat all three as leads for a future session, not as findings.

## Independent corroboration: UEFBen/UEFN-MCP-Toolset

**VERIFIED:** a third-party reference repo,
[`github.com/UEFBen/UEFN-MCP-Toolset`](https://github.com/UEFBen/UEFN-MCP-Toolset),
dumps UEFN's built-in toolsets under `UEFN-42.00/NativeToolsets/` — the same
UEFN 42.00 / UE6 build these probes ran on.

**VERIFIED:** that repo documents only built-in Epic toolsets. It contains no
guidance on registering custom or third-party toolsets, no Python-defined
toolset material, and no mention of `init_unreal.py` or the Python lifecycle
described above. **INFERRED:** someone else independently worked this exact
surface — same version, same registry APIs — thoroughly enough to enumerate
every native toolset, and also came up empty on a third-party registration
path. That is corroboration, not proof: absence of a documented path in one
other person's work doesn't rule one out, but it's a second data point
pointing the same direction as our four probes.

**VERIFIED:** its `dump_native_toolsets.py` is purely read-only. It calls
`unreal.load_module()` to force-load 35 known Epic toolset modules first,
then uses `unreal.ToolsetLibrary.get_derived_classes(unreal.ToolsetDefinition)`
to enumerate *all* toolset classes. **This is the enumeration method Probe 2
above looked for and did not find** — our own investigation reported "no
enumeration method found on registry." Record `get_derived_classes` on
`ToolsetLibrary`, paired with pre-loading known toolset modules via
`unreal.load_module()`, as the technique to use if this is revisited.

**VERIFIED:** the repo also calls `registry.is_toolset_class_registered()`,
`get_toolset_json_schema()`, and `get_all_toolset_json_schemas()` — the same
APIs our own probes used (see Probe 2 and Probe 3 above).

## Correction: the gate gates Epic's own toolsets too

**VERIFIED:** across 456 discovered tools, the UEFBen repo reports a
three-tier state, not a simple registered/unregistered split:

- **168 registered** — live and callable.
- **11 filtered** — present in class schemas but deliberately excluded from
  the live registry.
- **277 unregistered** — from classes that are not registered in the runtime
  registry, though many have valid schemas.

**VERIFIED, and this is the important part:** this affects Epic's *own*
toolsets, not just third-party ones. 34 native `UToolsetDefinition` classes
are unregistered, and `GameplayTagsToolset` has 8 tools in its schema but
only 4 registered.

**This corrects an inference earlier in this document.** The framing above
(see "What remains unknown") floated a C++-side allowlist or a
compiled-plugin requirement as if the gate specifically targeted third-party
/ Python-declared classes — a lockout aimed at outsiders. That framing is
probably wrong. Our probes' `is_toolset_class_registered = False` is the
*same state* 34 of Epic's own native classes are sitting in, per the
UEFBen data. There is evidently a general filtering layer between "class
exists with a valid schema" and "tool is live in the registry," and it gates
Epic's own classes too — so our observed behavior is not, by itself,
evidence of a deliberate third-party-specific lockout.

**Keep this honest, both directions:** this does *not* mean third-party
toolset registration works, or that it will if retried. Every probe in this
document still failed, and nothing here reopens that question. What it
means is that our stated *reason* for the failure was probably wrong, and
the mechanism is less clearly a deliberate exclusion-of-outsiders than this
document previously implied. **What actually drives that filtering layer
remains UNKNOWN** — the UEFBen repo explicitly does not explain
registered-vs-filtered-vs-unregistered either, and neither do we. The C++
allowlist, compiled-plugin, and per-toolset `Enable`-CVar candidates listed
under "What remains unknown" above are still unverified leads, now joined by
a fourth: whatever filters 34 of Epic's own native classes might be the same
mechanism, but that link itself is INFERRED, not confirmed.

## What was also ruled out: the Editor Preferences panel

Editor Preferences → Plugins → "MCP Toolset Servers" was checked as a
possible manual-registration path. It expects a `Server Url` with an
HTTP/SSE transport — the observed transport value was "Legacy SSE
(HTTP+SSE)". Our server is stdio. No evidence was found that stdio is
supported through this panel. Its `MCPServers` array had never been
populated on the test machine, so its persisted config format could not be
observed either — this remains an open gap, not a confirmed dead end, but
the transport mismatch alone makes it an unlikely path for a stdio server.

## Why this was worth trying, and when to revisit

UEFN moved Python to a dynamic lifecycle in this build:

- `Engine.Python.IsPythonLifeCycleDynamic=True` — "python will not be
  initialized on boot".
- `Engine.Python.IsEnabledByDefault=False` — "must be set prior to
  OnPostEngineInit".
- `Engine.Python.IsPythonInRestrictiveMode=True` — "still a work in
  progress".

Native toolset registration would have sidestepped our startup problem
entirely — no dependency on when or whether Python initializes, no separate
process to launch and keep alive. That's why it was worth four probes.

Revisit when Epic documents third-party toolset registration, or ships a
`.uplugin` example that registers a toolset from outside `Engine/Plugins/`.
The API surface already exists (`toolset_registry`, `ToolsetDefinition`,
`ToolsetRegistry`, the `@tool_call` decorator, Epic's own working
`demo_toolset.py`) and is clearly intended for this eventually — it just
isn't reachable from ordinary Python today.

## Bottom line

Four independent attempts, two hypotheses, one consistent result: the
toolset registry accepts a Python-declared class without error, but nothing
declared this way ever becomes visible to `list_toolsets`,
`describe_toolset`, or `call_tool`, and the published schema count never
moves off 29. Every "it worked" signal along the way (`register()`, the
`Registering Toolset` log line, the `execute_tool` return object) is either
attempt-side or unconditional. Only the query-side checks tell the truth,
and all of them said no. Power Tools stays a separate stdio MCP server for
now.
