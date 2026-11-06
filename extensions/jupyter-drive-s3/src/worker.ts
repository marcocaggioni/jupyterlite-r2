// jupyter-drive-s3 — Worker REST client.
//
// Replaces the S3 SDK layer of jupydrive-s3 with plain fetch() calls to the
// jupyter-drive Cloudflare Worker, the front door to the R2 bucket:
//
//   GET  /api/health                      -> { ok: true }
//   GET  /api/list?prefix=&delimiter=/    -> { objects: [{key,size,uploaded}], folders: [], cursor }
//   GET  /api/file/<key>                  -> object bytes (public)
//   HEAD /api/file/<key>                  -> headers only (public)
//   PUT  /api/file/<key>                  -> upload, needs x-write-secret
//   DELETE /api/file/<key>                -> delete, needs x-write-secret
//
// The Worker holds the R2 credentials (bucket binding), so the browser never
// sees any R2 keys. Public reads need no secret; writes send the shared
// WRITE_SECRET in the x-write-secret header.

import { Contents } from '@jupyterlab/services';
import { PathExt } from '@jupyterlab/coreutils';

export interface IRegisteredFileTypes {
  [fileExtension: string]: {
    fileType: string;
    fileMimeTypes: string[];
    fileFormat: string;
  };
}

export interface IWorkerListResult {
  objects: Array<{ key: string; size: number; uploaded: string }>;
  folders: string[];
}

interface IContentsList {
  [fileName: string]: Contents.IModel;
}

let data: Contents.IModel = {
  name: '',
  path: '',
  last_modified: '',
  created: '',
  content: null,
  format: null,
  mimetype: '',
  size: 0,
  writable: true,
  type: ''
};

/**
 * The name of the drive shown in the file browser.
 */
export const DRIVE_NAME = 'jupyter-drive';

/**
 * Fetch from the Worker, throwing a readable error on HTTP failure.
 */
async function workerFetch(
  workerUrl: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const url = workerUrl.replace(/\/$/, '') + path;
  const response = await fetch(url, init);
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        detail = body.error;
      }
    } catch {
      // Response is not JSON; keep the status text.
    }
    throw new Error(
      `Worker request failed (${response.status} ${detail}): ${init?.method ?? 'GET'} ${path}`
    );
  }
  return response;
}

/**
 * List objects under a prefix, following pagination cursors.
 * With a delimiter, `folders` holds the immediate subdirectories.
 */
export async function listWorker(
  workerUrl: string,
  prefix: string,
  delimiter?: string
): Promise<IWorkerListResult> {
  const objects: IWorkerListResult['objects'] = [];
  const folders: string[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ prefix });
    if (delimiter) {
      params.set('delimiter', delimiter);
    }
    if (cursor) {
      params.set('cursor', cursor);
    }
    const response = await workerFetch(workerUrl, `/api/list?${params}`);
    const result = (await response.json()) as {
      objects: IWorkerListResult['objects'];
      folders: string[];
      cursor: string | null;
    };
    objects.push(...(result.objects ?? []));
    folders.push(...(result.folders ?? []));
    cursor = result.cursor;
  } while (cursor);
  return { objects, folders };
}

/**
 * Get the download URL for a Worker object. Reads are public, so no
 * signing is needed — the URL is the Worker's public file endpoint.
 */
export function workerDownloadUrl(workerUrl: string, key: string): string {
  return `${workerUrl.replace(/\/$/, '')}/api/file/${encodeURIComponent(key)}`;
}

/**
 * Get list of contents of root or directory, or the contents of a file
 * when the path resolves to one.
 *
 * @param workerUrl: The base URL of the jupyter-drive Worker.
 * @param root: The path to the directory acting as root.
 * @param registeredFileTypes: The list containing all registered file types.
 * @param path: The path to the directory or file (optional).
 *
 * @returns: A promise which resolves with the contents model.
 */
export const listWorkerContents = async (
  workerUrl: string,
  root: string,
  registeredFileTypes: IRegisteredFileTypes,
  path?: string
): Promise<Contents.IModel> => {
  const fileList: IContentsList = {};
  // Directory listings use the prefix with a trailing slash; the root
  // listing uses an empty prefix.
  const prefix = path ? PathExt.join(root, path) + '/' : root ? root + '/' : '';
  const { objects, folders } = await listWorker(workerUrl, prefix, '/');

  // The listing of a directory never returns the directory's own
  // zero-byte placeholder key (key == prefix); filter it out.
  const entries = objects.filter(o => o.key !== prefix);

  if (entries.length === 0 && folders.length === 0) {
    if (path) {
      // Nothing under this prefix: the path is a file (or does not exist).
      return getWorkerFileContents(workerUrl, root, path, registeredFileTypes);
    }
    // Empty root: an empty directory listing.
  }

  entries.forEach(o => {
    const fileName = o.key.slice(prefix.length);
    // With a delimiter, objects are immediate children only.
    if (fileName.includes('/')) {
      return;
    }
    const [fileType, fileMimeType, fileFormat] = Private.getFileType(
      PathExt.extname(PathExt.basename(fileName)),
      false,
      registeredFileTypes
    );
    fileList[fileName] = {
      name: fileName,
      path: path ? PathExt.join(path, fileName) : fileName,
      last_modified: o.uploaded ?? '',
      created: '',
      content: null,
      format: fileFormat as Contents.FileFormat,
      mimetype: fileMimeType,
      size: o.size,
      writable: true,
      type: fileType
    };
  });

  folders.forEach(folderPrefix => {
    const folderName = folderPrefix.slice(prefix.length).replace(/\/$/, '');
    if (!folderName || folderName.includes('/')) {
      return;
    }
    const [fileType, fileMimeType, fileFormat] = Private.getFileType(
      '',
      true,
      registeredFileTypes
    );
    fileList[folderName] = {
      name: folderName,
      path: path ? PathExt.join(path, folderName) : folderName,
      last_modified: '',
      created: '',
      content: [],
      format: fileFormat as Contents.FileFormat,
      mimetype: fileMimeType,
      size: 0,
      writable: true,
      type: fileType
    };
  });

  data = {
    name: path ? PathExt.basename(path) : DRIVE_NAME,
    path: path ? path + '/' : DRIVE_NAME,
    last_modified: '',
    created: '',
    content: Object.values(fileList),
    format: 'json',
    mimetype: '',
    size: undefined,
    writable: true,
    type: 'directory'
  };

  return data;
};

/**
 * Retrieve contents of a file.
 *
 * @param workerUrl: The base URL of the jupyter-drive Worker.
 * @param root: The path to the directory acting as root.
 * @param path: The path to the file.
 * @param registeredFileTypes: The list containing all registered file types.
 *
 * @returns: A promise which resolves with the file contents model.
 */
export const getWorkerFileContents = async (
  workerUrl: string,
  root: string,
  path: string,
  registeredFileTypes: IRegisteredFileTypes
): Promise<Contents.IModel> => {
  const key = PathExt.join(root, path);
  const response = await workerFetch(
    workerUrl,
    `/api/file/${encodeURIComponent(key)}`
  );

  const [fileType, fileMimeType, fileFormat] = Private.getFileType(
    PathExt.extname(PathExt.basename(path)),
    false,
    registeredFileTypes
  );

  let fileContents: string | Uint8Array;
  let size = 0;

  // For certain media type files, extract content as a byte array and
  // decode to base64 to view in JupyterLab.
  if (fileFormat === 'base64' || fileType === 'PDF') {
    const buffer = new Uint8Array(await response.arrayBuffer());
    size = buffer.length;
    const chunk = 0x8000;
    let binary = '';
    for (let i = 0; i < buffer.length; i += chunk) {
      binary += String.fromCharCode.apply(
        null,
        Array.from(buffer.subarray(i, i + chunk))
      );
    }
    fileContents = btoa(binary);
  } else {
    fileContents = await response.text();
    size = fileContents.length;
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    size = parseInt(contentLength, 10);
  }

  // The Worker file endpoint does not expose the object's upload date,
  // so the current time is used; listings carry the real date.
  data = {
    name: PathExt.basename(path),
    path,
    last_modified: new Date().toISOString(),
    created: '',
    content: fileContents,
    format: fileFormat as Contents.FileFormat,
    mimetype: fileMimeType,
    size,
    writable: true,
    type: fileType
  };

  return data;
};

/**
 * Create a new file or directory, or save a file.
 *
 * When saving a file, the options parameter is needed.
 *
 * @param workerUrl: The base URL of the jupyter-drive Worker.
 * @param writeSecret: The shared write secret (x-write-secret header).
 * @param root: The path to the directory acting as root.
 * @param name: The name of the file or directory to be created or saved.
 * @param path: The full drive-relative path of the file or directory.
 * @param body: The new contents of the file.
 * @param registeredFileTypes: The list containing all registered file types.
 * @param isDir: Whether a directory is being created.
 * @param options: The optional parameters of saving a file (optional).
 *
 * @returns A promise which resolves with the new file or directory contents model.
 */
export const createWorkerObject = async (
  workerUrl: string,
  writeSecret: string,
  root: string,
  name: string,
  path: string,
  body: string | Blob,
  registeredFileTypes: IRegisteredFileTypes,
  isDir: boolean,
  options?: Partial<Contents.IModel>
): Promise<Contents.IModel> => {
  const key = PathExt.join(root, path) + (isDir ? '/' : '');

  const [fileType, fileMimeType, fileFormat] = Private.getFileType(
    PathExt.extname(PathExt.basename(name)),
    isDir,
    registeredFileTypes
  );

  // Checking if we are creating a new file or saving an existing one
  // (overwriting).
  if (options) {
    body = Private.formatBody(options, fileFormat, fileType, fileMimeType);
  }

  const headers: Record<string, string> = {
    'x-write-secret': writeSecret
  };
  if (typeof body === 'string') {
    headers['content-type'] = fileMimeType;
  }
  // A Blob body already carries its own content type.

  await workerFetch(workerUrl, `/api/file/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers,
    body: body as BodyInit
  });

  const lastModified = new Date().toISOString();

  data = {
    name,
    path: isDir ? path + '/' : path,
    last_modified: lastModified,
    created: lastModified,
    content: isDir ? [] : body,
    format: fileFormat as Contents.FileFormat,
    mimetype: fileMimeType,
    size: typeof body === 'string' ? body.length : body.size,
    writable: true,
    type: fileType
  };

  return data;
};

/**
 * Delete a file or directory.
 *
 * @param workerUrl: The base URL of the jupyter-drive Worker.
 * @param writeSecret: The shared write secret (x-write-secret header).
 * @param root: The path to the directory acting as root.
 * @param path: The path to the file or directory.
 */
export const deleteWorkerObjects = async (
  workerUrl: string,
  writeSecret: string,
  root: string,
  path: string
): Promise<void> => {
  const key = PathExt.join(root, path);
  // List by prefix, then delete only the exact key (a file) and keys
  // under key + '/' (a directory's contents). A bare prefix match would
  // also catch siblings like 'foo.ipynb.bak' when deleting 'foo.ipynb'.
  const { objects } = await listWorker(workerUrl, key);
  const keys = objects
    .map(o => o.key)
    .filter(k => k === key || k.startsWith(key + '/'));
  await Promise.all(
    keys.map(k =>
      workerFetch(workerUrl, `/api/file/${encodeURIComponent(k)}`, {
        method: 'DELETE',
        headers: { 'x-write-secret': writeSecret }
      })
    )
  );
};

/**
 * Check whether an object (file or directory) exists.
 *
 * Used before renaming a file to avoid overwriting, and when setting
 * the root.
 *
 * @param workerUrl: The base URL of the jupyter-drive Worker.
 * @param root: The path to the directory acting as root.
 * @param path: The path to the object.
 * @param isDir: Whether the object is a directory.
 *
 * @returns A promise which resolves or rejects depending on the
 * existence of the object.
 */
export const checkWorkerObject = async (
  workerUrl: string,
  root: string,
  path?: string,
  isDir?: boolean
): Promise<void> => {
  const prefix: string = path
    ? PathExt.join(root, path) + (isDir === true ? '/' : '')
    : root + '/';
  const { objects, folders } = await listWorker(workerUrl, prefix);
  if (objects.length > 0 || folders.length > 0) {
    return Promise.resolve();
  }
  return Promise.reject();
};

/**
 * Rename a file or directory. The Worker has no server-side copy, so a
 * rename is get + put + delete for each object under the old path.
 *
 * @param workerUrl: The base URL of the jupyter-drive Worker.
 * @param writeSecret: The shared write secret (x-write-secret header).
 * @param root: The path to the directory acting as root.
 * @param oldLocalPath: The old path of the object.
 * @param newLocalPath: The new path of the object.
 * @param newFileName: The new object name.
 * @param isDir: Whether the object is a directory or a file.
 * @param registeredFileTypes: The list containing all registered file types.
 *
 * @returns A promise which resolves with the new object contents model.
 */
export const renameWorkerObjects = async (
  workerUrl: string,
  writeSecret: string,
  root: string,
  oldLocalPath: string,
  newLocalPath: string,
  newFileName: string,
  isDir: boolean,
  registeredFileTypes: IRegisteredFileTypes
): Promise<Contents.IModel> => {
  let newKey = PathExt.join(root, newLocalPath);
  if (isDir) {
    newKey = newKey.endsWith('/') ? newKey.slice(0, -1) : newKey;
  }
  newKey = newKey.slice(0, newKey.lastIndexOf('/') + 1) + newFileName;

  const [fileType, fileMimeType, fileFormat] = Private.getFileType(
    PathExt.extname(PathExt.basename(newFileName)),
    isDir,
    registeredFileTypes
  );

  const oldKey = PathExt.join(root, oldLocalPath);
  // For a directory, list everything under its prefix; for a file, the
  // single object.
  const { objects } = await listWorker(
    workerUrl,
    isDir ? oldKey + '/' : oldKey
  );

  if (objects.length === 0) {
    throw new Error(`Cannot rename: ${oldLocalPath} not found`);
  }

  let body: string | ArrayBuffer | null = null;
  let size = 0;
  for (const obj of objects) {
    const remainingFilePath = obj.key.slice(oldKey.length);
    const response = await workerFetch(
      workerUrl,
      `/api/file/${encodeURIComponent(obj.key)}`
    );
    const contentType =
      response.headers.get('content-type') ?? 'application/octet-stream';
    const buffer = await response.arrayBuffer();
    await workerFetch(
      workerUrl,
      `/api/file/${encodeURIComponent(newKey + remainingFilePath)}`,
      {
        method: 'PUT',
        headers: {
          'x-write-secret': writeSecret,
          'content-type': contentType
        },
        body: buffer
      }
    );
    await workerFetch(
      workerUrl,
      `/api/file/${encodeURIComponent(obj.key)}`,
      {
        method: 'DELETE',
        headers: { 'x-write-secret': writeSecret }
      }
    );
    if (!isDir) {
      body = buffer;
      size = buffer.byteLength;
    }
  }

  const lastModifiedDate = new Date().toISOString();
  data = {
    name: newFileName,
    path: newKey.replace(root ? root + '/' : '', ''),
    last_modified: lastModifiedDate,
    created: '',
    content: isDir ? [] : body,
    format: fileFormat as Contents.FileFormat,
    mimetype: fileMimeType,
    size,
    writable: true,
    type: fileType
  };
  return data;
};

/**
 * Copy a file or directory to a new location within the bucket.
 *
 * @param workerUrl: The base URL of the jupyter-drive Worker.
 * @param writeSecret: The shared write secret (x-write-secret header).
 * @param root: The path to the directory acting as root.
 * @param name: The new object name.
 * @param path: The original path to the object to be copied.
 * @param toDir: The new path where the object should be copied.
 * @param registeredFileTypes: The list containing all registered file types.
 *
 * @returns A promise which resolves with the new object contents model.
 */
export const copyWorkerObjects = async (
  workerUrl: string,
  writeSecret: string,
  root: string,
  name: string,
  path: string,
  toDir: string,
  registeredFileTypes: IRegisteredFileTypes
): Promise<Contents.IModel> => {
  const isDir: boolean = await isDirectory(workerUrl, root, path);
  const oldKey = PathExt.join(root, path);
  const newKey = PathExt.join(root, toDir, name);

  const { objects } = await listWorker(
    workerUrl,
    isDir ? oldKey + '/' : oldKey
  );

  if (objects.length === 0) {
    throw new Error(`Cannot copy: ${path} not found`);
  }

  let size = 0;
  let lastModified = new Date().toISOString();
  for (const obj of objects) {
    const remainingFilePath = obj.key.slice(oldKey.length);
    const response = await workerFetch(
      workerUrl,
      `/api/file/${encodeURIComponent(obj.key)}`
    );
    const contentType =
      response.headers.get('content-type') ?? 'application/octet-stream';
    const buffer = await response.arrayBuffer();
    await workerFetch(
      workerUrl,
      `/api/file/${encodeURIComponent(newKey + remainingFilePath)}`,
      {
        method: 'PUT',
        headers: {
          'x-write-secret': writeSecret,
          'content-type': contentType
        },
        body: buffer
      }
    );
    if (!isDir) {
      size = buffer.byteLength;
    }
  }

  const [fileType, fileMimeType, fileFormat] = Private.getFileType(
    PathExt.extname(PathExt.basename(name)),
    isDir,
    registeredFileTypes
  );

  data = {
    name: PathExt.basename(name),
    path: PathExt.join(toDir, name),
    last_modified: lastModified,
    created: lastModified,
    content: isDir ? [] : null,
    format: fileFormat as Contents.FileFormat,
    mimetype: fileMimeType,
    size,
    writable: true,
    type: fileType
  };

  return data;
};

/**
 * Count number of appearances of an object name.
 *
 * @param workerUrl: The base URL of the jupyter-drive Worker.
 * @param root: The path to the directory acting as root.
 * @param path: The path of the object.
 * @param originalName: The original name of the object (before it was
 * incremented).
 *
 * @returns A promise which resolves with the number of appearances.
 */
export const countWorkerObjectNameAppearances = async (
  workerUrl: string,
  root: string,
  path: string,
  originalName: string
): Promise<number> => {
  let counter = 0;
  const parentPrefix = PathExt.join(root, path).slice(
    0,
    PathExt.join(root, path).lastIndexOf('/')
  );
  const { objects } = await listWorker(
    workerUrl,
    parentPrefix ? parentPrefix + '/' : '',
    '/'
  );
  objects.forEach(o => {
    let fileName = o.key.slice(parentPrefix ? parentPrefix.length + 1 : 0);
    fileName = fileName.split('/')[0];
    if (fileName.startsWith(originalName)) {
      counter += 1;
    }
  });
  return counter;
};

/**
 * This is a helper function that resolves whether a given path
 * is a directory, because the list API does not provide this directly.
 */
export async function isDirectory(
  workerUrl: string,
  root: string,
  objectPath: string
): Promise<boolean> {
  const prefix = PathExt.join(root, objectPath) + '/';
  const { objects, folders } = await listWorker(workerUrl, prefix, '/');
  return objects.length > 0 || folders.length > 0;
}

namespace Private {
  /**
   * Helping function to define file type, mimetype and format based on
   * file extension.
   * @param extension: File extension (e.g.: txt, ipynb, csv)
   * @param isDir: Boolean showing if the object is a directory or a file
   * @param registeredFileTypes: The list containing all registered file types.
   * @returns The object type, mimetype and format.
   */
  export function getFileType(
    extension: string,
    isDir: boolean,
    registeredFileTypes: IRegisteredFileTypes
  ) {
    let fileType: string = isDir === false ? 'text' : 'directory';
    let fileMimetype: string =
      isDir === false ? 'text/plain' : 'text/directory';
    let fileFormat: string = isDir === false ? 'text' : 'json';

    if (isDir === false && registeredFileTypes[extension]) {
      fileType = registeredFileTypes[extension].fileType;
      fileMimetype = registeredFileTypes[extension].fileMimeTypes[0];
      fileFormat = registeredFileTypes[extension].fileFormat;
    }

    // The file format for notebooks appears as json, but should be text.
    if (extension === '.ipynb') {
      fileFormat = 'text';
    }

    return [fileType, fileMimetype, fileFormat];
  }

  /**
   * Helping function used for formatting the body of files.
   *
   * @param options: The parameters for saving a file.
   * @param fileFormat: The registered file format.
   * @param fileType: The registered file type.
   * @param fileMimeType: The registered file mimetype.
   *
   * @returns The formatted content (body).
   */
  export function formatBody(
    options: Partial<Contents.IModel>,
    fileFormat: string,
    fileType: string,
    fileMimeType: string
  ) {
    let body: string | Blob;
    if (options.format === 'json') {
      body = JSON.stringify(options.content, null, 2);
    } else if (options.format === 'base64') {
      // JupyterLab uploads every file as base64 — including notebooks,
      // whose registered format here is 'text', not 'base64'. Decode
      // whenever the content arrives as base64, or the bucket stores
      // the base64 text instead of the real file and the notebook
      // fails to open ("Unexpected token" on load).
      // Transform base64 encoding to a utf-8 array for saving and
      // storing in the bucket.
      const byteCharacters = atob(options.content);
      const byteArrays: Uint8Array[] = [];

      for (let offset = 0; offset < byteCharacters.length; offset += 512) {
        const slice = byteCharacters.slice(offset, offset + 512);
        const byteNumbers = new Array(slice.length);
        for (let i = 0; i < slice.length; i++) {
          byteNumbers[i] = slice.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        byteArrays.push(byteArray);
      }

      body = new Blob(byteArrays, { type: fileMimeType });
    } else {
      body = options.content;
    }
    return body;
  }
}
