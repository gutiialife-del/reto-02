// Contrato de herramientas: { description, args (zod), execute(args, ctx) → string JSON }.
// Ninguna herramienta lanza: toda falla se devuelve como { ok: false, error }.
import { z } from "zod/v4"

export type ToolContext = { directory: string; sessionId: string }

export type ToolResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string }

export type ZodArgs = Record<string, z.ZodType>

/** Forma mínima que el registro necesita. `execute` se declara como método (bivariante) a propósito. */
export interface AnyTool {
  description: string
  args: ZodArgs
  execute(args: never, ctx: ToolContext): Promise<string>
}

type ToolDef<A extends ZodArgs> = {
  description: string
  args: A
  execute(args: z.infer<z.ZodObject<A>>, ctx: ToolContext): Promise<string>
}

/** Ayuda de tipos: devuelve el mismo objeto, con `args` inferidos desde los esquemas zod. */
export function defineTool<A extends ZodArgs>(def: ToolDef<A>): ToolDef<A> {
  return def
}

export function ok<T>(data: T): string {
  return JSON.stringify({ ok: true, data })
}

export function fail(error: string): string {
  return JSON.stringify({ ok: false, error })
}

/** Envuelve la lógica de una herramienta para que un error inesperado nunca escape como excepción. */
export async function guard(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ToolError) return fail(err.message)
    const msg = err instanceof Error ? err.message : String(err)
    return fail(`error interno de la herramienta: ${msg}`)
  }
}

/** Error de negocio esperado; `guard` lo convierte en { ok:false, error } con su mensaje tal cual. */
export class ToolError extends Error {}

export function parseResult(raw: string): ToolResult {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && "ok" in parsed) return parsed as ToolResult
    return { ok: false, error: "la herramienta devolvió un formato inesperado" }
  } catch {
    return { ok: false, error: "la herramienta devolvió JSON inválido" }
  }
}

export function isTool(value: unknown): value is AnyTool {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return typeof v.description === "string" && typeof v.args === "object" && typeof v.execute === "function"
}

/** Esquema JSON de los argumentos, limpiado de palabras clave poco soportadas por los proveedores. */
export function toJsonSchema(args: ZodArgs): Record<string, unknown> {
  const schema = limpiar(z.toJSONSchema(z.object(args))) as Record<string, unknown>
  delete schema.$schema
  return schema
}

function limpiar(nodo: unknown): unknown {
  if (Array.isArray(nodo)) return nodo.map(limpiar)
  if (!nodo || typeof nodo !== "object") return nodo
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(nodo as Record<string, unknown>)) {
    if (k === "propertyNames") continue
    if (k === "additionalProperties" && v && typeof v === "object" && !Object.keys(v).length) {
      out[k] = true
      continue
    }
    out[k] = limpiar(v)
  }
  return out
}
