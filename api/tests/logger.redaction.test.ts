import { Writable } from "node:stream";

import express from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { loggerOptions } from "../src/logger.js";

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.secret-payload.signature";

function captureLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { lines, logger: pino({ ...loggerOptions, level: "info" }, stream) };
}

describe("request log redaction", () => {
  it("censors authorization, cookie and set-cookie headers", async () => {
    const { lines, logger } = captureLogs();
    const app = express();
    app.use(pinoHttp({ logger }));
    app.get("/x", (_req, res) => {
      res.setHeader("Set-Cookie", "session=topsecret");
      res.json({ ok: true });
    });

    await request(app)
      .get("/x")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("Cookie", "sb-access-token=topsecret")
      .set("X-Internal-Token", "internal-secret");

    const output = lines.join("\n");
    expect(output).toContain('"authorization":"***"');
    expect(output).toContain('"cookie":"***"');
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain("topsecret");
    expect(output).not.toContain("internal-secret");
  });

  it("leaves ordinary headers readable", async () => {
    const { lines, logger } = captureLogs();
    const app = express();
    app.use(pinoHttp({ logger }));
    app.get("/x", (_req, res) => res.json({ ok: true }));

    await request(app).get("/x").set("User-Agent", "vitest-agent");

    expect(lines.join("\n")).toContain("vitest-agent");
  });
});
