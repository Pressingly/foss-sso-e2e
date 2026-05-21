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

const RULES: { name: string; pattern: RegExp }[] = [
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
});
