#!/usr/bin/env bash
#
# gen-spec-coverage.sh — regenerate docs/spec-coverage.md from the
# vendored specs + skill files + test @spec tags + deferred doc.
#
# Why this exists: docs/spec-coverage.md was hand-maintained, which
# made it the highest-drift file in the repo's doc set. The counts
# (and individual rows) routinely went stale between PRs that added
# tests or moved requirements. This script reads the same inputs the
# audit (scripts/check-spec-coverage.sh) reads and emits the table
# deterministically.
#
# Output: full markdown to stdout. Wire via Makefile or direct redirect:
#
#   make spec-coverage-doc                   # writes docs/spec-coverage.md
#   bash scripts/gen-spec-coverage.sh > docs/spec-coverage.md
#
# Drift detection: `make check-spec-coverage-doc-fresh` runs the
# generator and compares the output to the committed file. CI fails
# if they differ, forcing the author to regenerate before merge.
#
# Tag association: for each @spec tag found in tests/, this script
# tracks WHICH test file(s) carry it — that's the only piece of state
# the audit script doesn't already collect.
#
# Coverage states:
#   ✅       — at least one @spec tag pinning the requirement
#   🟡 Partial — at least one @spec tag AND a deferred-doc entry
#                marked "Partially covered" (the human note explains
#                the limitation)
#   ⚠️ Deferred — no @spec tag; entry in deferred doc with reason
#   ❌ Missing  — no @spec tag and no deferred entry. This SHOULD
#                never appear; the bidirectional audit fails CI when
#                it does. Emit it anyway for honest reporting.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
TESTS_DIR="$REPO_ROOT/tests"
DEFERRED_FILE="$REPO_ROOT/docs/spec-coverage-deferred.md"

VENDOR_SPEC_DIR="$REPO_ROOT/vendor/openspec/specs"
SKILL_DIR="$REPO_ROOT/vendor/openspec/skills"

if [[ -z "${SPEC_DIR:-}" && -d "$VENDOR_SPEC_DIR" ]]; then
  SPEC_DIR="$VENDOR_SPEC_DIR"
fi

# Module list — same as the audit. Order here drives output order
# (so we keep it stable to minimise diffs when the matrix regenerates).
SPEC_MODULES=(
  proxy-auth-middleware
  oauth2-proxy-gateway
  forwardauth-traefik
  session-lifecycle
  cognito-claim-mapping
  logout-flow
  workspace-auto-join
)

SKILL_MODULES=(
  outline-admin
  twenty-admin
  penpot-admin
  plane-admin
  surfsense-admin
  security-hardening
)

# Slugify a requirement title: lowercase, collapse non-alphanumerics
# to '-', strip leading/trailing '-'. Same convention as the audit.
slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g'
}

# Emit requirement titles for a module, one per line.
extract_reqs() {
  local module=$1 spec_path
  if [[ -f "$SPEC_DIR/$module/spec.md" ]]; then
    spec_path="$SPEC_DIR/$module/spec.md"
  elif [[ -f "$SKILL_DIR/$module/SKILL.md" ]]; then
    spec_path="$SKILL_DIR/$module/SKILL.md"
  else
    echo "ERROR: no spec.md or SKILL.md for module '$module'" >&2
    return 1
  fi
  sed -nE 's/^### Requirement:[[:space:]]*(.+)$/\1/p' "$spec_path"
}

# Build tag → file map. Each line of output is `module#slug<TAB>file`.
# Multiple files for the same tag emit multiple lines.
collect_tag_files() {
  if [[ ! -d "$TESTS_DIR" ]]; then
    return 0
  fi
  # grep -r with -H prefixes each hit with `file:`. Pull the @spec
  # value + the path.
  { grep -rHoE '// @spec [a-z0-9-]+#[a-z0-9-]+' "$TESTS_DIR" 2>/dev/null || true; } \
    | awk -F: '
        {
          file=$1
          # The match starts at "// @spec ..."; everything after is the tag.
          # We use index() to split on the literal " @spec " marker.
          i = index($0, "@spec ")
          if (i == 0) next
          tag = substr($0, i + length("@spec "))
          # Make file path relative to REPO_ROOT (caller will see absolute)
          print tag "\t" file
        }
      ' \
    | sed -E "s|\t$REPO_ROOT/|\t|" \
    | sort -u
}

# Build deferred → category map. Each line: `module##slug<TAB>category`.
# We slugify the title up-front so case differences between spec.md
# ("Layer 1 expiry SHALL ...") and deferred.md ("... shall ...")
# normalise to the same key. The audit script does the same.
# Category text comes from the **bold** segment after the title.
collect_deferred_categorised() {
  if [[ ! -f "$DEFERRED_FILE" ]]; then
    return 0
  fi
  local modules_re
  modules_re="^($( IFS='|'; echo "${SPEC_MODULES[*]} ${SKILL_MODULES[*]}" | tr ' ' '|' ))$"

  awk -v modules_re="$modules_re" '
    /^## / {
      hdr = $0
      sub(/^## +/, "", hdr)
      module = (hdr ~ modules_re) ? hdr : ""
      next
    }
    /^- `[^`]+`/ {
      if (module == "") next
      line = $0
      # Strip leading "- `"
      sub(/^- `/, "", line)
      # Split title at the closing backtick
      title = line
      sub(/`.*$/, "", title)
      if (length(title) < 3) next
      if (title ~ /^[[:space:]]/) next
      # Extract category — the first **bold** segment after the title.
      cat_line = line
      if (match(cat_line, /\*\*[^*]+\*\*/)) {
        category = substr(cat_line, RSTART + 2, RLENGTH - 4)
      } else {
        category = "Deferred"
      }
      print module "\t" title "\t" category
    }
  ' "$DEFERRED_FILE" \
    | while IFS=$'\t' read -r module title category; do
        local_slug=$(slugify "$title")
        printf '%s##%s\t%s\n' "$module" "$local_slug" "$category"
      done
}

# Build maps once.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

collect_tag_files > "$TMP/tag_files"
collect_deferred_categorised > "$TMP/deferred"

# Lookup helpers.
files_for_tag() {
  local tag=$1
  awk -v t="$tag" -F'\t' '$1==t { print $2 }' "$TMP/tag_files" | sort -u
}

category_for_deferred() {
  local module=$1 title=$2 slug
  slug=$(slugify "$title")
  awk -v key="$module##$slug" -F'\t' '$1==key { print $2; exit }' "$TMP/deferred"
}

# Render one row.
render_row() {
  local module=$1 title=$2
  local slug
  slug=$(slugify "$title")
  local tag="$module#$slug"

  local files
  files=$(files_for_tag "$tag")
  local deferred_cat
  deferred_cat=$(category_for_deferred "$module" "$title")

  local coverage test_col
  if [[ -n "$files" ]]; then
    # Partial = tagged AND deferred-doc says "Partially covered"
    if [[ "$deferred_cat" == "Partially covered" ]]; then
      coverage="🟡 Partial"
    else
      coverage="✅"
    fi
    test_col=$(
      echo "$files" \
        | awk '{ printf "%s`%s`", (NR>1 ? ", " : ""), $0 } END { print "" }'
    )
  elif [[ -n "$deferred_cat" ]]; then
    coverage="⚠️ Deferred"
    test_col="—"
  else
    coverage="❌ Missing"
    test_col="—"
  fi

  # Markdown-escape pipes in the title (rare but possible)
  local title_escaped=${title//|/\\|}
  printf '| %s | %s | %s |\n' "$title_escaped" "$coverage" "$test_col"
}

# ---------------------------------------------------------------------
# Emit the document.
# ---------------------------------------------------------------------

cat <<'HEADER'
# SSO Contract → E2E Coverage Matrix

Traceability matrix between the vendored openspec contract and this
Playwright suite. Every requirement maps to either a covering test
(`// @spec module#slug` tag in `tests/`) or a deferred entry in
[`spec-coverage-deferred.md`](./spec-coverage-deferred.md).

> **This file is auto-generated by `scripts/gen-spec-coverage.sh`.**
> Do not edit by hand — run `make spec-coverage-doc` to regenerate
> after any change to the specs / skills / tests / deferred doc.
> The CI gate `make check-spec-coverage-doc-fresh` fails the PR if
> the committed file is out of sync with the generator output.

**Legend:**
- ✅ — at least one `@spec` tag pins the requirement
- 🟡 Partial — tagged AND the deferred doc carries a "Partially
  covered" note (read the note for the limitation)
- ⚠️ Deferred — no tag; see
  [`spec-coverage-deferred.md`](./spec-coverage-deferred.md) for the
  rationale
- ❌ Missing — neither tagged nor deferred. CI fails when this
  happens; if you see it here, the audit and the generator are
  out of sync and the audit will surface the gap.

---

HEADER

# Per-module sections. Header text follows the existing convention
# (just `## <module>`) — no per-module prose, since per-module nuance
# now lives in test file head comments (the right place for it).
for module in "${SPEC_MODULES[@]}" "${SKILL_MODULES[@]}"; do
  printf '## %s\n\n' "$module"
  printf '| Requirement | Coverage | Test |\n'
  printf '|---|---|---|\n'
  while IFS= read -r req; do
    render_row "$module" "$req"
  done < <(extract_reqs "$module")
  printf '\n'
done

cat <<'FOOTER'
---

## Adding a new requirement

1. Add the `### Requirement:` block to the matching `spec.md` or `SKILL.md` under `vendor/openspec/`.
2. Add a `#### Scenario:` block in Gherkin (see [`spec-review-checklist.md`](./spec-review-checklist.md) Part A).
3. Either write a test with `// @spec module#requirement-slug` OR add an entry to `spec-coverage-deferred.md` with a category and rationale.
4. Run `make spec-coverage-doc` to regenerate this file.
5. Run `make pre-commit` — the spec-coverage audit + the doc-fresh gate must both pass.

Tag format:

```ts
// @spec proxy-auth-middleware#identity-mismatch-shall-flush-the-existing-session-immediately
test("user switch reflects in /me on next request", async ({ context }) => {
  // ...
});
```

Slug rule: requirement title, lowercased, non-alphanumeric runs collapsed to `-`, leading/trailing `-` stripped. Same logic in `scripts/check-spec-coverage.sh::slugify`.
FOOTER
