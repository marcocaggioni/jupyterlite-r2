// jupyter-drive-s3 — JupyterLab plugins.
//
// Derived from jupydrive-s3 (QuantStack, BSD-3-Clause): the same three
// plugins (credentials provider, default file browser, toolbar), but the
// drive talks to the jupyter-drive Cloudflare Worker instead of S3, and
// there is exactly one drive — no bucket switching, no cross-bucket copy.
//
// Settings (jupyter-drive-s3:auth-file-browser):
//   workerUrl    — base URL of the Worker (default: the live Worker)
//   root         — folder inside the bucket acting as root (default: '')
//   writeSecret  — shared write secret, sent as x-write-secret on
//                  PUT/DELETE; empty means reads only. Masked in the
//                  settings UI via jupyter-secrets-manager.

import {
  ILabShell,
  JupyterFrontEndPlugin,
  IRouter,
  JupyterFrontEnd
} from '@jupyterlab/application';
import {
  createToolbarFactory,
  Dialog,
  ICommandPalette,
  IToolbarWidgetRegistry,
  setToolbar,
  showDialog
} from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import { Contents } from '@jupyterlab/services';
import {
  IDefaultFileBrowser,
  IFileBrowserFactory,
  FileBrowser,
  Uploader
} from '@jupyterlab/filebrowser';
import { editIcon } from '@jupyterlab/ui-components';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ITranslator } from '@jupyterlab/translation';
import { CommandRegistry } from '@lumino/commands';
import {
  FilenameSearcher,
  IScore,
  folderIcon
} from '@jupyterlab/ui-components';
import { Token } from '@lumino/coreutils';
import { Drive } from './workercontents';
import { DRIVE_NAME } from './worker';
import './icons';
import { SecretsManager, ISecretsManager } from 'jupyter-secrets-manager';

/**
 * The command IDs used by the filebrowser plugin.
 */
namespace CommandIDs {
  export const openPath = 'filebrowser:open-path';
  export const toggleBrowser = 'filebrowser:toggle-main';
  export const rename = 'drives:rename';
  export const copyToR2 = 'drives:copy-to-r2';
  export const copyToLocal = 'drives:copy-to-local';
}

const FILE_BROWSER_FACTORY = 'DriveBrowser';
const FILE_BROWSER_PLUGIN_ID = 'jupyter-drive-s3:file-browser-toolbar';

/**
 * The class name added to the drive filebrowser filterbox node.
 */
const FILTERBOX_CLASS = 'jp-DriveBrowser-filterBox';

/**
 * Default base URL of the jupyter-drive Worker (public reads, shared
 * secret writes). Overridable in Settings.
 */
export const DEFAULT_WORKER_URL =
  'https://jupyter-drive.marco-caggioni.workers.dev';

/**
 * Settings for the Worker drive.
 */
export interface IWorkerAuth {
  factory: () => Promise<{
    name: string;
    root: string;
    workerUrl: string;
    writeSecret: string;
    secretsManager?: ISecretsManager;
    token?: symbol;
  }>;
}

/**
 * A token for a plugin that provides Worker authentication.
 */
export const IWorkerAuth = new Token<IWorkerAuth>(
  'jupyter-drive-s3:auth-file-browser'
);

/**
 * Authentication file browser ID.
 */
export const AUTH_FILEBROWSER_ID = 'jupyter-drive-s3:auth-file-browser';

/**
 * The auth/credentials provider for the file browser.
 */
const authFileBrowser: JupyterFrontEndPlugin<IWorkerAuth> =
  SecretsManager.sign(AUTH_FILEBROWSER_ID, token => ({
    id: 'jupyter-drive-s3:auth-file-browser',
    description: 'The default file browser auth/credentials provider',
    requires: [ISettingRegistry, ISecretsManager],
    provides: IWorkerAuth,
    activate: (
      app: JupyterFrontEnd,
      settings: ISettingRegistry,
      secretsManager: ISecretsManager
    ): IWorkerAuth => {
      const secretFields: string[] = ['writeSecret'];

      function loadSettings(setting: ISettingRegistry.ISettings) {
        const workerUrl = setting.get('workerUrl').composite as string;
        const root = setting.get('root').composite as string;

        secretFields.forEach((key: string) => {
          const secretValue = setting.get(key).composite as string;
          // Save secret to secret manager.
          secretsManager.set(
            token,
            AUTH_FILEBROWSER_ID,
            AUTH_FILEBROWSER_ID + '::' + key,
            {
              namespace: AUTH_FILEBROWSER_ID,
              id: AUTH_FILEBROWSER_ID + '::' + key,
              value: secretValue
            }
          );
        });

        return {
          name: DRIVE_NAME,
          root: root,
          workerUrl: workerUrl,
          writeSecret: setting.get('writeSecret').composite as string,
          secretsManager: secretsManager,
          token: token
        };
      }

      const attachSecretInput = (key: string) => {
        const input = document.getElementById(
          'jp-SettingsEditor-jupyter-drive-s3:auth-file-browser_' + key
        ) as HTMLInputElement;
        if (input) {
          input.type = 'password';
          secretsManager.attach(
            token,
            AUTH_FILEBROWSER_ID,
            AUTH_FILEBROWSER_ID + '::' + key,
            input
          );
        } else {
          setTimeout(() => attachSecretInput(key), 300);
        }
      };

      // Watch for DOM changes to make sure secret inputs are attached.
      const observer = new MutationObserver(() => {
        secretFields.forEach((key: string) => attachSecretInput(key));
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      const getInitialSettings = async () => {
        // Read the initial settings.
        const setting = await settings.load(authFileBrowser.id);
        const initial = loadSettings(setting);
        if (initial.workerUrl !== '') {
          return initial;
        } else {
          return null;
        }
      };

      // Wait for the application to be restored and for the
      // settings to be loaded.
      Promise.all([app.restored, settings.load(authFileBrowser.id)]).then(
        ([_, settingCredentials]) => {
          // Listen for the plugin setting changes using Signal.
          settingCredentials.changed.connect(() => {
            const workerConfig = loadSettings(settingCredentials);

            // Connect to drive using new config.
            const WorkerDrive = new Drive({ ...workerConfig });
            app.serviceManager.contents.addDrive(WorkerDrive);
          });
        }
      );

      return {
        factory: async () => {
          return (
            (await getInitialSettings()) ?? {
              name: DRIVE_NAME,
              root: '',
              workerUrl: DEFAULT_WORKER_URL,
              writeSecret: ''
            }
          );
        }
      };
    }
  }));

/**
 * The default file browser factory provider.
 */
const defaultFileBrowser: JupyterFrontEndPlugin<IDefaultFileBrowser> = {
  id: 'jupyter-drive-s3:default-file-browser',
  description: 'The default file browser factory provider',
  provides: IDefaultFileBrowser,
  requires: [IFileBrowserFactory, IWorkerAuth],
  optional: [IRouter, JupyterFrontEnd.ITreeResolver, ILabShell, ICommandPalette],
  activate: async (
    app: JupyterFrontEnd,
    fileBrowserFactory: IFileBrowserFactory,
    workerAuth: IWorkerAuth,
    router: IRouter | null,
    tree: JupyterFrontEnd.ITreeResolver | null,
    labShell: ILabShell | null,
    palette: ICommandPalette | null
  ): Promise<IDefaultFileBrowser> => {
    const { commands } = app;
    const auth = await workerAuth.factory();
    // Create the Worker drive.
    const WorkerDrive = new Drive({
      name: auth.name,
      root: auth.root,
      workerUrl: auth.workerUrl,
      writeSecret: auth.writeSecret
    });

    app.serviceManager.contents.addDrive(WorkerDrive);

    // Get registered file types.
    WorkerDrive.getRegisteredFileTypes(app);

    // Manually restore and load the default file browser.
    const defaultBrowser = fileBrowserFactory.createFileBrowser(
      'drivebrowser',
      {
        auto: false,
        restore: false,
        driveName: WorkerDrive.name
      }
    );

    // Second file browser for JupyterLite's stock local drive
    // (browser storage / IndexedDB, per-device, not shared).
    // It is the ContentsManager's default drive, so it is addressed
    // with unprefixed paths: driveName ''. The drive object itself
    // is named 'BrowserStorage', but that name is NOT a registered
    // additional drive, so 'BrowserStorage:' paths would not resolve
    // to it — '' is the correct driveName here.
    const localBrowser = fileBrowserFactory.createFileBrowser(
      'localfilebrowser',
      {
        auto: false,
        restore: false,
        driveName: ''
      }
    );

    localBrowser.node.setAttribute('role', 'region');
    localBrowser.node.setAttribute('aria-label', 'Local Files Section');
    localBrowser.title.icon = folderIcon;
    localBrowser.title.label = 'Local Files';
    localBrowser.title.caption =
      'Browser-only storage on this device (not shared)';

    // Rank 101 puts it just below the R2 Drive Browser, which the
    // stock filebrowser extension adds at rank 100.
    if (labShell) {
      labShell.add(localBrowser, 'left', { rank: 101 });
    }

    // Restore the local browser's model state under its own id.
    // Fire-and-forget on purpose: this must never block the
    // default-file-browser activation (and therefore app startup).
    // In 0.1.2 these were awaited here and a stalled local-drive
    // listing left the whole app stuck on "Loading JupyterLite...".
    void localBrowser.model
      .restore(localBrowser.id)
      .then(() => localBrowser.model.refresh())
      .catch(err => {
        console.warn('Local Files browser failed to load', err);
      });

    // Set attributes when adding the browser to the UI.
    defaultBrowser.node.setAttribute('role', 'region');
    defaultBrowser.node.setAttribute('aria-label', 'Drive Browser Section');
    defaultBrowser.title.icon = folderIcon;

    // Show the current file browser shortcut in its title.
    const updateBrowserTitle = () => {
      const binding = app.commands.keyBindings.find(
        b => b.command === CommandIDs.toggleBrowser
      );
      if (binding) {
        const ks = binding.keys.map(CommandRegistry.formatKeystroke).join(', ');
        defaultBrowser.title.caption = 'Drive Browser (' + ks + ')';
      } else {
        defaultBrowser.title.caption = 'Drive Browser';
      }
    };
    updateBrowserTitle();
    app.commands.keyBindingChanged.connect(() => {
      updateBrowserTitle();
    });

    // Add the rename command (directories are not renamable from the
    // context menu; see the toolbar schema).
    app.commands.addCommand(CommandIDs.rename, {
      execute: args => {
        const widget = fileBrowserFactory.tracker.currentWidget;

        if (widget) {
          return widget.rename();
        }
      },
      isVisible: () =>
        // So long as this command only handles one file at time, don't
        // show it if multiple files are selected.
        !!fileBrowserFactory.tracker.currentWidget &&
        Array.from(fileBrowserFactory.tracker.currentWidget.selectedItems())
          .length === 1,
      isEnabled: () =>
        // Disable directory rename for Worker folders.
        !!fileBrowserFactory.tracker.currentWidget &&
        fileBrowserFactory.tracker.currentWidget?.selectedItems().next()!
          .value.type !== 'directory',
      icon: editIcon.bindprops({ stylesheet: 'menuItem' }),
      label: 'Rename',
      mnemonic: 0
    });

    // Copy the current selection to the other drive (Local Files <->
    // R2 Drive). One shared routine, source/target swapped: contents
    // are read from the source drive with get() and written to the
    // target with save(), so binary files, notebooks and text all go
    // through the same fixed save/get paths as a normal save (base64
    // decode on PUT, empty-body guard, real last_modified). Folders
    // recurse; existing files are overwritten; nothing is deleted
    // on either side. ContentsManager.copy() cannot do this — it
    // throws for cross-drive copies.
    const copySelection = async (
      targetDriveName: string,
      targetBrowser: FileBrowser,
      targetLabel: string
    ): Promise<void> => {
      const widget = fileBrowserFactory.tracker.currentWidget;
      if (!widget) {
        return;
      }
      const items = Array.from(widget.selectedItems());
      if (items.length === 0) {
        return;
      }
      try {
        const copied = await Private.copyItemsToDrive(
          app.serviceManager.contents,
          items,
          targetDriveName
        );
        // Refresh the target panel so the new files show up.
        await targetBrowser.model.refresh();
        void showDialog({
          title: `Copy to ${targetLabel}`,
          body: `Copied ${copied} file${copied === 1 ? '' : 's'} to ${targetLabel}.`,
          buttons: [Dialog.okButton()]
        });
      } catch (error) {
        void showDialog({
          title: 'Copy failed',
          body: Private.copyErrorMessage(error),
          buttons: [Dialog.okButton()]
        });
      }
    };

    app.commands.addCommand(CommandIDs.copyToR2, {
      execute: () =>
        copySelection(WorkerDrive.name, defaultBrowser, 'R2 Drive'),
      isVisible: () =>
        !!fileBrowserFactory.tracker.currentWidget &&
        fileBrowserFactory.tracker.currentWidget.model.driveName === '' &&
        Array.from(fileBrowserFactory.tracker.currentWidget.selectedItems())
          .length > 0,
      label: 'Copy to R2 Drive',
      mnemonic: 0
    });

    app.commands.addCommand(CommandIDs.copyToLocal, {
      execute: () => copySelection('', localBrowser, 'Local Files'),
      isVisible: () =>
        !!fileBrowserFactory.tracker.currentWidget &&
        fileBrowserFactory.tracker.currentWidget.model.driveName ===
          WorkerDrive.name &&
        Array.from(fileBrowserFactory.tracker.currentWidget.selectedItems())
          .length > 0,
      label: 'Copy to Local Files',
      mnemonic: 0
    });

    // Command palette entries (context-menu entries live in
    // schema/file-browser-toolbar.json).
    palette?.addItem({
      command: CommandIDs.copyToR2,
      category: 'File Browser'
    });
    palette?.addItem({
      command: CommandIDs.copyToLocal,
      category: 'File Browser'
    });

    void Private.restoreBrowser(
      defaultBrowser,
      commands,
      router,
      tree,
      labShell
    );

    return defaultBrowser;
  }
};

/**
 * File browser toolbar buttons.
 */
const toolbarFileBrowser: JupyterFrontEndPlugin<void> = {
  id: 'jupyter-drive-s3:file-browser-toolbar',
  description: 'The toolbar for the drives file browser',
  requires: [
    IDefaultFileBrowser,
    IToolbarWidgetRegistry,
    ISettingRegistry,
    ITranslator,
    IFileBrowserFactory
  ],
  autoStart: true,
  activate: async (
    _: JupyterFrontEnd,
    fileBrowser: IDefaultFileBrowser,
    toolbarRegistry: IToolbarWidgetRegistry,
    settingsRegistry: ISettingRegistry,
    translator: ITranslator
  ): Promise<void> => {
    toolbarRegistry.addFactory(
      FILE_BROWSER_FACTORY,
      'uploaderTest',
      (fileBrowser: FileBrowser) =>
        new Uploader({ model: fileBrowser.model, translator })
    );

    toolbarRegistry.addFactory(
      FILE_BROWSER_FACTORY,
      'fileNameSearcherTest',
      (fileBrowser: FileBrowser) => {
        const searcher = FilenameSearcher({
          updateFilter: (
            filterFn: (item: string) => Partial<IScore> | null,
            query?: string
          ) => {
            fileBrowser.model.setFilter(value => {
              return filterFn(value.name.toLowerCase());
            });
          },
          useFuzzyFilter: true,
          placeholder: 'Filter files by names',
          forceRefresh: true
        });
        searcher.addClass(FILTERBOX_CLASS);
        return searcher;
      }
    );

    // Connect the filebrowser toolbar to the settings registry for the plugin.
    setToolbar(
      fileBrowser,
      createToolbarFactory(
        toolbarRegistry,
        settingsRegistry,
        FILE_BROWSER_FACTORY,
        FILE_BROWSER_PLUGIN_ID,
        translator
      )
    );
  }
};

/**
 * Export the plugins as default.
 */
const plugins: JupyterFrontEndPlugin<any>[] = [
  authFileBrowser,
  defaultFileBrowser,
  toolbarFileBrowser
];

export default plugins;

namespace Private {
  /**
   * Restores file browser state and overrides state if tree resolver resolves.
   */
  export async function restoreBrowser(
    browser: FileBrowser,
    commands: CommandRegistry,
    router: IRouter | null,
    tree: JupyterFrontEnd.ITreeResolver | null,
    labShell: ILabShell | null
  ): Promise<void> {
    const restoring = 'jp-mod-restoring';

    browser.addClass(restoring);

    if (!router) {
      await browser.model.restore(browser.id);
      await browser.model.refresh();
      browser.removeClass(restoring);
      return;
    }

    const listener = async () => {
      router.routed.disconnect(listener);

      const paths = await tree?.paths;
      if (paths?.file || paths?.browser) {
        // Restore the model without populating it.
        await browser.model.restore(browser.id, false);
        if (paths.file) {
          await commands.execute(CommandIDs.openPath, {
            path: paths.file,
            dontShowBrowser: true
          });
        }
        if (paths.browser) {
          await commands.execute(CommandIDs.openPath, {
            path: paths.browser,
            dontShowBrowser: true
          });
        }
      } else {
        await browser.model.restore(browser.id);
        await browser.model.refresh();
      }
      browser.removeClass(restoring);

      if (labShell?.isEmpty('main')) {
        void commands.execute('launcher:create');
      }
    };
    router.routed.connect(listener);
  }

  /**
   * The global (drive-prefixed) form of a drive-relative path.
   * The default (local) drive takes the bare path.
   */
  function toGlobalPath(driveName: string, localPath: string): string {
    const cleaned = PathExt.removeSlash(localPath);
    return driveName ? `${driveName}:${cleaned}` : cleaned;
  }

  /**
   * Copy the selected items of one file browser to the other drive,
   * preserving each item's path relative to its drive root. Returns
   * the number of files copied (folders themselves are not counted).
   * Existing files on the target are overwritten.
   */
  export async function copyItemsToDrive(
    contents: Contents.IManager,
    items: Contents.IModel[],
    targetDriveName: string
  ): Promise<number> {
    let copied = 0;
    for (const item of items) {
      const targetPath = toGlobalPath(
        targetDriveName,
        contents.localPath(item.path)
      );
      copied += await copyOne(contents, item.path, targetPath, targetDriveName);
    }
    return copied;
  }

  /**
   * Copy one item (file or folder) from a global source path to a
   * global target path. Folders recurse; the target folder is
   * created on the local drive (R2 folders are implicit key
   * prefixes, so nothing needs creating there).
   */
  async function copyOne(
    contents: Contents.IManager,
    sourcePath: string,
    targetPath: string,
    targetDriveName: string
  ): Promise<number> {
    const model = await contents.get(sourcePath, { content: true });
    if (model.type === 'directory') {
      await ensureDirectory(contents, targetPath, targetDriveName);
      let copied = 0;
      for (const child of model.content ?? []) {
        copied += await copyOne(
          contents,
          child.path,
          PathExt.join(targetPath, child.name),
          targetDriveName
        );
      }
      return copied;
    }
    // Reuse the normal save path, with the format the source drive
    // returned: 'text' for text, 'base64' for binary (decoded on
    // PUT to R2 by the 0.1.1 fix), 'json' for notebooks. The target
    // drive's save handles each the same way a manual save does.
    await ensureParentDirectories(contents, targetPath, targetDriveName);
    await contents.save(targetPath, {
      type: model.type,
      format: model.format,
      content: model.content,
      mimetype: model.mimetype
    });
    return 1;
  }

  /**
   * Make sure a directory exists on the target drive. No-op for R2
   * (folders are implicit); on the local drive, create it with
   * newUntitled + rename, creating parents first as needed.
   */
  async function ensureDirectory(
    contents: Contents.IManager,
    targetPath: string,
    targetDriveName: string
  ): Promise<void> {
    if (targetDriveName === DRIVE_NAME) {
      return;
    }
    try {
      await contents.get(targetPath);
      return;
    } catch {
      // Does not exist yet; create it below.
    }
    const parent = PathExt.dirname(targetPath);
    if (parent && parent !== '.' && parent !== targetPath) {
      await ensureDirectory(contents, parent, targetDriveName);
    }
    const created = await contents.newUntitled({
      ...(parent && parent !== '.'
        ? { path: parent }
        : {}),
      type: 'directory'
    });
    await contents.rename(created.path, targetPath);
  }

  /**
   * Make sure the parent folders of a target file path exist on the
   * target drive. No-op for R2 and for files at the drive root.
   */
  async function ensureParentDirectories(
    contents: Contents.IManager,
    targetPath: string,
    targetDriveName: string
  ): Promise<void> {
    const parent = PathExt.dirname(targetPath);
    if (!parent || parent === '.' || parent === targetPath) {
      return;
    }
    await ensureDirectory(contents, parent, targetDriveName);
  }

  /**
   * Plain-words explanation of a copy failure. A 401 from the Worker
   * means the write secret is not set (Local -> R2 writes are the
   * only direction that needs it).
   */
  export function copyErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('401')) {
      return (
        'Copy failed: the R2 write secret is not set, so the Worker ' +
        'refused the upload (401). Open Settings and enter the write ' +
        'secret for jupyter-drive-s3, then try again. (Copying from ' +
        'R2 to Local Files never needs the secret.)'
      );
    }
    return `Copy failed: ${message}`;
  }
}
