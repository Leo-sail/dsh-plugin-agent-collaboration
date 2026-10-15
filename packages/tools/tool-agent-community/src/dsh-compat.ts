/**
 * `defineTool` — the plugin's own, so this package needs no DSH package to register a tool.
 *
 * `defineTool` is a convenience wrapper: it turns the small `parameters` record this package
 * writes (`{ name: { type: 'string', required: true, description } }`) into the JSON Schema a tool
 * definition carries. Using the host's copy meant one more package that had to be present at a
 * compatible version before the plugin would load at all — and a mismatched copy in a profile is
 * exactly what took a user's sessions down (see INSTALL-LOCAL.md).
 *
 * The core package of this plugin has always built its definitions by hand and they work, so the
 * conversion below is all that was ever needed. It pins no DSH version and cannot be shadowed.
 *
 * @module
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** One parameter as the call sites declare it. */
interface ParameterSpec {
  readonly type?: string | undefined
  readonly required?: boolean | undefined
  readonly description?: string | undefined
  readonly enum?: readonly string[] | undefined
  readonly items?: unknown
}

/** The host's own signature, taken as a TYPE ONLY: call sites keep its full inference for `args`. */
type HostDefineTool = typeof import('@deepseek-ai/dsh-tools')['defineTool']

/**
 * Define a tool — the plugin's own builder, typed as the host's.
 *
 * The cast is the point: `args` in every `execute` body is still inferred from the `parameters`
 * record by the HOST's type, so the call sites are unchanged, while the value that actually runs
 * is this file's conversion. No runtime import, no version to match, nothing a profile can shadow.
 */
export const defineTool = ((spec: { readonly parameters?: Record<string, ParameterSpec> }) => {
  const parameters = spec.parameters ?? {}
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, parameter] of Object.entries(parameters)) {
    properties[name] = {
      type: parameter.type ?? 'string',
      ...(parameter.description !== undefined ? { description: parameter.description } : {}),
      ...(parameter.enum !== undefined ? { enum: [...parameter.enum] } : {}),
      ...(parameter.items !== undefined ? { items: parameter.items } : {}),
    }
    if (parameter.required === true) required.push(name)
  }
  return {
    ...spec,
    parameters: { type: 'object', additionalProperties: false, properties, required },
  }
}) as unknown as HostDefineTool
