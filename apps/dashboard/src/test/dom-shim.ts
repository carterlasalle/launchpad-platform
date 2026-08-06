// Minimal DOM shim for dashboard unit tests (vitest runs in the node
// environment). Implements exactly the surface the dashboard modules use,
// with REAL textContent semantics: assigning textContent stores a string and
// never parses HTML, and innerHTML writes are recorded so tests can assert
// that data-driven rendering never touches HTML parsing.

interface ShimListener {
  (event: { type: string; target: FakeElement }): void;
}

interface ShimWindowListener {
  (event: unknown): void;
}

const elementRegistry = new Map<string, FakeElement>();
const createdElements: FakeElement[] = [];

/** Every innerHTML assignment that happened during the test, for XSS audits. */
export const innerHTMLWrites: Array<{ tag: string; value: string }> = [];

const windowListeners = new Map<string, Set<ShimWindowListener>>();

/**
 * Minimal window for router/app tests: a mutable hash location plus listener
 * registration. Everything else the dashboard touches goes through the fake
 * `document` installed alongside it.
 */
export const windowShim = {
  location: { hash: '' },
  addEventListener(type: string, listener: ShimWindowListener): void {
    let set = windowListeners.get(type);
    if (!set) {
      set = new Set();
      windowListeners.set(type, set);
    }
    set.add(listener);
  },
};

/** Fires a window event (e.g. 'hashchange') at the registered listeners. */
export function fireWindowEvent(type: string, event: unknown = { type }): void {
  const set = windowListeners.get(type);
  if (!set) return;
  for (const listener of [...set]) listener(event);
}

export class FakeText {
  readonly nodeType = 3;
  textContent: string;
  parentNode: FakeElement | null = null;

  constructor(text: string) {
    this.textContent = text;
  }
}

export type FakeChild = FakeElement | FakeText;

export class FakeElement {
  readonly tagName: string;
  readonly children: FakeChild[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<ShimListener>>();
  readonly classTokens = new Set<string>();
  private ownText = '';
  private htmlValue = '';
  parentNode: FakeElement | null = null;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    createdElements.push(this);
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    // Real semantics: assigning textContent replaces all children with text.
    this.ownText = String(value);
    this.children.length = 0;
  }

  get innerHTML(): string {
    return this.htmlValue;
  }

  set innerHTML(value: string) {
    innerHTMLWrites.push({ tag: this.tagName, value: String(value) });
    this.htmlValue = String(value);
  }

  get className(): string {
    return [...this.classTokens].join(' ');
  }

  set className(value: string) {
    this.classTokens.clear();
    for (const token of String(value).split(/\s+/)) {
      if (token !== '') this.classTokens.add(token);
    }
  }

  get classList(): {
    add: (...tokens: string[]) => void;
    remove: (...tokens: string[]) => void;
    toggle: (token: string, force?: boolean) => boolean;
    contains: (token: string) => boolean;
  } {
    return {
      add: (...tokens) => {
        for (const token of tokens) this.classTokens.add(token);
      },
      remove: (...tokens) => {
        for (const token of tokens) this.classTokens.delete(token);
      },
      toggle: (token, force) => {
        const shouldAdd = force ?? !this.classTokens.has(token);
        if (shouldAdd) this.classTokens.add(token);
        else this.classTokens.delete(token);
        return shouldAdd;
      },
      contains: (token) => this.classTokens.has(token),
    };
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    const previousId = name === 'id' ? this.getAttribute('id') : null;
    this.attributes.set(name, String(value));
    if (name === 'id') {
      if (previousId !== null && elementRegistry.get(previousId) === this) elementRegistry.delete(previousId);
      if (value !== '') elementRegistry.set(String(value), this);
    }
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  get id(): string {
    return this.getAttribute('id') ?? '';
  }

  set id(value: string) {
    this.setAttribute('id', value);
  }

  get href(): string {
    return this.getAttribute('href') ?? '';
  }

  set href(value: string) {
    this.setAttribute('href', String(value));
  }

  get target(): string {
    return this.getAttribute('target') ?? '';
  }

  set target(value: string) {
    this.setAttribute('target', String(value));
  }

  get rel(): string {
    return this.getAttribute('rel') ?? '';
  }

  set rel(value: string) {
    this.setAttribute('rel', String(value));
  }

  get type(): string {
    return this.getAttribute('type') ?? '';
  }

  set type(value: string) {
    this.setAttribute('type', String(value));
  }

  get value(): string {
    return this.getAttribute('value') ?? '';
  }

  set value(value: string) {
    this.setAttribute('value', String(value));
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...children: Array<FakeElement | string>): void {
    for (const child of children) {
      if (typeof child === 'string') {
        const text = new FakeText(child);
        text.parentNode = this;
        this.children.push(text);
      } else {
        this.appendChild(child);
      }
    }
  }

  replaceChildren(...children: Array<FakeElement | string>): void {
    this.children.length = 0;
    this.append(...children);
  }

  addEventListener(type: string, listener: ShimListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  click(): void {
    const set = this.listeners.get('click');
    if (!set) return;
    for (const listener of [...set]) listener({ type: 'click', target: this });
  }

  focus(): void {
    // No-op in the shim.
  }
}

/**
 * Type-only adapter for elements the shim produced at runtime. The shim
 * installs a fake `document` while the DOM lib types still describe real
 * HTMLElements, so callers narrow through this helper instead of casting
 * across unrelated DOM types.
 */
export function asFakeElement(element: unknown): FakeElement {
  return element as FakeElement;
}

/** Collects every descendant element with the given tag name (e.g. 'IMG'). */
export function findTags(root: FakeElement, tag: string): FakeElement[] {
  const wanted = tag.toUpperCase();
  const results: FakeElement[] = [];
  const visit = (element: FakeElement): void => {
    for (const child of element.children) {
      if (child instanceof FakeElement) {
        if (child.tagName === wanted) results.push(child);
        visit(child);
      }
    }
  };
  visit(root);
  return results;
}

export function installDomShim(): void {
  innerHTMLWrites.length = 0;
  windowListeners.clear();
  windowShim.location.hash = '';
  if ((globalThis as Record<string, unknown>).document !== undefined) return;
  const document = {
    title: '',
    createElement(tag: string): FakeElement {
      return new FakeElement(tag);
    },
    createTextNode(text: string): FakeText {
      return new FakeText(text);
    },
    getElementById(id: string): FakeElement | null {
      return elementRegistry.get(id) ?? null;
    },
    querySelectorAll(selector: string): FakeElement[] {
      if (selector === '[data-nav]') return createdElements.filter((element) => element.getAttribute('data-nav') !== null);
      if (selector.startsWith('#')) return createdElements.filter((element) => element.id === selector.slice(1));
      return [];
    },
  };
  (globalThis as Record<string, unknown>).document = document;
  (globalThis as Record<string, unknown>).window = windowShim;
}
