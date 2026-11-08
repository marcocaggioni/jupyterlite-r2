// jupyterlab-jsoncanvas — read-only viewer for JSON Canvas (.canvas) files.
//
// Registers the `.canvas` file type (JSON Canvas 1.0, jsoncanvas.org) and
// a document widget that renders the board with the Hesprs JSON Canvas
// Viewer library: text cards (Markdown), file cards, link cards, groups,
// and edges, with pan / zoom / fit-to-view, a minimap, and light / dark
// themes. Viewer only — nothing is edited or saved.

import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';

import { JSONCanvasWidgetFactory } from './canvas';
import { canvasIcon } from './icons';
import '../style/index.js';

/**
 * The JSON Canvas viewer plugin.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-jsoncanvas:plugin',
  description:
    'Read-only viewer for JSON Canvas (.canvas) files, powered by the Hesprs JSON Canvas Viewer library.',
  autoStart: true,
  activate: (app: JupyterFrontEnd): void => {
    app.docRegistry.addFileType({
      name: 'jsoncanvas',
      displayName: 'JSON Canvas',
      contentType: 'file',
      fileFormat: 'text',
      extensions: ['.canvas'],
      mimeTypes: ['application/json'],
      icon: canvasIcon
    });
    const factory = new JSONCanvasWidgetFactory({
      name: 'JSON Canvas',
      fileTypes: ['jsoncanvas'],
      defaultFor: ['jsoncanvas'],
      readOnly: true
    });
    app.docRegistry.addWidgetFactory(factory);
  }
};

export default plugin;
