/**
 * Repository-level safety policy. There is one environment, so local `.env`
 * files point at production; these checks keep the shared Claude Code
 * guardrails (`.claude/settings.json`) from silently weakening.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repoFile = (path: string) => new URL(`../../${path}`, import.meta.url);

interface Permissions {
  deny: string[];
  ask: string[];
  allow: string[];
}

const settings = JSON.parse(
  readFileSync(repoFile(".claude/settings.json"), "utf8"),
) as {
  permissions: Permissions;
};
const { permissions } = settings;

/** Shell commands that must always be blocked, in both shells. */
const REQUIRED_DENY = [
  "git push *",
  "gh *",
  "docker push *",
  "*prisma migrate dev*",
  "*prisma migrate reset*",
  "*prisma db push*",
  "*shadow-database-url*",
  "npm run prisma*",
  "gcloud * delete *",
  "gcloud run deploy *",
  "gcloud run services update *",
  "gcloud run jobs execute *",
  "gcloud secrets versions access *",
  "gcloud storage rm *",
];

/** Commands that can reach production data and must prompt. */
const REQUIRED_ASK = [
  "npx prisma *",
  "gcloud *",
  "docker *",
  "psql *",
  "pg_dump *",
  "*python* -c *",
  "*python* - *",
  "*python* -m scripts.*",
];

/** The same command in both shells (PowerShell names some differently). */
const POWERSHELL_EQUIVALENT: Record<string, string> = { "rm *": "Remove-Item *" };

function commands(rules: string[], tool: "Bash" | "PowerShell"): string[] {
  const prefix = `${tool}(`;
  return rules
    .filter((rule) => rule.startsWith(prefix) && rule.endsWith(")"))
    .map((rule) => rule.slice(prefix.length, -1));
}

describe("Claude Code guardrails (.claude/settings.json)", () => {
  it.each(["Bash", "PowerShell"] as const)(
    "%s denies every destructive command",
    (tool) => {
      expect(commands(permissions.deny, tool)).toEqual(
        expect.arrayContaining(REQUIRED_DENY),
      );
    },
  );

  it.each(["Bash", "PowerShell"] as const)(
    "%s asks before commands that can reach production",
    (tool) => {
      expect(commands(permissions.ask, tool)).toEqual(
        expect.arrayContaining(REQUIRED_ASK),
      );
    },
  );

  it.each(["deny", "ask", "allow"] as const)(
    "every %s rule exists for both Bash and PowerShell",
    (list) => {
      const bash = commands(permissions[list], "Bash").map(
        (command) => POWERSHELL_EQUIVALENT[command] ?? command,
      );
      expect(commands(permissions[list], "PowerShell").sort()).toEqual(bash.sort());
    },
  );

  it("blocks reading and editing .env files", () => {
    expect(permissions.deny).toEqual(
      expect.arrayContaining(["Read(**/.env)", "Edit(**/.env)"]),
    );
  });

  it("never auto-allows npm scripts wholesale or Prisma", () => {
    const allowed = permissions.allow.join("\n");
    expect(allowed).not.toMatch(/npm run \*/);
    expect(allowed).not.toMatch(/prisma/i);
  });

  it("uses no ':*' after a partial word (it means ' *', so it never matches)", () => {
    // "npm run prisma:*" matches "npm run prisma ..." but not "prisma:migrate".
    const rules = [...permissions.deny, ...permissions.ask, ...permissions.allow];
    expect(rules.filter((rule) => /\w:\*\)$/.test(rule))).toEqual([]);
  });
});

describe("CLAUDE.md", () => {
  it("states that local .env files point at production", () => {
    const text = readFileSync(repoFile("CLAUDE.md"), "utf8");
    expect(text).toMatch(/local `\.env` files point at \*\*production\*\*/i);
    expect(text).toMatch(/shadow database/);
  });
});
