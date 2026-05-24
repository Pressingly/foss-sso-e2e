#!/usr/bin/env bash
#
# check-spec-coverage.sh — verify every openspec requirement is either covered
# by a test (`// @spec module#slug` tag) OR explicitly deferred in
# docs/spec-coverage-deferred.md.
#
# Why this exists: docs/spec-coverage.md captures the current state, but the
# matrix drifts as new specs land upstream. This script regenerates the
# coverage delta deterministically and fails CI when a new requirement
# arrives without a corresponding tag or deferred-list entry.
#
# Inputs:
#   $SPEC_DIR — path to an openspec/specs checkout. Defaults to
#               `vendor/openspec/specs/` inside this repo. Set to override
#               when working against an alternate checkout (e.g. a branch
#               with draft requirements).
#
# Outputs:
#   - stdout: markdown coverage table + delta
#   - exit 0 if every requirement is accounted for; exit 1 otherwise
#
# Tag format expected in tests/:
#   // @spec <module-slug>#<requirement-slug>
# where <module-slug> is the directory name under openspec/specs/ and
# <requirement-slug> is the lowercased title with non-alphanumeric runs
# collapsed to '-'.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
DEFERRED_FILE="$REPO_ROOT/docs/spec-coverage-deferred.md"
TESTS_DIR="$REPO_ROOT/tests"

# Default to the vendored openspec when SPEC_DIR isn't explicitly set.
VENDOR_SPEC_DIR="$REPO_ROOT/vendor/openspec/specs"
if [[ -z "${SPEC_DIR:-}" && -d "$VENDOR_SPEC_DIR" ]]; then
  SPEC_DIR="$VENDOR_SPEC_DIR"
fi

# Per-app skill files live alongside specs/, in vendor/openspec/skills/.
# They use the same `### Requirement:` shape (where refactored) so the
# audit can walk them as additional modules. Add a skill module here
# once it carries at least one `### Requirement:` block.
SKILL_DIR="$REPO_ROOT/vendor/openspec/skills"
SKILL_MODULES=(
  outline-admin
)

SPEC_MODULES=(
  proxy-auth-middleware
  oauth2-proxy-gateway
  forwardauth-traefik
  session-lifecycle
  cognito-claim-mapping
  logout-flow
  workspace-auto-join
)

# Combined module list — order matters only for output stability.
ALL_MODULES=("${SPEC_MODULES[@]}" "${SKILL_MODULES[@]}")

# Slugify a requirement title: lowercase, collapse runs of non-alphanumerics
# to single '-', strip leading/trailing '-'. Same convention as the matrix.
slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g'
}

# Read a spec file and emit the slugified requirement titles, one per line.
# Fails loudly on any source-fetch or parse error — silent-pass would let
# CI miss new requirements landing upstream.
extract_reqs() {
  local module=$1 spec_path content
  if [[ -z "${SPEC_DIR:-}" ]]; then
    echo "ERROR: SPEC_DIR is empty and vendor/openspec/specs is missing." >&2
    echo "       Restore vendor/openspec/specs or set SPEC_DIR explicitly." >&2
    return 1
  fi
  # Spec modules live at SPEC_DIR/<module>/spec.md; skill modules at
  # SKILL_DIR/<module>/SKILL.md. Both shapes use `### Requirement:`.
  if [[ -f "$SPEC_DIR/$module/spec.md" ]]; then
    spec_path="$SPEC_DIR/$module/spec.md"
  elif [[ -f "$SKILL_DIR/$module/SKILL.md" ]]; then
    spec_path="$SKILL_DIR/$module/SKILL.md"
  else
    echo "ERROR: no spec.md or SKILL.md found for module '$module' under" >&2
    echo "       $SPEC_DIR/$module/ or $SKILL_DIR/$module/" >&2
    return 1
  fi
  content=$(cat "$spec_path")

  # Defense-in-depth: every module is expected to declare at least one
  # requirement. A zero-requirement parse means either the source was
  # truncated/corrupted or the spec format drifted — either way, bail
  # rather than silently accepting "module has nothing to cover".
  local reqs
  reqs=$(printf '%s\n' "$content" | sed -nE 's/^### Requirement:[[:space:]]*(.+)$/\1/p')
  if [[ -z "$reqs" ]]; then
    echo "ERROR: no '### Requirement:' lines found for module '$module'" >&2
    echo "       source may be malformed or the spec format changed." >&2
    return 1
  fi
  printf '%s\n' "$reqs"
}

# Collect every `// @spec module#slug` tag from the test tree.
collect_tags() {
  if [[ ! -d "$TESTS_DIR" ]]; then
    return 0
  fi
  # grep returns 1 on no-match; mask it so `set -e` + pipefail don't abort.
  { grep -rhoE '// @spec [a-z0-9-]+#[a-z0-9-]+' "$TESTS_DIR" 2>/dev/null || true; } \
    | sed -E 's|^// @spec ||' \
    | sort -u
}

# Collect deferred entries from the deferred markdown file. The doc is
# organised by module header (`## <module-name>`) followed by list items of
# the form `- \`<requirement-title>\` — <category> — <rationale>`. Walk the
# file linearly, tracking the current module from the most recent `## ` line.
collect_deferred() {
  if [[ ! -f "$DEFERRED_FILE" ]]; then
    return 0
  fi
  # Stricter awk: only accept module headers that match a known module
  # name (so accidental ## headings — e.g. "## Categories summary",
  # "## Coverage outside the openspec contract scope" — don't capture
  # subsequent backtick-wrapped list items). Require the requirement
  # title to be ≥3 chars and not start with whitespace inside the
  # backticks (catches `   ` placeholder rows).
  awk -v modules_pipe="$(IFS='|'; echo "${ALL_MODULES[*]}")" '
    BEGIN { modules_re = "^(" modules_pipe ")$" }
    /^## / {
      hdr = $0
      sub(/^## +/, "", hdr)
      if (hdr ~ modules_re) {
        module = hdr
      } else {
        module = ""
      }
      next
    }
    /^- `[^`]+`/ {
      if (module == "") next
      title = $0
      sub(/^- `/, "", title)
      sub(/`.*$/, "", title)
      if (length(title) < 3) next
      if (title ~ /^[[:space:]]/) next
      print module "##" title
    }
  ' "$DEFERRED_FILE" \
    | while IFS='#' read -r module _ title; do
        # awk used `##` as separator so the empty middle field absorbs the
        # natural `#` in `module#title` without colliding with title text.
        printf '%s#%s\n' "$module" "$(slugify "$title")"
      done | sort -u
}

# ---------- main ----------

declare -a covered=()
declare -a deferred=()
declare -a missing=()
declare -a all_reqs=()

tags_blob=$(collect_tags)
deferred_blob=$(collect_deferred)

# Use newline-delimited blobs + grep instead of bash arrays + mapfile so the
# script runs on bash 3.2 (macOS default) as well as 4+/5+.
is_in_blob() {
  local needle=$1 blob=$2
  printf '%s\n' "$blob" | grep -Fqx "$needle"
}

for module in "${ALL_MODULES[@]}"; do
  # Call extract_reqs into a variable so its exit code propagates. Using
  # `< <(extract_reqs ...)` here would swallow a non-zero exit because
  # process substitution doesn't trip `set -e` / `pipefail` in the parent.
  if ! reqs=$(extract_reqs "$module"); then
    echo "FATAL: could not enumerate requirements for module '$module'." >&2
    echo "       (See errors above. Audit cannot proceed without an" >&2
    echo "       authoritative requirement list — refusing to silent-pass.)" >&2
    exit 2
  fi

  while IFS= read -r title; do
    [[ -z "$title" ]] && continue
    local_slug=$(slugify "$title")
    key="$module#$local_slug"
    all_reqs+=("$key")

    if is_in_blob "$key" "$tags_blob"; then
      covered+=("$key")
    elif is_in_blob "$key" "$deferred_blob"; then
      deferred+=("$key")
    else
      missing+=("$key")
    fi
  done <<< "$reqs"
done

total=${#all_reqs[@]}
n_cov=${#covered[@]}
n_def=${#deferred[@]}
n_miss=${#missing[@]}

echo "## SSO Spec Coverage Audit"
echo
echo "Contract source: \`vendor/openspec/specs/\` (snapshot vendored in this repo)"
echo
echo "| Status | Count |"
echo "|---|---|"
echo "| ✅ Covered (test tag found)  | $n_cov |"
echo "| ⚠️ Deferred (in deferred doc) | $n_def |"
echo "| ❌ Missing (no tag, no defer) | $n_miss |"
echo "| **Total requirements** | **$total** |"
echo

if [[ $n_miss -gt 0 ]]; then
  echo "### Missing — requirement landed upstream but not yet covered or deferred"
  echo
  for key in "${missing[@]}"; do
    echo "- \`$key\`"
  done
  echo
  echo "**Fix:** add a \`// @spec $key\` tag above the covering \`test()\` call,"
  echo "OR add an entry in \`docs/spec-coverage-deferred.md\` explaining why this"
  echo "requirement is not e2e-testable from this suite."
  exit 1
fi

echo "**All $total spec requirements are accounted for.**"
exit 0
