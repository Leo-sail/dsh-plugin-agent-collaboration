/**
 * Minimal type surface for `@deepseek-ai/schemastery`.
 *
 * WHY THIS FILE EXISTS. schemastery is a PEER dependency supplied by the DSH host at runtime,
 * and this workspace deliberately does not install auto-peers (`autoInstallPeers: false` in
 * `pnpm-workspace.yaml`). Without a declaration, `tsc` reports `TS2307 Cannot find module
 * '@deepseek-ai/schemastery'` for every package that declares a `Config` schema — two of the
 * eight errors that used to be pinned in `scripts/typecheck-baseline.json`.
 *
 * This file models ONLY the surface this repo uses: `z.object/number/string/boolean/array`,
 * the `step/min/max/default/required` chain, and the `z<T>` type-position generic the real
 * package supports. It does not change runtime: the host's real schemastery still executes.
 * `Infer` mirrors schemastery's builder→value unwrapping so `z.object({...})` assigns to
 * `z<Config>`.
 *
 * KEEP IT HONEST: if a future change uses new schemastery API, add it here (or make it a real
 * devDependency once the toolchain allows installs). A declaration that lies would let a
 * runtime-only API slip through typecheck.
 */
declare module '@deepseek-ai/schemastery' {
  /** Chainable schema builder. */
  interface z<S = unknown> {
    step(value: number): z<S>
    min(value: number): z<S>
    max(value: number): z<S>
    default(value: S): z<S>
    required(value?: boolean): z<S>
    description(text: string): z<S>
  }

  /** What a schema produces (a schema of `T` builds a `T`). */
  type Infer<T> = T extends z<infer S> ? S : T

  const z: {
    object<T extends Record<string, unknown>>(shape: T): z<{ readonly [K in keyof T]: Infer<T[K]> }>
    number(): z<number>
    string(): z<string>
    boolean(): z<boolean>
    array<T>(inner: z<T>): z<T[]>
  }

  export default z
}
