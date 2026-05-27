import { DurableObject } from "cloudflare:workers";
import { sha256 } from "@noble/hashes/sha256";
import type { Env, UploadRecord } from "../env";
import { uploadKey } from "../env";
import {
  deleteDriveFile,
  initResumableUpload,
  type DriveFileMetadata,
} from "../drive";

interface PersistedState {
  sessionUri: string;
  uploadId: string;
  userId: string;
  filename: string;
  contentType: string;
  totalSize: number;
  expectedSha256?: string;
  parents?: string[];
  currentOffset: number;
}

export interface InitArgs {
  uploadId: string;
  userId: string;
  accessToken: string;
  filename: string;
  contentType: string;
  totalSize: number;
  expectedSha256?: string;
  parents?: string[];
}

export interface ChunkArgs {
  start: number;
  end: number;
  total: number;
  accessToken: string;
  body: Uint8Array;
}

export type ChunkResult =
  | { status: "incomplete"; nextOffset: number }
  | { status: "complete"; file: DriveFileMetadata; actualSha256: string | null }
  | { status: "error"; httpStatus: number; message: string };

function toHex(b: Uint8Array): string {
  let out = "";
  for (const x of b) out += x.toString(16).padStart(2, "0");
  return out;
}

export class UploadSession extends DurableObject<Env> {
  private hasher = sha256.create();
  private hasherValid = false;
  private bytesHashed = 0;

  async setRecord(record: UploadRecord): Promise<void> {
    await this.ctx.storage.put("record", record);
  }

  async getRecord(): Promise<UploadRecord | null> {
    const r = await this.ctx.storage.get<UploadRecord>("record");
    return r ?? null;
  }

  async markCompletedSingle(args: {
    driveFileId: string;
    driveName: string;
    driveMime: string;
    actualSize: number;
    actualSha256: string;
  }): Promise<void> {
    const record = await this.getRecord();
    if (!record) return;
    if (record.status === "completed") return;
    const completed: UploadRecord = {
      ...record,
      status: "completed",
      actualSize: args.actualSize,
      actualSha256: args.actualSha256,
      driveFileId: args.driveFileId,
      driveName: args.driveName,
      driveMime: args.driveMime,
    };
    await this.setRecord(completed);
  }

  async markFailedRecord(reason: string): Promise<void> {
    const record = await this.getRecord();
    if (!record) return;
    if (record.status === "failed") return;
    await this.setRecord({ ...record, status: "failed", failureReason: reason });
  }

  async init(args: InitArgs): Promise<{ sessionUri: string; currentOffset: number }> {
    const existing = await this.ctx.storage.get<PersistedState>("state");
    if (existing) {
      return { sessionUri: existing.sessionUri, currentOffset: existing.currentOffset };
    }

    const sessionUri = await initResumableUpload({
      accessToken: args.accessToken,
      filename: args.filename,
      contentType: args.contentType,
      contentLength: args.totalSize,
      ...(args.parents ? { parents: args.parents } : {}),
    });

    const state: PersistedState = {
      sessionUri,
      uploadId: args.uploadId,
      userId: args.userId,
      filename: args.filename,
      contentType: args.contentType,
      totalSize: args.totalSize,
      ...(args.expectedSha256 ? { expectedSha256: args.expectedSha256 } : {}),
      ...(args.parents ? { parents: args.parents } : {}),
      currentOffset: 0,
    };
    await this.ctx.storage.put("state", state);

    this.hasher = sha256.create();
    this.hasherValid = true;
    this.bytesHashed = 0;

    return { sessionUri, currentOffset: 0 };
  }

  async receiveChunk(args: ChunkArgs): Promise<ChunkResult> {
    const state = await this.ctx.storage.get<PersistedState>("state");
    if (!state) {
      return { status: "error", httpStatus: 409, message: "session not initialized" };
    }
    if (args.total !== state.totalSize) {
      return { status: "error", httpStatus: 400, message: "totalSize mismatch" };
    }
    if (args.start !== state.currentOffset) {
      return {
        status: "error",
        httpStatus: 409,
        message: `offset mismatch: expected ${state.currentOffset}, got ${args.start}`,
      };
    }
    const chunkLength = args.end - args.start + 1;
    if (chunkLength !== args.body.byteLength) {
      return { status: "error", httpStatus: 400, message: "Content-Range size != body size" };
    }
    if (args.end + 1 > state.totalSize) {
      return { status: "error", httpStatus: 400, message: "chunk exceeds totalSize" };
    }

    if (this.hasherValid && this.bytesHashed === args.start) {
      this.hasher.update(args.body);
      this.bytesHashed += args.body.byteLength;
    } else {
      // hasher state was lost (DO restart) — abandon SHA-256 verification
      this.hasherValid = false;
    }

    const driveRes = await fetch(state.sessionUri, {
      method: "PUT",
      headers: {
        "Content-Type": state.contentType,
        "Content-Length": String(chunkLength),
        "Content-Range": `bytes ${args.start}-${args.end}/${args.total}`,
      },
      body: args.body as unknown as BodyInit,
    });

    if (driveRes.status === 308) {
      const nextOffset = args.end + 1;
      await this.ctx.storage.put("state", { ...state, currentOffset: nextOffset });
      return { status: "incomplete", nextOffset };
    }

    if (driveRes.status === 200 || driveRes.status === 201) {
      const file = (await driveRes.json()) as DriveFileMetadata;
      const actualSha256 = this.hasherValid ? toHex(this.hasher.digest()) : null;

      if (
        state.expectedSha256 &&
        actualSha256 &&
        state.expectedSha256.toLowerCase() !== actualSha256.toLowerCase()
      ) {
        await deleteDriveFile(args.accessToken, file.id);
        await this.markFailed(state, "sha256 mismatch");
        return { status: "error", httpStatus: 409, message: "sha256 mismatch" };
      }

      const record: UploadRecord = {
        status: "completed",
        userId: state.userId,
        filename: state.filename,
        size: state.totalSize,
        contentType: state.contentType,
        ...(state.expectedSha256 ? { sha256: state.expectedSha256 } : {}),
        ...(state.parents ? { parentFolderId: state.parents[0]! } : {}),
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        actualSize: Number(file.size) || state.totalSize,
        ...(actualSha256 ? { actualSha256 } : {}),
        driveFileId: file.id,
        driveName: file.name,
        driveMime: file.mimeType,
        ...(actualSha256 ? {} : { failureReason: "hasher invalidated mid-upload; sha256 unverified" }),
      };
      await this.setRecord(record);
      await this.env.UPLOAD_KV.put(uploadKey(state.uploadId), JSON.stringify(record), {
        expirationTtl: 24 * 3600,
      });
      await this.ctx.storage.delete("state");

      return { status: "complete", file, actualSha256 };
    }

    const text = await driveRes.text();
    await this.markFailed(state, `drive ${driveRes.status}: ${text.slice(0, 200)}`);
    return { status: "error", httpStatus: 502, message: `drive ${driveRes.status}` };
  }

  private async markFailed(state: PersistedState, reason: string): Promise<void> {
    const failed: UploadRecord = {
      status: "failed",
      userId: state.userId,
      filename: state.filename,
      size: state.totalSize,
      contentType: state.contentType,
      ...(state.expectedSha256 ? { sha256: state.expectedSha256 } : {}),
      ...(state.parents ? { parentFolderId: state.parents[0]! } : {}),
      expiresAt: state.currentOffset
        ? new Date(Date.now() + 3600 * 1000).toISOString()
        : new Date().toISOString(),
      failureReason: reason,
    };
    await this.setRecord(failed);
    await this.env.UPLOAD_KV.put(uploadKey(state.uploadId), JSON.stringify(failed), {
      expirationTtl: 3600,
    });
    await this.ctx.storage.delete("state");
  }
}
