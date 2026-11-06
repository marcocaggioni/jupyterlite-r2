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
  IToolbarWidgetRegistry,
  setToolbar
} from '@jupyterlab/apputils';
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
  optional: [IRouter, JupyterFrontEnd.ITreeResolver, ILabShell],
  activate: async (
    app: JupyterFrontEnd,
    fileBrowserFactory: IFileBrowserFactory,
    workerAuth: IWorkerAuth,
    router: IRouter | null,
    tree: JupyterFrontEnd.ITreeResolver | null,
    labShell: ILabShell | null
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
    await localBrowser.model.restore(localBrowser.id);
    await localBrowser.model.refresh();

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
}
