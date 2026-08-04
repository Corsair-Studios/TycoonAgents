"""
UEFN Shared Asset-Usage / Orphan Confirmation
=============================================
Authoritative "is this asset truly unreferenced?" check shared by the material,
texture, and Niagara browsers. Uses the Asset Registry REVERSE reference graph
(get_referencers) across ALL asset types, plus a Verse source-text cross-check,
mirroring dependency_viewer.py's proven logic.

WHY THIS EXISTS: walking the currently-loaded level's actors only sees that ONE
level. It is blind to other levels/islands, devices' @editable asset references,
Verse scripts, material-instance parent materials, decals, UI, landscape, and
soft references. Flagging an asset "unused" from a level-walk alone can falsely
mark in-use assets as deletable. This module is the safety net: a candidate is
only confirmed orphaned when NOTHING anywhere references it.

Public API:
    confirm_orphans(candidate_paths, project_only=True, registry=None) -> dict
        {path: reason} for candidates with NO project references (registry
        referencers + Verse source text). Paths ABSENT from the result ARE
        referenced and must NOT be flagged as unused. UNCHANGED signature and
        behavior — kept for existing callers (asset_sweep, niagara_inspector,
        material_browser, texture_finder). Internally now built on top of
        confirm_orphans_detailed() below and is slightly MORE conservative
        than before: a candidate whose registry check errored used to be
        silently treated as "no referencers" and could be flagged orphaned;
        it is now tiered "unknown" and excluded from this result instead
        (never reported as unused when a check failed to run).
    confirm_orphans_detailed(candidate_paths, project_only=True, registry=None,
                              max_referencers=10, max_verse_matches=5) -> dict
        ADDITIVE. {path: {tier, reason, registry_checked,
        registry_referencers, registry_referencer_count,
        registry_referencers_capped, verse_checked, verse_matches,
        verse_matches_capped}} for EVERY candidate examined (not just
        orphans). tier is one of "referenced", "referenced_verse",
        "likely_unused", "unknown" — see the function docstring.
    get_referencer_details(pkg, project_only=True, registry=None) -> list[str]
        Project referencer package paths for one asset (for "who uses this").
        UNCHANGED.
    load_verse_source_text() -> str
        UNCHANGED. Concatenated, lowercased Verse source text (or "" if the
        scan is unavailable this run).
    load_verse_source_files() -> list[dict]
        ADDITIVE per-file accessor: [{"path": <relative path>, "text":
        <lowercased content>}, ...] — same underlying scan/cache as
        load_verse_source_text(), just not flattened, so callers can report
        WHICH file matched.
    verse_scan_available() -> bool
        ADDITIVE. True if the Verse scan actually ran this process (project
        root resolved), False if it could not run at all. Lets callers tell
        "checked, found nothing" apart from "could not check".
"""

import glob
import os
import unreal

# CANONICAL skip-list, imported (guarded) by material_browser.py,
# texture_finder.py, niagara_inspector.py, dependency_viewer.py, and
# asset_sweep.py. "/Temp/" is UEFN's transient/scratch mount — a referencer
# living there is not a real in-use signal (the reference itself is
# transient), so it must never keep a candidate asset out of the orphan
# list. material_browser.py already excluded it; moderation_scanner.py's
# independently-derived _ENGINE_EXCLUDE_PREFIXES agrees. This is the one
# deliberate behavior change in this pass: confirm_orphans() below now
# treats /Temp/-only referencers the same way material_browser already did.
_SKIP_PREFIXES = ("/Engine/", "/Script/", "/Temp/")
_VERSE_SKIP = {"Saved", "Intermediate", "__pycache__", ".uefn_bridge"}

# Per-process cache of the resolved Verse scan: a dict with keys
# {"available": bool, "content_root": str|None, "files": [{"path", "text"}]}.
# Computed once by _compute_verse_scan(); load_verse_source_text() (legacy,
# flattened) and load_verse_source_files() (new, per-file) both read from it.
_verse_scan_cache = [None]


def _set_dep_option(opts, names, value=True):
    """Set the first attribute name that exists on an options object. Defensive:
    UEFN's AssetRegistryDependencyOptions attribute names vary across builds."""
    for n in names:
        try:
            if hasattr(opts, n):
                setattr(opts, n, value)
                return True
        except Exception:
            pass
    return False


def _make_ref_options():
    """AssetRegistryDependencyOptions with hard+soft package references enabled.
    Works for both get_dependencies and get_referencers. Never crashes."""
    try:
        opts = unreal.AssetRegistryDependencyOptions()
        _set_dep_option(opts, ("include_hard_package_references", "include_hard_package_data"))
        _set_dep_option(opts, ("include_soft_package_references", "include_soft_package_data"))
        return opts
    except Exception as e:
        unreal.log_warning(f"asset_usage: could not configure ref options — {e}")
        try:
            return unreal.AssetRegistryDependencyOptions()
        except Exception:
            return None


def get_project_prefix():
    """Detect the current project's asset prefix (e.g. '/MyProject/'). Generic —
    derived from a level actor or the world path; never hard-codes a project."""
    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        actors = subsystem.get_all_level_actors()
        if actors:
            parts = actors[0].get_path_name().split("/")
            if len(parts) >= 2 and parts[1]:
                return "/" + parts[1] + "/"
    except Exception:
        pass
    try:
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        world = subsystem.get_world()
        if world:
            parts = world.get_path_name().split("/")
            if len(parts) >= 2 and parts[1]:
                return "/" + parts[1] + "/"
    except Exception:
        pass
    return "/Game/"


def _resolve_unreal_project_dir_with_content():
    """
    SECONDARY fallback only (see load_verse_source_text): ask the live UEFN
    session for ``unreal.Paths.project_dir()``.

    DEMOTED from primary (was preferred in 0.0.418): in UEFN this API
    resolves to the EMBEDDED ENGINE's project — FortniteGame in the game
    install tree — NOT the user's island project, which is only a mounted
    plugin. Trusting it unconditionally scanned the game install and
    reported every real user asset as a ghost. So the result is now
    validated: only accepted if it exists on disk, contains a ``Content``
    subdirectory (matching the walkup fallback's contract), AND contains a
    ``*.uefnproject`` file (FortniteGame has a ``.uproject`` and never a
    ``.uefnproject``).

    Returns a normalized full path, or ``None`` so the caller falls through
    to the legacy walkup.
    """
    try:
        import unreal
        raw = unreal.Paths.project_dir()
        if not raw:
            return None
        full = os.path.normpath(unreal.Paths.convert_relative_path_to_full(raw))
        if not (os.path.isdir(full) and os.path.isdir(os.path.join(full, "Content"))):
            return None
        if not any(entry.endswith(".uefnproject") for entry in os.listdir(full)):
            return None
        return full
    except Exception:
        return None


def _walkup_project_root():
    """
    Candidate 1 (kept from 0.0.424): filesystem walkup anchored at
    ``__file__`` to the first ancestor containing a ``*.uefnproject`` file
    — the staged bridge scripts always live under that project's
    ``Content/Python/``, so this is authoritative regardless of what
    UEFN's embedded engine has open. Returns ``None`` if no
    ``.uefnproject`` is found within the bounded walkup.
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidate = script_dir
    for _ in range(10):
        try:
            entries = os.listdir(candidate)
        except Exception:
            entries = []
        if any(entry.endswith(".uefnproject") for entry in entries):
            return candidate
        parent = os.path.dirname(candidate)
        if parent == candidate:
            break
        candidate = parent
    return None


def _get_island_sample_packages(project_prefix, limit=25):
    """
    Enumerate up to ``limit`` package names under ``project_prefix`` from
    the Asset Registry — used both as validation-gate samples and as the
    source packages for the asset-anchored candidate. Returns ``[]`` on any
    failure or when the prefix is unavailable; callers must treat that as
    "no samples available", not an error.
    """
    if not project_prefix:
        return []
    try:
        registry = unreal.AssetRegistryHelpers.get_asset_registry()
        assets = registry.get_assets_by_path(project_prefix, recursive=True)
        return [str(a.package_name) for a in assets[:limit]]
    except Exception:
        return []


def _derive_content_root_from_asset_path(pkg, disk_path):
    """
    Given an island package path like ``/YourProject/Props/Anim/X`` and
    its real on-disk file (e.g.
    ``.../YourProject/Content/Props/Anim/X.uasset``), strip the
    package-relative tail to recover ``.../YourProject/Content``. Returns
    ``None`` if ``disk_path`` doesn't end with the expected tail.
    """
    if not pkg or not disk_path:
        return None
    parts = pkg.strip("/").split("/")
    if len(parts) < 2:
        return None
    rel_parts = parts[1:]  # drop the island-name segment
    ext = os.path.splitext(disk_path)[1] or ".uasset"
    tail = "/".join(rel_parts) + ext
    norm_disk = disk_path.replace("\\", "/")
    if not norm_disk.lower().endswith(tail.lower()):
        return None
    content_root = norm_disk[: -len(tail)].rstrip("/")
    return os.path.normpath(content_root) if content_root else None


def _resolve_project_root_via_asset_anchor(sample_pkgs):
    """
    Candidate 2 (NEW) — authoritative when running engine-side. Because
    UEFN copies the project's Content/Python into the embedded FortniteGame
    install and executes scripts FROM THERE, ``__file__`` anchoring can
    resolve into the install tree instead of the user's real project. This
    candidate instead asks Unreal directly where ONE island asset actually
    lives on disk and derives the project root from that real path.

    Tries, per sample package: (a)
    ``unreal.PackageName.long_package_name_to_filename``, then (b)
    ``unreal.load_asset``/``EditorAssetLibrary.load_asset`` +
    ``unreal.SystemLibrary.get_system_path`` — every API guarded with
    hasattr/getattr. Returns ``None`` if nothing resolves.
    """
    if not sample_pkgs:
        return None
    for pkg in sample_pkgs[:5]:
        pkg = str(pkg)
        disk_path = None

        try:
            package_name_cls = getattr(unreal, "PackageName", None)
            fn = getattr(package_name_cls, "long_package_name_to_filename", None)
            if fn is not None:
                disk_path = fn(pkg, ".uasset")
        except Exception:
            disk_path = None

        if not disk_path:
            try:
                asset = None
                loader = getattr(unreal, "load_asset", None)
                if loader is not None:
                    asset = loader(pkg)
                if asset is None:
                    eal = getattr(unreal, "EditorAssetLibrary", None)
                    if eal is not None and hasattr(eal, "load_asset"):
                        asset = eal.load_asset(pkg)
                if asset is not None:
                    sysapi = getattr(unreal, "SystemLibrary", None)
                    if sysapi is not None and hasattr(sysapi, "get_system_path"):
                        disk_path = sysapi.get_system_path(asset)
            except Exception:
                disk_path = None

        if not disk_path:
            continue

        try:
            if hasattr(unreal, "Paths"):
                disk_path = unreal.Paths.convert_relative_path_to_full(disk_path)
        except Exception:
            pass

        content_root = _derive_content_root_from_asset_path(pkg, disk_path)
        if content_root:
            project_root = os.path.dirname(content_root)
            if os.path.isdir(project_root):
                return project_root
    return None


def _default_location_project_roots(project_prefix):
    """
    Candidate 3 (NEW) — probe conventional UEFN project locations for a
    project named after the island prefix (``/YourProject/`` -> ``YourProject``):
    ``~/Documents/Fortnite Projects/<Name>``,
    ``~/OneDrive/Documents/Fortnite Projects/<Name>``, and any
    ``~/OneDrive*/Documents/Fortnite Projects/<Name>`` match (OneDrive can
    redirect Documents under a tenant-specific folder name). Only ever a
    starting guess — the validation gate still decides the winner.
    """
    if not project_prefix:
        return []
    project_name = project_prefix.strip("/")
    if not project_name:
        return []

    home = os.path.expanduser("~")
    probes = [
        os.path.join(home, "Documents", "Fortnite Projects", project_name),
        os.path.join(home, "OneDrive", "Documents", "Fortnite Projects", project_name),
    ]
    try:
        probes.extend(glob.glob(os.path.join(home, "OneDrive*", "Documents", "Fortnite Projects", project_name)))
    except Exception:
        pass

    results = []
    seen = set()
    for proj_dir in probes:
        norm = os.path.normpath(proj_dir)
        if norm in seen or not os.path.isdir(norm):
            continue
        seen.add(norm)
        try:
            has_uefnproject = any(entry.endswith(".uefnproject") for entry in os.listdir(norm))
        except Exception:
            has_uefnproject = False
        if has_uefnproject and os.path.isdir(os.path.join(norm, "Content")):
            results.append(norm)
    return results


def _validate_project_root(project_root, project_prefix, sample_pkgs):
    """
    VALIDATION GATE applied uniformly to every candidate. Stats up to 25
    island-prefix registry assets against ``<project_root>/Content``:
    passes as soon as one resolves to a real ``.uasset``/``.umap`` on disk
    (a wrong tree — e.g. the FortniteGame install — will match zero of
    them). Falls back to a lighter ``.uefnproject``-presence check on
    ``project_root`` itself when no registry samples are available.
    """
    if not project_root or not os.path.isdir(project_root):
        return False

    if sample_pkgs and project_prefix:
        content_dir = os.path.join(project_root, "Content")
        for pkg in sample_pkgs[:25]:
            pkg = str(pkg)
            if not pkg.startswith(project_prefix):
                continue
            relative = pkg[len(project_prefix):]
            if not relative:
                continue
            base_path = os.path.join(content_dir, *relative.split("/"))
            if os.path.isfile(base_path + ".uasset") or os.path.isfile(base_path + ".umap"):
                return True
        return False

    try:
        return any(entry.endswith(".uefnproject") for entry in os.listdir(project_root))
    except Exception:
        return False


def _compute_verse_scan():
    """One-shot resolution + walk (see load_verse_source_text's former
    docstring, preserved below) producing a dict:
        {"available": bool, "content_root": str|None,
         "files": [{"path": <relative-to-content_root>, "text": <lowercased>}]}
    "available" is the signal load_verse_source_text() used to collapse into
    an empty string: False means the project content root could not be
    verified this run (Verse cross-reference check unavailable), NOT that it
    was verified and simply has zero .verse files (that case is "available":
    True, "files": []). Callers that need to tell those two apart (a real
    "checked, found nothing" vs. "could not check") use verse_scan_available()
    rather than inspecting the flattened text.
    """
    result = {"available": False, "content_root": None, "files": []}
    try:
        project_prefix = get_project_prefix()
        sample_pkgs = _get_island_sample_packages(project_prefix)

        candidates = []

        walkup = _walkup_project_root()
        if walkup:
            candidates.append(walkup)

        anchored = _resolve_project_root_via_asset_anchor(sample_pkgs)
        if anchored:
            candidates.append(anchored)

        candidates.extend(_default_location_project_roots(project_prefix))

        unreal_root = _resolve_unreal_project_dir_with_content()
        if unreal_root:
            candidates.append(unreal_root)

        content_root = None
        for cand in candidates:
            if _validate_project_root(cand, project_prefix, sample_pkgs):
                content_root = cand
                break

        if content_root:
            files = []
            for dirpath, dirnames, filenames in os.walk(content_root):
                dirnames[:] = [d for d in dirnames if d not in _VERSE_SKIP and not d.startswith(".")]
                for fn in filenames:
                    if fn.endswith(".verse"):
                        full_path = os.path.join(dirpath, fn)
                        try:
                            with open(full_path, "r", encoding="utf-8", errors="replace") as vf:
                                raw = vf.read()
                        except Exception:
                            continue
                        rel_path = os.path.relpath(full_path, content_root).replace("\\", "/")
                        files.append({"path": rel_path, "text": raw.lower()})
            result["available"] = True
            result["content_root"] = content_root
            result["files"] = files
            unreal.log(f"asset_usage: Verse scan — {len(files)} .verse file(s)")
        else:
            unreal.log_warning(
                "asset_usage: Verse scan root could not be verified — "
                "Verse cross-reference check unavailable this run."
            )
    except Exception as ve:
        unreal.log_warning(f"asset_usage: Verse scan failed — {ve}")
    return result


def _get_verse_scan():
    """Cached accessor for the resolved Verse scan dict — computed once per
    process via _compute_verse_scan()."""
    if _verse_scan_cache[0] is None:
        _verse_scan_cache[0] = _compute_verse_scan()
    return _verse_scan_cache[0]


def load_verse_source_text():
    """Concatenated, lowercased text of every .verse file under the project's
    root (walks the whole project, not just Content/, so devices/plugins are
    covered too). Cached per process. Used as a belt-and-suspenders check for
    assets referenced by name in Verse code rather than via a serialized
    hard/soft reference.

    UNCHANGED behavior/signature — kept for backward compatibility. Now a
    thin flattening wrapper over _get_verse_scan()/_compute_verse_scan();
    see load_verse_source_files() for the per-file form and
    verse_scan_available() to distinguish "ran, found nothing" from
    "could not run".

    ENGINE-COPY EXECUTION MODE: UEFN copies the project's Content/Python into
    the embedded engine install (.../FortniteGame/Content/Python/) and
    EXECUTES scripts from there, so plain __file__-anchored walkup alone is
    not reliably sufficient (see _resolve_unreal_project_dir_with_content).
    Every candidate is validated against real registry assets on disk before
    being trusted; if NONE validates, the Verse cross-reference check is
    simply treated as unavailable (empty text) rather than falling back to a
    legacy filesystem guess that could walk the install tree.
    """
    scan = _get_verse_scan()
    if not scan.get("available"):
        return ""
    return "\n".join(f["text"] for f in scan.get("files", []))


def load_verse_source_files():
    """ADDITIVE per-file accessor. Returns a list of
    {"path": <path relative to the resolved project content root>,
     "text": <lowercased file content>} for every .verse file found this
    process, or [] if the scan is unavailable (see verse_scan_available()).
    Same underlying cached scan as load_verse_source_text() — no extra
    filesystem work. Lets callers report WHICH Verse file (and, by searching
    "text", which line) matched, instead of only "somewhere in Verse"."""
    scan = _get_verse_scan()
    return [dict(f) for f in scan.get("files", [])]


def verse_scan_available():
    """ADDITIVE. True if the Verse cross-reference scan actually ran this
    process (a project content root was resolved and validated), False if it
    could not run at all. A candidate asset must never be reported as
    "likely_unused" when this is False for its evaluation — that would
    conflate "checked, found nothing" with "could not check"."""
    return bool(_get_verse_scan().get("available"))


def _get_referencers_raw(registry, pkg, ref_options):
    """Low-level get_referencers call with success/failure kept SEPARATE from
    an empty result. Returns (refs, ok): refs is a list of str package paths
    (possibly empty), ok is False only when the call itself raised — an
    empty list from a successful call is a real "no referencers" signal, not
    a failure, and must not be treated as one."""
    try:
        refs = registry.get_referencers(pkg, ref_options)
        return ([str(r) for r in refs] if refs else []), True
    except Exception as e:
        unreal.log_warning(f"asset_usage: get_referencers failed for {pkg} — {e}")
        return [], False


def _filter_project_referencers(refs, pkg, project_prefix, project_only):
    """Apply the shared skip-prefix + project-scope + self-exclusion rules to
    a raw referencer list. Pure filtering, no registry call."""
    out = [r for r in refs if not any(r.startswith(p) for p in _SKIP_PREFIXES)]
    if project_only and project_prefix:
        out = [r for r in out if r.startswith(project_prefix)]
    return [r for r in out if r != pkg]


def get_project_referencers(registry, pkg, ref_options, project_prefix, project_only=True):
    """Project-scoped reverse referencers for one package path (excludes self,
    /Engine, /Script). Returns a list of package-path strings. UNCHANGED
    signature/behavior — a registry error still yields [] here, exactly as
    before, for existing callers (get_referencer_details and anything else
    that only wants a plain list, not error-vs-empty detail)."""
    refs, _ok = _get_referencers_raw(registry, pkg, ref_options)
    if not refs:
        return []
    return _filter_project_referencers(refs, pkg, project_prefix, project_only)


def _search_verse_matches(verse_scan, patterns, max_matches=5):
    """Search the cached per-file Verse text for any of `patterns` (already
    lowercased). Returns (matches, capped): matches is a list of
    {"file": <relative path>, "line": <1-based int|None>, "pattern": <the
    matched pattern string>}, one entry per matching file, capped at
    max_matches; capped is True (never silently) whenever more files matched
    than were kept."""
    matches = []
    total_matched_files = 0
    for finfo in verse_scan.get("files", []):
        text = finfo.get("text", "")
        hit_pattern = None
        for pat in patterns:
            if pat and pat in text:
                hit_pattern = pat
                break
        if hit_pattern is None:
            continue
        total_matched_files += 1
        if len(matches) < max_matches:
            idx = text.find(hit_pattern)
            line_no = text.count("\n", 0, idx) + 1 if idx >= 0 else None
            matches.append({"file": finfo.get("path"), "line": line_no, "pattern": hit_pattern})
    return matches, total_matched_files > len(matches)


def confirm_orphans_detailed(candidate_paths, project_only=True, registry=None,
                              max_referencers=10, max_verse_matches=5):
    """ADDITIVE, richer sibling of confirm_orphans() — returns a confidence
    tier PLUS the evidence behind it for EVERY candidate examined (not just
    the orphaned subset confirm_orphans() returns). Existing callers of
    confirm_orphans() are unaffected; this is for callers (asset_sweep.py)
    that want to show WHY a verdict was reached, not just the verdict.

    Tiers:
        "referenced"        — a hard/soft registry referencer was found
                               (registry check ran successfully and found at
                               least one project referencer).
        "referenced_verse"  — no registry referencer, but the asset's short
                               name, full package path, or object-path form
                               ("/Prefix/Path/Asset.Asset") appears in the
                               project's Verse source.
        "likely_unused"     — the registry check AND the Verse scan both ran
                               successfully and found nothing. Still not
                               proof of deletion safety: dynamic string-path
                               runtime loads (LoadObject / Verse LoadAsset
                               with a computed path) are undetectable by
                               static analysis.
        "unknown"           — one or more checks could not run (a registry
                               error, or the Verse scan root could not be
                               resolved this session). NEVER conflated with
                               "likely_unused" — this asset was not confirmed
                               safe, it simply could not be fully evaluated.

    Returns {path: {
        "tier": str,
        "reason": str,                              # human-readable summary
        "registry_checked": bool,
        "registry_referencers": [str, ...],         # capped, project-scoped
        "registry_referencer_count": int,            # true total, pre-cap
        "registry_referencers_capped": bool,
        "verse_checked": bool,
        "verse_matches": [{"file": str, "line": int|None, "pattern": str}, ...],
        "verse_matches_capped": bool,
    }}
    """
    result = {}
    if not candidate_paths:
        return result
    if registry is None:
        registry = unreal.AssetRegistryHelpers.get_asset_registry()
    ref_options = _make_ref_options()
    project_prefix = get_project_prefix() if project_only else None
    verse_scan = _get_verse_scan()
    verse_available = bool(verse_scan.get("available"))

    for pkg in candidate_paths:
        pkg = str(pkg)
        raw_refs, registry_ok = _get_referencers_raw(registry, pkg, ref_options)
        filtered = _filter_project_referencers(raw_refs, pkg, project_prefix, project_only)

        entry = {
            "registry_checked": registry_ok,
            "registry_referencers": [],
            "registry_referencer_count": 0,
            "registry_referencers_capped": False,
            "verse_checked": False,
            "verse_matches": [],
            "verse_matches_capped": False,
        }

        if registry_ok and filtered:
            capped_list = filtered[:max_referencers]
            entry["registry_referencers"] = capped_list
            entry["registry_referencer_count"] = len(filtered)
            entry["registry_referencers_capped"] = len(filtered) > max_referencers
            entry["tier"] = "referenced"
            note = f"referenced by {len(filtered)} project package(s) via the Asset Registry"
            if entry["registry_referencers_capped"]:
                note += f" (showing first {max_referencers})"
            entry["reason"] = note
            result[pkg] = entry
            continue

        # Registry found nothing (or the check itself failed) — fall through
        # to the Verse cross-check, same order as the original confirm_orphans().
        short_name = pkg.rsplit("/", 1)[-1]
        patterns = []
        if short_name:
            patterns.append(short_name.lower())
        patterns.append(pkg.lower())
        if short_name:
            patterns.append(f"{pkg}.{short_name}".lower())

        if verse_available:
            entry["verse_checked"] = True
            matches, capped = _search_verse_matches(verse_scan, patterns, max_verse_matches)
            entry["verse_matches"] = matches
            entry["verse_matches_capped"] = capped
            if matches:
                entry["tier"] = "referenced_verse"
                files_note = ", ".join(sorted({m["file"] for m in matches})[:3])
                entry["reason"] = (
                    f"matched in Verse source ({files_note}"
                    f"{', +more' if capped else ''})"
                )
                result[pkg] = entry
                continue

        if registry_ok and verse_available:
            entry["tier"] = "likely_unused"
            entry["reason"] = "no references found (registry + Verse scan both checked, found nothing)"
        else:
            entry["tier"] = "unknown"
            missing = []
            if not registry_ok:
                missing.append("registry lookup failed")
            if not verse_available:
                missing.append("Verse scan root unresolved")
            entry["reason"] = "could not fully evaluate — " + "; ".join(missing)
        result[pkg] = entry

    return result


def confirm_orphans(candidate_paths, project_only=True, registry=None):
    """Given candidate 'unused' package paths, return {path: reason} ONLY for
    those with no project references anywhere (registry referencers + Verse
    source text). Any candidate that IS referenced is omitted and must be kept.

    UNCHANGED signature and return shape — existing callers (asset_sweep.py,
    niagara_inspector.py, material_browser.py, texture_finder.py) all use
    this via plain `pkg in confirmed` membership checks and are unaffected.
    Now implemented on top of confirm_orphans_detailed() and is slightly MORE
    conservative than the original: a candidate tiered "unknown" (a check
    failed to run) is no longer included here. Previously a registry error
    was silently treated as "no referencers" and such a candidate could be
    flagged orphaned if Verse also came back empty — that was exactly the
    false-"dead"-verdict risk this module exists to prevent. Callers that
    want to see "unknown" candidates explicitly should use
    confirm_orphans_detailed() instead."""
    result = {}
    if not candidate_paths:
        return result
    detailed = confirm_orphans_detailed(candidate_paths, project_only=project_only, registry=registry)
    for pkg, entry in detailed.items():
        if entry.get("tier") == "likely_unused":
            result[pkg] = "no references found (registry + Verse scan)"
    return result


def get_referencer_details(pkg, project_only=True, registry=None):
    """Convenience: project referencer package paths for one asset."""
    if registry is None:
        registry = unreal.AssetRegistryHelpers.get_asset_registry()
    ref_options = _make_ref_options()
    project_prefix = get_project_prefix() if project_only else None
    return get_project_referencers(registry, str(pkg), ref_options, project_prefix, project_only)
