# Verse Common Errors — Pre-Flight Reference

## Why this file exists

Verse is scarce in LLM training data. Models pattern-match to C#, Python,
TypeScript, and Blueprint, then hallucinate APIs, keywords, and syntax that do
not exist in Verse. Real UEFN forum reports describe Copilot as "more harmful
than helpful when programming verse" with "no idea about any of the UEFN
libraries and functions."

**Prime directive: verify every API against the digest files before writing
it. Never write an API from memory.**

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

### C# / TS / Python idioms

LINQ, list comprehensions, `async`/`await` as keywords, `foreach`, `switch`,
ternaries — none exist as such. Use the Verse equivalent.

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

Pick the weakest specifier that's still true; the compiler enforces it at
every call site.

### 5. Options, not null

```verse
# Declaring
MaybeValue : ?int = option{42}
Empty : ?int = false

# Unwrapping — must be a failure context
if (X := MaybeValue?):
    Print("{X}")
```

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

### 7. Concurrency

- `spawn{}` — fire-and-forget task.
- `sync{}` — run branches concurrently, wait for ALL.
- `race{}` — run branches concurrently, first to finish wins, others cancel.
- `branch{}` — run concurrently without waiting.

Epic's guidance prefers structured concurrency (`sync`/`race`/`branch`) over
bare `spawn` where the control flow can be expressed structurally.

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

### 9. `@editable`

Not supported on abstract or non-concrete classes. Arrays of `@editable`
device references can silently reset to `None` (e.g. after a class
signature change) — don't assume a populated array stays populated; guard
with a failure context before using entries.

### 10. `Print()` gotcha

`Log_level.Debug` and `Log_level.Verbose` go **only** to the UEFN Output Log —
they never appear on-screen. Default on-screen `Print` duration is short
(roughly 2 seconds). This is the usual cause of "why isn't my Print showing."

### 11. Common `using` misses

"Unknown identifier" usually means a missing or wrong `using`. Colliding
names imported from two different paths produce "Ambiguous" instead.

- `GetPlayspace()` needs `using { /Fortnite.com/Playspaces }`.
- Extending `creative_device` needs `using { /Verse.org/Simulation }`.

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
- Anything in this file ultimately sourced from the unofficial
  uefncentral.com rather than Epic's own documentation.

### Primary references

- https://dev.epicgames.com/documentation/en-us/fortnite/failure-in-verse
- https://dev.epicgames.com/documentation/en-us/fortnite/verse-language-quick-reference
- https://dev.epicgames.com/documentation/en-us/fortnite/concurrency-overview-in-verse
- https://dev.epicgames.com/documentation/en-us/fortnite/control-flow-in-verse
- https://dev.epicgames.com/documentation/en-us/fortnite/editable-properties-in-verse
