// Safe DOM helpers. Every data-driven view in the dashboard is built with
// createElement/textContent through these functions — untrusted strings never
// pass through innerHTML or template interpolation, so they can never enter
// HTML parsing.

import { ApiError, UnauthenticatedError } from './api.js';
import { classifyStatus, type StatusDimension } from './status.js';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

export function append(parent: HTMLElement, ...children: Array<HTMLElement | string | null | undefined>): HTMLElement {
  for (const child of children) {
    if (child === null || child === undefined) continue;
    parent.append(child);
  }
  return parent;
}

export function setText(target: HTMLElement, value: unknown): HTMLElement {
  target.textContent = value === null || value === undefined ? '' : String(value);
  return target;
}

export function clear(target: HTMLElement): void {
  target.replaceChildren();
}

export function internalLink(href: string, label: string): HTMLAnchorElement {
  const anchor = el('a', 'internal-link');
  anchor.href = href;
  setText(anchor, label);
  return anchor;
}

export function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', 'button');
  setText(button, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

export function statusBadge(dimension: StatusDimension, value: string | null | undefined): HTMLElement {
  const { label, tone } = classifyStatus(dimension, value);
  // Class names derive only from the classification, never from the value.
  const badge = el('span', `status-badge status-badge--${dimension} status-badge--${tone}`);
  append(badge, el('i', 'status-badge__dot'), label);
  return badge;
}

export interface ViewState {
  kind: 'loading' | 'empty' | 'error' | 'unknown';
  title: string;
  message: string;
  detail?: string;
  actions?: HTMLElement[];
}

export function stateElement(state: ViewState): HTMLElement {
  const root = el('div', `view-state view-state--${state.kind}`);
  const mark = el('span', 'view-state__mark');
  setText(mark, state.kind === 'loading' ? '…' : state.kind === 'error' ? '!' : state.kind === 'empty' ? '∅' : '?');
  const copy = el('div', 'view-state__copy');
  const title = el('p', 'view-state__title');
  setText(title, state.title);
  const message = el('p', 'view-state__message');
  setText(message, state.message);
  append(copy, title, message);
  if (state.detail) {
    const detail = el('p', 'view-state__detail');
    setText(detail, state.detail);
    append(copy, detail);
  }
  append(root, mark, copy);
  if (state.actions && state.actions.length > 0) {
    const actions = el('div', 'view-state__actions');
    for (const action of state.actions) append(actions, action);
    append(root, actions);
  }
  return root;
}

export function timestamp(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export function shortId(value: string, length = 12): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

/**
 * Concise error state with safe recovery links (NFR-UX-004): a short summary,
 * a retry action, and links to the audit log and operations views.
 */
export function errorStateView(error: unknown, options?: { reload?: () => void; openSession?: () => void }): ViewState {
  if (error instanceof UnauthenticatedError) {
    const actions: HTMLElement[] = [];
    if (options?.openSession) actions.push(actionButton('OPEN SESSION', options.openSession));
    return {
      kind: 'error',
      title: 'Authentication required',
      message: error.message,
      detail: 'Protected control-plane reads fail closed without an operator session token.',
      actions,
    };
  }
  const apiError = error instanceof ApiError ? error : null;
  const actions: HTMLElement[] = [];
  if (options?.reload) actions.push(actionButton('RETRY', options.reload));
  actions.push(internalLink('#/audit', 'VIEW AUDIT LOG'));
  actions.push(internalLink('#/operations', 'VIEW OPERATIONS'));
  const detail = apiError ? `${apiError.code}${apiError.status !== null ? ` · HTTP ${apiError.status}` : ''}` : null;
  return {
    kind: 'error',
    title: 'Control plane read failed',
    message: apiError ? apiError.message : error instanceof Error ? error.message : 'An unexpected error occurred.',
    ...(detail === null ? {} : { detail }),
    actions,
  };
}
