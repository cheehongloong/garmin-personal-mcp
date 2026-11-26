export class WorkerEntrypoint<Env = unknown, Props = unknown> {
  readonly ctx: ExecutionContext<Props>;
  readonly env: Env;

  constructor(ctx: ExecutionContext<Props>, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
