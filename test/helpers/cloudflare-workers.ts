// Minimal stand-in for the `cloudflare:workers` runtime module so code that
// imports it can be exercised under plain Node vitest.
export class WorkerEntrypoint {}

export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: DurableObjectState,
    protected env: Env
  ) {}
}
