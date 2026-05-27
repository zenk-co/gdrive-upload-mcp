import { sha256 } from "@noble/hashes/sha256";

export interface ShaCountingStream {
  stream: TransformStream<Uint8Array, Uint8Array>;
  finalize: () => { sha256: string; size: number };
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function createShaCountingStream(maxBytes: number): ShaCountingStream {
  const hasher = sha256.create();
  let size = 0;
  let aborted = false;
  let finalDigest: Uint8Array | null = null;

  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (aborted) return;
      size += chunk.byteLength;
      if (size > maxBytes) {
        aborted = true;
        controller.error(new Error(`upload exceeds maxBytes (${maxBytes})`));
        return;
      }
      hasher.update(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      if (!aborted) finalDigest = hasher.digest();
    },
  });

  return {
    stream,
    finalize() {
      if (!finalDigest) throw new Error("stream did not complete");
      return { sha256: toHex(finalDigest), size };
    },
  };
}
