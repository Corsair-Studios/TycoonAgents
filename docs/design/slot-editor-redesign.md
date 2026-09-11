# Slot editor redesign proposal (p27-t2)

Design-only proposal for reducing the routing slot card's overwhelm. No code, media, or test changes are made here.

## 1. Information hierarchy

Every slot (top-level agent or fallback entry) gets one summary line, always visible, built from fields already on `RoutingSlot` (src/core/routingProfile.ts):

```
vendor · model · route: <native | bridged via MCP <name> | OpenAI-compatible endpoint> · billing class · fallback count
```

- `route` derives from `transport`/`mcpServer`: `claude-native` on the harness's native vendor -> "native"; `transport: mcp` with `mcpServer` set -> "bridged via MCP `<mcpServer>`"; `transport: openai-compatible` -> "OpenAI-compatible endpoint".
- Accent per p24: light blue when vendor is foreign to the harness (`agentAccent()` in media/src/main/005-agent-accent.js returns "foreign"), amber + "(fb)" suffix when the slot is itself a fallback entry (`agentAccent()` returns "fallback"). Native slots get no accent.
- The summary line replaces today's chip row (`vs. orch. flat-rate | tasks | MCP | vendor | billing quota`) as the always-visible identity of the slot; the chip row's remaining informational bits (task/MCP context) move to the Connection section below, since they describe route detail, not identity.

## 2. Progressive disclosure

Default-visible: summary line, Keywords, tier radios, Save/Remove/Open.
Behind a "Connection" `<details>` (collapsed by default, auto-expanded when a hard dispatch warning exists): Vendor, Model, Transport, Cost class, credential/endpoint env fields, MCP server, subscription notice, fallback chain.

Per-state defaults for the Connection section's initial `open` state:

| State | Connection default |
|---|---|
| native | closed (nothing to configure) |
| bridged-installed | closed (working; open on demand) |
| bridged-missing | **open** (action needed) |
| foreign-endpoint | closed, unless a hard fallback dispatch warning fires |

## 3. Per-state visibility table

| Field | native | bridged-installed | bridged-missing | foreign-endpoint | fallback sub-form |
|---|---|---|---|---|---|
| Vendor select | shown | shown | shown | shown | shown |
| Model | shown | shown | shown | shown | shown |
| Transport | hidden (implied claude-native) | shown | shown | shown | shown |
| Cost class | shown | shown | shown | shown | shown |
| Endpoint URL env | hidden | hidden | hidden | shown | shown if openai-compatible |
| Credential env | hidden | shown | shown | shown | shown |
| MCP server field | hidden | shown | shown | hidden | shown if transport=mcp |
| Subscription/bridge notice | hidden | hidden (status line instead, per p27-t1) | shown | hidden | same as parent |
| Fallback chain `<details>` | shown | shown | shown | shown | n/a (chain doesn't nest) |

"bridged-installed" vs "bridged-missing" is exactly the p27-t1 distinction: notice shows only when the bridge is missing; otherwise a one-line status ("Bridged via Codex MCP - connected") replaces it.

## 4. ASCII mockups

**native:**
```
o anthropic . claude-sonnet-4-6 . native . metered
  Keywords: [ code, review          ]  ( ) fast (o) balanced ( ) deep
  [Open] [Save] [Remove]
```

**bridged-installed:**
```
(blue) openai . gpt-6-astra . bridged via MCP codex-mcp . subscription . 1 fallback
  Keywords: [ codex, review         ]  ( ) fast (o) balanced ( ) deep
  > Connection
  [Open] [Save] [Remove]
```
(expanded)
```
  v Connection
    Vendor: [openai v]  Model: [gpt-6-astra________]
    Transport: [mcp v]  Cost class: [subscription v]
    Credential env: [OPENAI_API_KEY______] [Set value...]
    MCP server: [codex-mcp___________]
    Status: Bridged via Codex MCP - connected
    > Fallback chain (1)
```

**bridged-missing:**
```
(blue) google . gemini-2.5-pro . bridged via MCP (not installed) . subscription
  Keywords: [ gemini, review        ]  ( ) fast (o) balanced ( ) deep
  v Connection  (auto-opened)
    Vendor: [google v]  Model: [gemini-2.5-pro_____]
    Transport: [mcp v]  Cost class: [subscription v]
    Credential env: [GEMINI_API_KEY______] [Set value...]
    MCP server: [____________________]
    ! Subscription providers are set up in chat, not here.
    [Copy request]
  [Open] [Save] [Remove]
```

**foreign-endpoint (openai-compatible/local):**
```
(blue) ollama-windows . llama3.1 . OpenAI-compatible endpoint . local
  Keywords: [ local, draft          ]  ( ) fast (o) balanced ( ) deep
  > Connection
  [Open] [Save] [Remove]
```
(expanded)
```
  v Connection
    Vendor: [Custom endpoint... v]  Provider name: [ollama-windows_____]
    Model: [llama3.1____________]
    Endpoint URL env: [OLLAMA_ENDPOINT_____] [Set value...]
    API key env: [OLLAMA_API_KEY______] [Set value...]
    > Fallback chain (0)  [+ Add fallback]
```

## 5. Copy-request action

Replace the inline notice box's embedded "Copy request" button placement with a single button in the Connection section's status row, not a standalone box:

- **bridged-installed**: no button - a plain status line, "Bridged via `<CLI>` MCP - connected."
- **bridged-missing**: one button, `[Copy request]`, next to a one-line status "Bridge not installed." Clicking reveals the same generated prompt text (still built by `buildSubscriptionMcpNotice`'s `buildPrompt()`) transiently (e.g. a small popover or the button's own label swap to "Copied", as today) - no persistent textarea taking up card space.
- **foreign-endpoint**: no button - nothing to bridge; this state fully self-serves via endpoint/key env fields.

## 6. Fallback chain display

Compact list, one line per entry, inside the existing `<details>` "Fallback chain (n)":
```
#1  anthropic . claude-haiku
#2  openai . gpt-6-astra (fb) ! not dispatchable under codex
```
- Amber `(fb)` suffix stays on every fallback entry's line per the p24 accent legend, applied consistently regardless of vendor.
- The existing hard-dispatch warning (`buildFallbackDispatchWarning`) stays attached per-entry, unchanged in wording, just visually below its compact line instead of below the full expanded sub-form.
- Legend line once at the top of the fallback list: "(fb) = fallback target".

## 7. Unchanged

Keywords field, tier radios (fast/balanced/deep), Save, Remove, Open all keep their current position, labels, and behavior - no relocation, no rename.

## 8. Accessibility

- Route/state is never conveyed by color alone: the summary line's route text ("native"/"bridged via MCP X"/"OpenAI-compatible endpoint") and the "(fb)" suffix carry the same information the accent color does.
- Keyboard order: summary line (non-interactive, skipped in tab order) -> Keywords -> tier radios -> Connection `<details>` toggle -> (if open) Vendor -> Model -> Transport -> Cost class -> credential/endpoint fields -> MCP server -> status/Copy request -> Fallback chain toggle -> fallback entries -> Open/Save/Remove. `<details>` remains natively keyboard-toggleable (Enter/Space on the summary).

## 9. Migration note

No `routing.json` schema change is expected - this proposal only reorganizes which `RoutingSlot` fields render by default vs. under Connection, and replaces the notice's visual placement. All existing fields (`vendor`, `transport`, `mcpServer`, `model`, `costModelClass`, `endpointEnv`, `credentialEnv`, `fallback`) map 1:1 to today's schema (src/core/routingProfile.ts:24-37); no new fields are introduced.

## 10. Implementation outline

1. **Summary line + Connection collapse** - media/src/main/100-slot-editor-settings.js: wrap the existing field block (vendor through MCP server, currently always rendered inline in `buildSlotEditorFields`) in a `<details class="routing-connection-details">`; add a `buildSlotSummaryLine(slot, harness)` helper alongside `nativeVendorForHarness`/`subscriptionNoticeVendorLabel` producing the vendor.model.route.billing.fallback string with accent classes from `agentAccent()` (005-agent-accent.js).
2. **Status line vs. notice, and copy-request button relocation** - same file: extend `buildSubscriptionMcpNotice`'s `shouldShow()`/`render()` split (already distinguishing bridge states per p27-t1) so a "connected" status line renders when `shouldShow()` is false but the slot is bridged, and move `copyBtn` out of the textarea-holding box into the status row for the bridged-missing case only.
3. **Fallback chain compact rows** - same file: replace `buildFallbackEditor`'s per-entry rendering of the full `buildSlotEditorFields` block with a one-line summary (reusing the item-1 helper) plus the existing up/down/remove controls and dispatch warning, deferring full fields to a per-entry `<details>`.

Files touched: media/src/main/100-slot-editor-settings.js only; media/style.css for `.routing-connection-details`/`.routing-slot-summary-line`/`.routing-fallback-item-line` styling (owned by ux-ui-designer, separate task).
