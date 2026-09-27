#!/usr/bin/env python3
"""
Phase 1+2 docs migration for the gbrain refactor.

Walks a repo, for each .md file:
  - Adds/updates YAML frontmatter (type, status, last-updated, tags, related)
  - Converts markdown links [text](rel/path.md) to wikilinks [[slug|text]]
  - Idempotent: if frontmatter already present, merges instead of duplicating
  - Adds discovered cross-doc references to `related:` field

Tags and any final manual review are NOT done here — that's a Claude pass.

Usage:
  migrate-docs.py <repo-dir> <namespace>

Example:
  migrate-docs.py ~/swx-model-router-saas swx-model-router-saas
"""
import sys
import os
import re
import subprocess
import yaml
from pathlib import Path
from urllib.parse import urlparse, unquote

# -------- filename casing ----------
# Filenames that MUST stay uppercase. Trimmed AGGRESSIVELY because gbrain
# v0.18.2's link extractor silently skips ANY file with uppercase letters
# in the filename (verified bug: README.md, CONTRIBUTING.md, CHANGELOG.md,
# even arbitrary FOO.md — none get their wikilinks/markdown links extracted).
# Only files that AI tools/CLIs look up by exact-case name should stay up.
PRESERVE_CASE = {
    "CLAUDE.md",                # Claude Code project memory (exact-name lookup)
    "AGENTS.md", "AGENT_INSTRUCTIONS.md",
    "GEMINI.md", "COPILOT.md",
    "LICENSE", "LICENSE.md",
}

def lowercase_md_files(repo_root: Path):
    """Rename uppercase .md files to lowercase via `git mv` (preserves history).
    Skips PRESERVE_CASE convention files. Returns list of renames made."""
    renames = []
    excludes = (
        "/node_modules/", "/.git/", "/build/", "/dist/", "/_deps/",
        "/.next/", "/dependencies/", "/.claude/", "/target/",
        "/.clerk/", "/.tmp/",
    )
    for p in sorted(repo_root.rglob("*")):
        if not p.is_file() or p.suffix.lower() != ".md":
            continue
        path_str = "/" + str(p.relative_to(repo_root)) + "/"
        if any(ex in path_str for ex in excludes):
            continue
        if p.name in PRESERVE_CASE:
            continue
        if p.name == p.name.lower():
            continue
        new_name = p.name.lower()
        new_path = p.with_name(new_name)
        # case-only rename on case-insensitive FS would clobber; use 2-step
        rel_old = str(p.relative_to(repo_root))
        rel_new = str(new_path.relative_to(repo_root))
        # tmp intermediate to handle case-insensitive filesystems safely
        tmp_name = "." + new_name + ".__caserename__"
        tmp_path = p.with_name(tmp_name)
        rel_tmp = str(tmp_path.relative_to(repo_root))
        try:
            subprocess.check_call(
                ["git", "-C", str(repo_root), "mv", rel_old, rel_tmp],
                stderr=subprocess.DEVNULL
            )
            subprocess.check_call(
                ["git", "-C", str(repo_root), "mv", rel_tmp, rel_new],
                stderr=subprocess.DEVNULL
            )
            renames.append((rel_old, rel_new))
        except subprocess.CalledProcessError as e:
            print(f"  ! rename failed: {rel_old} -> {rel_new}: {e}", file=sys.stderr)
    return renames

# -------- path → type heuristic ----------
def infer_type(rel_path: str) -> str:
    p = rel_path.lower()
    name = os.path.basename(p)
    if name in ("todo.md", "todos.md", "roadmap.md"):
        return "todo"
    if name == "readme.md":
        return "readme"
    if "/decisions/" in p or re.search(r"\b\d{4}-[a-z0-9-]+\.md$", p):
        return "decision"
    if "/runbooks/" in p or "/runbook" in p:
        return "runbook"
    if "/history/" in p:
        return "history"
    if "/spec" in p or name.endswith(".spec.md"):
        return "spec"
    if name in ("design.md", "claude.md", "agents.md", "agent_instructions.md", "gemini.md"):
        return "reference"
    if "/docs/" in p or p.startswith("docs/") or "design" in name:
        return "design"
    return "reference"

def infer_status(rel_path: str) -> str:
    if "/history/" in rel_path.lower():
        return "historical"
    return "active"

def git_last_updated(repo_root: Path, rel_path: str) -> str:
    try:
        out = subprocess.check_output(
            ["git", "-C", str(repo_root), "log", "-1", "--format=%cs", "--", rel_path],
            stderr=subprocess.DEVNULL, text=True
        ).strip()
        return out or "unknown"
    except Exception:
        return "unknown"

# -------- frontmatter parsing ----------
FM_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)

def split_frontmatter(text: str):
    m = FM_RE.match(text)
    if m:
        try:
            existing = yaml.safe_load(m.group(1)) or {}
        except yaml.YAMLError:
            existing = {}
        body = text[m.end():]
        return existing, body
    return {}, text

def render_frontmatter(fm: dict) -> str:
    # Stable key order for diffability
    order = ["type", "status", "last-updated", "tags", "related"]
    ordered = {k: fm[k] for k in order if k in fm}
    extras = {k: v for k, v in fm.items() if k not in order}
    full = {**ordered, **extras}
    body = yaml.safe_dump(full, default_flow_style=False, sort_keys=False).rstrip() + "\n"
    return f"---\n{body}---\n"

# -------- wikilink conversion ----------
# matches [text](target) where target is NOT a full URL/anchor/mailto
MD_LINK_RE = re.compile(
    r"(?<!\!)\[([^\]\n]+)\]\(([^)\n]+)\)"
)

def is_external(target: str) -> bool:
    if target.startswith("#"):
        return True
    if target.startswith(("http://", "https://", "mailto:", "tel:", "ftp://")):
        return True
    p = urlparse(target)
    if p.scheme:
        return True
    return False

def normalize_slug(p: str) -> str:
    # strip .md, lowercase, slashes preserved
    p = re.sub(r"\.md$|\.MD$", "", p)
    return p.lower()

def resolve_wikilink_target(repo_root: Path, file_rel: str, link_target: str):
    """
    Resolve a markdown link target to:
      (wikilink_target, brain_slug)
    where wikilink_target is the FILE-RELATIVE path (no .md, lowercased) that
    gbrain's fs extractor uses to resolve the link, and brain_slug is the
    full namespaced slug for the `related:` frontmatter list.

    Returns (None, None) if target is external, non-md, or outside the repo.
    """
    target_clean = link_target.split("#", 1)[0]
    target_clean = unquote(target_clean)
    if not target_clean:
        return None, None
    if is_external(link_target):
        return None, None
    if not (target_clean.endswith(".md") or target_clean.endswith(".MD")):
        return None, None
    # validate target resolves inside repo (for `related:` slug calc only)
    base_dir = (repo_root / file_rel).parent
    abs_target = (base_dir / target_clean).resolve()
    try:
        rel_to_repo = abs_target.relative_to(repo_root)
    except ValueError:
        return None, None
    # wikilink target = file-relative path with .md stripped and lowercased
    # (gbrain auto-lowercases slugs, and resolves wikilinks relative to the
    # file's own directory). Preserve any leading `../` for upward refs.
    wl_target = normalize_slug(target_clean)
    return wl_target, None  # brain_slug returned by caller for `related:`

def convert_links(body: str, repo_root: Path, file_rel: str, namespace: str):
    """Returns (new_body, list_of_brain_slugs_for_related_frontmatter)."""
    related = []

    def repl(m):
        text = m.group(1)
        target = m.group(2)
        wl_target, _ = resolve_wikilink_target(repo_root, file_rel, target)
        if wl_target is None:
            return m.group(0)  # leave external/non-md links unchanged
        # Compute brain slug for `related:` frontmatter (full namespaced path)
        target_clean = target.split("#", 1)[0]
        base_dir = (repo_root / file_rel).parent
        abs_target = (base_dir / unquote(target_clean)).resolve()
        rel_to_repo = abs_target.relative_to(repo_root)
        brain_slug = f"{namespace}/{normalize_slug(str(rel_to_repo))}"
        related.append(brain_slug)
        # Use file-relative wikilink target (not the brain slug). gbrain's fs
        # extractor resolves wikilinks relative to the file's directory.
        # Drop the display alias when text matches the basename (cleaner).
        basename = os.path.basename(wl_target)
        if text.strip().lower() == basename.lower():
            return f"[[{wl_target}]]"
        return f"[[{wl_target}|{text}]]"

    new_body = MD_LINK_RE.sub(repl, body)
    seen = set()
    related_unique = []
    for r in related:
        if r not in seen:
            seen.add(r)
            related_unique.append(r)
    return new_body, related_unique

# -------- per-file processor ----------
def process_file(path: Path, repo_root: Path, namespace: str) -> dict:
    rel = str(path.relative_to(repo_root))
    text = path.read_text()
    existing_fm, body = split_frontmatter(text)

    new_body, related = convert_links(body, repo_root, rel, namespace)

    # Build frontmatter — preserve any existing keys, set/override our standard ones
    fm = dict(existing_fm) if isinstance(existing_fm, dict) else {}
    fm.setdefault("type", infer_type(rel))
    fm.setdefault("status", infer_status(rel))
    fm["last-updated"] = git_last_updated(repo_root, rel)
    fm.setdefault("tags", [])
    # merge related: union with existing
    existing_related = fm.get("related", []) or []
    if not isinstance(existing_related, list):
        existing_related = []
    fm["related"] = sorted(set(existing_related) | set(related))

    out = render_frontmatter(fm) + new_body
    if out != text:
        path.write_text(out)
        return {"path": rel, "changed": True, "links_converted": len(related)}
    return {"path": rel, "changed": False, "links_converted": 0}

# -------- main ----------
def main():
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    repo_root = Path(sys.argv[1]).expanduser().resolve()
    namespace = sys.argv[2]

    if not (repo_root / ".git").exists():
        print(f"Not a git repo: {repo_root}", file=sys.stderr)
        sys.exit(2)

    excludes = (
        "/node_modules/", "/.git/", "/build/", "/dist/", "/_deps/",
        "/.next/", "/dependencies/", "/.claude/", "/target/",
        "/.clerk/", "/.tmp/",
    )

    md_files = []
    for p in repo_root.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() != ".md":
            continue
        path_str = "/" + str(p.relative_to(repo_root)) + "/"
        if any(ex in path_str for ex in excludes):
            continue
        md_files.append(p)

    print(f"# {namespace}: {len(md_files)} files")

    # Phase 0: lowercase non-convention .md filenames so wikilinks resolve
    renames = lowercase_md_files(repo_root)
    if renames:
        print(f"  [phase 0] renamed {len(renames)} files to lowercase:")
        for old, new in renames:
            print(f"    {old} -> {new}")
        # rebuild md_files list after rename
        md_files = []
        for p in repo_root.rglob("*"):
            if not p.is_file() or p.suffix.lower() != ".md":
                continue
            path_str = "/" + str(p.relative_to(repo_root)) + "/"
            if any(ex in path_str for ex in excludes):
                continue
            md_files.append(p)

    total_changed = 0
    total_links = 0
    for p in sorted(md_files):
        result = process_file(p, repo_root, namespace)
        if result["changed"]:
            total_changed += 1
            total_links += result["links_converted"]
            print(f"  ✓ {result['path']}  (+{result['links_converted']} wikilinks)")
        else:
            print(f"  · {result['path']}  (unchanged)")
    print(f"# Done: {total_changed}/{len(md_files)} files changed, {total_links} wikilinks created")

if __name__ == "__main__":
    main()
