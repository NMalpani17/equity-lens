import { describe, expect, it } from "vitest";

import { parseSse } from "@/lib/sse";

function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const frames = [];
  for await (const frame of parseSse(stream)) frames.push(frame);
  return frames;
}

describe("parseSse", () => {
  it("parses frames split across chunks and CRLF line endings", async () => {
    const frames = await collect(
      streamOf(
        'event: token\ndata: {"te',
        'xt":"Hi"}\n\nevent: done\r\ndata: {}\r\n\r\n',
      ),
    );

    expect(frames).toEqual([
      { event: "token", data: '{"text":"Hi"}' },
      { event: "done", data: "{}" },
    ]);
  });

  it("ignores frames without data and keeps an unfinished tail out", async () => {
    const frames = await collect(
      streamOf(": keep-alive\n\nevent: token\ndata: {}\n\nevent: tok"),
    );

    expect(frames).toEqual([{ event: "token", data: "{}" }]);
  });
});
