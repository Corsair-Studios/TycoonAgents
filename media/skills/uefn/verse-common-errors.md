<!-- version: 3.0.0 -->
# Verse Common Errors — Pre-Flight Reference

## Why this file exists

Verse is scarce in LLM training data. Models pattern-match to C#, Python,
TypeScript, and Blueprint, then hallucinate APIs, keywords, and syntax that do
not exist in Verse. Real UEFN forum reports describe Copilot as "more harmful
than helpful when programming verse" with "no idea about any of the UEFN
libraries and functions."

**Prime directive: verify every API against the digest files before writing
it. Never write an API from memory.**

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
- [Concurrency / spawn syntax](#7-concurrency) — `spawn{}` brace syntax, not `spawn:` block syntax
- [Arrays and maps](#6-arrays-and-maps-indexing-is-failable) — `%` modulo does not exist, use `Mod[...]`
- [String interpolation](#16-string-interpolation-not-concatenation) — `{var}`, not `+` concatenation
- [Struct literals](#15-struct-literals-struct-scope-and-failable-struct-fields) — field init uses `=`, not `:=`

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

### Visibility / Access Errors
- [Public member depends on a non-public type](#public-member-depends-on-a-non-public-type) — custom types used by public members must be `<public>`
- [Public accessor depends on a non-public class](#public-accessor-depends-on-a-non-public-class) — singleton-getter pattern
- [Ambiguous identifier across files](#13-ambiguous-identifier-across-files) — prefix identifiers uniquely

### Import / Using Errors
- [Unknown member — missing `using`](#11-unknown-member-missing-using-statement) — extension methods need the defining module imported

### Naming / Scope Errors
- [Local variable name conflicts with a module name](#14-local-variable-name-conflicts-with-a-module-name) — avoid `VFX`/`SFX`/`UI`/`Assets`/`Materials`/`Textures` as variable names
- [Unknown identifier — scope issues](#12-unknown-identifier-scope-issues) — declare variables before conditional use
- [`pass` does not exist](#unknown-identifier-pass) — Python-ism, not valid Verse
- [Reserved identifier `_`](#reserved-identifier-_) — no underscore placeholder in `for`/patterns

### Failable / Optional Handling
- [Square brackets vs parentheses](#call-style-square-brackets-vs-parentheses) — `[]` for failable, `()` for always-succeed
- [Failable conversions vs optional returns](#failable-conversions-vs-optional-returns) — the two look similar but need different handling
- [Unsafe array access](#17-unsafe-array-access-patterns) — always bounds-check

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

**Error message:** `Unknown identifier 'pass'.`

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

Unlike Python or Rust, Verse does not allow `_` as an "unused variable"
placeholder in `for` loops or pattern matching.

```verse
# WRONG — underscore is reserved
for (Index -> _ : MyArray):
    DoSomething(Index)

# RIGHT — use a named variable even if unused
for (Index -> Item : MyArray):
    DoSomething(Index)   # Item is unused, that's fine — Verse doesn't warn
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

When in doubt, check the digest signature for `<decides>` — that decides the
brackets, not convention.

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
var DeviceMap : [int]state = map{}
```

**The `%` modulo operator does not exist.** Use `Mod[...]` (which is
failable — see the bracket rule above). Integer division (`/`) also returns
`rational`, not `int`, so it can't substitute for modulo either.

```verse
# Ring-buffer pattern
NextIndex := CurrentIndex + 1
if (WrappedIndex := Mod[NextIndex, BufferSize]):
    set CurrentIndex = WrappedIndex
else:
    set CurrentIndex = 0
```

### 7. Concurrency

- `spawn{}` — fire-and-forget task.
- `sync{}` — run branches concurrently, wait for ALL.
- `race{}` — run branches concurrently, first to finish wins, others cancel.
- `branch{}` — run concurrently without waiting.

Epic's guidance prefers structured concurrency (`sync`/`race`/`branch`) over
bare `spawn` where the control flow can be expressed structurally.

`spawn` takes a brace block, not a colon-indented block:

```verse
# WRONG
spawn:
    MyFunction()

# RIGHT
spawn{MyFunction()}
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
as **parallel arrays** rather than an array of structs/tuples:

```verse
@editable
Volumes : []volume_device = array{}
@editable
SpawnTimes : []float = array{}
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

Struct field initialization uses `=`, not `:=`:

```verse
var MyStruct : my_struct = my_struct{
    Field1 = value1,
    Field2 = value2
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
    TotalDamage = ExistingRecord.TotalDamage + Damage  # Error! int + int can fail
    HitCount = ExistingRecord.HitCount + 1              # Error!
}

# RIGHT — compute the failable values first, then build the struct:
NewTotalDamage := ExistingRecord.TotalDamage + Damage  # ':=' on its own line is a failure context
NewHitCount := ExistingRecord.HitCount + 1
NewRecord := player_damage_record{
    TotalDamage = NewTotalDamage   # now just assigning a resolved value
    HitCount = NewHitCount
}
```

### 16. String interpolation, not concatenation

```verse
# WRONG — '+' concatenation does not work on strings this way
Print("Value is " + MyVariable)

# RIGHT
Print("Value is {MyVariable}")
```

### 17. Unsafe array access patterns

Even when a bound is already known, prefer the failure-context form over a
manual length check — but if a manual check is used, still gate the access
itself with `if`:

```verse
for (Index := 0..Array.Length):
    if (Index < Array.Length):
        if (Element := Array[Index]):
            # Use Element
```

## Visibility and access errors

### Public member depends on a non-public type

**Error message:** `Definition X is accessible universally, but depends on
Y, which is only accessible from subpaths...`

When a `<public>` member (an event, function, etc.) uses a type that is not
itself `<public>`, the compiler rejects it — external code could reach the
member but not the type it depends on.

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

Events take only **one** type parameter. Wrap multiple values in a `tuple`.

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

This is the precise, real-world version of a rule that's easy to
over-generalize: it is **not** that compound `and`/`or` conditions are
forbidden — Verse has real `and`/`or` operators. The actual trap is narrower:
writing `if (SomeLogicValue = true):` makes the equality comparison itself a
failable operation, which turns the `if` block into a failure context that
then disallows ordinary `no_rollback` operations like `Print`, `spawn{}`, and
`set` inside it.

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

## Version drift

Since UEFN 28.10, Verse has formal language versioning: deprecated syntax
still **compiles** but emits a warning ahead of a future breaking change.
That means a memorized-but-stale pattern can fail **silently** (a warning,
not an error) rather than loudly. Never assume a remembered signature is
current — check the digest, every time, even for APIs you're sure you've
used correctly before.

## Uncertain — verify before relying on

These points are flagged from research that could not be independently
verified. Treat them as leads to check against the digest or Epic's current
docs, not as settled fact:

- The exact on-disk digest path is commonly reported as under
  `%LOCALAPPDATA%\UnrealEditorFortnite\Saved\VerseProject\...`, but this has
  not been independently verified. Treat it as "typically under the UEFN
  data root" — the agents auto-detect the real location by search, so don't
  hardcode this path.
- The precise placement syntax for access specifiers (`<public>`,
  `<internal>`, `<protected>`, `<private>`) — confirm against the digest or
  Epic's docs before relying on a specific ordering or position.
- Anything in this file ultimately sourced from unofficial third-party
  community documentation rather than Epic's own documentation.

### Primary references

- https://dev.epicgames.com/documentation/en-us/fortnite/failure-in-verse
- https://dev.epicgames.com/documentation/en-us/fortnite/verse-language-quick-reference
- https://dev.epicgames.com/documentation/en-us/fortnite/concurrency-overview-in-verse
- https://dev.epicgames.com/documentation/en-us/fortnite/control-flow-in-verse
- https://dev.epicgames.com/documentation/en-us/fortnite/editable-properties-in-verse
