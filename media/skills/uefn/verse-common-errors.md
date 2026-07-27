<!-- version: 4.1.0 -->
<!-- changelog: 4.1.0 adds rules 20-22 (module-path depth, digest-verified-but-missing-using,
     double-wrapped optionals), a compile-failure stakes warning, and the verse_lint.py
     pointer — sourced from docs/VERSE-AGENT-COMPILE-FAILURES.md (11 real errors, one
     UEFN project, 2026-07-27). Additive only; no prior content changed. -->
# Verse Common Errors — Pre-Flight Reference

## Why this file exists

Verse is scarce in LLM training data. Models pattern-match to C#, Python,
TypeScript, and Blueprint, then hallucinate APIs, keywords, and syntax that do
not exist in Verse. Real UEFN forum reports describe Copilot as "more harmful
than helpful when programming verse" with "no idea about any of the UEFN
libraries and functions."

**Prime directive: verify every API against the digest files before writing
it. Never write an API from memory.**

## A failed compile is not benign — treat correctness as high-stakes

**Observed in one UEFN project:** a failed Verse compile can trigger an
engine rollback path that infinitely recurses and **crashes the editor**
(stack overflow in `SemanticAnalyzer.cpp:9320`). The creator hit this crash
loop twice in one session. That means "just try it and see if it compiles"
is not a cheap iteration strategy here — each non-compiling file can cost a
full editor restart, not just a red error in the output log. Verify imports,
module paths, and parameter conventions *before* triggering a build, not
after.

## How this file is sourced

Every claim below is reconciled against Epic's official documentation
(dev.epicgames.com/documentation/en-us/fortnite/) and the community-maintained
**Book of Verse** (verselang.github.io/book) — Epic's own Verse topic pages
now explicitly point readers to the Book of Verse as a deeper reference.
Epic describes it as tracking "the head of the main development branch,"
with the caveat that some of its content may predate an official Epic
release. Anything neither source could confirm is listed under
[Uncertain](#uncertain--verify-before-relying-on) rather than stated as fact.
**The project's digest files override this file in every case** — see
[Digest files = ground truth](#digest-files--ground-truth) below.

## TOP 5 MOST FREQUENT ERRORS — CHECK THESE FIRST

**These errors occur in almost every implementation. Always verify you haven't
made them before considering a change done.**

| # | Error | Symptom | Solution |
|---|-------|---------|----------|
| **1** | Missing `using` statement | `Unknown member 'X' in 'player'` | Add `using { ModuleName }` for extension methods — see [rule 11](#11-unknown-member-missing-using-statement) |
| **2** | Public accessor, non-public class | `Definition X is accessible universally, but depends on Y...` | Add `<public>` to the class being returned — see [visibility errors](#public-accessor-depends-on-a-non-public-class) |
| **3** | Custom event `Subscribe` | `Unknown member 'Subscribe' in 'event(T)'` | Use `Await()` in an async loop, not `Subscribe()` — see [event Subscribe vs Await](#event-subscribe-vs-await) |
| **4** | Public member, non-public type | Same as #2, but for structs/enums | Add `<public>` to the struct/enum used by the public member — see [visibility errors](#public-member-depends-on-a-non-public-type) |
| **5** | Logic comparison in `if` | `no_rollback effect not allowed` after `if (X = true):` | Use `if (X?):` instead of `if (X = true):` — see [no_rollback effect errors](#if-x-equals-true-triggers-a-no_rollback-error) |

**STOP and check: did you make any of these?**

## Quick Reference by Category

### Syntax Errors
- [`@editable` attribute](#9-editable-attribute) — single-line `@editable{ToolTip := X}`, not a multi-line block; `ToolTip` needs a `<localizes>` message, not a raw string
- [Concurrency / spawn syntax](#7-concurrency) — `spawn{}` uses braces; `sync:`/`race:`/`rush:`/`branch:` use colon blocks
- [Arrays and maps](#6-arrays-and-maps-indexing-is-failable) — `%` modulo does not exist, use `Mod[...]`
- [String interpolation](#16-string-interpolation-not-concatenation) — `{var}`, not `+` concatenation
- [Struct literals](#15-struct-literals-struct-scope-and-failable-struct-fields) — field init uses `:=`, not `=` (Epic: editable-properties-in-verse)

### Effect System Errors
- [Failure contexts](#3-failure-contexts) — failable operations need a failure context
- [`<suspends>` is mandatory](#2-suspends-is-mandatory) — functions that `Sleep`/`Await` must be marked `<suspends>`
- [`no_rollback` called from `<transacts>`](#called-from-a-transacts-context) — `<transacts>` can only call transaction-safe functions
- [`if (X = true)` causes `no_rollback` error](#if-x-equals-true-triggers-a-no_rollback-error) — use `if (X?)` instead
- [Failable expression in struct literal](#15-struct-literals-struct-scope-and-failable-struct-fields) — compute failable values first

### Type System Errors
- [Event with multiple type parameters](#event-with-multiple-type-parameters) — use `event(tuple(a, b))`, not `event(a, b)`
- [Event Subscribe vs Await](#event-subscribe-vs-await) — custom `event(T)` uses `Await()`, not `Subscribe()`
- [No `ToString` for a custom enum](#no-tostring-overload-for-a-custom-enum) — define `ToString()` before using an enum in string interpolation
- [`class<concrete>` instantiation at module level](#class-concrete-instantiation-at-module-level) — cannot instantiate outside a runtime context
- [Incompatible parameter types](#18-incompatible-parameter-types) — a `tuple()` is not a substitute for the expected plain type (e.g. `agent`)

### Visibility / Access Errors
- [Public member depends on a non-public type](#public-member-depends-on-a-non-public-type) — custom types used by public members must be `<public>`
- [Public accessor depends on a non-public class](#public-accessor-depends-on-a-non-public-class) — singleton-getter pattern
- [Ambiguous identifier across files](#13-ambiguous-identifier-across-files) — prefix identifiers uniquely

### Import / Using Errors
- [Unknown member — missing `using`](#11-unknown-member-missing-using-statement) — extension methods need the defining module imported
- [Module path depends on the new file's directory depth](#20-module-path-depends-on-the-new-files-directory-depth) — never copy a `using` block from a reference file at a different depth
- [Finding a symbol in the digest is not enough — you still need its owning `using`](#21-finding-a-symbol-in-the-digest-is-not-enough) — walk backwards from the symbol to its enclosing `module`

### Naming / Scope Errors
- [Local variable name conflicts with a module name](#14-local-variable-name-conflicts-with-a-module-name) — avoid `VFX`/`SFX`/`UI`/`Assets`/`Materials`/`Textures` as variable names
- [Unknown identifier — scope issues](#12-unknown-identifier-scope-issues) — declare variables before conditional use
- [`pass` does not exist](#unknown-identifier-pass) — Python-ism, not valid Verse (unconfirmed — see Uncertain)
- [Reserved identifier `_`](#reserved-identifier-_) — no underscore placeholder in `for`/patterns; IS valid as a `case` wildcard

### Failable / Optional Handling
- [Square brackets vs parentheses](#call-style-square-brackets-vs-parentheses) — `[]` for failable, `()` for always-succeed
- [Failable conversions vs optional returns](#failable-conversions-vs-optional-returns) — the two look similar but need different handling
- [Unsafe array access](#17-unsafe-array-access-patterns) — `..` ranges are inclusive; iterate `0..Array.Length - 1`, or prefer `for (Element : Array)`
- [Double-wrapped optional parameters](#22-double-wrapped-optional-parameters) — `?Param := Value`, not `?Param := option{Value}`

## Things that DO NOT EXIST in Verse

### `null`

Verse has no `null`. Use option types (`?T`).

```verse
# WRONG
var Target : ?agent = null

# RIGHT
var Target : ?agent = false   # false is the empty option
```

### Exceptions — `try` / `catch` / `throw`

Verse has no exceptions. Use failure contexts and the `<decides>` effect.

```verse
# WRONG
try:
    DoRiskyThing()
catch(Err):
    Print("failed")

# RIGHT
if (DoRiskyThing[]):
    Print("succeeded")
else:
    Print("failed")
```

### Idioms borrowed from other languages

LINQ, list comprehensions, `async`/`await` as keywords, `foreach`, `switch`,
ternaries, Python's `pass` — none exist as such. Use the Verse equivalent.

```verse
# WRONG (LINQ-style)
Result := Items.Where(X => X > 0).Select(X => X * 2)

# RIGHT (for-loop with filter)
Result := for (Item : Items, Item > 0):
    Item * 2
```

```verse
# WRONG (foreach)
foreach (Item in Items):
    Print("{Item}")

# RIGHT
for (Item : Items):
    Print("{Item}")
```

```verse
# WRONG (switch)
switch (Value):
    case 1: DoA()
    case 2: DoB()

# RIGHT (case expression)
case (Value):
    1 => DoA()
    2 => DoB()
    _ => DoDefault()
```

### Invented `creative_device` methods and `using` paths

Do not invent method names on `creative_device` or plausible-looking `using`
paths (e.g. a guessed `/Fortnite.com/Something`). Confirm both against the
digest before writing them.

### Unknown identifier `pass`

**Error message:** `Unknown identifier 'pass'.` (community-reported; not
independently confirmed against Epic's docs this pass — see
[Uncertain](#uncertain--verify-before-relying-on).)

`pass` is a Python keyword meaning "do nothing." Verse has no equivalent
keyword, and — unlike Python — does not require a statement in every block,
so there's rarely a need to reach for one.

```verse
# WRONG — pass is not valid Verse:
if (SomeCondition?):
    pass  # Error: Unknown identifier

# RIGHT — remove the empty block, or restructure so it isn't needed:
if (SomeCondition?):
    0  # if a placeholder expression is truly unavoidable
```

### Reserved identifier `_`

**Error message:** `Cannot use reserved identifier '_' as definition name.`
(Book of Verse §01 Expressions.)

Unlike Python or Rust, Verse does not allow `_` as a general "unused
variable" placeholder — for example, in `for` loops or destructuring, you
cannot bind a value to `_` as a definition name.

```verse
# WRONG — underscore is reserved as a definition name:
for (Index -> _ : MyArray):
    DoSomething(Index)

# RIGHT — use a named variable even if unused
for (Index -> Item : MyArray):
    DoSomething(Index)   # Item is unused, that's fine — Verse doesn't warn
```

**Exception: `_` IS valid as a wildcard pattern inside a `case` expression**
(matching "anything else"), which is a different role than a definition
name:

```verse
# RIGHT — '_' as a case wildcard, not a definition name:
case (Value):
    1 => DoA()
    2 => DoB()
    _ => DoDefault()
```

## Call style: square brackets vs parentheses

This is one of the most common LLM mistakes in Verse: mixing up brackets and
parentheses changes the call's failure semantics, and the compiler treats it
as a hard error, not a style choice.

- `Function[...]` — brackets. Used for calls that CAN FAIL (`<decides>`
  effect) — must appear in a failure context (see the compile-error rules
  below).
- `Function(...)` — parentheses. Used for calls that ALWAYS SUCCEED.

| Function | Call style | Why |
|---|---|---|
| `Floor(X)` | `()` | Always succeeds |
| `Ceil(X)` | `()` | Always succeeds |
| `Round(X)` | `()` | Always succeeds |
| `Abs(X)` | `()` | Always succeeds |
| `Volume.IsInVolume(Agent)` | `()` | Regular method call, always succeeds |
| `Mod[X, Y]` | `[]` | Can fail (division by zero) |
| `Array[Index]` | `[]` | Can fail (index out of bounds) |
| `Map[Key]` | `[]` | Can fail (key not found) |
| `MakeUnitVector[Vec]` | `[]` | Can fail (zero-length vector) |
| `GetPlayer[PlayerIndex]` | `[]` | Can fail (player not found) |

**The general `[]`-failable / `()`-always-succeeds RULE is confirmed, and
`Array[Index]` and `Mod[X, Y]` are individually confirmed against Epic's
docs. The other individual per-function entries above (`Floor`, `Ceil`,
`Round`, `Abs`, `Map[Key]`, `MakeUnitVector[]`, `GetPlayer[]`) are
community-reported and were not independently verified this pass — check
each against the digest before relying on it.**

When in doubt, check the digest signature for `<decides>` — that decides the
brackets, not convention.

**Real compiler error strings for a bracket/parenthesis mismatch:**

- `This call uses square brackets to call a function that does not have the 'decides' effect`
- `This invocation calls a function that has the 'decides' effect, which is not allowed by its context`

```verse
# WRONG — Floor always succeeds; brackets wrongly imply it can fail:
Result := Floor[Value / 10]

# RIGHT — Floor uses parentheses:
Result := Floor(Value / 10)

# WRONG — Mod can fail; parentheses wrongly imply it always succeeds:
Result := Mod(Value, 10)

# RIGHT — Mod needs brackets plus a failure context/fallback:
Result := Mod[Value, 10] or 0
```

### The `or` fallback works only on assignment, not on `set`

```verse
# Valid — ':=' is itself a failure context, 'or' supplies the fallback
Index := Mod[Value, 10] or 0
Element := Array[0] or DefaultValue

# INVALID — 'or' on the RHS of 'set' is NOT a failure context
set Index = Mod[Value, 10] or 0   # does not compile

# Correct form for 'set'
if (NewIndex := Mod[Value, 10]):
    set Index = NewIndex
else:
    set Index = 0
```

## Failable conversions vs optional returns

**This is a common source of errors. These two patterns look similar but
require DIFFERENT handling — this is the definitive version of the rule; if
anything elsewhere in this file seems to disagree, this section wins.**

### Failable conversions must stay inside `if`

Functions/conversions with the `<decides>` effect (called with `[]` brackets)
**require a failure context**. The `if` condition IS that failure context —
do not extract them into a separate line first.

```verse
# CORRECT — failable conversion inside if:
if (CustomPlayer := GetCustomPlayer(player[Agent])):
    CustomPlayer.DoSomething()

# CORRECT — chained failable operations:
if (Player := player[Agent], Character := Player.GetFortCharacter[]):
    Character.DoSomething()

# WRONG — extracting a failable conversion breaks it:
MaybePlayerData := GetPlayerData(player[Agent])  # ERROR: player[] needs a failure context!
if (PlayerData := MaybePlayerData?):
    PlayerData.DoSomething()
```

**Common failable conversions (keep inside `if`):**

| Conversion | Why |
|---|---|
| `player[Agent]` | Agent might not be a player |
| `GetFortCharacter[]` | Player might not have a character |
| `Array[Index]` | Index might be out of bounds |
| `Map[Key]` | Key might not exist |

### Optional returns can be extracted

Functions returning optional types (like `?device`, `?transform`) can be
extracted first, because the function call itself always succeeds — it just
returns an optional value that you unwrap separately.

```verse
# CORRECT — optional return extracted, then checked:
MaybeTransform := GetCollisionManager().GetCollisionPoint(Position)  # Returns ?transform
if (Transform := MaybeTransform?):
    UseTransform(Transform)

# ALSO CORRECT — optional field access:
MaybePowerup := PlayerData.ActiveItem  # ActiveItem is ?player_item
if (Powerup := MaybePowerup?):
    Powerup.OnUsed(Agent)
```

### The compile error when you skip the `?` on an optional-returning function

**Error message:** `Expected an expression that can fail in the 'if' condition
clause(3513)`

This is the concrete error that motivates the distinction above: writing
`if (X := F()):` where `F()` returns an optional (`?T`) rather than a
`<decides>` function does not automatically unwrap it — the `if` condition
needs something that can actually fail, and a plain binding to an optional
value isn't that.

```verse
# WRONG — GetRandomDevice returns ?device_type, so the if never unwraps it:
if (Device := GetRandomDevice(Source)):   # Error 3513
    Device.Activate(Player.Player)

# RIGHT — extract first, then unwrap the optional with '?':
Device := GetRandomDevice(Source)
if (Device?):
    Device.Activate(Player.Player)

# ALSO RIGHT — unwrap inline with '?':
if (Device := GetRandomDevice(Source)?):
    Device.Activate(Player.Player)
```

### How to tell the difference

| Pattern | Type | Handling |
|---|---|---|
| `player[X]`, `Array[i]`, `Map[k]` | Failable (`<decides>`) | Keep inside `if` |
| `Function[...]` with brackets | Failable (`<decides>`) | Keep inside `if` |
| `var Field : ?type` | Optional field | Can extract, check with `?` |
| `Function(...) : ?type` | Optional return | Can extract, check with `?` |

### Mixed patterns

When one expression combines both a failable conversion and an optional
value, keep the failable part inside the `if` and chain the optional unwrap:

```verse
# Failable player[] must stay in if, but optional ActiveItem can be chained:
if (PlayerData := GetPlayerData(player[Agent])):
    if (Powerup := PlayerData.ActiveItem?):  # ActiveItem is optional, extracted here
        Powerup.OnUsed(Agent)
```

## The compile-error rules

### 1. `set` is required to mutate

```verse
# WRONG — does not compile
var Score : int = 0
Score += 1

# RIGHT
var Score : int = 0
set Score += 1
```

- `=` initializes/defines a value.
- `:=` defines with an inferred type — common in `if`/`for` clauses.
- `set` mutates an existing `var`.

### 2. `<suspends>` is mandatory

Any function that calls `Sleep()`, `Await()`, or another `<suspends>`
function must itself be marked `<suspends>`. Omitting it is a hard compile
**error**, not a warning. `<decides>` and `<suspends>` cannot be combined on
the same function.

```verse
# WRONG — missing <suspends>, will not compile
DoDelayedThing()<computes> : void =
    Sleep(1.0)
    Print("done")

# RIGHT
DoDelayedThing()<suspends> : void =
    Sleep(1.0)
    Print("done")
```

If a `<suspends>` operation needs to run from a non-suspending context, break
it into a separate function and fire it with `spawn`:

```verse
spawn{HandleComplexOperationAsync(Agent, Data)}

HandleComplexOperationAsync(Agent : agent, Data : type)<suspends>:void=
    # Complex logic here
```

### 3. Failure contexts

Failable expressions — array/map indexing (`Arr[I]`, `Map[Key]`),
comparisons, `<decides>` calls — must appear inside `if`, a `for`
filter/iteration clause, `not`, or the left side of `or`. Forgetting this
produces the single most common Verse error:

> **"This expression can fail so it must appear in a failure context."**

```verse
# WRONG
Value := Arr[Index]
Print("{Value}")

# RIGHT
if (Value := Arr[Index]):
    Print("{Value}")
```

### 4. Effect specifiers

- `<computes>` — pure, cannot fail, cannot suspend.
- `<decides>` — can fail (must be called from a failure context).
- `<transacts>` — failable AND rollback-safe (side effects undo on failure).
- `<suspends>` — yields across frames (calls `Sleep`/`Await`/other `<suspends>`).
- `<varies>` — result may differ between calls even with the same inputs.
- No specifier at all — defaults to `no_rollback`: not transaction-safe, not
  guaranteed to fail cleanly. See the [no_rollback effect errors](#no_rollback-effect-errors)
  section — this default is the root cause of two of the most common errors.

Pick the weakest specifier that's still true; the compiler enforces it at
every call site.

### 5. Options, not null

```verse
# Declaring
MaybeValue : ?int = option{42}
Empty : ?int = false

# Unwrapping a variable already in hand — must be a failure context
if (X := MaybeValue?):
    Print("{X}")
```

An empty device-typed optional is also `false`, not `null` or an empty
constructor:

```verse
MyDevice : ?creative_prop = false
```

**`option{}` with no argument is commonly reported as invalid** — treat
`false` as the reliable way to spell "empty optional" regardless (that part
IS confirmed). Whether `option{}` with zero arguments specifically fails to
compile was not independently confirmed against Epic's docs or the Book of
Verse this pass — see [Uncertain](#uncertain--verify-before-relying-on).

```verse
# UNVERIFIED — option{} with no argument is commonly reported to fail:
Empty : ?int = option{}

# CONFIRMED RIGHT — false IS the empty option; use option{Value} only when you have a value
Empty : ?int = false
Full : ?int = option{42}
```

Device types can't be constructed with empty braces either — `creative_prop{}`
is invalid; a device reference is either populated by the editor/engine or is
the empty optional `false`.

**Optional types can't have methods called on them directly — unwrap first:**

```verse
# WRONG — Play() called directly on an optional
OptionalDevice.Play()

# RIGHT — unwrap with '?' inside a failure context, then call the method
if (Device := OptionalDevice?):
    Device.Play()
```

See [Failable conversions vs optional returns](#failable-conversions-vs-optional-returns)
above for the full rule on when a value can be extracted before unwrapping
versus when it must stay inside the `if`.

### 6. Arrays / maps — indexing is FAILABLE

```verse
Nums : []int = array{1, 2, 3}
Lookup : [string]int = map{"a" => 1, "b" => 2}

# WRONG
First := Nums[0]

# RIGHT
if (First := Nums[0]):
    Print("{First}")
```

**Map keys must be simple comparable types** (e.g. `int`, `string`) — not
device objects:

```verse
# WRONG — a device object is not a valid map key:
var DeviceMap : [volume_device]state = map{}

# RIGHT — key by a simple comparable type instead:
var DeviceMap : [int]state = map{}
# Track devices by index, alongside a parallel array of the devices
# themselves (see the @editable parallel-arrays pattern below).
```

**The `%` modulo operator does not exist.** Use `Mod[...]` (which is
failable — see the bracket rule above). Integer division (`/`) also returns
`rational`, not `int`, so it can't substitute for modulo either — this trips
up hand-rolled modulo via multiply-and-subtract:

**Error message:** `No overload of operator'*' matches arguments
(:rational,:type{N})`

```verse
# WRONG — '/' returns rational, not int; rational * int does not compile:
DivisionResult : int = Counter / ArrayLength   # actually a rational!
Result : int = Counter - (DivisionResult * ArrayLength)   # FAILS — the error above
```

```verse
# RIGHT — use Mod[] instead of hand-rolling modulo:
Index := Mod[Value, 10] or 0
```

**Why `Mod` uses brackets:** `Mod` is failable — modulo by zero would fail —
so it must be called with `[]` and used in a failure context (see the
bracket rule above), never plain `()`. (`%` does not exist; `Mod` is the
official replacement — dev.epicgames.com/documentation/en-us/fortnite/
verse-api/versedotorg/verse/mod.) The literal `<decides>` specifier text
shown in some community write-ups of `Mod`'s declaration was not
independently confirmed against Epic's API page this pass — the behavior
(failable, bracket call) is confirmed regardless of the exact specifier
spelling.

```verse
# Ring-buffer pattern
NextIndex := CurrentIndex + 1
if (WrappedIndex := Mod[NextIndex, BufferSize]):
    set CurrentIndex = WrappedIndex
else:
    set CurrentIndex = 0
```

### 7. Concurrency

- `spawn{...}` — fire-and-forget task. Takes a **brace** block.
- `sync:` — run branches concurrently, wait for ALL. Takes a **colon**
  block.
- `race:` — run branches concurrently, first to finish wins, others cancel.
  Takes a **colon** block.
- `rush:` — run branches concurrently, resolves on the first branch to
  fail (or succeeds if all do). Takes a **colon** block.
- `branch:` — run concurrently without waiting. Takes a **colon** block.

(Book of Verse §14 Concurrency.) `spawn` is the odd one out: it takes a
brace block, not a colon-indented block. The other four concurrency forms —
`sync`, `race`, `rush`, `branch` — DO use colon-indented blocks, like `if`
and `for`. Don't over-generalize the `spawn` brace rule onto them.

```verse
# WRONG — spawn does not take a colon block:
spawn:
    MyFunction()

# RIGHT — spawn takes a brace block:
spawn{MyFunction()}

# RIGHT — sync/race/rush/branch take colon blocks:
sync:
    TaskA()
    TaskB()
```

**Multiple spawn calls** each get their own `spawn{}` block on a separate
line — not a `spawn:` block per call, and not multiple calls crammed into one
`spawn{}`:

```verse
# WRONG
spawn:
    Function1()
spawn:
    Function2()

# RIGHT
spawn{Function1()}
spawn{Function2()}
```

A `no_rollback`-effect call is not allowed directly in some contexts — wrap
it in `spawn{}` instead of calling it inline:

```verse
spawn{MyDevice.Activate()}
```

### 8. `for` loops

```verse
# Counted range
for (I := 0..N-1):
    Print("{I}")

# Iterate a collection with index
for (Index -> Value : Collection):
    Print("{Index}: {Value}")

# With a filter clause
for (Item : Items, Item > 0):
    Print("{Item}")
```

An index variable is required even when unused — see
[reserved identifier `_`](#reserved-identifier-_) above.

### 9. `@editable` attribute

Not supported on abstract or non-concrete classes. Arrays of `@editable`
device references can silently reset to `None` (e.g. after a class
signature change) — don't assume a populated array stays populated; guard
with a failure context before using entries.

`@editable` only exposes simple types cleanly — model related per-entry data
as **parallel arrays** rather than an array of structs/tuples. It also cannot
take an array of a complex struct type:

```verse
# WRONG — @editable can't expose an array of a complex struct:
@editable
ComplexConfigs : []my_config_struct = array{}

# RIGHT — parallel arrays of simple types instead:
@editable
Volumes : []volume_device = array{}
@editable
SpawnTimes : []float = array{}
@editable
Cooldowns : []float = array{}
```

**`ToolTip` needs single-line brace syntax, not a multi-line block.**

**Error message:** `Unsupported attribute value expression: error(9005)`

```verse
# WRONG — multi-line block syntax causes error(9005):
@editable:
    ToolTip := MyTooltipMessage
MyProperty : float = 1.0

# RIGHT — single-line curly brace syntax:
@editable{ToolTip := MyTooltipMessage}
MyProperty : float = 1.0

# RIGHT — simple @editable without a tooltip needs no braces:
@editable
MyProperty : float = 1.0
```

**`ToolTip` also expects a `message` type, not a raw string.**

**Error message:** `This variable expects to be initialized with a value of
type message, but this initializer is an incompatible value of type []char.`

```verse
# WRONG — a raw string literal is []char, not message:
@editable{ToolTip := "This is my tooltip text"}
MyProperty : int = 0

# RIGHT — define a <localizes> message constant first, then reference it:
MyPropertyTip<localizes>:message := "This is my tooltip text."

my_device := class(creative_device):
    @editable{ToolTip := MyPropertyTip}
    MyProperty : int = 0
```

This is required even if you never plan to localize the project.

### 10. `Print()` gotcha

`Log_level.Debug` and `Log_level.Verbose` go **only** to the UEFN Output Log —
they never appear on-screen. Default on-screen `Print` duration is short
(roughly 2 seconds). This is the usual cause of "why isn't my Print showing."

Custom enums also need an explicit `ToString` before they can appear inside a
`Print` interpolation — see
[No ToString overload for a custom enum](#no-tostring-overload-for-a-custom-enum).

### 11. Unknown member: missing using statement

**Error message:** `Unknown member 'MyExtensionMethod' in 'player'. Did you
forget to specify using { /path/to/Module }?`

Extension methods (functions defined on existing types like `player`) are
only visible when you import the module that defines them. The compiler
helpfully names the missing module in the error.

```verse
# File: persistence.verse
# Defines extension methods on the player type:
(Player:player).IsItemUnlocked<public>(ItemID:int):logic=
    # implementation...

# File: my_device.verse — WRONG (missing import):
using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }

my_device := class(creative_device):
    CheckPlayer(Player:player):void=
        if (Player.IsItemUnlocked(42)?):  # Error: Unknown member 'IsItemUnlocked'
            Print("Unlocked!")

# RIGHT — import the module with the extension methods:
using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }
using { Persistence }  # local module — bare relative name

my_device := class(creative_device):
    CheckPlayer(Player:player):void=
        if (Player.IsItemUnlocked(42)?):  # Now works!
            Print("Unlocked!")
```

**Local project modules use bare relative names** (just the module name);
**Epic modules use full `/`-prefixed paths** (e.g. `/Fortnite.com/Devices`).
The error message always shows the full path even for local modules — for
those you typically just import the module name.

### 12. Unknown identifier: scope issues

Declare variables before conditional use:

```verse
# WRONG — MyVariable only exists inside the if
if (SomeCondition):
    MyVariable := SomeValue
Print("{MyVariable}")   # unknown identifier

# RIGHT — declare first, mutate with 'set' inside the branch
var MyVariable : int = 0
if (SomeCondition):
    set MyVariable = SomeValue
```

### 13. Ambiguous identifier across files

**Error message:** `Ambiguous identifier; could be (module1:)Name or
(module2:)Name`

Defining an identifier with the same name as a `<public>` identifier in
another file leaves the compiler unable to tell which one you mean.

```verse
# File A (interactive_prop_device.verse):
DetectionCenterTip<public><localizes>:message := "Center point for detection."

# File B (boss_room_device.verse) — WRONG:
DetectionCenterTip<localizes>:message := "Boss room detection center."  # Ambiguous!

# File B — RIGHT (use a unique prefix):
BossRoomDetectionTip<localizes>:message := "Boss room detection center."
```

Prefix identifiers with a unique name to avoid conflicts with public
identifiers from other files.

### 14. Local variable name conflicts with a module name

**Error message:** `The data X is ambiguous with this definition: module Y`
or `Ambiguous identifier; could be X or Y`

If the project has modules named `VFX`, `SFX`, `UI`, `Assets`, `Materials`,
or `Textures`, using those exact names as local variables causes ambiguity.

```verse
# Project has a module named VFX in the project's Assets tree
# WRONG — local variable named VFX conflicts with the module:
PlayEffects():void=
    if (VFX := MyVFXDevice?):  # Error! Ambiguous with VFX module
        VFX.Play()

# RIGHT — use a more specific variable name:
PlayEffects():void=
    if (EffectSpawner := MyVFXDevice?):
        EffectSpawner.Play()
```

### 15. Struct literals, struct scope, and failable struct fields

**Struct field initialization uses `:=`, not `=`.** Epic's own example:
`VectorOnes<public>:vector3 = vector3{X:=1.0, Y:=1.0, Z:=1.0}`
(dev.epicgames.com/documentation/en-us/fortnite/editable-properties-in-verse);
Book of Verse §03 Containers: `vector2{X := 100.0, Y := 250.0}`.

```verse
# WRONG — struct literal fields do not use '=':
var MyStruct : my_struct = my_struct{
    Field1 = value1,
    Field2 = value2
}

# RIGHT — struct literal fields use ':=':
var MyStruct : my_struct = my_struct{
    Field1 := value1,
    Field2 := value2
}
```

Structs must be defined outside and before the class that uses them — a
struct declared inside or after the class body will not resolve:

```verse
my_struct := struct:
    Field : int = 0

my_device := class(creative_device):
    # my_struct is visible here
```

**Failable expressions cannot go directly inside a struct literal field.**

**Error message:** `This invocation calls a function that has the 'decides'
effect, which is not allowed by its context` and `Unsupported argument to
archetype instantiation`

Arithmetic on `int` can fail (overflow), so `int + int` carries the
`<decides>` effect — struct field assignment isn't a failure context.

```verse
# WRONG — failable arithmetic directly inside a struct literal:
NewRecord := player_damage_record{
    TotalDamage := ExistingRecord.TotalDamage + Damage  # Error! int + int can fail
    HitCount := ExistingRecord.HitCount + 1              # Error!
}

# RIGHT — compute the failable values first, then build the struct:
NewTotalDamage := ExistingRecord.TotalDamage + Damage  # ':=' on its own line is a failure context
NewHitCount := ExistingRecord.HitCount + 1
NewRecord := player_damage_record{
    TotalDamage := NewTotalDamage   # now just assigning a resolved value
    HitCount := NewHitCount
}
```

### 16. String interpolation, not concatenation

**Confirmed:** string interpolation with `{Expr}` inside a string literal is
the idiomatic way to build a string with embedded values.

**Unverified this pass:** whether `+` concatenation on strings is entirely
unsupported, and whether a bare `ToString()` free function doesn't exist —
neither claim could be confirmed against Epic's docs or the Book of Verse
(see [Uncertain](#uncertain--verify-before-relying-on)). Prefer
interpolation regardless; it's the confirmed idiomatic form either way.

```verse
# REPORTED AS WRONG (unconfirmed) — '+' concatenation on strings:
Print("Value is " + MyVariable)

# REPORTED AS WRONG (unconfirmed) — bare ToString() call:
Print("Value is " + ToString(MyVariable))

# CONFIRMED RIGHT — interpolate directly:
Print("Value is {MyVariable}")
```

**Multi-variable interpolation** works the same way with more than one
placeholder:

```verse
Index : int = 5
Name : string = "Test"
Print("Item {Index} named {Name} is ready")
```

### 17. Unsafe array access patterns

**`..` ranges are inclusive on both ends — there is no exclusive range
syntax** (Book of Verse §07 Control Flow: "The `..` operator is always
inclusive."). That means `0..Array.Length` iterates ONE PAST the last valid
index; the correct upper bound is `Array.Length - 1`.

```verse
# WRONG — 0..Array.Length runs one index past the end of the array:
for (Index := 0..Array.Length):
    if (Element := Array[Index]):
        # Use Element

# RIGHT — inclusive range needs the '- 1':
for (Index := 0..Array.Length - 1):
    if (Element := Array[Index]):
        # Use Element
```

**Prefer the idiomatic collection-iteration forms** over a manual counted
range — they can't get the off-by-one wrong because there's no length
arithmetic to write:

```verse
# RIGHT — idiomatic, no index math at all:
for (Element : Array):
    # Use Element

# RIGHT — idiomatic, with a zero-based index:
for (Index -> Element : Array):
    # Use Index and Element
```

`Array[Index]` is still failable regardless of loop form — keep it inside a
failure context (`if`) as shown above.

### 18. Incompatible parameter types

A function's parameter type must match exactly — passing a `tuple()` where
the function expects a plain value (e.g. `agent`) is a compile error, not an
implicit coercion.

```verse
# WRONG — Activate expects an agent, not a tuple:
MyDevice.Activate((Agent,))

# RIGHT — pass the agent value directly:
MyDevice.Activate(Agent)
```

### 19. Randomness

**`/Verse.org/Random` exists and is current** — confirmed against Epic's
official API reference:

```verse
GetRandomInt<public><native>(Low:int, High:int)<transacts>:int
```

```verse
using { /Verse.org/Random }

RollDamage()<transacts>:int=
    GetRandomInt(1, 6)
```

Do not fall back to a hand-rolled counter-based pseudo-random workaround —
that pattern was sourced from older, unverified material and isn't needed;
`GetRandomInt` is the real, current API.

### 20. Module path depends on the new file's directory depth

**Observed in one project:** error 3506, `Unknown identifier`, hit twice in
one file.

**Error message:** `Unknown identifier 'GameInit'.` /
`Unknown identifier 'main_game_globals'.`

A `using { GameInit }` statement resolves relative to the file it's written
in. It compiled fine in `Content/MyProject/Framework/GameSystems/*.verse`,
but copying that same `using` block verbatim into a **new** file at
`Content/` root did not resolve — from root, the correct reference was the
fully-qualified `MyProject.Framework.GameInit.main_game_globals`.

```verse
# WRONG — copied from a file several directories deeper, does not
# resolve from Content/ root:
using { GameInit }

MyDevice := class(creative_device):
    OnBegin<override>()<suspends>:void=
        main_game_globals.DoSomething()   # Error 3506: Unknown identifier

# RIGHT — from a shallower directory, use the fully-qualified path:
MyDevice := class(creative_device):
    OnBegin<override>()<suspends>:void=
        MyProject.Framework.GameInit.main_game_globals.DoSomething()
```

**Rule:** derive `using` paths from the *target* file's own directory —
never copy a `using` block verbatim from a reference file at a different
depth. Before writing a new file's imports, check whether an existing file
**at the same depth** already uses that import, and copy from that one
instead. This is a single-project observation (directory-relative module
resolution), not an exhaustively verified language rule — confirm against
the digest and an existing sibling file, not against a deeper or shallower
reference file.

### 21. Finding a symbol in the digest is not enough

**Observed in one project:** error 3506 (`Unknown member`/`Unknown
identifier`), three separate symbols in one build.

Locating a symbol in a digest file (`Fortnite.digest.verse`,
`UnrealEngine.digest.verse`, etc.) confirms the API **exists**. It does not
confirm it's **visible** — you also need a `using` for the module that
*owns* it, or the call still fails to resolve.

```verse
# WRONG — GetFortCharacter and MakeNavigationTarget were both verified to
# exist in the digest, but their owning modules were never imported:
using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }

CheckPlayer(Player : player):void=
    if (Character := Player.GetFortCharacter[]):        # Error 3506
        NavTarget := MakeNavigationTarget(Character)     # Error 3506
        Print("ready")                                    # Error 3506

# RIGHT — add the using for the module that owns each symbol:
using { /Fortnite.com/Devices }
using { /Fortnite.com/Characters }              # owns GetFortCharacter
using { /Fortnite.com/AI }                      # owns MakeNavigationTarget
using { /UnrealEngine.com/Temporary/Diagnostics } # owns Print
using { /Verse.org/Simulation }

CheckPlayer(Player : player):void=
    if (Character := Player.GetFortCharacter[]):
        NavTarget := MakeNavigationTarget(Character)
        Print("ready")
```

**Rule:** after locating a symbol in a digest, walk backwards to its
enclosing `module` declaration in that same digest file and add the matching
`using`. Treat "found in the digest" and "callable from this file" as two
separate checks, not one.

### 22. Double-wrapped optional parameters

**Observed in one project:** error 3509, type mismatch, calling
`npc_spawner_device.SpawnAt`.

Given a signature like
`SpawnAt(Position:vector3, ?Rotation:?rotation)<suspends>:?agent`, the `?`
prefix on the parameter name already marks it optional. Wrapping the
argument in `option{...}` on top of that double-wraps it into
`?(?rotation)`, which does not match the expected `?rotation`.

```verse
# Signature: SpawnAt(Position:vector3, ?Rotation:?rotation)<suspends>:?agent

# WRONG — the '?' prefix on the parameter already means optional;
# wrapping the value in option{} double-wraps it:
MySpawner.SpawnAt(Pos, ?Rotation := option{FacingRotation})   # Error 3509

# RIGHT — pass the value directly:
MySpawner.SpawnAt(Pos, ?Rotation := FacingRotation)
```

**Rule:** when a parameter name is already prefixed with `?` in the
signature, assign the plain value with `:=` — never re-wrap it in
`option{...}`. Reserve `option{...}` for building a `?T`-typed value from
scratch, not for satisfying an already-optional parameter.

## Visibility and access errors

### Public member depends on a non-public type

**Error message:** `Definition X is accessible universally, but depends on
Y, which is only accessible from subpaths...`

When a `<public>` member (an event, function, etc.) uses a type that is not
itself `<public>`, the compiler is commonly reported to reject it —
external code could reach the member but not the type it depends on. The
`<public>` specifier **placement syntax** itself (`Name<public>:type`,
`type_name<public> := struct<concrete>:`) is confirmed against Epic's docs.
Whether this dependency specifically triggers a compile error was not
independently confirmed this pass — see
[Uncertain](#uncertain--verify-before-relying-on). Adding `<public>` to the
dependency is a safe, low-cost fix regardless.

```verse
# WRONG — public event uses a non-public enum:
my_phase := enum:
    Phase1
    Phase2

my_device := class(creative_device):
    PhaseChangedEvent<public> : event(my_phase) = event(my_phase){}  # Error!

# RIGHT — make the enum public too:
my_phase<public> := enum:
    Phase1
    Phase2

my_device := class(creative_device):
    PhaseChangedEvent<public> : event(my_phase) = event(my_phase){}  # OK
```

If a public member depends on a custom type (enum, struct, class), that type
must also be `<public>`.

### Public accessor depends on a non-public class

**Error message:** `Definition GetMyManager is accessible universally, but
depends on my_manager, which is only accessible from subpaths of
/path/to/module. The definition should be no more accessible than its
dependencies.`

A `<public>` function that returns a class type requires that class to also
be `<public>`. This shows up constantly in singleton-accessor patterns.

```verse
# WRONG — public accessor returns a non-public class:
my_manager := class(creative_device):  # not public
    # implementation...

var ManagerInstance : weak_map(session, my_manager) = map{}

GetMyManager<public>()<transacts>:my_manager=  # Error! my_manager is not public
    if (Singleton := ManagerInstance[GetSession()]):
        return Singleton
    return my_manager{}

# RIGHT — make the class public so the accessor can return it:
my_manager<public> := class(creative_device):  # now public
    # implementation...

var ManagerInstance : weak_map(session, my_manager) = map{}

GetMyManager<public>()<transacts>:my_manager=  # now works!
    if (Singleton := ManagerInstance[GetSession()]):
        return Singleton
    return my_manager{}
```

**Full singleton pattern:**

```verse
my_manager<public> := class(creative_device):
    OnBegin<override>()<suspends>:void=
        if. set ManagerInstance[GetSession()] = Self

var ManagerInstance : weak_map(session, my_manager) = map{}

GetMyManager<public>()<transacts>:my_manager=
    if (Singleton := ManagerInstance[GetSession()]):
        return Singleton
    return my_manager{}   # fallback, should not normally happen
```

The `<public>` specifier goes on the class definition itself, not just its
members. Any type referenced by a public accessor, parameter, or return type
must also be public.

## Custom events versus device events

### Event Subscribe vs Await

**Error message:** `Unknown member 'Subscribe' in 'event(my_payload)'`

Verse has two different event systems:

1. **Built-in device events** (like `AgentEntersEvent`, `InteractedWithEvent`)
   return `listenable(T)`, which has `Subscribe()`.
2. **Custom `event(T)` types** use `Signal()` to emit and `Await()` to
   receive — they do **not** have `Subscribe()`.

```verse
# WRONG — custom event(T) has no Subscribe:
MyEvent : event(my_payload) = event(my_payload){}

OnBegin<override>()<suspends>:void=
    MyEvent.Subscribe(HandleEvent)  # Error! No Subscribe member

# RIGHT — use an async loop with Await() instead:
MyEvent : event(my_payload) = event(my_payload){}

OnBegin<override>()<suspends>:void=
    spawn{ListenForEvents()}

ListenForEvents()<suspends>:void=
    loop:
        Payload := MyEvent.Await()   # suspends until the event is signaled
        HandleEvent(Payload)

HandleEvent(Payload : my_payload):void=
    # process the event
```

**Comparison:**

| Feature | `listenable(T)` (device events) | `event(T)` (custom events) |
|---|---|---|
| Subscribe | `Event.Subscribe(Callback)` | not supported |
| Await | `Event.Await()` | `Event.Await()` |
| Signal | not supported (device-driven) | `Event.Signal(Value)` |
| Example | `Button.InteractedWithEvent` | `MyCustomEvent : event(int)` |

**Async-loop pattern for custom events:**

```verse
# Emitting side:
MyEvent.Signal(PayloadValue)

# Receiving side:
loop:
    Value := MyEvent.Await()
    ProcessValue(Value)
```

### Event with multiple type parameters

**Error message:** `No overload of the function 'event' matches the provided
arguments`

Events are commonly reported to take only **one** type parameter — that
specific restriction was not independently confirmed against Epic's docs or
the Book of Verse this pass (see
[Uncertain](#uncertain--verify-before-relying-on)). The `tuple` workaround
below is a safe pattern either way: wrap multiple values in a `tuple` when
you need an event to carry more than one payload value.

```verse
# WRONG — events don't support multiple type parameters:
MyEvent : event(player, float) = event(player, float){}
MyEvent.Signal(Player, Damage)

# RIGHT — use a tuple for multiple values:
MyEvent : event(tuple(player, float)) = event(tuple(player, float)){}
MyEvent.Signal((Player, Damage))   # double parens: outer for Signal, inner for the tuple

# Receiving the event:
(Player, Damage) := MyEvent.Await()   # destructure the tuple
```

## Class concrete instantiation at module level

**Error messages:** `Expected a type, got archetype constructor
instead.(3547)` and `This archetype instantiation constructs a class that
has the 'transacts' effect, which is not allowed by its context.(3512)`

Trying to instantiate a `class<concrete>` at module level with archetype
syntax (`:=`) fails, because class construction has the `<transacts>` effect
and effects aren't allowed outside a runtime context.

```verse
# WRONG — cannot instantiate class<concrete> at module level:
my_class<public> := class<concrete>:
    Value : int = 0

MyInstance<public> := my_class:   # Error 3547, 3512
    Value := 42
```

**Solution 1 — `@editable` arrays:** configure instances in the UEFN editor
instead of hardcoding them.

```verse
my_class<public> := class<concrete>:
    @editable
    Value : int = 0

some_device := class(creative_device):
    @editable
    Instances : []my_class = array{}
```

**Solution 2 — use a struct instead:** structs can be instantiated at module
level, so this works for constant/immutable data.

```verse
my_struct<public> := struct:
    Value : int = 0

MyInstance<public> : my_struct = my_struct:
    Value := 42
```

**Solution 3 — runtime instantiation:** create the instance inside a function
or `OnBegin`, where the `<transacts>` effect is allowed.

```verse
my_class<public> := class<concrete>:
    Value : int = 0

some_device := class(creative_device):
    var MyInstance : ?my_class = false

    OnBegin<override>()<suspends>:void=
        set MyInstance = option{my_class{Value := 42}}
```

**When to use each:**

| Scenario | Solution |
|---|---|
| Need editor-configurable instances | `@editable` arrays |
| Need constant/immutable data | struct instead of class |
| Need mutable runtime instances | runtime instantiation |

## No ToString overload for a custom enum

**Error message:** `No overload of the function 'ToString' matches the
provided arguments (:my_enum)`

Using a custom enum in string interpolation (`Print("Value: {MyEnumValue}")`)
requires a `ToString` conversion, which custom enums don't get by default.

```verse
# WRONG — using a custom enum in string interpolation without ToString:
my_status := enum:
    Active
    Inactive

MyFunction():void=
    Status := my_status.Active
    Print("Current status: {Status}")  # Error! No ToString for my_status

# RIGHT — define a ToString function for the enum:
my_status := enum:
    Active
    Inactive

ToString(Status : my_status)<computes>:string =
    case(Status):
        my_status.Active => "Active"
        my_status.Inactive => "Inactive"

MyFunction():void=
    Status := my_status.Active
    Print("Current status: {Status}")  # now works!
```

Use `<computes>` since `case` here is a pure computation with no side
effects.

## `no_rollback` effect errors

Functions with no effect specifier default to `no_rollback` — not
transaction-safe. Two distinct, very common errors come from this default.

### Called from a `<transacts>` context

**Error message:** `This invocation calls a function that has the
'no_rollback' effect, which is not allowed by its context`

A `<transacts>` function can only call other transaction-safe functions
(also `<transacts>` or `<computes>`).

```verse
# WRONG — <transacts> function calls a function with the default no_rollback effect:
GetAllItems():[]item=   # no specifier = no_rollback
    for (Item : ItemRegistry). Item

GetFirstItem<public>()<transacts>:?item=
    Items := GetAllItems()   # Error! no_rollback not allowed in transacts
    if (First := Items[0]):
        return option{First}
    return false

# RIGHT (option 1) — drop <transacts> from the caller:
GetFirstItem<public>():?item=
    Items := GetAllItems()
    if (First := Items[0]):
        return option{First}
    return false

# RIGHT (option 2) — make the callee transacts-compatible instead:
GetAllItems()<transacts>:[]item=
    # ...must only use transact-safe operations
```

Only mark a function `<transacts>` when it genuinely needs to participate in
speculative execution and can be rolled back — most utility functions don't.

### `if (X = true)` triggers a `no_rollback` error

**Error message:** `This invocation calls a function that has the
'no_rollback' effect, which is not allowed by its context.`

**Compound `and`/`or` conditions inside a single `if` ARE valid Verse** —
this is not a rule that requires splitting them into nested `if`s. Epic's
own example (§04 Operators, Book of Verse):

```verse
if (Level >= 10 and Score > 1000):
    UnlockAchievement()
```

The narrower, real trap below is easy to over-generalize into "compound
conditions are forbidden" — they are not. Writing `if (SomeLogicValue =
true):` makes the equality comparison itself a failable operation, which
turns the `if` block into a failure context that then disallows ordinary
`no_rollback` operations like `Print`, `spawn{}`, and `set` inside it.

> The `X?` idiom below (querying a `logic` value) is confirmed. That this
> specific error string is what `if (X = true):` produces has not been
> independently verified against Epic's docs — treat the exact error
> attribution as a field report, and the `X?` fix as the safe default
> regardless.

```verse
# WRONG — no_rollback operations inside a failable comparison's if block:
if (Player.IsFurnitureUnlocked(ID) = true):   # failable comparison
    Print("Unlocked!")      # Error: no_rollback not allowed
    spawn{DoSomething()}    # Error: no_rollback not allowed
    return
```

**Solution:** store the `logic` result first, then check it with `?`, which
queries a `logic` value without creating a failable/transactional context.

```verse
# RIGHT — separate the check from the actions:
IsUnlocked := Player.IsFurnitureUnlocked(ID)
if (IsUnlocked?):   # '?' queries logic without a failable context
    Print("Unlocked!")      # OK now
    spawn{DoSomething()}    # OK now
    return
```

The `?` operator on a `logic` value succeeds when the value is `true` and
fails when `false`, without creating the transactional context that would
disallow `no_rollback` effects.

## Digest files = ground truth

- `Verse.digest.verse` — core language.
- `Fortnite.digest.verse` — Fortnite API surface.
- `UnrealEngine.digest.verse` — Unreal API surface.
- `Assets.digest.verse` — imported project assets.

The verse-expert and uefn-auditor agents already auto-detect these: they
recursively search the UEFN data root and the open project, and when
multiple copies exist the most recently modified one wins.

**Grep the relevant digest for the exact symbol and signature BEFORE writing
a call.** The digest overrides anything in this file and anything in the
model's memory — if this file and the digest disagree, the digest is right.

## Deterministic lint: verse_lint.py

A small deterministic lint ships beside this file:

```
python .claude/skills/uefn/verse_lint.py <file-or-directory>
```

**Exit codes:** `0` clean, `1` findings reported, `2` usage error, `3`
incomplete scan (it could not check everything). **Exit code `3` is never a
pass** — treat an incomplete scan the same as an unverified file, not a
clean one.

It currently detects:

- unguarded `set Map[Key] = Value` (see [rule 6](#6-arrays-and-maps-indexing-is-failable))
- comparison operators bound with `:=` outside a failure context (see
  [rule 3](#3-failure-contexts))
- double-wrapped optional parameters (see
  [rule 22](#22-double-wrapped-optional-parameters))

**It covers only a subset of the errors in this file, and a clean run is NOT
a compile guarantee.** In particular, [rule 20](#20-module-path-depends-on-the-new-files-directory-depth)
(module-path depth) and [rule 21](#21-finding-a-symbol-in-the-digest-is-not-enough)
(digest-verified-but-missing-`using`) are **not detectable by static text
scanning** — both require knowing the target file's location relative to
the module tree and cross-referencing the digest, neither of which the lint
has access to. Run the lint as a fast pre-check, not a substitute for
digest verification or an actual UEFN build.

## Version drift

Since UEFN 28.10, Verse has formal language versioning: deprecated syntax
still **compiles** but emits a warning ahead of a future breaking change.
That means a memorized-but-stale pattern can fail **silently** (a warning,
not an error) rather than loudly. Never assume a remembered signature is
current — check the digest, every time, even for APIs you're sure you've
used correctly before.

## Uncertain — verify before relying on

These points are flagged from research that could not be independently
verified against Epic's official documentation or the Book of Verse. Treat
them as leads to check against the digest or Epic's current docs, not as
settled fact. **The digest files override this file in every case.**

- The exact on-disk digest path is commonly reported as under
  `%LOCALAPPDATA%\UnrealEditorFortnite\Saved\VerseProject\...`, but this has
  not been independently verified. Treat it as "typically under the UEFN
  data root" — the agents auto-detect the real location by search, so don't
  hardcode this path.
- The exact ordering when MULTIPLE specifiers are combined on one
  definition (e.g. `<public><native>` vs `<native><public>`) — the basic
  single-specifier placement syntax (`Name<public>:type`,
  `type_name<public> := struct<concrete>:`) IS confirmed; multi-specifier
  ordering was not independently checked this pass.
- Anything in this file ultimately sourced from unofficial third-party
  community documentation rather than Epic's own documentation or the Book
  of Verse.
- The individual per-function call-style entries in the
  [call style table](#call-style-square-brackets-vs-parentheses) for
  `Floor()`, `Ceil()`, `Round()`, `Abs()`, `Map[Key]`, `MakeUnitVector[]`,
  and `GetPlayer[]` — community-reported, not individually confirmed. The
  general `[]`/`()` rule and the `Array[Index]` / `Mod[X, Y]` entries ARE
  confirmed.
- `option{}` with no argument being invalid — no source confirmed or denied
  this either way. `false` as the empty optional IS confirmed; use that
  regardless.
- The specific claim that `if (X = true):` produces a `no_rollback` error —
  the underlying `X?` query-operator idiom is confirmed; this particular
  error attribution is not.
- `+` string concatenation being unsupported on strings, and a bare
  `ToString()` free function not existing — string interpolation itself
  (`"{Expr}"`) IS confirmed as the idiomatic form regardless.
- `pass` not existing as a Verse identifier — consistent with the absence of
  any keyword reference for it, but not explicitly stated as forbidden by
  either source.
- `event(T)` accepting only ONE type parameter — the `tuple(...)` workaround
  pattern is safe to use regardless; the strict single-parameter limit
  itself wasn't independently confirmed.
- A public member depending on a non-public type being a hard compile
  error — the `<public>` specifier PLACEMENT syntax is confirmed (see
  above); this specific dependency-triggers-an-error rule is not.
- The literal `<decides>` specifier text as it appears on `Mod`'s actual
  declaration — `Mod`'s failable, bracket-call behavior IS confirmed via
  Epic's API page regardless of the exact specifier spelling reported.

### Primary references

- https://dev.epicgames.com/documentation/en-us/fortnite/failure-in-verse
- https://dev.epicgames.com/documentation/en-us/fortnite/verse-language-quick-reference
- https://dev.epicgames.com/documentation/en-us/fortnite/concurrency-overview-in-verse
- https://dev.epicgames.com/documentation/en-us/fortnite/control-flow-in-verse
- https://dev.epicgames.com/documentation/en-us/fortnite/editable-properties-in-verse
- https://dev.epicgames.com/documentation/en-us/fortnite/verse-api/versedotorg/verse/mod
- https://verselang.github.io/book (Book of Verse — Epic's topic pages defer
  to this as tracking the head of the main development branch, with the
  caveat that some content may predate an official release)
