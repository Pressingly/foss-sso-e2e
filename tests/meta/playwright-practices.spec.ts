import { test, expect } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

type Violation = {
  file: string;
  line: number;
  rule: string;
  text: string;
};

const ROOT = path.resolve(__dirname, "../..");
const TESTS_DIR = path.join(ROOT, "tests");
const EXCLUDED_DIRS = new Set(["bugs"]);

// Each rule's `exemptPaths` lists files (path suffixes) where the
// pattern is legitimately allowed — the source-of-truth file for the
// literal, or a test that specifically validates the literal value.
// Anywhere else in the suite, the rule fires.
const RULES: { name: string; pattern: RegExp; exemptPaths?: string[] }[] = [
  {
    name: "focused tests must not be committed — remove `.only` before pushing (otherwise CI silently runs one test)",
    pattern: /\b(?:test|describe)\.only\s*\(/,
  },
  {
    name:
      "page.waitForTimeout is banned for readiness — use locator.waitFor({state}), " +
      "waitForURL(regex), or expect.poll(() => observable). For pacing only " +
      "(rate-limit politeness, between-link gaps), import `delay` from `node:timers/promises` " +
      "— never as a readiness escape hatch",
    pattern: /\.waitForTimeout\s*\(/,
  },
  {
    name:
      "waitForLoadState('networkidle') is unreliable on every SPA in this suite " +
      "(Twenty's GraphQL websocket, Outline's chunk loader, Penpot's hash router, " +
      "the portal's async session check). Replace with waitForURL(regex), " +
      "locator.waitFor({state}), expect(page).toHaveTitle(...), or expect.poll(() => page.url())",
    pattern: /\.waitForLoadState\s*\(\s*['"]networkidle['"]/,
  },
  {
    name:
      "waitUntil: 'networkidle' is unreliable on every SPA in this suite. " +
      "Use 'commit' or 'domcontentloaded' plus an explicit assertion " +
      "(waitForURL / toHaveTitle / expect.poll against the observable)",
    pattern: /waitUntil\s*:\s*['"]networkidle['"]/,
  },
  {
    name:
      "hardcoded platform URL — import MAIN_URL or APP_URLS from constants.ts. " +
      "The whole topology derives from one env var (FOSS_BASE_URL); a stray literal " +
      "silently breaks runs against staging/prod/non-default deployments",
    pattern: /["']https?:\/\/[a-z0-9.-]*foss\.arbisoft\.com/i,
  },
  {
    name:
      "hardcoded _oauth2_proxy cookie name — import AUTH_COOKIE from constants.ts. " +
      "Override is FOSS_AUTH_COOKIE; a literal breaks non-default cookie configs. " +
      "Cookie-tampering / session-fixation tests legitimately use the literal " +
      "to validate the value itself — those paths are exempt",
    pattern: /["']_oauth2_proxy["']/,
    exemptPaths: [
      "tests/security/cookie-tampering.spec.ts",
      "tests/security/session-fixation.spec.ts",
    ],
  },
  {
    name:
      "Page Object Model is not used in this suite — apps are upstream-owned SPAs " +
      "with churning selectors; POM adds indirection without reducing churn. " +
      "Helpers in tests/lib/app-menus.ts (per-app function map) are the right granularity",
    pattern: /\bclass\s+\w*Page\s*\{/,
  },
];

async function listSpecFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) return [];
        return listSpecFiles(fullPath);
      }
      return entry.isFile() && entry.name.endsWith(".spec.ts") ? [fullPath] : [];
    })
  );
  return files.flat();
}

function stripLineComments(line: string): string {
  const commentStart = line.indexOf("//");
  return commentStart >= 0 ? line.slice(0, commentStart) : line;
}

test.describe("Playwright suite hygiene", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "static hygiene check is browser-independent"
  );

  test("specs avoid fragile readiness waits and focused tests", async () => {
    const violations: Violation[] = [];

    for (const file of await listSpecFiles(TESTS_DIR)) {
      const rel = path.relative(ROOT, file);
      if (rel === "tests/meta/playwright-practices.spec.ts") continue;
      const lines = (await readFile(file, "utf8")).split(/\r?\n/);
      let inBlockComment = false;

      lines.forEach((rawLine, index) => {
        let line = rawLine;
        if (inBlockComment) {
          const end = line.indexOf("*/");
          if (end < 0) return;
          line = line.slice(end + 2);
          inBlockComment = false;
        }

        while (line.includes("/*")) {
          const start = line.indexOf("/*");
          const end = line.indexOf("*/", start + 2);
          if (end < 0) {
            line = line.slice(0, start);
            inBlockComment = true;
            break;
          }
          line = `${line.slice(0, start)}${line.slice(end + 2)}`;
        }

        const code = stripLineComments(line).trim();
        if (!code) return;

        for (const rule of RULES) {
          if (rule.exemptPaths?.some((p) => rel === p || rel.endsWith(`/${p}`))) continue;
          if (rule.pattern.test(code)) {
            violations.push({
              file: rel,
              line: index + 1,
              rule: rule.name,
              text: code,
            });
          }
        }
      });
    }

    expect(
      violations,
      violations
        .map((v) => `${v.file}:${v.line} — ${v.rule}\n  ${v.text}`)
        .join("\n")
    ).toEqual([]);
  });

  // Structural conventions — file-level checks that don't fit a line-pattern.
  //
  // skills.md §1 organises tests/auth/ as the SSO-chain-contract group:
  // every spec in there should pin at least one openspec requirement via
  // a `// @spec module#slug` tag. Tests in tests/security/, tests/apps/,
  // tests/flows/ are orthogonal-coverage by design and don't require tags.
  test("every tests/auth spec carries at least one @spec tag", async () => {
    const authDir = path.join(TESTS_DIR, "auth");
    const files = await listSpecFiles(authDir);
    const missing: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (!/^\s*\/\/\s*@spec\s+[a-z0-9-]+#[a-z0-9-]+/m.test(content)) {
        missing.push(path.relative(ROOT, file));
      }
    }
    expect(
      missing,
      `tests/auth/ specs are expected to pin at least one openspec requirement.\n` +
        `Files missing the tag:\n${missing.map((f) => `  - ${f}`).join("\n")}\n\n` +
        `Tag format: \`// @spec <module>#<requirement-slug>\` above the test/describe.\n` +
        `If the file is orthogonal coverage that doesn't pin an openspec requirement,\n` +
        `move it under tests/security/, tests/apps/, or tests/flows/ instead.`
    ).toEqual([]);
  });

  // The bug-spec discipline in CLAUDE.md: every tests/bugs/*.spec.ts
  // must have a sibling tests/bugs/specs/*.plan.md describing the
  // scenario (Status, Application Overview, Test Scenarios, …). The
  // plan is the source-of-intent that survives selector churn — a
  // bug test without one is a regression in our own conventions.
  test("every tests/bugs spec has a sibling plan.md", async () => {
    const bugsDir = path.join(TESTS_DIR, "bugs");
    const specsDir = path.join(bugsDir, "specs");
    let bugFiles: string[];
    try {
      const entries = await readdir(bugsDir, { withFileTypes: true });
      bugFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith(".spec.ts"))
        .map((e) => path.join(bugsDir, e.name));
    } catch {
      bugFiles = [];
    }

    let planFiles = new Set<string>();
    try {
      const entries = await readdir(specsDir, { withFileTypes: true });
      planFiles = new Set(
        entries.filter((e) => e.isFile() && e.name.endsWith(".plan.md")).map((e) => e.name)
      );
    } catch {
      // specs/ may not exist yet — that's fine when bugFiles is empty.
    }

    const orphans: string[] = [];
    for (const specFile of bugFiles) {
      const base = path.basename(specFile, ".spec.ts");
      const expected = `${base}.plan.md`;
      if (!planFiles.has(expected)) {
        orphans.push(`${path.relative(ROOT, specFile)} (expected sibling: tests/bugs/specs/${expected})`);
      }
    }

    expect(
      orphans,
      `tests/bugs/ specs must each have a sibling plan.md describing the\n` +
        `scenario (template in CLAUDE.md → "Bug spec plan format").\n` +
        `Missing:\n${orphans.map((f) => `  - ${f}`).join("\n")}`
    ).toEqual([]);
  });
});
