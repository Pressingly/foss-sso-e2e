# Bug-fixer Makefile — convenience wrapper around bug-fixer CLI invocations.
#
# Each target sources .env (gitignored; holds PLANE_API_TOKEN, FOSS_USER,
# FOSS_PASS, …) before invoking the agent. So you can:
#
#     make list                       # see open bugs
#     make debug ID=73                # fetch ticket + auto-scope for diagnosis
#     make e2e   ID=73                # fetch ticket + auto-scope for e2e prep
#     make test  ID=<full-uuid>       # actually generate plan + test
#     make retry ID=<full-uuid>       # re-run after a failed attempt
#
# `make debug` and `make e2e` both run scripts/bug-bootstrap.py, which
# fetches the Plane ticket and runs the root-cause-analyst's Step 0
# scope detection mechanically — so you start the next step (diagnosis
# or test writing) with a narrow target instead of grepping all repos.

SHELL := /usr/bin/env bash

# Load .env at the start of each recipe shell. `.` is POSIX (`source` is bash-
# only). Wrapped in `set -a` so every var exported, then `set +a` to restore.
ENV := set -a; . ./.env; set +a;

.PHONY: help list debug e2e test retry venv install state-clean

help: ## Show available targets
	@printf 'Bug-fixer targets\n\n'
	@printf '  %-32s %s\n' 'make list'             'List open Plane bugs (read-only; no writes).'
	@printf '  %-32s %s\n' 'make debug ID=<N>'     'Fetch the ticket + scope it for diagnosis. Prints next prompt for the root-cause-analyst skill.'
	@printf '  %-32s %s\n' 'make e2e   ID=<N>'     'Fetch the ticket + scope it for e2e test creation. Prints next prompt for the bug-fixer skill.'
	@printf '  %-32s %s\n' 'make test  ID=<uuid>'  'Generate plan + test for one bug; verify it reproduces.'
	@printf '  %-32s %s\n' 'make retry ID=<uuid>'  'Re-run after a failed attempt (clears the failure marker).'
	@printf '  %-32s %s\n' 'make state-clean'      'Wipe state.json (start fresh; re-runs everything).'
	@printf '  %-32s %s\n' 'make venv'             'Create the local venv (uv-managed, Python 3.12+).'
	@printf '  %-32s %s\n' 'make install'          'venv + install the package as editable (with [dev]).'
	@printf '\n'
	@printf 'Notes\n'
	@printf '  - All targets read .env from this directory. Required vars:\n'
	@printf '      PLANE_API_TOKEN, PLANE_BASE_URL, PLANE_WORKSPACE_SLUG, PLANE_PROJECT_ID,\n'
	@printf '      FOSS_USER, FOSS_PASS  (and DEVSTACK_PATH, GITHUB_TOKEN for full pipeline)\n'
	@printf '  - `make debug` and `make e2e` accept ID as FOSSSMBBUN-N, just N, or full UUID.\n'
	@printf '  - `make test` and `make retry` need the full UUID (printed by debug/e2e).\n'

list:
	@$(ENV) .venv/bin/bug-fixer --list-only

debug:
	@if [ -z "$(ID)" ]; then \
		echo "usage: make debug ID=<FOSSSMBBUN-N | N | full-uuid>" >&2; \
		echo "       run \`make list\` first to pick a bug" >&2; \
		exit 1; \
	fi
	@$(ENV) python3 scripts/bug-bootstrap.py "$(ID)"
	@echo ""
	@echo "==================================================================="
	@echo "Next step — diagnose mode:"
	@echo "  In Claude Code (this repo), ask:"
	@echo "    \"Use the root-cause-analyst skill to diagnose this ticket."
	@echo "     Scope per the bug-bootstrap output above. Produce a finding"
	@echo "     at docs/root-cause-<N>-\$$(date +%F).md\""
	@echo ""
	@echo "  Skill: .claude/skills/root-cause-analyst/SKILL.md"
	@echo "==================================================================="

e2e:
	@if [ -z "$(ID)" ]; then \
		echo "usage: make e2e ID=<FOSSSMBBUN-N | N | full-uuid>" >&2; \
		echo "       run \`make list\` first to pick a bug" >&2; \
		exit 1; \
	fi
	@$(ENV) python3 scripts/bug-bootstrap.py "$(ID)"
	@echo ""
	@echo "==================================================================="
	@echo "Next step — e2e test creation:"
	@echo "  Copy the UUID printed above, then:"
	@echo "    make test ID=<paste-uuid-here>"
	@echo ""
	@echo "  OR drive interactively in Claude Code, ask:"
	@echo "    \"Use the bug-fixer skill to write a spec-driven plan + test"
	@echo "     for this ticket. Scope per the bug-bootstrap output above.\""
	@echo "==================================================================="

test:
	@if [ -z "$(ID)" ]; then \
		echo "usage: make test ID=<full-uuid>" >&2; \
		echo "       run \`make list\` first to pick a bug, or \`make e2e ID=<N>\` to scope it" >&2; \
		exit 1; \
	fi
	@$(ENV) .venv/bin/bug-fixer --test-only --issue-id $(ID)

retry:
	@if [ -z "$(ID)" ]; then \
		echo "usage: make retry ID=<full-uuid>" >&2; \
		exit 1; \
	fi
	@$(ENV) .venv/bin/bug-fixer --retry-failed --test-only --issue-id $(ID)

state-clean:
	@rm -f state.json state.json.tmp
	@echo "state cleared"

venv:
	@command -v uv >/dev/null 2>&1 || { echo "uv not installed. Install: curl -LsSf https://astral.sh/uv/install.sh | sh" >&2; exit 1; }
	@uv venv --python 3.12 .venv

install: venv
	@uv pip install --python .venv/bin/python -e ".[dev]"
