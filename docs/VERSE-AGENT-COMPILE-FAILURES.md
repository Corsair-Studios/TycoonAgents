# Verse Agent Reliability — Compile-Failure Repro Notes

Evidence for improving the Verse-authoring agents (`verse-expert`,
`uefn-auditor`) and the `uefn` skill. Observed while building two Verse
devices in the `StarWars` UEFN project on 2026-07-27:
`gamestart_cinematic_device.verse` and `emperor_walk_device.verse`.

**Scope:** this is about agent/skill guidance, not the Task tool. See
[DELEGATION-ISSUES.md](DELEGATION-ISSUES.md) for the separate delegation
reliability problems.

## Summary

Across three build cycles, agent-authored Verse failed to compile **11 times**
in two files. Every failure fell into one of five categories, all of which are
statically detectable and none of which were caught by the existing review
gate.

Worse: in UEFN, a failed Verse compile is not benign. It triggers an engine
rollback path that infinitely recurses and **crashes the editor**
(`SemanticAnalyzer.cpp:9320`, stack overflow → `0x80000003`). The user hit a
crash loop twice. So a non-compiling file is not a cheap mistake to iterate
on — it costs an editor restart each time.

## Root cause (agent guidance, fixable here)

The agents verified **API existence** against the installed digest and
correctly concluded the methods they called were real. What they did not
verify was **compilability** — imports, effect specifiers, module resolution,
and parameter conventions. The review gate inherited the same blind spot and
reported PASS on files that could not compile.

## The five failure categories

### 1. Module resolution depends on the new file's directory depth

Hit twice in one file (errors 3506 `Unknown identifier GameInit` /
`main_game_globals`).

`using { GameInit }` resolves correctly from
`Content/Gorillas/Framework/GameSystems/*.verse`, so the agent copied it into
a new file at `Content/` root, where it does **not** resolve. From root the
correct reference is the fully-qualified
`Gorillas.Framework.GameInit.main_game_globals`.

**Rule to add:** when creating a *new* Verse file, derive module paths from
the target file's own directory. Never copy a `using` block verbatim from a
reference file at a different depth. Confirm by checking whether any existing
file *at the same depth* uses that import.

### 2. Comparison operators are failable and cannot be bound with `:=`

Produced 3 of 8 errors in one build (error 3512, `decides` effect).

```verse
# WRONG — >= carries the 'decides' effect
HasCooledDown := (Now - LastPlayedTime) >= CooldownSeconds
IsFirstTrigger := LastPlayedTime = 0.0

# RIGHT — evaluate inside a failure context
var MayPlay : logic = false
if (LastPlayedTime <= 0.0):
    set MayPlay = true
else if ((Now - LastPlayedTime) >= CooldownSeconds):
    set MayPlay = true
```

**Note:** `verse-common-errors.md` *already documents this* (§3 Failure
contexts, and the lookup table at ~line 365). The reference was not the gap —
see "The highest-value fix" below.

### 3. Map/array writes by key are failable

Same family as #2; caused 2 errors in `gamestart_cinematic_device.verse`.

```verse
# WRONG
set MyMap[Key] = Value

# RIGHT — project idiom, used in 7 places in illest_global_ui_manager.verse
if:
    set MyMap[Key] = Value
```

### 4. Missing `using` for the module that owns a verified symbol

Errors 3506: `Unknown member GetFortCharacter in agent`, `Unknown identifier
MakeNavigationTarget`.

Both symbols were correctly located in `Fortnite.digest.verse`, and both were
called without importing their owning module — `/Fortnite.com/Characters` and
`/Fortnite.com/AI` respectively.

**Rule to add:** after locating a symbol in the digest, walk backwards to its
enclosing `module` declaration and add the corresponding `using`. Finding the
signature is necessary but not sufficient.

Same class of error: `Print` requires
`using { /UnrealEngine.com/Temporary/Diagnostics }`.

### 5. Double-wrapped optional parameters

Error 3509, type mismatch on `npc_spawner_device.SpawnAt`.

```verse
# Signature: SpawnAt(Position:vector3, ?Rotation:?rotation)<suspends>:?agent

# WRONG — the ? prefix already denotes optional
EmperorSpawner.SpawnAt(Pos, ?Rotation := option{FacingRotation})

# RIGHT
EmperorSpawner.SpawnAt(Pos, ?Rotation := FacingRotation)
```

## Structural finding: the review gate over-reports confidence

The `uefn-auditor` pass verified device signatures against the live digests
and returned PASS on files that then failed to compile — twice. That is not
the auditor being wrong; signature verification is genuinely what it did. The
problem is that the result was reported upstream as "verified," which the
orchestrator relayed to the user as stronger assurance than it was.

**Suggested change:** have the auditor state explicitly what it did and did
not check — e.g. *"Verified: API existence and signatures against digest. NOT
verified: imports, effect specifiers, module resolution, compilability. Only a
UEFN build confirms this compiles."* This costs nothing and prevents the
orchestrator from overstating confidence.

## Orchestrator-side failures (not the sub-agents)

Two of the failures in this session originated with the orchestrator, not the
Verse agents. They are worth recording because the fixes are behavioural and
cost nothing to adopt.

**1. Guessing at compile errors instead of asking for them.** When the user
reported "two errors in the file," the orchestrator inferred likely causes
from the code and fixed two plausible-but-wrong things (a missing `Print`
import, a suspect `<transacts>` specifier), then reported them as the fixes.
The user came back with the actual compiler output — two `decides`-effect
errors on map writes at specific lines — and the real fix took two minutes.

*Rule:* when a compile fails, ask for the verbatim error text and line numbers
before editing. Never infer which errors the compiler reported. A user saying
"there are N errors" is not a description of *which* errors.

**2. Category 5 was orchestrator-authored, not agent-authored.** The
double-wrapped `?Rotation := option{...}` was hand-written by the orchestrator
directly from the digest signature, without applying the optional-parameter
convention. The categories in this report are failure *modes*, not an
indictment of the sub-agents specifically — the orchestrator is subject to
every one of them and made two of them itself.

*Rule:* the orchestrator's direct edits deserve the same checks it demands of
sub-agents. "Small enough to do inline" is not "exempt from the rules."

**3. Relaying agent PASS as verification.** The orchestrator twice told the
user that changes were "verified" on the strength of an auditor PASS, then had
to walk it back when the build failed. Reading the file on disk confirms the
edit *landed*; it does not confirm it *compiles*. Those are different claims
and were reported as one.

*Rule:* state the verification actually performed. "Written and
signature-checked, not compiled" is accurate and sets the right expectation
when the only real gate is a UEFN build the orchestrator cannot run.

## The highest-value fix

**The reference already covers several of these; the agents did not reliably
read it.**

`verse-common-errors.md` is 1,427 lines and lives at:

```
<project>/Content/.claude/skills/uefn/verse-common-errors.md
```

It already documents category 2 explicitly, including the exact error string
(`"This invocation calls a function that has the 'decides' effect..."`) and a
lookup table row for `Map[k]` / `Array[i]`.

The agent briefs said to read *"verse-common-errors.md in the uefn skill
folder."* That prose path does not resolve unaided — a `find` for it under
`~/.claude` returns nothing, because the file lives under the **project's**
`.claude/skills/`, not the user's. Agents that could not locate it proceeded
silently rather than reporting the miss.

**Recommendations, in priority order:**

1. **Inject the absolute, resolved path** to `verse-common-errors.md` into the
   agent prompt rather than referring to it by name.
2. **Inline the top ~10 rules** directly into the `verse-expert` /
   `uefn-auditor` system prompts, so correctness does not depend on a
   successful file read.
3. **Make an unreadable reference a hard failure** — an agent that cannot open
   its stated reference should say so, not continue.
4. **Add categories 1, 4, and 5** to `verse-common-errors.md`; they are not
   currently covered.
5. **Add a UEFN-specific warning**: a failed Verse compile can crash the
   editor via the rollback path, so "just try it and see" is expensive.
   Agents should treat compile correctness as high-stakes.

## Environment

- UEFN / Fortnite `++Fortnite+Release-41.20-CL-55550516`, UE 5.8.0
- Digests at
  `%LOCALAPPDATA%\UnrealEditorFortnite\Saved\VerseProject\StarWars\{Fortnite,Verse,UnrealEngine}\*.digest.verse`
- Crash logs:
  `%LOCALAPPDATA%\UnrealEditorFortnite\Saved\Crashes\UECC-Windows-{0879EBF3...,F96D33BE...}`
- Project: `StarWars` UEFN island (48,087 project assets, ~27k Verse surfaces)
