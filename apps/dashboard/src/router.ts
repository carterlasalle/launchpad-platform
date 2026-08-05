// Hash-based router for the dashboard shell. Routes are declared as templates
// with `:param` segments; matching is anchored and parameters are
// percent-decoded safely (malformed encoding never matches).

import type { ApiClient } from './api.js';
import { append, clear, errorStateView, internalLink, stateElement } from './dom.js';

export interface PageContext {
  client: ApiClient;
  reload: () => void;
  openSession: () => void;
}

export interface PageView {
  title: string;
  element: HTMLElement;
}

export type PageRenderer = (context: PageContext, params: Record<string, string>) => Promise<PageView>;

export interface RouteDefinition {
  name: string;
  template: string;
  pattern: RegExp;
  keys: string[];
  render: PageRenderer;
}

export function defineRoute(template: string, name: string, render: PageRenderer): RouteDefinition {
  const keys: string[] = [];
  const source = template.replace(/:([A-Za-z][A-Za-z0-9_-]*)/g, (_token, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  return { name, template, pattern: new RegExp(`^${source}$`), keys, render };
}

export function parseHash(hash: string): string {
  const value = (hash ?? '').replace(/^#/, '');
  return value === '' ? '/' : value;
}

export interface RouteMatch {
  route: RouteDefinition;
  params: Record<string, string>;
}

export function matchRoute(path: string, routes: readonly RouteDefinition[]): RouteMatch | null {
  for (const route of routes) {
    const match = route.pattern.exec(path);
    if (match === null) continue;
    const params: Record<string, string> = {};
    let valid = true;
    for (let index = 0; index < route.keys.length; index += 1) {
      const raw = match[index + 1];
      const key = route.keys[index];
      if (raw === undefined || key === undefined) {
        valid = false;
        break;
      }
      try {
        params[key] = decodeURIComponent(raw);
      } catch {
        valid = false;
        break;
      }
    }
    if (valid) return { route, params };
  }
  return null;
}

export class HashRouter {
  private readonly routes: readonly RouteDefinition[];
  private readonly container: HTMLElement;
  private readonly context: PageContext;

  constructor(options: { routes: readonly RouteDefinition[]; container: HTMLElement; client: ApiClient; openSession: () => void }) {
    this.routes = options.routes;
    this.container = options.container;
    this.context = {
      client: options.client,
      openSession: options.openSession,
      reload: () => {
        void this.render();
      },
    };
  }

  start(): void {
    window.addEventListener('hashchange', () => {
      void this.render();
    });
    if (window.location.hash === '' || window.location.hash === '#') window.location.hash = '#/';
    void this.render();
  }

  async render(): Promise<void> {
    const path = parseHash(window.location.hash);
    const match = matchRoute(path, this.routes);
    try {
      if (match === null) {
        this.mount(unknownState(path));
        return;
      }
      this.setActiveNav(match.route.name);
      const view = await match.route.render(this.context, match.params);
      this.mount(view.element);
    } catch (error) {
      this.mount(stateElement(errorStateView(error, { reload: this.context.reload, openSession: this.context.openSession })));
    }
  }

  private mount(element: HTMLElement): void {
    clear(this.container);
    append(this.container, element);
  }

  private setActiveNav(name: string): void {
    document.querySelectorAll('[data-nav]').forEach((item) => {
      item.classList.toggle('is-active', item.getAttribute('data-nav') === name);
    });
  }
}

function unknownState(path: string): HTMLElement {
  return stateElement({
    kind: 'unknown',
    title: 'Unknown page',
    message: `No dashboard view exists for "${path}".`,
    actions: [internalLink('#/', 'BACK TO APPLICATIONS')],
  });
}
