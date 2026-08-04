declare module 'cloudflare:workers' {
  export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected readonly env: Env;
    constructor(ctx: ExecutionContext, env: Env);
  }
  export interface WorkflowEvent<Params = unknown> { readonly payload: Readonly<Params>; readonly timestamp: Date; readonly instanceId: string; readonly workflowName: string; }
  export interface WorkflowStep { do<T>(name: string, callback: () => Promise<T>): Promise<T>; sleep(name: string, duration: string | number): Promise<void>; }
}
