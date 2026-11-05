// Herramienta transversal del agente (expuesta como agente_solicitar_confirmacion).
// No ejecuta nada: deja constancia formal de que el turno termina pidiendo confirmación humana.
// El servidor usa esa marca para resaltar el estado en el front y para habilitar `confirmado: true`
// únicamente en el siguiente mensaje del usuario (regla CA3 / RN4).
import { z } from "zod/v4"
import { defineTool, guard, ok } from "../core/tool"

export const solicitar_confirmacion = defineTool({
  description:
    "Registra que necesitas confirmación explícita del usuario antes de una acción externa o de registrar datos dudosos; llámala justo antes de terminar el turno con tu pregunta.",
  args: {
    accion: z.string().min(3).describe("Acción que quedará habilitada si el usuario confirma, p. ej. 'simular envío de ec-corp-andina'"),
    detalle: z.string().describe("Qué exactamente debe confirmar el usuario (valores, riesgos), en una o dos frases"),
  },
  async execute(args) {
    return guard(async () => ok({ registrada: true, accion: args.accion, detalle: args.detalle, resumen: `confirmación solicitada: ${args.accion}` }))
  },
})
