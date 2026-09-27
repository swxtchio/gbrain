#!/usr/bin/env python3
"""
Tag suggester pass. For each .md file with empty tags in frontmatter,
scan the body for keyword hits in the curated vocabulary and assign
the top 1-5 tags. Idempotent: if tags is already populated, leave alone.

Usage:
  suggest-tags.py <repo-dir>
"""
import sys
import os
import re
from pathlib import Path
import yaml

# Curated vocabulary with keyword patterns. Order matters: more-specific
# matches earlier so they take priority when filling 5 slots.
VOCAB = [
    # domain
    ("srtx",            [r"\bsrtx\b", r"srt(x)?[-_ ]?engine", r"srtx_eng"]),
    ("srt",             [r"\bsrt\b", r"secure reliable transport", r"libsrt"]),
    ("dpdk",            [r"\bdpdk\b", r"kernel[- ]bypass", r"hugepage"]),
    ("clerk",           [r"\bclerk\b", r"clerk_secret_key"]),
    ("auth",            [r"\bauth\b|authn|authz|authentication|authorization|jwt|oauth|rbac"]),
    ("billing",         [r"\bbilling\b|credit balance|stripe|invoic"]),
    ("pipeline",        [r"\bpipeline\b|stage graph|customer pipeline"]),
    ("orchestration",   [r"orchestration|orchestrator"]),
    ("nats",            [r"\bnats\b|nats[- ]subject|jetstream"]),
    ("kms",             [r"\bkms\b|key management|encryption key"]),
    ("action-gateway",  [r"action[- ]gateway|action gateway"]),
    ("blox",            [r"\bblox\b|block runtime"]),
    ("mcp",             [r"\bmcp\b|model context protocol|mcp[- ]server"]),
    ("sse",             [r"\bsse\b|server[- ]sent event|event[- ]stream"]),
    ("chat",            [r"\bchat\b|chat[- ]intent|chat[- ]stream"]),
    # concern
    ("architecture",    [r"architecture|architectural|system design"]),
    ("security",        [r"\bsecurity\b|threat|csrf|xss|injection|hardening"]),
    ("performance",     [r"performance|latency|throughput|benchmark"]),
    ("reliability",     [r"reliab|resilien|fault[- ]toleran|retry|backpressure"]),
    ("observability",   [r"observab|metric|datadog|prometheus|telemetr|trace"]),
    ("testing",         [r"\btesting\b|unit test|integration test|gtest|pytest"]),
    ("ci-cd",           [r"\bci\b|continuous integration|github actions|gworkflow|deploy"]),
    # lifecycle
    ("mvp",             [r"\bmvp\b"]),
    ("pilot",           [r"\bpilot\b"]),
    ("ga",              [r"\bga\b|general availability"]),
    ("historical",      [r"\bhistorical\b|legacy|deprecated|archived|superseded"]),
    ("planning",        [r"planning|roadmap"]),
]

FM_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
MAX_TAGS = 5

def suggest(text: str, max_tags: int = MAX_TAGS) -> list:
    body = text.lower()
    scores = []
    for tag, patterns in VOCAB:
        hits = 0
        for pat in patterns:
            hits += len(re.findall(pat, body))
        if hits > 0:
            scores.append((tag, hits))
    # sort by hit count desc, take top max_tags, preserve VOCAB order on ties
    scores.sort(key=lambda x: -x[1])
    return [t for t, _ in scores[:max_tags]]

def process(path: Path):
    text = path.read_text()
    m = FM_RE.match(text)
    if not m:
        return False
    fm = yaml.safe_load(m.group(1)) or {}
    if not isinstance(fm, dict):
        return False
    if fm.get("tags"):
        return False  # already populated
    body = text[m.end():]
    fm["tags"] = suggest(body)
    if not fm["tags"]:
        return False
    # rerender frontmatter preserving order
    order = ["type", "status", "last-updated", "tags", "related"]
    ordered = {k: fm[k] for k in order if k in fm}
    extras = {k: v for k, v in fm.items() if k not in order}
    full = {**ordered, **extras}
    new_fm = yaml.safe_dump(full, default_flow_style=False, sort_keys=False).rstrip() + "\n"
    path.write_text(f"---\n{new_fm}---\n{body}")
    return True

def main():
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    root = Path(sys.argv[1]).expanduser().resolve()
    excludes = (
        "/node_modules/", "/.git/", "/build/", "/dist/", "/_deps/",
        "/.next/", "/dependencies/", "/.claude/", "/target/",
        "/.clerk/", "/.tmp/",
    )
    n_changed = 0
    for p in sorted(root.rglob("*.md")):
        path_str = "/" + str(p.relative_to(root)) + "/"
        if any(ex in path_str for ex in excludes):
            continue
        if process(p):
            n_changed += 1
            # show what tags landed for review
            text = p.read_text()
            m = FM_RE.match(text)
            fm = yaml.safe_load(m.group(1)) or {}
            print(f"  ✓ {p.relative_to(root)} → tags={fm.get('tags')}")
    print(f"# {n_changed} files tagged")

if __name__ == "__main__":
    main()
