SHELL := /bin/zsh
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

NPM ?= npm
SPEC ?=
PW_PROJECT ?= chromium

# HEADED: applies to single-test convenience targets (test-name, test-one,
# test-spec). Default = 1 (visible Chrome) locally, 0 in CI (auto-detected
# via $CI). Force-override with HEADED=0 to run a single test headless,
# or HEADED=1 in CI for whatever reason (won't work without a display).
HEADED ?= $(if $(CI),0,1)
HEADED_FLAG := $(if $(filter 1,$(HEADED)),--headed)

.PHONY: help install install-browsers install-browsers-ci typecheck audit pre-commit test test-auth test-apps test-flows test-security test-all-browsers test-spec test-one test-name report clean

help: ## Show available targets
	@awk 'BEGIN {FS = ":.*## "; print "Usage: make <target>\n\nTargets:"} /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install Node dependencies
	$(NPM) install

install-browsers: ## Install Playwright browsers (all)
	$(NPM) run install:browsers

install-browsers-ci: ## Install CI browser set (chromium)
	$(NPM) run install:browsers:ci

typecheck: ## Run TypeScript type-check
	npx tsc --noEmit

audit: ## Run the spec-coverage audit (needs SPEC_DIR or SPEC_REPO_TOKEN)
	bash scripts/check-spec-coverage.sh

audit-paths: ## Audit doc cross-references — every relative file path in CLAUDE/README/skills/TRIAGE/docs must resolve
	bash scripts/check-doc-paths.sh

pre-commit: typecheck audit audit-paths ## Run typecheck + audits before pushing. Add a fast test subset locally if useful.
	@echo "✓ typecheck + spec-coverage + doc-path audits clean"

test: ## Run full test suite
	@# Guard against the common footgun: someone runs `make test ID=FOSSSMBBUN-112 FORCE=1`
	@# from the repo root, intending to invoke the test-writer agent. The agent's
	@# Makefile lives in agents/test-writer/ and shares the `test` verb. Without
	@# this guard, ID/FORCE/RETRY are silently ignored and the full 324-test suite
	@# kicks off — a 30+ minute wrong-turn before the user realises.
	@if [ -n "$(ID)" ] || [ -n "$(FORCE)" ] || [ -n "$(RETRY)" ]; then \
		echo "" >&2; \
		echo "ERROR: 'make test' at the repo root runs the Playwright suite — it doesn't" >&2; \
		echo "       accept ID / FORCE / RETRY (those belong to the test-writer agent)." >&2; \
		echo "" >&2; \
		echo "       Did you mean to invoke the test-writer agent? Run:" >&2; \
		echo "" >&2; \
		echo "         cd agents/test-writer && make test ID=$(ID)$(if $(FORCE), FORCE=$(FORCE))$(if $(RETRY), RETRY=$(RETRY))" >&2; \
		echo "" >&2; \
		echo "       If you actually wanted the full Playwright suite, drop the ID/FORCE/RETRY" >&2; \
		echo "       arguments: 'make test'." >&2; \
		echo "" >&2; \
		exit 2; \
	fi
	$(NPM) test

test-auth: ## Run auth tests
	$(NPM) run test:auth

test-apps: ## Run app tests
	$(NPM) run test:apps

test-flows: ## Run flow tests
	$(NPM) run test:flows

test-security: ## Run security tests
	$(NPM) run test:security

test-all-browsers: ## Run full suite on chromium+firefox+webkit
	$(NPM) run test:all-browsers

test-spec: ## Run one spec (SPEC=tests/.../foo.spec.ts [HEADED=0 to force headless] [GREP="pattern"] [PW_PROJECT=chromium])
	if [ -z "$(SPEC)" ]; then echo "SPEC is required (example: make test-spec SPEC=tests/security/headers.spec.ts)"; exit 2; fi
	npx dotenv -- playwright test "$(SPEC)" --project="$(PW_PROJECT)" $(HEADED_FLAG) $(if $(GREP),--grep "$(GREP)") --reporter=list --workers=1

test-name: ## Run any test by name pattern across the whole suite (NAME="test name" [HEADED=0 to force headless])
	@if [ -z "$(NAME)" ]; then \
		echo "NAME is required (example: make test-name NAME=\"Outline: per-app Logout\")"; \
		echo "Tip: paste the test name from a CI failure line — it's the bit after the › arrow."; \
		exit 2; \
	fi
	PW_INCLUDE_STAGING=1 npx dotenv -- playwright test --grep "$(NAME)" --project="$(PW_PROJECT)" $(HEADED_FLAG) --reporter=list --workers=1

test-one: ## Run one spec by filename substring (NAME=<substring> [HEADED=0 to force headless] [GREP="test name pattern"])
	@if [ -z "$(NAME)" ]; then \
		echo "NAME is required (example: make test-one NAME=pm-project-create)"; \
		exit 2; \
	fi
	@matches=$$(find tests -type f -name "*$(NAME)*.spec.ts" | sort); \
	count=$$(printf '%s\n' "$$matches" | grep -c . || true); \
	if [ "$$count" -eq 0 ]; then \
		echo "No spec matched '*$(NAME)*.spec.ts' under tests/"; \
		exit 1; \
	elif [ "$$count" -gt 1 ]; then \
		echo "Multiple specs matched '*$(NAME)*.spec.ts':"; \
		printf '  %s\n' $$matches; \
		echo "Be more specific (e.g. NAME=$(NAME)-something)."; \
		exit 1; \
	fi; \
	echo "→ $$matches"; \
	PW_INCLUDE_STAGING=1 npx dotenv -- playwright test "$$matches" --project="$(PW_PROJECT)" $(HEADED_FLAG) $(if $(GREP),--grep "$(GREP)") --reporter=list --workers=1

report: ## Open Playwright HTML report
	$(NPM) run report

clean: ## Remove generated test artifacts
	rm -rf playwright-report test-results

