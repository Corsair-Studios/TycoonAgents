/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Constructs the Provider (src/core/provider.ts) the extension host runs,
// given a resolved provider id (see src/core/providerSelection.ts). Kept in
// its own module, separate from extension.ts, so it can be unit tested
// without booting the full extension activate() path.

import type { Provider } from "../../core/provider";
import { ClaudeCodeProvider } from "../../providers/claude-code";
import { OpenCodeProvider } from "../../providers/opencode";
import type { ProviderId } from "../../core/providerSelection";
// Importing claude-code and opencode above already registers both mappers
// as a module-load side effect; registerAllMappers.ts is the canonical
// single place that guarantees this, kept in sync here defense-in-depth
// (see standalone/src/sharedLogic.mjs for the other caller).
import "../../providers/registerAllMappers";

/** Builds the Provider for `id`, pointed at `activityFile`. Throws if `id`
 * is not a recognized ProviderId (resolveProviderId already validates this
 * before it reaches here, so this is a defense-in-depth check). */
export function createProvider(id: ProviderId, activityFile: string): Provider {
  switch (id) {
    case "claude-code":
      return new ClaudeCodeProvider({ activityFile });
    case "opencode":
      return new OpenCodeProvider(activityFile);
    default: {
      const exhaustive: never = id;
      throw new Error(`TycoonAgents: unknown provider id "${String(exhaustive)}".`);
    }
  }
}
