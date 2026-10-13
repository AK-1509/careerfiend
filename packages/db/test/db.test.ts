import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, migrationSql } from "../src/index";

describe("db", () => {
  it("creates the schema on a fresh embedded Postgres and round-trips a row, including bytes", async () => {
    const db = createDb("pglite:memory");
    await db.setting.create({ data: { key: "k", value: "v" } });
    expect((await db.setting.findUnique({ where: { key: "k" } }))?.value).toBe("v");
    await db.storedFile.create({ data: { path: "a/b.txt", contentType: "text/plain", sha256: "x", size: 3, data: Buffer.from("abc") } });
    expect(Buffer.from((await db.storedFile.findUniqueOrThrow({ where: { path: "a/b.txt" } })).data).toString()).toBe("abc");
    await db.$disconnect();
  });

  it("embedded migrations match prisma/migrations (run npm run -w @careerfiend/db migration after schema changes)", () => {
    const dir = path.join(import.meta.dirname, "..", "prisma", "migrations");
    const files = readdirSync(dir)
      .filter((d) => existsSync(path.join(dir, d, "migration.sql")))
      .sort()
      .map((name) => ({ name, sql: readFileSync(path.join(dir, name, "migration.sql"), "utf8") }));
    expect(migrationSql()).toEqual(files);
  });

  it("rejects unsupported URLs", () => {
    expect(() => createDb("file:./x.db")).toThrow(/Unsupported DATABASE_URL/);
  });
});
