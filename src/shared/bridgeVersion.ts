/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * Pure string-only helpers for comparing UEFN bridge versions
 * (`BRIDGE_VERSION = "x.y.z"` stamped in `media/uefn-bridge/bridge_version.py`
 * and mirrored into a project's staged copy). Deliberately free of any
 * `vscode`/`fs` import so this module is trivially unit-testable and safe to
 * import from both the extension host and plain `node --test` runs.
 */

/**
 * Extract the version string from a `bridge_version.py` file's text via a
 * regex on `BRIDGE_VERSION = "x.y.z"` (single or double quotes, tolerant of
 * extra whitespace around `=`). Returns `null` when no such line is found.
 */
export function parseBridgeVersion(fileText: string): string | null {
  const match = /BRIDGE_VERSION\s*=\s*["']([^"']+)["']/.exec(fileText);
  return match ? match[1] : null;
}

/**
 * True iff `v` is a well-formed numeric version string: one or more
 * dot-separated components, every component a non-empty run of digits
 * (e.g. `"0.0.441"`, `"1"`). Anything else — empty string, a non-numeric
 * component like `"abc"` or `"1.x"` — is false. Used to distinguish a
 * genuinely-comparable installed `BRIDGE_VERSION` stamp from a corrupted
 * one that would otherwise make `isBridgeVersionNewer` a permanent
 * false/false dead end.
 */
export function isNumericVersion(v: string): boolean {
  if (typeof v !== "string" || v.length === 0) return false;
  return v.split(".").every((part) => part.length > 0 && /^\d+$/.test(part));
}

/**
 * True iff `candidate` is strictly newer than `baseline`, comparing
 * dot-separated components NUMERICALLY (not lexicographically) left to
 * right — a naive string compare gets "0.0.441" vs "0.0.9" wrong ('4' <
 * '9'). Missing trailing components are treated as 0 (so "0.1" > "0.0.9",
 * but "1.0.0" is not > "1"). Any non-numeric/garbage component makes that
 * component compare as not-newer rather than throwing — this function must
 * never throw.
 */
export function isBridgeVersionNewer(candidate: string, baseline: string): boolean {
  try {
    const toParts = (v: string): number[] =>
      v.split(".").map((p) => {
        const n = Number.parseInt(p, 10);
        return Number.isFinite(n) ? n : NaN;
      });

    const a = toParts(candidate);
    const b = toParts(baseline);
    const len = Math.max(a.length, b.length);

    for (let i = 0; i < len; i++) {
      const av = a[i] ?? 0;
      const bv = b[i] ?? 0;
      if (Number.isNaN(av) || Number.isNaN(bv)) return false;
      if (av > bv) return true;
      if (av < bv) return false;
    }
    return false; // equal
  } catch {
    return false;
  }
}
