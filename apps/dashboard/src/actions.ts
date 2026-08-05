// Operator action controls for the dashboard.
//
// Every control issues the EXACT existing control-plane endpoint for its
// action — recovery actions POST /v1/applications/:id/actions/:kind and
// config changes POST /v1/applications/:id/changes/:change — through the
// authenticated ApiClient (which fails closed without a session token).
// Destructive or provider-affecting requests (rollback, cancel, config
// changes) require an explicit confirmation click before anything is sent.
// Config changes only open control-repository pull requests server-side;
// nothing in this module ever targets a provider API. Per-control status is
// rendered as text in an aria-live region: pending while in flight, then the
// control-plane result or a concise error.

import { ApiClient, ApiError } from './api.js';
import { append, el, setText, shortId } from './dom.js';

export type OperatorActionKind = 'retry' | 'recheck' | 'rollback' | 'cancel';

export const OPERATOR_ACTION_KINDS: readonly OperatorActionKind[] = ['retry', 'recheck', 'rollback', 'cancel'] as const;

/** Action kinds that mutate the provider or stop work and so need confirmation. */
const CONFIRMATION_KINDS = new Set<OperatorActionKind>(['rollback', 'cancel']);

/** Action kinds that are bound to one specific workflow run. */
const OPERATION_BOUND_KINDS = new Set<OperatorActionKind>(['retry', 'cancel']);

const ACTION_LABELS: Record<OperatorActionKind, string> = {
  retry: 'RETRY',
  recheck: 'RECHECK HEALTH',
  rollback: 'ROLLBACK',
  cancel: 'CANCEL',
};

/** The exact existing control-plane endpoint for a recovery action. */
export function operatorActionPath(applicationId: string, kind: OperatorActionKind): string {
  return `/v1/applications/${encodeURIComponent(applicationId)}/actions/${kind}`;
}

export const CONFIG_CHANGE_KINDS = ['root', 'framework', 'domain', 'proxy', 'env', 'adopt', 'restore'] as const;
export type ConfigChangeKind = (typeof CONFIG_CHANGE_KINDS)[number];

/** The exact existing control-plane endpoint for a PR-only config change. */
export function configChangePath(applicationId: string, change: ConfigChangeKind): string {
  return `/v1/applications/${encodeURIComponent(applicationId)}/changes/${change}`;
}

/** Deterministic client idempotency key for a cancel of one operation; replays of the same cancel reuse it. */
export function cancelIdempotencyKey(applicationId: string, operationId: string): string {
  return `launchpad:cancel:${applicationId}:${operationId}`;
}

const CHANGE_LABELS: Record<ConfigChangeKind, string> = {
  root: 'ROOT DIRECTORY',
  framework: 'FRAMEWORK',
  domain: 'DOMAIN',
  proxy: 'PROXY MODE',
  env: 'ENVIRONMENT VARIABLE',
  adopt: 'ADOPT OBSERVED ROOT',
  restore: 'RESTORE DESIRED STATE',
};

export interface ConfigChangeField {
  /** Body field name sent to the existing config-change endpoint. */
  name: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
}

const CONFIG_CHANGE_FIELDS: Record<Exclude<ConfigChangeKind, 'adopt' | 'restore'>, ConfigChangeField[]> = {
  root: [{ name: 'value', label: 'Root directory', placeholder: 'apps/web' }],
  framework: [{ name: 'value', label: 'Framework (empty = auto)', placeholder: 'nextjs' }],
  domain: [
    { name: 'hostname', label: 'Hostname', placeholder: 'app.example.com' },
    { name: 'zoneRef', label: 'Zone reference', placeholder: 'config://cloudflare/example.com' },
    { name: 'mode', label: 'Mode', defaultValue: 'dns-only' },
  ],
  proxy: [
    { name: 'hostname', label: 'Hostname', placeholder: 'app.example.com' },
    { name: 'value', label: 'Value', defaultValue: 'proxied' },
  ],
  env: [
    { name: 'environment', label: 'Environment', defaultValue: 'production' },
    { name: 'name', label: 'Variable name', placeholder: 'API_URL' },
    { name: 'value', label: 'Value', placeholder: 'https://api.example.com' },
  ],
};

function conciseError(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) {
    const message = error.message.trim();
    if (message !== '') return message;
  }
  return 'The action failed.';
}

function setBusy(buttons: HTMLButtonElement[], busy: boolean): void {
  for (const button of buttons) button.disabled = busy;
}

/**
 * Renders one button per requested action kind plus an aria-live status line.
 * Operation-bound kinds (retry, cancel) are skipped when no operationId is
 * supplied. Rollback and cancel need a confirmation click before they send.
 */
export function operatorActionControls(options: { client: ApiClient; applicationId: string; operationId?: string | null; kinds: readonly OperatorActionKind[] }): HTMLElement {
  const root = el('div', 'operator-actions');
  const status = el('p', 'action-status');
  status.setAttribute('aria-live', 'polite');
  const buttons: HTMLButtonElement[] = [];
  const run = async (kind: OperatorActionKind): Promise<void> => {
    setBusy(buttons, true);
    setText(status, `${ACTION_LABELS[kind]} pending…`);
    try {
      const body: Record<string, unknown> = {};
      let idempotencyKey: string | undefined;
      if (kind === 'retry' || kind === 'cancel') {
        const operationId = options.operationId ?? null;
        if (!operationId) throw new ApiError('CLIENT', 'This action needs the operation it applies to.');
        body.operationId = operationId;
        if (kind === 'cancel') idempotencyKey = cancelIdempotencyKey(options.applicationId, operationId);
      }
      const result = await options.client.post<Record<string, unknown>>(operatorActionPath(options.applicationId, kind), body, idempotencyKey);
      const operationId = options.operationId ?? null;
      if (kind === 'retry') setText(status, `Retry queued for ${shortId(operationId ?? '')}`);
      else if (kind === 'recheck') setText(status, 'Health recheck queued');
      else if (kind === 'rollback') setText(status, `Rollback ${result.status === 'SUCCEEDED' ? 'completed' : 'queued'} to known-good`);
      else setText(status, `Operation ${shortId(operationId ?? '')} canceled`);
    } catch (error) {
      setText(status, `Action failed: ${conciseError(error)}`);
    } finally {
      setBusy(buttons, false);
    }
  };
  for (const kind of options.kinds) {
    if (OPERATION_BOUND_KINDS.has(kind) && !options.operationId) continue;
    const button = el('button', 'button button--compact');
    setText(button, ACTION_LABELS[kind]);
    button.type = 'button';
    let armed = false;
    button.addEventListener('click', () => {
      if (CONFIRMATION_KINDS.has(kind) && !armed) {
        armed = true;
        button.setAttribute('data-armed', 'true');
        setText(button, `CONFIRM ${ACTION_LABELS[kind]}`);
        return;
      }
      if (CONFIRMATION_KINDS.has(kind)) {
        armed = false;
        button.removeAttribute('data-armed');
        setText(button, ACTION_LABELS[kind]);
      }
      void run(kind);
    });
    buttons.push(button);
    append(root, button);
  }
  append(root, status);
  return root;
}

function fieldsFor(change: ConfigChangeKind): ConfigChangeField[] {
  if (change === 'adopt' || change === 'restore') return [];
  return CONFIG_CHANGE_FIELDS[change];
}

function submitConfigChange(client: ApiClient, applicationId: string, change: ConfigChangeKind, body: Record<string, unknown>, button: HTMLButtonElement, status: HTMLElement): void {
  button.disabled = true;
  setText(status, `${CHANGE_LABELS[change]} change pending…`);
  void client.post<Record<string, unknown>>(configChangePath(applicationId, change), body).then(
    (result) => {
      const pullRequest = typeof result.pullRequest === 'object' && result.pullRequest !== null ? (result.pullRequest as Record<string, unknown>) : null;
      const url = pullRequest && typeof pullRequest.url === 'string' && pullRequest.url !== '' ? pullRequest.url : null;
      setText(status, url === null ? `Pull request opened for the ${CHANGE_LABELS[change]} change` : `Pull request opened: ${url}`);
      button.disabled = false;
    },
    (error: unknown) => {
      setText(status, `Action failed: ${conciseError(error)}`);
      button.disabled = false;
    },
  );
}

/**
 * Renders one PR-only config change form per kind. Each form collects the
 * change's fields, requires a confirmation click, then POSTs to the existing
 * `/v1/applications/:id/changes/:change` endpoint. No provider is ever
 * targeted: the control plane opens (or reuses) a control-repository pull
 * request from these requests.
 */
export function configChangeControls(options: { client: ApiClient; applicationId: string }): HTMLElement {
  const root = el('div', 'config-changes');
  for (const change of CONFIG_CHANGE_KINDS) {
    const section = el('section', 'config-change');
    const heading = el('h3', 'config-change__heading');
    setText(heading, `CHANGE ${CHANGE_LABELS[change]}`);
    append(section, heading);
    const body: Record<string, unknown> = {};
    const fields = fieldsFor(change);
    const inputs: HTMLInputElement[] = [];
    for (const field of fields) {
      const label = el('label', 'config-change__label');
      setText(label, field.label);
      const input = el('input', 'config-change__input');
      input.type = 'text';
      if (field.placeholder !== undefined) input.setAttribute('placeholder', field.placeholder);
      if (field.defaultValue !== undefined) input.value = field.defaultValue;
      append(label, input);
      append(section, label);
      inputs.push(input);
    }
    const status = el('p', 'action-status');
    status.setAttribute('aria-live', 'polite');
    const button = el('button', 'button button--compact');
    setText(button, `OPEN PR: ${CHANGE_LABELS[change]}`);
    button.type = 'button';
    let armed = false;
    button.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        button.setAttribute('data-armed', 'true');
        setText(button, `CONFIRM OPEN PR: ${CHANGE_LABELS[change]}`);
        return;
      }
      armed = false;
      button.removeAttribute('data-armed');
      setText(button, `OPEN PR: ${CHANGE_LABELS[change]}`);
      for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        const input = inputs[index];
        if (!field || !input) continue;
        const value = input.value.trim();
        if (value !== '') body[field.name] = value;
      }
      submitConfigChange(options.client, options.applicationId, change, body, button, status);
    });
    append(section, button, status);
    append(root, section);
  }
  return root;
}
