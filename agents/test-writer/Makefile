# Test-writer Makefile — convenience wrapper around test-writer CLI invocations.
#
# Two verbs cover the whole workflow:
#
#     make list                       # see open bugs
#     make test ID=92                 # resolve + scope + write + verify
#     make test ID=92 FORCE=1         # overwrite an existing reproduction
#     make test ID=92 RETRY=1         # re-run after a previous failed attempt
#
# `make test` accepts any of: N, FOSSSMBBUN-N, or full UUID. It runs
# bug-bootstrap.py to resolve + scope the ticket (so you see what's
# being processed), then invokes the agent against the resolved UUID.

SHELL := /usr/bin/env bash

# Load .env at the start of each recipe shell. `.` is POSIX (`source` is bash-
# only). Wrapped in `set -a` so every var exported, then `set +a` to restore.
ENV := set -a; . ./.env; set +a;

.PHONY: help list test state-clean venv install

help: ## Show available targets
	@printf 'Test-writer targets\n\n'
	@printf '  %-40s %s\n' 'make list'                   'List open Plane bugs (read-only; no writes).'
	@printf '  %-40s %s\n' 'make test ID=<N|UUID>'       'Resolve + scope + write plan/test + verify reproduction.'
	@printf '  %-40s %s\n' 'make test ID=<N> FORCE=1'    'Overwrite an existing tests/bugs/bug_<id>.spec.ts.'
	@printf '  %-40s %s\n' 'make test ID=<N> RETRY=1'    'Re-run after a previous failed attempt (clears the failure marker).'
	@printf '  %-40s %s\n' 'make state-clean'            'Wipe state.json (start fresh; re-runs everything).'
	@printf '  %-40s %s\n' 'make venv'                   'Create the local venv (uv-managed, Python 3.12+).'
	@printf '  %-40s %s\n' 'make install'                'venv + install the package as editable (with [dev]).'
	@printf '\n'
	@printf 'Notes\n'
	@printf '  - All targets read .env from this directory. Required vars:\n'
	@printf '      PLANE_API_TOKEN, PLANE_BASE_URL, PLANE_WORKSPACE_SLUG, PLANE_PROJECT_ID,\n'
	@printf '      FOSS_USER, FOSS_PASS\n'
	@printf '  - `make test` accepts ID as FOSSSMBBUN-N, just N, or full UUID.\n'

list:
	@$(ENV) .venv/bin/test-writer --list-only

test:
	@if [ -z "$(ID)" ]; then \
		echo "usage: make test ID=<N | FOSSSMBBUN-N | full-uuid> [FORCE=1] [RETRY=1]" >&2; \
		echo "       run \`make list\` first to pick a bug" >&2; \
		exit 1; \
	fi
	@output=$$($(ENV) python3 scripts/bug-bootstrap.py "$(ID)"); \
	echo "$$output"; \
	uuid=$$(echo "$$output" | awk '/^UUID:/ {print $$2}'); \
	if [ -z "$$uuid" ]; then echo "could not resolve UUID for $(ID)" >&2; exit 1; fi; \
	echo ""; \
	$(ENV) .venv/bin/test-writer --issue-id $$uuid $(if $(FORCE),--force) $(if $(RETRY),--retry-failed)

state-clean:
	@rm -f state.json state.json.tmp
	@echo "state cleared"

venv:
	@command -v uv >/dev/null 2>&1 || { echo "uv not installed. Install: curl -LsSf https://astral.sh/uv/install.sh | sh" >&2; exit 1; }
	@if [ -d .venv ]; then \
		echo ".venv already exists — skipping create (use 'rm -rf .venv && make venv' to recreate)"; \
	else \
		uv venv --python 3.12 .venv; \
	fi

install: venv
	@uv pip install --python .venv/bin/python -e ".[dev]"
