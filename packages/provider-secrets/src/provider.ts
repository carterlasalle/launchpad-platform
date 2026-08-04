import { SensitiveValue } from '@launchpad/shared';
import type { ProviderContext, SecretProvider } from '@launchpad/provider-contract';

export class EnvironmentSecretProvider implements SecretProvider {
  readonly values: Record<string, string>;

  constructor(values: Record<string, string> = {}) {
    this.values = { ...values };
  }

  async resolve(reference: string, _ctx: ProviderContext): Promise<SensitiveValue<unknown>> {
    if (!reference.startsWith('env://')) throw new Error(`Unsupported secret reference scheme '${reference.split(':')[0] ?? 'unknown'}'.`);
    const name = reference.slice('env://'.length);
    const value = this.values[name] ?? (typeof process !== 'undefined' ? process.env[name] : undefined);
    if (value === undefined) throw new Error(`Secret reference '${reference}' is not configured.`);
    return new SensitiveValue(value);
  }

  async fingerprint(reference: string, ctx: ProviderContext): Promise<string> {
    const value = await this.resolve(reference, ctx);
    return value.fingerprint();
  }
}
