// jupyterlab-jsoncanvas — read-only renderer for JSON Canvas (.canvas) files.
//
// Implements JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/): nodes
// (text / file / link / group) and edges, drawn as HTML cards over an SVG
// edge layer inside a pannable / zoomable viewport. Files are only read,
// never written. Group background images are not rendered in v1.

import { PathExt } from '@jupyterlab/coreutils';
import {
  ABCWidgetFactory,
  DocumentRegistry,
  DocumentWidget
} from '@jupyterlab/docregistry';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { IRenderMime } from '@jupyterlab/rendermime-interfaces';
import { Message } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';

import { canvasIcon } from './icons';

/** A side of a node an edge may attach to. */
export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';

/** The shape of an edge endpoint. */
export type CanvasEnd = 'none' | 'arrow';

export interface ICanvasNode {
  id: string;
  type: 'text' | 'file' | 'link' | 'group';
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
}

export interface ICanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: CanvasSide;
  toSide?: CanvasSide;
  fromEnd?: CanvasEnd;
  toEnd?: CanvasEnd;
  color?: string;
  label?: string;
}

export interface ICanvasData {
  nodes: ICanvasNode[];
  edges: ICanvasEdge[];
}

/** Obsidian's preset canvas colors, keyed by the spec's "1"–"6". */
const PRESET_COLORS: Record<string, string> = {
  '1': '#fb464c',
  '2': '#e9973f',
  '3': '#e0de71',
  '4': '#44cf6e',
  '5': '#53d8d8',
  '6': '#a882ff'
};

const DEFAULT_EDGE_COLOR = '#8a8a8a';
const NODE_SIDES: CanvasSide[] = ['top', 'right', 'bottom', 'left'];
const EDGE_ENDS: CanvasEnd[] = ['none', 'arrow'];

/**
 * Resolve a spec `canvasColor` (preset "1"–"6" or hex) to a CSS color.
 * Returns `fallback` for anything else.
 */
function resolveColor(color: string | undefined, fallback: string): string {
  if (!color) {
    return fallback;
  }
  if (color in PRESET_COLORS) {
    return PRESET_COLORS[color];
  }
  if (/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color)) {
    return color;
  }
  return fallback;
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map(c => c + c)
          .join('')
      : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asSide(value: unknown): CanvasSide | null {
  return typeof value === 'string' &&
    (NODE_SIDES as string[]).includes(value)
    ? (value as CanvasSide)
    : null;
}

function asEnd(value: unknown): CanvasEnd | null {
  return typeof value === 'string' && (EDGE_ENDS as string[]).includes(value)
    ? (value as CanvasEnd)
    : null;
}

/**
 * Validate parsed JSON into canvas data. Invalid nodes / edges are dropped
 * (and counted); a non-object top level or non-array `nodes` / `edges`
 * makes the whole file invalid.
 */
function parseCanvas(
  content: string
): { data: ICanvasData | null; error: string | null; dropped: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return {
      data: null,
      error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      dropped: 0
    };
  }
  const root = asRecord(parsed);
  if (!root) {
    return { data: null, error: 'Canvas file must be a JSON object.', dropped: 0 };
  }
  if (
    ('nodes' in root && !Array.isArray(root.nodes)) ||
    ('edges' in root && !Array.isArray(root.edges))
  ) {
    return {
      data: null,
      error: 'Canvas file must have `nodes` and `edges` arrays.',
      dropped: 0
    };
  }

  const nodes: ICanvasNode[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  const rawNodes = Array.isArray(root.nodes) ? root.nodes : [];
  for (const raw of rawNodes) {
    const rec = asRecord(raw);
    const id = rec ? asString(rec.id) : null;
    const type = rec ? asString(rec.type) : null;
    const x = rec ? asFiniteNumber(rec.x) : null;
    const y = rec ? asFiniteNumber(rec.y) : null;
    const width = rec ? asFiniteNumber(rec.width) : null;
    const height = rec ? asFiniteNumber(rec.height) : null;
    const validType =
      type === 'text' || type === 'file' || type === 'link' || type === 'group';
    if (
      !rec ||
      !id ||
      !validType ||
      x === null ||
      y === null ||
      width === null ||
      height === null ||
      width <= 0 ||
      height <= 0 ||
      seen.has(id)
    ) {
      dropped++;
      continue;
    }
    const node: ICanvasNode = {
      id,
      type: type as ICanvasNode['type'],
      x,
      y,
      width,
      height
    };
    const color = asString(rec.color);
    if (color) {
      node.color = color;
    }
    if (type === 'text') {
      const text = asString(rec.text);
      if (text === null) {
        dropped++;
        continue;
      }
      node.text = text;
    } else if (type === 'file') {
      const file = asString(rec.file);
      if (file === null) {
        dropped++;
        continue;
      }
      node.file = file;
      const subpath = asString(rec.subpath);
      if (subpath) {
        node.subpath = subpath;
      }
    } else if (type === 'link') {
      const url = asString(rec.url);
      if (url === null) {
        dropped++;
        continue;
      }
      node.url = url;
    } else {
      const label = asString(rec.label);
      if (label) {
        node.label = label;
      }
    }
    seen.add(id);
    nodes.push(node);
  }

  const edges: ICanvasEdge[] = [];
  const rawEdges = Array.isArray(root.edges) ? root.edges : [];
  for (const raw of rawEdges) {
    const rec = asRecord(raw);
    const id = rec ? asString(rec.id) : null;
    const fromNode = rec ? asString(rec.fromNode) : null;
    const toNode = rec ? asString(rec.toNode) : null;
    if (
      !rec ||
      !id ||
      !fromNode ||
      !toNode ||
      !seen.has(fromNode) ||
      !seen.has(toNode)
    ) {
      dropped++;
      continue;
    }
    const edge: ICanvasEdge = { id, fromNode, toNode };
    const fromSide = asSide(rec.fromSide);
    if (fromSide) {
      edge.fromSide = fromSide;
    }
    const toSide = asSide(rec.toSide);
    if (toSide) {
      edge.toSide = toSide;
    }
    const fromEnd = asEnd(rec.fromEnd);
    if (fromEnd) {
      edge.fromEnd = fromEnd;
    }
    const toEnd = asEnd(rec.toEnd);
    if (toEnd) {
      edge.toEnd = toEnd;
    }
    const color = asString(rec.color);
    if (color) {
      edge.color = color;
    }
    const label = asString(rec.label);
    if (label) {
      edge.label = label;
    }
    edges.push(edge);
  }

  return { data: { nodes, edges }, error: null, dropped };
}

interface IPoint {
  x: number;
  y: number;
}

interface IAnchor extends IPoint {
  /** Outward unit normal of the side, for the bezier control point. */
  nx: number;
  ny: number;
}

function sideAnchor(node: ICanvasNode, side: CanvasSide): IAnchor {
  switch (side) {
    case 'top':
      return { x: node.x + node.width / 2, y: node.y, nx: 0, ny: -1 };
    case 'bottom':
      return {
        x: node.x + node.width / 2,
        y: node.y + node.height,
        nx: 0,
        ny: 1
      };
    case 'left':
      return { x: node.x, y: node.y + node.height / 2, nx: -1, ny: 0 };
    case 'right':
    default:
      return {
        x: node.x + node.width,
        y: node.y + node.height / 2,
        nx: 1,
        ny: 0
      };
  }
}

/**
 * Pick the sides an edge would use when the file leaves them out: the
 * sides facing each other along the dominant axis between node centers.
 */
function autoSides(
  from: ICanvasNode,
  to: ICanvasNode
): { fromSide: CanvasSide; toSide: CanvasSide } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { fromSide: 'right', toSide: 'left' }
      : { fromSide: 'left', toSide: 'right' };
  }
  return dy >= 0
    ? { fromSide: 'bottom', toSide: 'top' }
    : { fromSide: 'top', toSide: 'bottom' };
}

function cubicPoint(
  p0: IPoint,
  c0: IPoint,
  c1: IPoint,
  p1: IPoint,
  t: number
): IPoint {
  const u = 1 - t;
  return {
    x:
      u * u * u * p0.x +
      3 * u * u * t * c0.x +
      3 * u * t * t * c1.x +
      t * t * t * p1.x,
    y:
      u * u * u * p0.y +
      3 * u * u * t * c0.y +
      3 * u * t * t * c1.y +
      t * t * t * p1.y
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {}
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
  return el;
}

const WORLD_PAD = 120;
const MIN_SCALE = 0.1;
const MAX_SCALE = 4;

/**
 * The panel that renders one canvas file. Owns the viewport, the world
 * transform (pan / zoom), and the card + edge DOM.
 */
export class CanvasPanel extends Widget {
  private _context: DocumentRegistry.IContext<DocumentRegistry.IModel>;
  private _rendermime: IRenderMimeRegistry | null;
  private _viewport: HTMLDivElement;
  private _world: HTMLDivElement;
  private _svg: SVGSVGElement;
  private _cards: HTMLDivElement;
  private _zoomLabel: HTMLSpanElement;
  private _errorBar: HTMLDivElement;
  private _renderers: IRenderMime.IRenderer[] = [];
  private _scale = 1;
  private _tx = 0;
  private _ty = 0;
  private _fitted = false;
  private _ready = false;

  constructor(
    context: DocumentRegistry.IContext<DocumentRegistry.IModel>,
    rendermime: IRenderMimeRegistry | null
  ) {
    super();
    this._context = context;
    this._rendermime = rendermime;
    this.addClass('jp-JSONCanvas');
    this.node.setAttribute('tabindex', '0');

    this._viewport = document.createElement('div');
    this._viewport.className = 'jp-JSONCanvas-viewport';
    this._world = document.createElement('div');
    this._world.className = 'jp-JSONCanvas-world';
    this._svg = svgEl('svg', {
      class: 'jp-JSONCanvas-edges'
    }) as SVGSVGElement;
    this._cards = document.createElement('div');
    this._cards.className = 'jp-JSONCanvas-cards';
    this._world.appendChild(this._svg);
    this._world.appendChild(this._cards);
    this._viewport.appendChild(this._world);
    this.node.appendChild(this._viewport);

    this._errorBar = document.createElement('div');
    this._errorBar.className = 'jp-JSONCanvas-error';
    this._errorBar.hidden = true;
    this.node.appendChild(this._errorBar);

    const toolbar = document.createElement('div');
    toolbar.className = 'jp-JSONCanvas-toolbar';
    const zoomOut = this._makeButton('−', 'Zoom out', () => {
      this._zoomBy(1 / 1.25);
    });
    this._zoomLabel = document.createElement('span');
    this._zoomLabel.className = 'jp-JSONCanvas-zoomLabel';
    this._zoomLabel.textContent = '100%';
    const zoomIn = this._makeButton('+', 'Zoom in', () => {
      this._zoomBy(1.25);
    });
    const fit = this._makeButton('Fit', 'Fit to view', () => {
      this._fit();
    });
    toolbar.appendChild(zoomOut);
    toolbar.appendChild(this._zoomLabel);
    toolbar.appendChild(zoomIn);
    toolbar.appendChild(fit);
    this.node.appendChild(toolbar);

    this._viewport.addEventListener('pointerdown', e => {
      this._onPointerDown(e);
    });
    this._viewport.addEventListener(
      'wheel',
      e => {
        this._onWheel(e);
      },
      { passive: false }
    );

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
    this._disposeRenderers();
    super.dispose();
  }

  protected onResize(msg: Widget.ResizeMessage): void {
    super.onResize(msg);
    if (!this._fitted) {
      this.update();
    }
  }

  protected onUpdateRequest(msg: Message): void {
    super.onUpdateRequest(msg);
    if (!this._ready) {
      return;
    }
    this._render();
  }

  private _makeButton(
    label: string,
    title: string,
    onClick: () => void
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'jp-JSONCanvas-toolbarButton';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', () => {
      onClick();
    });
    return button;
  }

  private _disposeRenderers(): void {
    for (const renderer of this._renderers) {
      renderer.dispose();
    }
    this._renderers = [];
  }

  private _applyTransform(): void {
    this._world.style.transform = `translate(${this._tx}px, ${this._ty}px) scale(${this._scale})`;
    this._zoomLabel.textContent = `${Math.round(this._scale * 100)}%`;
  }

  private _fit(): void {
    const vw = this._viewport.clientWidth;
    const vh = this._viewport.clientHeight;
    // Untransformed world size, as set during render.
    const w = parseFloat(this._world.style.width || '0');
    const h = parseFloat(this._world.style.height || '0');
    if (!vw || !vh || !w || !h) {
      return;
    }
    const scale = Math.min(1.5, Math.max(0.05, Math.min(vw / w, vh / h)));
    this._scale = scale;
    this._tx = (vw - w * scale) / 2;
    this._ty = (vh - h * scale) / 2;
    this._fitted = true;
    this._applyTransform();
  }

  private _zoomBy(factor: number, cx?: number, cy?: number): void {
    const vw = this._viewport.clientWidth;
    const vh = this._viewport.clientHeight;
    const mx = cx ?? vw / 2;
    const my = cy ?? vh / 2;
    const next = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, this._scale * factor)
    );
    const ratio = next / this._scale;
    this._tx = mx - (mx - this._tx) * ratio;
    this._ty = my - (my - this._ty) * ratio;
    this._scale = next;
    this._applyTransform();
  }

  private _onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.closest('.jp-JSONCanvas-card') ||
        target.closest('.jp-JSONCanvas-toolbar') ||
        target.closest('a') ||
        target.closest('button'))
    ) {
      return;
    }
    event.preventDefault();
    const viewport = this._viewport;
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('jp-JSONCanvas-panning');
    let lastX = event.clientX;
    let lastY = event.clientY;
    const onMove = (move: PointerEvent): void => {
      this._tx += move.clientX - lastX;
      this._ty += move.clientY - lastY;
      lastX = move.clientX;
      lastY = move.clientY;
      this._applyTransform();
    };
    const onUp = (): void => {
      viewport.removeEventListener('pointermove', onMove);
      viewport.removeEventListener('pointerup', onUp);
      viewport.removeEventListener('pointercancel', onUp);
      viewport.classList.remove('jp-JSONCanvas-panning');
    };
    viewport.addEventListener('pointermove', onMove);
    viewport.addEventListener('pointerup', onUp);
    viewport.addEventListener('pointercancel', onUp);
  }

  private _onWheel(event: WheelEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && target.closest('.jp-JSONCanvas-card')) {
      // Let cards scroll their own content.
      return;
    }
    event.preventDefault();
    const rect = this._viewport.getBoundingClientRect();
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    this._zoomBy(factor, event.clientX - rect.left, event.clientY - rect.top);
  }

  private _renderMarkdown(host: HTMLElement, text: string): void {
    const rendermime = this._rendermime;
    if (!rendermime) {
      host.textContent = text;
      return;
    }
    let renderer: IRenderMime.IRenderer;
    try {
      renderer = rendermime.createRenderer('text/markdown');
    } catch (e) {
      host.textContent = text;
      return;
    }
    const model = rendermime.createModel({
      data: { 'text/markdown': text }
    });
    this._renderers.push(renderer);
    host.appendChild(renderer.node);
    void renderer.renderModel(model).catch(() => {
      host.textContent = text;
    });
  }

  private _render(): void {
    this._disposeRenderers();
    this._cards.textContent = '';
    while (this._svg.firstChild) {
      this._svg.removeChild(this._svg.firstChild);
    }
    this._errorBar.hidden = true;
    this._errorBar.textContent = '';

    const content = this._context.model.toString();
    const { data, error, dropped } = parseCanvas(content);
    if (!data) {
      this._showError(error ?? 'Could not read this canvas file.');
      return;
    }
    if (dropped > 0) {
      this._showError(
        `${dropped} invalid node(s) / edge(s) were skipped.`,
        false
      );
    }

    const { nodes, edges } = data;
    if (nodes.length === 0) {
      this._showError('This canvas has no nodes.');
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
    }
    const ox = minX - WORLD_PAD;
    const oy = minY - WORLD_PAD;
    const worldW = maxX - minX + 2 * WORLD_PAD;
    const worldH = maxY - minY + 2 * WORLD_PAD;
    this._world.style.width = `${worldW}px`;
    this._world.style.height = `${worldH}px`;
    this._svg.setAttribute('width', String(worldW));
    this._svg.setAttribute('height', String(worldH));
    this._svg.setAttribute('viewBox', `0 0 ${worldW} ${worldH}`);

    const byId = new Map(nodes.map(n => [n.id, n]));
    this._renderEdges(edges, byId, ox, oy);
    for (const node of nodes) {
      this._renderNode(node, ox, oy);
    }

    if (!this._fitted) {
      this._fit();
    } else {
      this._applyTransform();
    }
  }

  private _showError(message: string, fatal = true): void {
    this._errorBar.textContent = message;
    this._errorBar.hidden = false;
    if (fatal) {
      this._world.style.width = '0px';
      this._world.style.height = '0px';
    }
  }

  private _renderNode(node: ICanvasNode, ox: number, oy: number): void {
    const card = document.createElement('div');
    card.className = `jp-JSONCanvas-card jp-JSONCanvas-card-${node.type}`;
    card.style.left = `${node.x - ox}px`;
    card.style.top = `${node.y - oy}px`;
    card.style.width = `${node.width}px`;
    card.style.height = `${node.height}px`;
    const color = node.color
      ? resolveColor(node.color, '')
      : '';
    if (color) {
      card.style.borderColor = color;
      if (node.type === 'group') {
        card.style.backgroundColor = hexToRgba(color, 0.08);
      } else {
        card.style.borderWidth = '2px';
      }
    }

    const body = document.createElement('div');
    body.className = 'jp-JSONCanvas-cardBody';
    if (node.type === 'text') {
      this._renderMarkdown(body, node.text ?? '');
    } else if (node.type === 'file') {
      const kind = document.createElement('div');
      kind.className = 'jp-JSONCanvas-cardKind';
      kind.textContent = 'File';
      const path = document.createElement('div');
      path.className = 'jp-JSONCanvas-filePath';
      path.textContent = node.subpath
        ? `${node.file ?? ''}${node.subpath}`
        : (node.file ?? '');
      body.appendChild(kind);
      body.appendChild(path);
    } else if (node.type === 'link') {
      const kind = document.createElement('div');
      kind.className = 'jp-JSONCanvas-cardKind';
      kind.textContent = 'Link';
      const url = node.url ?? '';
      if (/^https?:\/\//i.test(url)) {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.textContent = url;
        body.appendChild(kind);
        body.appendChild(anchor);
      } else {
        const text = document.createElement('div');
        text.textContent = url;
        body.appendChild(kind);
        body.appendChild(text);
      }
    } else {
      // group
      if (node.label) {
        const label = document.createElement('div');
        label.className = 'jp-JSONCanvas-groupLabel';
        label.textContent = node.label;
        body.appendChild(label);
      }
    }
    card.appendChild(body);
    this._cards.appendChild(card);
  }

  private _renderEdges(
    edges: ICanvasEdge[],
    byId: Map<string, ICanvasNode>,
    ox: number,
    oy: number
  ): void {
    const defs = svgEl('defs');
    this._svg.appendChild(defs);
    const markers = new Map<string, string>();
    const markerFor = (color: string): string => {
      const key = color.replace('#', '');
      if (!markers.has(key)) {
        const id = `jpc-arrow-${key}`;
        const marker = svgEl('marker', {
          id,
          markerWidth: '12',
          markerHeight: '12',
          refX: '10',
          refY: '6',
          orient: 'auto-start-reverse',
          markerUnits: 'userSpaceOnUse'
        });
        const path = svgEl('path', {
          d: 'M 0 0 L 12 6 L 0 12 z',
          fill: color
        });
        marker.appendChild(path);
        defs.appendChild(marker);
        markers.set(key, id);
      }
      return markers.get(key) as string;
    };

    for (const edge of edges) {
      const from = byId.get(edge.fromNode);
      const to = byId.get(edge.toNode);
      if (!from || !to) {
        continue;
      }
      const auto = autoSides(from, to);
      const fromSide = edge.fromSide ?? auto.fromSide;
      const toSide = edge.toSide ?? auto.toSide;
      const fromEnd = edge.fromEnd ?? 'none';
      const toEnd = edge.toEnd ?? 'arrow';
      const a0 = sideAnchor(from, fromSide);
      const a1 = sideAnchor(to, toSide);
      const p0: IPoint = { x: a0.x - ox, y: a0.y - oy };
      const p1: IPoint = { x: a1.x - ox, y: a1.y - oy };
      const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const bend = Math.max(30, Math.min(140, dist * 0.4));
      const c0: IPoint = { x: p0.x + a0.nx * bend, y: p0.y + a0.ny * bend };
      const c1: IPoint = { x: p1.x + a1.nx * bend, y: p1.y + a1.ny * bend };
      const color = resolveColor(edge.color, DEFAULT_EDGE_COLOR);
      const path = svgEl('path', {
        d: `M ${p0.x} ${p0.y} C ${c0.x} ${c0.y}, ${c1.x} ${c1.y}, ${p1.x} ${p1.y}`,
        fill: 'none',
        stroke: color,
        'stroke-width': '2'
      });
      if (toEnd === 'arrow') {
        path.setAttribute('marker-end', `url(#${markerFor(color)})`);
      }
      if (fromEnd === 'arrow') {
        path.setAttribute('marker-start', `url(#${markerFor(color)})`);
      }
      this._svg.appendChild(path);
      if (edge.label) {
        const mid = cubicPoint(p0, c0, c1, p1, 0.5);
        const text = svgEl('text', {
          x: String(mid.x),
          y: String(mid.y),
          class: 'jp-JSONCanvas-edgeLabel'
        });
        text.textContent = edge.label;
        this._svg.appendChild(text);
      }
    }
  }
}

/**
 * The document widget wrapping a canvas panel.
 */
export class JSONCanvasDocumentWidget extends DocumentWidget<
  CanvasPanel,
  DocumentRegistry.IModel
> {
  constructor(
    context: DocumentRegistry.IContext<DocumentRegistry.IModel>,
    rendermime: IRenderMimeRegistry | null
  ) {
    super({ context, content: new CanvasPanel(context, rendermime) });
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
  private _rendermime: IRenderMimeRegistry | null;

  constructor(
    options: DocumentRegistry.IWidgetFactoryOptions<JSONCanvasDocumentWidget>,
    rendermime: IRenderMimeRegistry | null
  ) {
    super(options);
    this._rendermime = rendermime;
  }

  protected createNewWidget(
    context: DocumentRegistry.IContext<DocumentRegistry.IModel>
  ): JSONCanvasDocumentWidget {
    return new JSONCanvasDocumentWidget(context, this._rendermime);
  }
}
