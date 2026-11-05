// Registro de herramientas: cada export de src/tools/<archivo>.ts que cumpla el contrato
// se publica al modelo con el nombre <archivo>_<export>.
import { type AnyTool, isTool, toJsonSchema } from "./tool"

export type RegisteredTool = {
  nombre: string
  tool: AnyTool
  parameters: Record<string, unknown>
}

export function registrarHerramientas(modulos: Record<string, Record<string, unknown>>): RegisteredTool[] {
  const out: RegisteredTool[] = []
  for (const [archivo, mod] of Object.entries(modulos)) {
    for (const [exportName, value] of Object.entries(mod)) {
      if (!isTool(value)) continue
      out.push({ nombre: `${archivo}_${exportName}`, tool: value, parameters: toJsonSchema(value.args) })
    }
  }
  return out
}
