// jupyter-drive-s3 — Contents.IDrive backed by the jupyter-drive Worker.
//
// Derived from jupydrive-s3's Drive (QuantStack, BSD-3-Clause): the same
// IDrive surface, but every operation goes through the Worker REST API
// (see worker.ts) instead of the AWS S3 SDK. The Worker holds the R2
// credentials; the browser only ever sees the Worker URL and, for writes,
// the shared write secret.

import { Signal, ISignal } from '@lumino/signaling';
import { Contents, ServerConnection } from '@jupyterlab/services';
import { URLExt, PathExt } from '@jupyterlab/coreutils';
import { JupyterFrontEnd } from '@jupyterlab/application';

import {
  checkWorkerObject,
  copyWorkerObjects,
  countWorkerObjectNameAppearances,
  createWorkerObject,
  deleteWorkerObjects,
  isDirectory,
  listWorkerContents,
  renameWorkerObjects,
  workerDownloadUrl,
  DRIVE_NAME,
  IRegisteredFileTypes
} from './worker';

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

export class Drive implements Contents.IDrive {
  /**
   * Construct a new drive object.
   *
   * @param options - The options used to initialize the object.
   */
  constructor(options: Drive.IOptions) {
    const { workerUrl, writeSecret, name, root } = options;
    this._serverSettings = ServerConnection.makeSettings();

    this._workerUrl = workerUrl;
    this._writeSecret = writeSecret ?? '';
    this._name = name || DRIVE_NAME;
    this._baseUrl = URLExt.join(this._workerUrl, 'api', 'file');
    this._provider = 'Worker';
    this._root = root ?? '';
    this._registeredFileTypes = {};
  }

  /**
   * The Worker base URL.
   */
  get workerUrl(): string {
    return this._workerUrl;
  }

  /**
   * The Worker base URL.
   */
  set workerUrl(url: string) {
    this._workerUrl = url;
  }

  /**
   * The shared write secret sent in the x-write-secret header.
   */
  get writeSecret(): string {
    return this._writeSecret;
  }

  /**
   * The shared write secret sent in the x-write-secret header.
   */
  set writeSecret(secret: string) {
    this._writeSecret = secret;
  }

  /**
   * The Drive base URL
   */
  get baseUrl(): string {
    return this._baseUrl;
  }

  /**
   * The Drive base URL
   */
  set baseUrl(url: string) {
    this._baseUrl = url;
  }

  /**
   * The Drive name getter
   */
  get name(): string {
    return this._name;
  }

  /**
   * The Drive name setter
   */
  set name(name: string) {
    this._name = name;

    // If the name of the drive is changed, the filebrowser needs to
    // refresh its contents.
    this._fileChanged.emit({
      type: 'new',
      oldValue: null,
      newValue: { path: '' }
    });
  }

  /**
   * The Drive root getter
   */
  get root(): string {
    return this._root;
  }

  /**
   * The Drive root setter
   */
  set root(root: string) {
    this.formatRoot(root ?? '').then(root => (this._root = root));
  }

  /**
   * Get the formatted root checker.
   */
  get isRootFormatted(): boolean {
    return this._isRootFormatted;
  }

  /**
   * Set the formatted root checker.
   */
  set isRootFormatted(isRootFormatted) {
    this._isRootFormatted = isRootFormatted;
  }

  /**
   * The Drive provider getter
   */
  get provider(): string {
    return this._provider;
  }

  /**
   * The Drive provider setter */
  set provider(name: string) {
    this._provider = name;
  }

  /**
   * The registered file types
   */
  get registeredFileTypes(): IRegisteredFileTypes {
    return this._registeredFileTypes;
  }

  /**
   * The registered file types
   */
  set registeredFileTypes(fileTypes: IRegisteredFileTypes) {
    this._registeredFileTypes = fileTypes;
  }

  /**
   * Settings for the notebook server.
   */
  get serverSettings(): ServerConnection.ISettings {
    return this._serverSettings;
  }

  /**
   * A signal emitted when a file operation takes place.
   */
  get fileChanged(): ISignal<this, Contents.IChangedArgs> {
    return this._fileChanged;
  }

  /**
   * Test whether the manager has been disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * A signal emitted when the drive is disposed.
   */
  get disposed(): ISignal<this, void> {
    return this._disposed;
  }

  /**
   * Dispose of the resources held by the manager.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._disposed.emit();
    Signal.clearData(this);
  }

  /**
   * Get an encoded download url given a file path.
   *
   * @param path - An absolute POSIX file path on the server.
   */
  async getDownloadUrl(path: string): Promise<string> {
    const key = PathExt.join(this._root, path);
    return workerDownloadUrl(this._workerUrl, key);
  }

  /**
   * Get a file or directory.
   *
   * @param localPath: The path to the file.
   * @param options: The options used to fetch the file.
   *
   * @returns A promise which resolves with the file content.
   */
  async get(
    path: string,
    options?: Contents.IFetchOptions
  ): Promise<Contents.IModel> {
    path = path.replace(this._name + '/', '');

    // Format root the first time contents are retrieved.
    if (!this._isRootFormatted) {
      this.formatRoot(this._root ?? '').then((root: string) => {
        this._root = root;
      });
      this._isRootFormatted = true;
    }

    // Listing the contents of a directory or retrieving the contents
    // of a file.
    data = await listWorkerContents(
      this._workerUrl,
      this.root,
      this.registeredFileTypes,
      path
    );

    Contents.validateContentsModel(data);
    return data;
  }

  /**
   * Create a new untitled file or directory in the specified directory path.
   *
   * @param options: The options used to create the file.
   *
   * @returns A promise which resolves with the created file content when
   * the file is created.
   */
  async newUntitled(
    options: Contents.ICreateOptions = {}
  ): Promise<Contents.IModel> {
    // Get current list of contents of drive.
    const old_data = await listWorkerContents(
      this._workerUrl,
      this._root,
      this.registeredFileTypes,
      options.path
    );

    if (options.type !== undefined) {
      // Get incremented untitled name.
      const name = this.incrementUntitledName(old_data, options);
      const fullPath = options.path ? PathExt.join(options.path, name) : name;
      data = await createWorkerObject(
        this._workerUrl,
        this._writeSecret,
        this._root,
        name,
        fullPath,
        '', // Create new file with empty body.
        this.registeredFileTypes,
        options.type === 'directory' ? true : false
      );
    } else {
      console.warn('Type of new element is undefined');
    }

    Contents.validateContentsModel(data);
    this._fileChanged.emit({
      type: 'new',
      oldValue: null,
      newValue: data
    });
    return data;
  }

  protected incrementUntitledName(
    contents: Contents.IModel,
    options: Contents.ICreateOptions
  ): string {
    const content: Array<Contents.IModel> = contents.content;
    let name: string = '';
    let countText = 0;
    let countDir = 0;
    let countNotebook = 0;
    if (options.type === 'notebook') {
      options.ext = 'ipynb';
    }

    content.forEach(item => {
      if (options.ext !== undefined) {
        if (item.name.includes('untitled') && item.name.includes('.txt')) {
          countText = countText + 1;
        } else if (
          item.name.includes('Untitled') &&
          item.name.includes('.ipynb')
        ) {
          countNotebook = countNotebook + 1;
        }
      } else if (item.name.includes('Untitled Folder')) {
        countDir = countDir + 1;
      }
    });

    if (options.ext === 'txt') {
      if (countText === 0) {
        name = 'untitled' + '.' + options.ext;
      } else {
        name = 'untitled' + countText + '.' + options.ext;
      }
    }
    if (options.ext === 'ipynb') {
      if (countNotebook === 0) {
        name = 'Untitled' + '.' + options.ext;
      } else {
        name = 'Untitled' + countNotebook + '.' + options.ext;
      }
    } else if (options.type === 'directory') {
      if (countDir === 0) {
        name = 'Untitled Folder';
      } else {
        name = 'Untitled Folder ' + countDir;
      }
    }
    return name;
  }

  /**
   * Delete a file.
   *
   * @param path - The path to the file.
   *
   * @returns A promise which resolves when the file is deleted.
   */
  async delete(localPath: string): Promise<void> {
    await deleteWorkerObjects(
      this._workerUrl,
      this._writeSecret,
      this._root,
      localPath
    );

    this._fileChanged.emit({
      type: 'delete',
      oldValue: { path: localPath },
      newValue: { path: undefined }
    });
  }

  /**
   * Rename a file or directory.
   *
   * @param oldLocalPath - The original file path.
   * @param newLocalPath - The new file path.
   *
   * @returns A promise which resolves with the new file contents model
   * when the file is renamed.
   */
  async rename(
    oldLocalPath: string,
    newLocalPath: string,
    options: Contents.ICreateOptions = {}
  ): Promise<Contents.IModel> {
    let newFileName = PathExt.basename(newLocalPath);
    const isDir: boolean = await isDirectory(
      this._workerUrl,
      this._root,
      oldLocalPath
    );

    try {
      await checkWorkerObject(
        this._workerUrl,
        this._root,
        newLocalPath,
        isDir
      );
      newFileName = await this.incrementName(newLocalPath, isDir);
    } catch (error) {
      // Object does not exist yet; continue, as the name is free.
    } finally {
      data = await renameWorkerObjects(
        this._workerUrl,
        this._writeSecret,
        this._root,
        oldLocalPath,
        newLocalPath,
        newFileName,
        isDir,
        this._registeredFileTypes
      );
    }

    Contents.validateContentsModel(data);
    this._fileChanged.emit({
      type: 'rename',
      oldValue: { path: oldLocalPath },
      newValue: data
    });
    return data;
  }

  /**
   * Helping function to increment name of existing files or directories.
   *
   * @param localPath - The path to the file.
   * @param isDir - Whether the object is a directory or a file.
   */
  protected async incrementName(localPath: string, isDir: boolean) {
    let fileExtension: string = '';
    let originalName: string = '';

    // Check if we are dealing with a directory.
    if (isDir === true) {
      localPath =
        localPath[localPath.length - 1] === '/'
          ? localPath.substring(0, localPath.length - 1)
          : localPath;
      originalName = PathExt.basename(localPath);
    }
    // Dealing with a file.
    else {
      // Extract name from path.
      originalName = PathExt.basename(localPath);
      // Eliminate file extension.
      fileExtension = PathExt.extname(originalName);
      originalName =
        originalName.split('.')[originalName.split('.').length - 2];
    }

    const counter = await countWorkerObjectNameAppearances(
      this._workerUrl,
      this._root,
      localPath,
      originalName
    );
    let newName = counter ? originalName + counter : originalName;
    newName = isDir ? newName + '/' : newName + fileExtension;

    return newName;
  }

  /**
   * Save a file.
   *
   * @param localPath - The desired file path.
   * @param options - Optional overrides to the model.
   *
   * @returns A promise which resolves with the file content model when
   * the file is saved.
   */
  async save(
    localPath: string,
    options: Partial<Contents.IModel> = {}
  ): Promise<Contents.IModel> {
    const fileName = PathExt.basename(localPath);

    data = await createWorkerObject(
      this._workerUrl,
      this._writeSecret,
      this._root,
      fileName,
      localPath,
      options.content,
      this._registeredFileTypes,
      false,
      options
    );

    Contents.validateContentsModel(data);
    this._fileChanged.emit({
      type: 'save',
      oldValue: null,
      newValue: data
    });
    return data;
  }

  /**
   * Copy a file into a given directory.
   *
   * @param path - The original file path.
   * @param toDir - The destination directory path.
   *
   * @returns A promise which resolves with the new contents model when
   * the file is copied.
   */
  protected async incrementCopyName(copiedItemPath: string) {
    const isDir: boolean = await isDirectory(
      this._workerUrl,
      this._root,
      copiedItemPath
    );

    // Extracting original file name.
    const originalFileName = PathExt.basename(copiedItemPath);

    // Constructing new file name and path with -Copy string.
    const newFileName = isDir
      ? originalFileName + '-Copy'
      : originalFileName.split('.')[0] +
        '-Copy.' +
        originalFileName.split('.')[1];

    const newFilePath =
      copiedItemPath.substring(0, copiedItemPath.lastIndexOf('/') + 1) +
      newFileName +
      (isDir ? '/' : '');

    // Getting incremented name of Copy in case of duplicates.
    const incrementedName = await this.incrementName(newFilePath, isDir);

    return incrementedName;
  }

  /**
   * Copy a file into a given directory.
   *
   * @param path - The original file path.
   * @param toDir - The destination directory path.
   *
   * @returns A promise which resolves with the new contents model when
   * the file is copied.
   */
  async copy(
    path: string,
    toDir: string,
    options: Contents.ICreateOptions = {}
  ): Promise<Contents.IModel> {
    // Construct new file or directory name for the copy.
    const newFileName = await this.incrementCopyName(path);

    data = await copyWorkerObjects(
      this._workerUrl,
      this._writeSecret,
      this._root,
      newFileName,
      path,
      toDir,
      this._registeredFileTypes
    );

    Contents.validateContentsModel(data);
    this._fileChanged.emit({
      type: 'new',
      oldValue: null,
      newValue: data
    });
    return data;
  }

  /**
   * Create a checkpoint for a file.
   *
   * @param path - The path of the file.
   *
   * @returns A promise which resolves with the new checkpoint model when
   * the checkpoint is created.
   */
  async createCheckpoint(path: string): Promise<Contents.ICheckpointModel> {
    const emptyCheckpoint: Contents.ICheckpointModel = {
      id: '',
      last_modified: ''
    };
    return Promise.resolve(emptyCheckpoint);
  }

  /**
   * List available checkpoints for a file.
   *
   * @param path - The path of the file.
   *
   * @returns A promise which resolves with a list of checkpoint models
   * for the file.
   */
  listCheckpoints(path: string): Promise<Contents.ICheckpointModel[]> {
    return Promise.resolve([]);
  }

  /**
   * Restore a file to a known checkpoint state.
   *
   * @param path - The path of the file.
   * @param checkpointID - The id of the checkpoint to restore.
   *
   * @returns A promise which resolves when the checkpoint is restored.
   */
  restoreCheckpoint(path: string, checkpointID: string): Promise<void> {
    return Promise.reject('Repository is read only');
  }

  /**
   * Delete a checkpoint for a file.
   *
   * @param path - The path of the file.
   * @param checkpointID - The id of the checkpoint to delete.
   *
   * @returns A promise which resolves when the checkpoint is deleted.
   */
  deleteCheckpoint(path: string, checkpointID: string): Promise<void> {
    return Promise.reject('Read only');
  }

  /**
   * Get all registered file types and store them accordingly with their
   * file extension (e.g.: .txt, .pdf, .jpeg), file mimetype (e.g.:
   * text/plain, application/pdf) and file format (e.g.: base64, text).
   *
   * @param app
   */
  getRegisteredFileTypes(app: JupyterFrontEnd) {
    // Get called when instantiating the toolbar.
    const registeredFileTypes = app.docRegistry.fileTypes();

    for (const fileType of registeredFileTypes) {
      // Check if we are dealing with a directory.
      if (fileType.extensions.length === 0) {
        this._registeredFileTypes[''] = {
          fileType: 'directory',
          fileFormat: 'json',
          fileMimeTypes: ['text/directory']
        };
      }

      // Store the mimetype and fileformat for each file extension.
      fileType.extensions.forEach(extension => {
        if (!this._registeredFileTypes[extension]) {
          this._registeredFileTypes[extension] = {
            fileType: fileType.name,
            fileMimeTypes: [...fileType.mimeTypes],
            fileFormat: fileType.fileFormat ? fileType.fileFormat : ''
          };
        }
      });
    }
  }

  /**
   * Helping function which formats root by removing all leading or
   * trailing backslashes and checking if given path to directory exists.
   *
   * @param root - The path to the directory acting as root.
   * @returns formatted root
   */
  private async formatRoot(root: string) {
    // If root is empty, no formatting needed.
    if (root === '') {
      return root;
    }

    // Reformat the path to arbitrary root so it has no leading or
    // trailing /.
    root = PathExt.removeSlash(PathExt.normalize(root));
    // Check if directory exists within bucket.
    try {
      await checkWorkerObject(this._workerUrl, root);
      // The directory exists, root is formatted correctly.
      return root;
    } catch (error) {
      console.log("Given path to root directory doesn't exist within bucket.");
      return '';
    }
  }

  private _serverSettings: ServerConnection.ISettings;
  private _workerUrl: string = '';
  private _writeSecret: string = '';
  private _name: string = '';
  private _root: string = '';
  private _isRootFormatted: boolean = false;
  private _provider: string = '';
  private _baseUrl: string = '';
  private _fileChanged = new Signal<this, Contents.IChangedArgs>(this);
  private _isDisposed: boolean = false;
  private _disposed = new Signal<this, void>(this);
  private _registeredFileTypes: IRegisteredFileTypes = {};
}

export namespace Drive {
  /**
   * The options used to initialize a `Drive`.
   */
  export interface IOptions {
    /**
     * Base URL of the jupyter-drive Worker.
     */
    workerUrl: string;

    /**
     * Shared write secret (sent as the x-write-secret header on
     * PUT/DELETE). Empty means reads only.
     */
    writeSecret?: string;

    /**
     * The name for the `Drive`, which is used in file paths to
     * disambiguate it from other drives.
     */
    name: string;

    /**
     * Path to directory from drive, which acts as root.
     */
    root: string;

    /**
     * The server settings for the server.
     */
    serverSettings?: ServerConnection.ISettings;
  }
}
