// Configuración de la aplicación: qué herramientas se publican y qué conocimiento recibe el agente.
// Comportamiento → agent/prompt.md · Conocimiento → src/knowledge/ · Ejecución → src/tools/.
import path from "node:path"
import { readText, fechaReferencia } from "./core/util"
import * as agente from "./tools/agente"
import * as contratos from "./tools/contratos"

export const APP = {
  nombre: "Registro de Contratos Vigentes",
  herramientas: { contratos, agente } as Record<string, Record<string, unknown>>,
  conocimiento: ["src/knowledge/registro-contratos.md"],
  ejemplos: [
    "Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que esté limpio, muéstrame lo que requiere revisión campo por campo y termina con el reporte de alertas. No registres nada dudoso sin preguntarme.",
    "¿Qué mensajes hay pendientes en el buzón?",
    "Genera el reporte de alertas con fecha 2026-09-03.",
  ],
}

export async function cargarSystemPrompt(root: string): Promise<string> {
  const prompt = (await readText(path.join(root, "agent", "prompt.md"))) ?? ""
  const partes = [prompt.trim()]
  for (const archivo of APP.conocimiento) {
    const texto = await readText(path.join(root, archivo))
    if (texto) partes.push(`\n\n---\n# Conocimiento del proceso (${archivo})\n\n${texto.trim()}`)
  }
  let fecha = ""
  try {
    fecha = fechaReferencia()
  } catch {
    fecha = "desconocida (FECHA_REFERENCIA inválida)"
  }
  partes.push(`\n\n---\nFecha actual del sistema: ${fecha}. Si el usuario indica otra fecha de "hoy", usa la suya para las alertas.`)
  return partes.join("")
}

/** Metadatos del módulo reutilizable (modulo/), generado por scripts/modulo.ts desde estas mismas piezas. */
export const MODULO = {
  descripcion: "Agente que actúa como punto único de recepción de contratos: extrae, clasifica, registra en el maestro, archiva y alerta vencimientos y pólizas.",
  skill: "registro-contratos",
  descripcionSkill: "Conocimiento del proceso de registro de contratos vigentes de Periferia: esquema del maestro, reglas de duplicado/actualización, revisión humana y alertas.",
  conocimiento: APP.conocimiento,
  herramientas: ["contratos", "agente"],
}
