// Shared page scaffolding: hosts for the loading/empty/error/unknown state
// machine, headings, tables and rows. All content flows through the safe DOM
// helpers — no HTML interpolation anywhere.

import { append, clear, el, errorStateView, setText, stateElement, type ViewState } from '../dom.js';
import type { PageContext } from '../router.js';

export interface PageHost {
  root: HTMLElement;
  show(state: ViewState): void;
  fill(content: HTMLElement): void;
}

export function createPageHost(className = 'page'): PageHost {
  const root = el('div', className);
  const state = el('div', 'page__state');
  append(root, state);
  return {
    root,
    show(next: ViewState): void {
      clear(state);
      append(state, stateElement(next));
    },
    fill(content: HTMLElement): void {
      clear(state);
      append(state, content);
    },
  };
}

export function pageHeading(eyebrow: string, title: string, meta?: string): HTMLElement {
  const heading = el('header', 'page-head');
  const eyebrowEl = el('p', 'eyebrow');
  setText(eyebrowEl, eyebrow);
  const h1 = el('h1');
  setText(h1, title);
  append(heading, eyebrowEl, h1);
  if (meta) {
    const metaEl = el('p', 'page-head__meta');
    setText(metaEl, meta);
    append(heading, metaEl);
  }
  return heading;
}

export function dataTable(headers: string[], rows: HTMLElement[]): HTMLElement {
  const table = el('table', 'data-table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const header of headers) {
    const th = el('th');
    setText(th, header);
    append(headRow, th);
  }
  append(thead, headRow);
  const tbody = el('tbody');
  for (const tableRow of rows) append(tbody, tableRow);
  append(table, thead, tbody);
  return table;
}

export function row(cells: Array<HTMLElement | string>): HTMLTableRowElement {
  const tr = el('tr');
  for (const cell of cells) {
    const td = el('td');
    if (typeof cell === 'string') setText(td, cell);
    else append(td, cell);
    append(tr, td);
  }
  return tr;
}

export function codeText(value: unknown): HTMLElement {
  const code = el('code', 'mono');
  setText(code, typeof value === 'string' ? value : JSON.stringify(value));
  return code;
}

export function handlePageError(host: PageHost, context: PageContext, error: unknown): void {
  host.show(errorStateView(error, { reload: context.reload, openSession: context.openSession }));
}

export function subNav(applicationId: string): HTMLElement {
  const nav = el('nav', 'sub-nav');
  const links: Array<[string, string]> = [
    ['RESOURCES', `#/applications/${encodeURIComponent(applicationId)}/resources`],
    ['PLAN', `#/applications/${encodeURIComponent(applicationId)}/plan`],
    ['DEPLOYMENTS', `#/applications/${encodeURIComponent(applicationId)}/deployments`],
    ['HEALTH', `#/applications/${encodeURIComponent(applicationId)}/health`],
    ['DRIFT', `#/applications/${encodeURIComponent(applicationId)}/drift`],
    ['AUDIT', `#/applications/${encodeURIComponent(applicationId)}/audit`],
  ];
  for (const [label, href] of links) {
    const anchor = el('a', 'internal-link');
    anchor.href = href;
    setText(anchor, label);
    append(nav, anchor);
  }
  return nav;
}
