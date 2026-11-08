import { LabIcon } from '@jupyterlab/ui-components';

/**
 * Icon for JSON Canvas files: two cards joined by an arrow.
 */
export const canvasIcon = new LabIcon({
  name: 'jupyterlab-jsoncanvas:canvas',
  svgstr: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
<rect x="1" y="1.5" width="5.5" height="4.5" rx="1" fill="none" stroke="currentColor"/>
<rect x="9.5" y="10" width="5.5" height="4.5" rx="1" fill="none" stroke="currentColor"/>
<path d="M6.5 4 L9.5 10" fill="none" stroke="currentColor"/>
<path d="M9.5 10 L9.5 7.2 M9.5 10 L7.4 9.4" fill="none" stroke="currentColor"/>
</svg>`
});
