/**
 * Repository-level safety policy. There is one environment, so local `.env`
 * files point at production; these checks keep the shared Claude Code
 * guardrails (`.claude/settings.json`) from silently weakening, and every
 * table under row level security.
 */
import { readdirSync, readFileSync } from "node:fs";
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

describe("Prisma migrations: row level security", () => {
  const RLS_MIGRATION = "20261007000000_enable_row_level_security";
  const migrationsDir = repoFile("api/prisma/migrations/");
  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const sql = (name: string) =>
    readFileSync(new URL(`${name}/migration.sql`, migrationsDir), "utf8");

  it("has the migration that enables RLS on every table in the schema", () => {
    expect(migrations).toContain(RLS_MIGRATION);
    const body = sql(RLS_MIGRATION);
    expect(body).toMatch(/schemaname = current_schema\(\)/);
    expect(body).toMatch(/ENABLE ROW LEVEL SECURITY/);
    // Owner access (the api and ai-service) must keep working.
    expect(body).not.toMatch(/FORCE ROW LEVEL SECURITY/);
  });

  it("enables RLS on every table created after it", () => {
    const missing: string[] = [];
    // By timestamp, so a same-day migration that sorts first is still checked.
    const since = RLS_MIGRATION.slice(0, 14);
    for (const name of migrations.filter(
      (m) => m !== RLS_MIGRATION && m.slice(0, 14) >= since,
    )) {
      const body = sql(name);
      for (const [, table] of body.matchAll(
        /CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)"?/gi,
      )) {
        const enabled = new RegExp(
          `ALTER TABLE "?${table}"? ENABLE ROW LEVEL SECURITY`,
          "i",
        ).test(body);
        if (!enabled) missing.push(`${name}: ${table}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
