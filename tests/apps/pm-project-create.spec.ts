// Plane: a logged-in user can create a new project from the workspace
// projects page. Pins the full create round-trip (Plane API + SeaweedFS
// storage backend + presigned-URL upload path).
//
// No openspec module covers project creation — classified in
// `docs/spec-coverage-deferred.md` under "Coverage outside the openspec
// contract scope" (app-functionality concern, not SSO contract).
//
// History: promoted from `tests/bugs/bug_4961d647.spec.ts` after the
// underlying SeaweedFS access-key alignment fix landed.

import { test, expect } from "../../fixtures";
import {
  APP_URLS,
  PLANE_WORKSPACE_SLUG,
  isAuthWall,
  escapeHostForRegex,
} from "../../constants";

const PM_HOST = new URL(APP_URLS.PM).hostname;
const PM_HOST_REGEX = new RegExp(`^https?://${escapeHostForRegex(PM_HOST)}`);
const PROJECTS_URL = `${APP_URLS.PM}/${PLANE_WORKSPACE_SLUG}/projects/`;

// Plane's create-project API path. POST goes to
// `/api/v1/workspaces/<slug>/projects/`; the substring match keeps the
// test tolerant of minor versioning shifts between Plane releases.
const PROJECTS_API_RE = /\/api\/.*\/projects\/?($|\?)/;

test.describe("Plane: workspace project creation", () => {
  test("a user can create a new project from the workspace projects page", async ({
    context,
  }) => {
    test.setTimeout(120_000);

    const page = await context.newPage();
    let createdProjectId: string | undefined;

    try {
      // 1. Navigate to the workspace projects page.
      await page.goto(PROJECTS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      await expect(page).toHaveURL(PM_HOST_REGEX);
      expect(
        isAuthWall(page.url()),
        `projects page bounced to auth wall: ${page.url()}`,
      ).toBe(false);
      await expect(page).toHaveURL(/\/projects\/?(\?|$)/);

      // Track 4xx/5xx on the create-project endpoint during submit. Helps
      // diagnose storage-backend regressions where the API returns
      // 400-class with a misleading "cannot upload" body — and any
      // future validation rejection (e.g. PROJECT_NAME_CANNOT_CONTAIN_*).
      // Body capture is async; pendingErrorReads is drained before
      // assertions so the body lands in the failure message instead of
      // forcing a local repro to discover.
      const projectsApiErrors: string[] = [];
      const pendingErrorReads: Promise<void>[] = [];
      page.on("response", (res) => {
        const u = res.url();
        if (!u.startsWith(APP_URLS.PM)) return;
        if (!PROJECTS_API_RE.test(u)) return;
        const status = res.status();
        if (status < 400) return;
        pendingErrorReads.push(
          (async () => {
            const body = await res.text().catch(() => "<unreadable>");
            projectsApiErrors.push(
              `${status} ${res.request().method()} ${u} — body: ${body.slice(0, 300)}`,
            );
          })(),
        );
      });

      // 2. Locate the project-creation entry point. The shared FOSS_USER
      //    on `fossarbisoft` almost always has prior projects → the
      //    "Add project" affordance, not the empty-state CTA. Try both.
      const emptyStateCta = page
        .getByRole("button", { name: /start\s*your\s*first\s*project/i })
        .or(page.getByRole("link", { name: /start\s*your\s*first\s*project/i }))
        .first();
      const addProjectButton = page
        .getByRole("button", { name: /(add|create|new)\s*project/i })
        .first();

      await expect
        .poll(
          async () =>
            (await emptyStateCta.isVisible().catch(() => false)) ||
            (await addProjectButton.isVisible().catch(() => false)),
          {
            message: `Plane projects page did not expose a project-creation entry point at ${PROJECTS_URL}. Last URL: ${page.url()}`,
            timeout: 20_000,
          },
        )
        .toBe(true);

      const entryPoint = (await emptyStateCta.isVisible().catch(() => false))
        ? emptyStateCta
        : addProjectButton;
      await entryPoint.click({ timeout: 10_000 });

      // 3. The create-project dialog should render. Plane labels the
      //    input "Project name" or "Name" depending on release.
      const nameInput = page
        .getByRole("textbox", { name: /project\s*name|^name$/i })
        .or(page.locator('input[name="name"]'))
        .first();
      await expect(
        nameInput,
        "create-project dialog should show a project-name input",
      ).toBeVisible({ timeout: 15_000 });

      // 4. Fill a unique name (cleared up in `finally`).
      //    Two constraints from Plane's create API:
      //      • Plane rejects hyphens/underscores/punctuation in names
      //        (PROJECT_NAME_CANNOT_CONTAIN_SPECIAL_CHARACTERS) — use spaces.
      //      • Plane auto-derives a 3-5 char project identifier from the
      //        name's first letters. If two projects (across all time)
      //        produce the same auto-identifier, the second fails with
      //        PROJECT_IDENTIFIER_ALREADY_EXIST. So the name needs to
      //        vary in its leading alphabetical characters — a random
      //        alpha tag guarantees a unique derived identifier per run.
      const tag = Math.random().toString(36).slice(2, 8);
      const projectName = `e2e ${tag} ${Date.now()}`;
      await nameInput.fill(projectName);
      await expect(nameInput).toHaveValue(projectName);

      // 5. Submit. Scope to the dialog so we don't re-click the
      //    entry-point button (which also matches `/create.*project/i`).
      const dialogScope = page
        .getByRole("dialog")
        .or(page.locator('[role="dialog"], form'))
        .first();
      const submit = (
        (await dialogScope.isVisible().catch(() => false))
          ? dialogScope
          : page
      )
        .getByRole("button", { name: /^\s*create\s*project\s*$/i })
        .first();
      await expect(
        submit,
        "dialog should expose a 'Create Project' submit button",
      ).toBeVisible({ timeout: 10_000 });

      // Listen for the POST response — it carries the new project id we
      // need for teardown, and is the concrete signal that the submit
      // has actually round-tripped (vs. the long-polling endpoints that
      // keep the page perpetually "busy" on Plane).
      const submitResponsePromise = page
        .waitForResponse(
          (res) =>
            res.url().startsWith(APP_URLS.PM) &&
            PROJECTS_API_RE.test(res.url()) &&
            res.request().method() === "POST",
          { timeout: 30_000 },
        )
        .catch(() => null);

      await submit.click({ timeout: 10_000 });

      const submitResponse = await submitResponsePromise;

      // Capture project id from the response for teardown.
      if (submitResponse && submitResponse.ok()) {
        const body = await submitResponse.json().catch(() => null);
        const id = body?.id ?? body?.project_id ?? body?.data?.id;
        if (typeof id === "string") {
          createdProjectId = id;
        }
      }

      // Dialog close is the natural UI-completion signal for create.
      // Bounded; "dialog still open" is captured below as a failure mode.
      await expect(dialogScope)
        .toBeHidden({ timeout: 5_000 })
        .catch(() => {});

      // 6. Verify creation succeeded — either the dialog closed AND we
      //    see the new project in the list, OR we navigated to its
      //    detail page (Plane's default after-create landing).
      const bodyText =
        (await page.locator("body").innerText().catch(() => "")) ?? "";
      const cannotUploadError =
        /cannot\s*upload|media\s*type|unsupported\s*media/i.test(bodyText);

      const dialogStillOpen = await dialogScope.isVisible().catch(() => false);
      const projectVisibleInList = await page
        .getByText(projectName, { exact: false })
        .first()
        .isVisible()
        .catch(() => false);
      const urlMovedOffProjectsList = !/\/projects\/?(\?|$)/.test(page.url());

      // Drain any in-flight body reads before reading projectsApiErrors.
      await Promise.all(pendingErrorReads);

      const failures: string[] = [];
      if (projectsApiErrors.length) {
        failures.push(
          `Plane projects API returned error(s) during submit: ${projectsApiErrors.join(" | ")}`,
        );
      }
      if (cannotUploadError) {
        // The misleading "cannot upload" / media-type wording is the
        // exact symptom of the SeaweedFS access-key drift bug that this
        // test was originally written for (formerly bug_4961d647).
        failures.push(
          `Page shows a "cannot upload" / media-type error after submit (storage-backend regression). Body excerpt: ${bodyText.slice(0, 300)}`,
        );
      }
      const created =
        (!dialogStillOpen && projectVisibleInList) ||
        urlMovedOffProjectsList;
      if (!created) {
        failures.push(
          `Project "${projectName}" was not created. dialogStillOpen=${dialogStillOpen}, projectVisibleInList=${projectVisibleInList}, url=${page.url()}`,
        );
      }

      expect(
        failures,
        `Creating a new project in Plane should succeed end-to-end. Captured failures: ${failures.join(" || ") || "<none>"}`,
      ).toEqual([]);
    } finally {
      // Teardown: delete the project so reruns don't accumulate. The
      // worker `context` is authenticated as FOSS_USER (workspace
      // member); Plane lets owners/admins delete projects. Best-effort:
      // if the delete fails, log it (CI will surface the noise) but
      // don't mask a passing test result.
      if (createdProjectId) {
        // Match the same path the create-POST uses — `/api/workspaces/...`
        // (no `/v1/` segment). Hitting the wrong path silently 404s
        // inside the .catch and orphans projects, which then cause
        // PROJECT_IDENTIFIER_ALREADY_EXIST on subsequent runs.
        const deleteUrl = `${APP_URLS.PM}/api/workspaces/${PLANE_WORKSPACE_SLUG}/projects/${createdProjectId}/`;
        await context.request.delete(deleteUrl).catch((e) => {
          // eslint-disable-next-line no-console
          console.error(
            `[pm-project-create] failed to delete project ${createdProjectId}: ${e}`,
          );
        });
      }
    }
  });
});
