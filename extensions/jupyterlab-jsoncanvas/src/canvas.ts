// jupyterlab-jsoncanvas — read-only viewer for JSON Canvas (.canvas) files.
//
// Rendering is done by the Hesprs JSON Canvas Viewer library
// (https://github.com/Hesprs/JSON-Canvas-Viewer, MIT), which implements
// 100% of the JSON Canvas 1.0 spec (jsoncanvas.org): text / file / link /
// group nodes, edges, pan / zoom, light / dark themes, plus the Controls
// and Minimap modules for the chrome. This file only wires the library
// into JupyterLab: the document widget, feeding the parsed .canvas JSON
// from the document model to the viewer, theme following, and error
// handling. Files are only read, never written.
//
// File-node attachments are not remapped: the library fetches them
// relative to the page, so a referenced file shows as a placeholder
// rather than a preview. The path is still shown on the card.

import { PathExt } from '@jupyterlab/coreutils';
import {
  ABCWidgetFactory,
  DocumentRegistry,
  DocumentWidget
} from '@jupyterlab/docregistry';
import { Message } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import {
  Controls,
  JSONCanvasViewer,
  Minimap,
  parser,
  type JSONCanvas,
  type JSONCanvasViewerInterface
} from 'json-canvas-viewer';

import { canvasIcon } from './icons';

type CanvasViewer = JSONCanvasViewerInterface<
  [typeof Controls, typeof Minimap]
>;

/** JupyterLab's light/dark flag, from the body attribute it maintains. */
function currentTheme(): 'light' | 'dark' {
  return document.body.dataset.jpThemeLight === 'false' ? 'dark' : 'light';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse the file content into the canvas object the library expects.
 * Only the top-level shape is checked here (a JSON object whose
 * `nodes` / `edges`, when present, are arrays); the library itself
 * validates and renders the nodes and edges. Returns an error string
 * instead of throwing.
 */
function parseCanvas(
  content: string
): { data: JSONCanvas | null; error: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return {
      data: null,
      error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`
    };
  }
  const root = asRecord(parsed);
  if (!root) {
    return { data: null, error: 'Canvas file must be a JSON object.' };
  }
  if (
    ('nodes' in root && !Array.isArray(root.nodes)) ||
    ('edges' in root && !Array.isArray(root.edges))
  ) {
    return {
      data: null,
      error: 'Canvas file must have `nodes` and `edges` arrays.'
    };
  }
  // The library's type marks edge sides required, but the spec leaves
  // them optional, so the raw object goes through untouched.
  return { data: parsed as unknown as JSONCanvas, error: null };
}

/**
 * The panel that hosts one library viewer for one canvas file.
 */
export class CanvasPanel extends Widget {
  private _context: DocumentRegistry.IContext<DocumentRegistry.IModel>;
  private _host: HTMLDivElement;
  private _errorBar: HTMLDivElement;
  private _viewer: CanvasViewer | null = null;
  private _themeObserver: MutationObserver | null = null;
  private _ready = false;

  constructor(context: DocumentRegistry.IContext<DocumentRegistry.IModel>) {
    super();
    this._context = context;
    this.addClass('jp-JSONCanvas');
    this.node.setAttribute('tabindex', '0');

    this._host = document.createElement('div');
    this._host.className = 'jp-JSONCanvas-host';
    this.node.appendChild(this._host);

    this._errorBar = document.createElement('div');
    this._errorBar.className = 'jp-JSONCanvas-error';
    this._errorBar.hidden = true;
    this.node.appendChild(this._errorBar);

    void this._context.ready.then(() => {
      this._ready = true;
      this.update();
    });
    this._context.model.contentChanged.connect(() => {
      this.update();
    }, this);
    this._context.fileChanged.connect(() => {
      this.update();
    }, this);
  }

  dispose(): void {
    this._disposeViewer();
    super.dispose();
  }

  protected onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    // The viewer needs a laid-out container to fit the board.
    this.update();
  }

  protected onUpdateRequest(msg: Message): void {
    super.onUpdateRequest(msg);
    if (!this._ready || !this.isAttached) {
      return;
    }
    this._render();
  }

  private _disposeViewer(): void {
    if (this._themeObserver) {
      this._themeObserver.disconnect();
      this._themeObserver = null;
    }
    if (this._viewer) {
      this._viewer.dispose();
      this._viewer = null;
    }
  }

  private _showError(message: string): void {
    this._errorBar.textContent = message;
    this._errorBar.hidden = false;
  }

  private _clearError(): void {
    this._errorBar.textContent = '';
    this._errorBar.hidden = true;
  }

  private _watchTheme(): void {
    if (this._themeObserver) {
      return;
    }
    this._themeObserver = new MutationObserver(() => {
      this._viewer?.changeTheme(currentTheme());
    });
    this._themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-jp-theme-light']
    });
  }

  private _render(): void {
    const content = this._context.model.toString();
    const { data, error } = parseCanvas(content);
    if (!data) {
      this._disposeViewer();
      this._showError(error ?? 'Could not read this canvas file.');
      return;
    }
    this._clearError();

    if (this._viewer) {
      this._viewer.load({ canvas: data });
      return;
    }

    const viewer = new JSONCanvasViewer(
      {
        container: this._host,
        canvas: data,
        parser,
        theme: currentTheme()
      },
      [Controls, Minimap]
    );
    this._viewer = viewer;
    this._watchTheme();
    // Frame the whole board once the viewer has started.
    viewer.onStart.subscribe(() => {
      viewer.resetView();
    });
  }
}

/**
 * The document widget wrapping a canvas panel.
 */
export class JSONCanvasDocumentWidget extends DocumentWidget<
  CanvasPanel,
  DocumentRegistry.IModel
> {
  constructor(context: DocumentRegistry.IContext<DocumentRegistry.IModel>) {
    super({ context, content: new CanvasPanel(context) });
    this.addClass('jp-JSONCanvasDocument');
    this.title.label = PathExt.basename(context.localPath);
    this.title.caption = context.localPath;
    this.title.closable = true;
    this.title.icon = canvasIcon;
  }
}

/**
 * Widget factory for `.canvas` files.
 */
export class JSONCanvasWidgetFactory extends ABCWidgetFactory<
  JSONCanvasDocumentWidget,
  DocumentRegistry.IModel
> {
  protected createNewWidget(
    context: DocumentRegistry.IContext<DocumentRegistry.IModel>
  ): JSONCanvasDocumentWidget {
    return new JSONCanvasDocumentWidget(context);
  }
}
