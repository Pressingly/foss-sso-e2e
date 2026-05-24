#!/usr/bin/env bash
#
# refresh-openspec.sh — re-vendor the openspec + skills from a local
# checkout of awais786/sso-rules-moneta into vendor/openspec/.
#
# Why this exists: vendor/openspec/ is the source the spec-coverage
# audit (and the per-app SKILL.md reference docs) read at CI time. It's
# checked into this repo so CI doesn't need a token or network access
# to the (private) sso-rules-moneta repo. Drift between vendor and
# upstream is reconciled by running this script manually, which lands
# as a normal diff in a PR — so updates are reviewable.
#
# Usage:
#   SSO_RULES_SRC=/path/to/sso-rules-moneta bash scripts/refresh-openspec.sh
#
# Or, if your checkout lives at the conventional sibling path,
# leave SSO_RULES_SRC unset:
#   bash scripts/refresh-openspec.sh
#
# The script:
#   1. Validates the source has openspec/specs/ + skills/
#   2. Wipes vendor/openspec/specs and vendor/openspec/skills (NOT the README)
#   3. Copies the source dirs in
#   4. Prints a diff summary so the change is visible at commit time

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
VENDOR_DIR="$REPO_ROOT/vendor/openspec"

DEFAULT_SRC="$(cd "$REPO_ROOT/.." && pwd)/sso-rules-moneta"
SRC="${SSO_RULES_SRC:-$DEFAULT_SRC}"

if [[ ! -d "$SRC/openspec/specs" ]]; then
  echo "ERROR: $SRC/openspec/specs not found." >&2
  echo "       Set SSO_RULES_SRC to a local sso-rules-moneta checkout, e.g.:" >&2
  echo "         SSO_RULES_SRC=/path/to/sso-rules-moneta bash $0" >&2
  exit 1
fi

if [[ ! -d "$SRC/skills" ]]; then
  echo "ERROR: $SRC/skills not found in $SRC." >&2
  echo "       Are you pointing at the right checkout?" >&2
  exit 1
fi

echo "Vendoring from: $SRC"
echo "Into:           $VENDOR_DIR"
echo

rm -rf "$VENDOR_DIR/specs" "$VENDOR_DIR/skills"
mkdir -p "$VENDOR_DIR/specs" "$VENDOR_DIR/skills"
cp -R "$SRC/openspec/specs/." "$VENDOR_DIR/specs/"
cp -R "$SRC/skills/." "$VENDOR_DIR/skills/"

# Record upstream commit if the source is a git checkout — useful for
# tracing what state we vendored.
src_sha="(not a git checkout)"
if (cd "$SRC" && git rev-parse HEAD >/dev/null 2>&1); then
  src_sha=$(cd "$SRC" && git rev-parse HEAD)
fi

echo "Files vendored:"
echo "  specs/  : $(find "$VENDOR_DIR/specs" -type f | wc -l | tr -d ' ') file(s)"
echo "  skills/ : $(find "$VENDOR_DIR/skills" -type f | wc -l | tr -d ' ') file(s)"
echo
echo "Upstream sha: $src_sha"
echo

# Diff summary against working tree — visible at commit time.
if (cd "$REPO_ROOT" && git diff --stat -- vendor/openspec >/dev/null 2>&1); then
  echo "Diff summary (vs. working tree):"
  (cd "$REPO_ROOT" && git diff --stat -- vendor/openspec) || true
fi

echo
echo "Done. Review the diff, run \`make audit\` to confirm coverage,"
echo "then commit vendor/openspec changes alongside any new \`@spec\` tags."
