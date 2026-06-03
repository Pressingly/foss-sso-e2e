#!/usr/bin/env bash
#
# check-doc-paths.sh — verify every relative file-path reference in the
# repo's load-bearing docs points at a file that actually exists.
#
# Why this exists: CLAUDE.md, README.md, skills.md, TRIAGE.md, and the
# docs/ tree carry path references that decay silently. A spec file gets
# renamed, a doc gets moved to docs/archive/, a helper changes location
# — and the prose still says `tests/auth/foo.spec.ts` or
# `[skills.md](./skills.md)` long after the link is dead. The
# bidirectional spec-coverage audit handles drift for tests ↔ specs;
# this one handles drift for prose ↔ files.
#
# Scope:
#   - Markdown links of shape `[text](./path)` or `[text](../path)` or
#     `[text](path)` where the target looks like a file path (not URL).
#   - Backtick-quoted refs that look like paths and have an extension
#     (e.g. `tests/auth/sso-login.spec.ts`, `docs/spec-coverage.md`).
#
# Not in scope:
#   - URLs (`https://...`, `http://...`, `mailto:`)
#   - Wildcard / glob refs (e.g. `tests/auth/*.spec.ts`, `tests/**/*.ts`)
#   - Backtick refs that don't have a slash AND extension (`Outline`,
#     `auth-token`, `_oauth2_proxy`)
#   - Refs whose path component is interpolated (e.g.
#     `tests/apps/${app}-admin.spec.ts`)
#   - Synthetic / generated paths (e.g. `playwright-report/`)
#
# Exit codes:
#   0 — every checked reference resolves
#   1 — at least one broken reference; details printed to stderr
#
# Add or remove input files via the `DOC_FILES` array below. The intent
# is to cover the docs a contributor lands on first (CLAUDE / README /
# skills / TRIAGE) and everything under docs/. To skip a specific
# false-positive add it to `IGNORED_PATTERNS`.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

# Docs to audit. Glob expansion happens inside the loop so a missing
# docs/ entry doesn't break anything.
DOC_FILES=(
  "$REPO_ROOT/CLAUDE.md"
  "$REPO_ROOT/README.md"
  "$REPO_ROOT/skills.md"
  "$REPO_ROOT/TRIAGE.md"
  "$REPO_ROOT/TESTS.md"
)
# Include every CURRENT .md under docs/. The archive is excluded —
# its contents are time-bound snapshots that reference paths as they
# existed at the time of writing; auditing them would surface false
# positives whenever a file moves or is renamed. Same reason
# `test-review-*` snapshots aren't audited.
while IFS= read -r f; do
  case "$f" in
    */docs/archive/*) continue ;;
    */docs/test-review-*) continue ;;
  esac
  DOC_FILES+=("$f")
done < <(find "$REPO_ROOT/docs" -name '*.md' 2>/dev/null | sort)

# Patterns that look like file paths but aren't (won't be checked).
# Each line is an extended-regex applied to the candidate path.
IGNORED_PATTERNS=(
  # External URLs
  '^https?://'
  '^mailto:'
  # Glob patterns (something/*, **, etc.)
  '\*'
  # Brace expansion (e.g. `tests/apps/{outline,twenty,penpot}-admin.spec.ts`)
  '\{[^}]*,'
  # Placeholder interpolation
  '\$\{'
  '<[a-z-]+>'
  # Anchors-only (e.g. "#section")
  '^#'
  # HTTP / API endpoint paths (server URLs, not files) — refs prose
  # like `/api/users/me/`, `/oauth2/sign_out`, `/god-mode/`,
  # `/auth/email`. These all start with a slash AND a known endpoint
  # prefix.
  '^/(api|oauth2|auth|sign_in|sign_out|signin|signup|sign-in|sign-up|users|workspaces|settings|home|search|drafts|archive|admin|admin-panel|callback|authorize|callback|god-mode|members|teams|invitations|onboarding|create-workspace|profile|dashboard|me)(/|$)'
  # Generated artefacts that don't live in the repo
  '^playwright-report/'
  '^test-results/'
  '^node_modules/'
  # The .env file is user-created, not in the repo
  '^\.env(\.example)?$'
  # External repo paths (foss-server-bundle etc. — these are
  # cross-repo doc pointers, not refs to files in this repo)
  '^foss-server-bundle/'
  # `data/` is a banned directory called out by CLAUDE.md
  # ("Don't add data/ ..."). It's a negative-shaped reference; the
  # file SHOULDN'T exist, and the audit shouldn't complain.
  '^data/$'
  # Example placeholders in the bug-spec format
  '^tests/seed\.spec\.ts$'
  # OpenAPI / generated JSON endpoints referenced in prose
  '/openapi\.json$'
  # Cross-repo refs into foss-server-bundle's provisioning scripts —
  # prose mentions them ("foss-server-bundle's `scripts/provision-admin/plane.py`")
  # without the bundle prefix, but the file lives in the other repo.
  '^scripts/provision-admin/'
  # `.github/workflows/e2e-prod.yml` is documented in README but not
  # yet built (the production workflow is planned, not shipped).
  # Remove this ignore once the file lands.
  '^\.github/workflows/e2e-prod\.yml$'
)

# Extract candidate paths from a single doc file. Emits one
# tab-separated line per candidate:
#
#   <line_no>\t<raw_path>
#
# Two patterns are matched:
#
#   1. Markdown link: `](./path)` or `](path)` — group is the part
#      between `](` and `)`.
#   2. Backtick literal that looks like a path: contains `/` AND ends
#      with a known extension OR is a dir-shaped ref ending in `/`.
extract_candidates() {
  local file=$1
  # Pattern 1 — markdown links.
  grep -nE '\]\(\.?\.?/?[^)]+\)' "$file" 2>/dev/null \
    | sed -E 's/^([0-9]+):.*\]\(([^)]+)\).*/\1\t\2/' \
    || true

  # Pattern 2 — backtick refs with slash and extension.
  # The grep below pulls backtick literals that contain a slash AND
  # either end in a common extension or end in a slash (dir).
  awk -F: '
    {
      line=$1; rest=substr($0, length(line)+2)
      n = 0
      while (match(rest, /`[^`]+`/)) {
        token = substr(rest, RSTART+1, RLENGTH-2)
        # path-shaped: contains a slash, has no whitespace (rules out
        # shell commands like `git log -- tests/` and prose phrases),
        # and either ends in .ext or ends in / (directory).
        if (token ~ /\// && token !~ /[[:space:]]/ && (token ~ /\.(md|ts|tsx|js|json|sh|yml|yaml|cfg|env|sql|py|nginx|conf|md|ipynb)$/ || token ~ /\/$/)) {
          print line "\t" token
        }
        rest = substr(rest, RSTART + RLENGTH)
      }
    }
  ' < <(grep -nE '`[^`]+`' "$file" 2>/dev/null) || true
}

# Check whether a candidate (raw path string from the doc) resolves to
# an existing file/dir. Resolution is relative to the doc's directory.
# Returns 0 if exists, 1 if missing or unparseable.
#
# Emits the resolved path on success via stdout so the caller can use
# it for diagnostics; emits the cleaned raw path on missing so the
# error message is meaningful.
candidate_exists() {
  local doc=$1 raw=$2
  # Strip trailing fragment (#section) and any quotes.
  local clean=${raw%%#*}
  clean=${clean%\"}
  clean=${clean#\"}
  clean=$(printf '%s' "$clean" | sed -E 's/[[:space:]]+$//')
  if [[ -z "$clean" ]]; then
    printf '%s' "$raw"
    return 1
  fi
  local doc_dir
  doc_dir=$(dirname "$doc")
  # Try two resolutions, in order, both via bash's path-tolerant [[ -e ]]:
  #   1. doc-relative (the markdown-link convention — `./foo.md`,
  #      `../sibling/file.md`)
  #   2. repo-root-relative (the prose convention in docs/ files —
  #      `tests/auth/foo.spec.ts` interpreted as `${REPO_ROOT}/tests/...`)
  # Both are common in this repo; checking both eliminates false
  # positives from refs in docs/ that mean repo-root paths.
  if [[ "$clean" == /* ]]; then
    # Absolute (rare) — accept as-is.
    if [[ -e "$clean" ]]; then
      printf '%s' "$clean"; return 0
    fi
  else
    if [[ -e "$doc_dir/$clean" ]]; then
      printf '%s' "$doc_dir/$clean"; return 0
    fi
    if [[ -e "$REPO_ROOT/$clean" ]]; then
      printf '%s' "$REPO_ROOT/$clean"; return 0
    fi
  fi
  printf '%s' "$clean"
  return 1
}

# Check whether the candidate matches any IGNORED_PATTERNS — i.e.
# should be skipped entirely.
is_ignored() {
  local candidate=$1
  for pat in "${IGNORED_PATTERNS[@]}"; do
    if [[ "$candidate" =~ $pat ]]; then
      return 0
    fi
  done
  return 1
}

# Main loop.
total=0
broken=0
declare -a broken_lines=()

for doc in "${DOC_FILES[@]}"; do
  if [[ ! -f "$doc" ]]; then
    continue
  fi
  rel_doc=${doc#"$REPO_ROOT/"}
  while IFS=$'\t' read -r line_no raw_path; do
    if [[ -z "$raw_path" ]]; then
      continue
    fi
    if is_ignored "$raw_path"; then
      continue
    fi
    total=$((total + 1))
    if candidate_exists "$doc" "$raw_path" >/dev/null; then
      continue
    fi
    broken=$((broken + 1))
    broken_lines+=("$rel_doc:$line_no: missing → $raw_path")
  done < <(extract_candidates "$doc" | sort -u)
done

if (( broken == 0 )); then
  echo "✓ doc-path audit clean — $total path references checked across ${#DOC_FILES[@]} files"
  exit 0
fi

{
  echo "✗ doc-path audit — $broken / $total references point at missing files:"
  echo ""
  for line in "${broken_lines[@]}"; do
    echo "  $line"
  done
  echo ""
  echo "Either restore the file, update the reference, or — if the"
  echo "false positive is structural (wildcard, glob, placeholder) —"
  echo "extend IGNORED_PATTERNS in scripts/check-doc-paths.sh."
} >&2
exit 1
