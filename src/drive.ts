export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: string;
}

export interface InitResumableArgs {
  accessToken: string;
  filename: string;
  contentType: string;
  contentLength: number;
  parents?: string[];
}

const DRIVE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true";

const DRIVE_FILE_FIELDS = "id,name,mimeType,size";

export async function initResumableUpload(args: InitResumableArgs): Promise<string> {
  const body: Record<string, unknown> = { name: args.filename };
  if (args.parents && args.parents.length > 0) body.parents = args.parents;

  const res = await fetch(`${DRIVE_UPLOAD_URL}&fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": args.contentType,
      "X-Upload-Content-Length": String(args.contentLength),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`drive resumable init failed: ${res.status} ${text}`);
  }
  const location = res.headers.get("Location");
  if (!location) throw new Error("drive resumable init missing Location header");
  return location;
}

export async function streamToDriveSession(
  sessionUri: string,
  body: ReadableStream<Uint8Array>,
  contentType: string,
  contentLength: number
): Promise<DriveFileMetadata> {
  const res = await fetch(sessionUri, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(contentLength),
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`drive upload failed: ${res.status} ${text}`);
  }
  return (await res.json()) as DriveFileMetadata;
}

export async function cancelDriveSession(sessionUri: string): Promise<void> {
  try {
    await fetch(sessionUri, { method: "DELETE" });
  } catch {
    // best effort
  }
}

export async function deleteDriveFile(accessToken: string, fileId: string): Promise<void> {
  try {
    await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    // best effort
  }
}
