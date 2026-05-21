SHELL := /bin/zsh
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

NPM ?= npm
SPEC ?=
PW_PROJECT ?= chromium

.PHONY: help install install-browsers install-browsers-ci typecheck audit pre-commit test test-auth test-apps test-flows test-security test-all-browsers test-spec test-one report clean

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

pre-commit: typecheck audit ## Run typecheck + audit before pushing. Add a fast test subset locally if useful.
	@echo "✓ typecheck + spec-coverage audit clean"

test: ## Run full test suite
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

test-spec: ## Run one Playwright spec by full path (usage: make test-spec SPEC=tests/security/headers.spec.ts PW_PROJECT=chromium)
	if [ -z "$(SPEC)" ]; then echo "SPEC is required (example: make test-spec SPEC=tests/security/headers.spec.ts)"; exit 2; fi
	npx dotenv -- playwright test "$(SPEC)" --project="$(PW_PROJECT)"

test-one: ## Run one Playwright spec by filename substring (usage: make test-one NAME=pm-project-create)
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
	PW_INCLUDE_STAGING=1 npx dotenv -- playwright test "$$matches" --project="$(PW_PROJECT)" --reporter=list --workers=1

report: ## Open Playwright HTML report
	$(NPM) run report

clean: ## Remove generated test artifacts
	rm -rf playwright-report test-results

