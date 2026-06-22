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

// --- Read / management operations -----------------------------------------

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_INFO_FIELDS = "id,name,mimeType,size,modifiedTime";

export interface DriveFileInfo {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
}

function authHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
}

export async function driveSearch(args: {
  accessToken: string;
  query?: string;
  pageSize?: number;
  pageToken?: string;
}): Promise<{ files: DriveFileInfo[]; nextPageToken?: string }> {
  const params = new URLSearchParams({
    fields: `nextPageToken,files(${DRIVE_INFO_FIELDS})`,
    pageSize: String(args.pageSize ?? 25),
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    corpora: "user",
    orderBy: "modifiedTime desc",
  });
  if (args.query) params.set("q", args.query);
  if (args.pageToken) params.set("pageToken", args.pageToken);

  const res = await fetch(`${DRIVE_FILES_URL}?${params.toString()}`, { headers: authHeaders(args.accessToken) });
  if (!res.ok) throw new Error(`drive search failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { files: DriveFileInfo[]; nextPageToken?: string };
}

export async function driveGetMetadata(args: {
  accessToken: string;
  fileId: string;
}): Promise<DriveFileInfo> {
  const url = `${DRIVE_FILES_URL}/${encodeURIComponent(args.fileId)}?fields=${encodeURIComponent(
    DRIVE_INFO_FIELDS,
  )}&supportsAllDrives=true`;
  const res = await fetch(url, { headers: authHeaders(args.accessToken) });
  if (res.status === 404) throw new Error("file not found or not accessible");
  if (!res.ok) throw new Error(`drive metadata failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as DriveFileInfo;
}

/** Returns the raw Drive `alt=media` response so the caller can stream the body. */
export async function driveDownloadResponse(args: {
  accessToken: string;
  fileId: string;
}): Promise<Response> {
  const url = `${DRIVE_FILES_URL}/${encodeURIComponent(args.fileId)}?alt=media&supportsAllDrives=true`;
  return fetch(url, { headers: authHeaders(args.accessToken) });
}

/** Like {@link deleteDriveFile} but surfaces failures (used by the delete_file tool). */
export async function deleteDriveFileChecked(accessToken: string, fileId: string): Promise<void> {
  const res = await fetch(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`drive delete failed: ${res.status} ${await res.text()}`);
  }
}
