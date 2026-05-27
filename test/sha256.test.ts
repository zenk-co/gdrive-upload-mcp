import { describe, test, expect } from "vitest";
import { createShaCountingStream } from "../src/sha256";
import { sha256 } from "@noble/hashes/sha256";

const encoder = new TextEncoder();

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function pipeThrough(input: Uint8Array[], maxBytes: number) {
  const counter = createShaCountingStream(maxBytes);
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of input) controller.enqueue(chunk);
      controller.close();
    },
  });
  const piped = readable.pipeThrough(counter.stream);
  const reader = piped.getReader();
  const out: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out.push(value);
  }
  return { counter, out };
}

describe("sha256 streaming", () => {
  test("computes correct hash and size for a single chunk", async () => {
    const bytes = encoder.encode("hello world");
    const { counter, out } = await pipeThrough([bytes], 1024);
    const result = counter.finalize();
    expect(result.size).toBe(bytes.byteLength);
    expect(result.sha256).toBe(toHex(sha256(bytes)));
    expect(Buffer.concat(out.map((x) => Buffer.from(x))).toString()).toBe("hello world");
  });

  test("computes correct hash across multiple chunks", async () => {
    const chunks = [
      encoder.encode("the quick "),
      encoder.encode("brown fox "),
      encoder.encode("jumps over"),
    ];
    const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const { counter } = await pipeThrough(chunks, 1024);
    const result = counter.finalize();
    expect(result.size).toBe(merged.byteLength);
    expect(result.sha256).toBe(toHex(sha256(new Uint8Array(merged))));
  });

  test("aborts when total exceeds maxBytes", async () => {
    const big = new Uint8Array(100);
    const counter = createShaCountingStream(50);
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    const piped = readable.pipeThrough(counter.stream);
    const reader = piped.getReader();
    await expect(reader.read()).rejects.toThrow(/exceeds maxBytes/);
  });

  test("finalize before stream completes throws", () => {
    const counter = createShaCountingStream(1024);
    expect(() => counter.finalize()).toThrow(/did not complete/);
  });
});
