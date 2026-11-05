// Ciclo del agente: prompt → modelo → herramientas → modelo … → respuesta.
// Reglas: tope de iteraciones (CA1), compuerta de confirmación humana (CA3/RN4),
// registro de cada llamada (CA4) y errores en lenguaje claro sin matar la sesión (CA5).
import type { LlmAdapter, ToolSpec } from "../llm/adapter"
import type { RegisteredTool } from "../core/registry"
import { runTool } from "../core/run"
import { normalizar } from "../core/util"
import type { Session, ToolCallRecord, Turno } from "./session"

export type Limites = {
  maxIteraciones: number
  maxTokensSesion: number
  maxTokensRespuesta: number
  timeoutMs: number
}

export type AgentDeps = {
  llm: LlmAdapter
  tools: RegisteredTool[]
  system: string
  directory: string
  limites: Limites
}

const HERRAMIENTA_CONFIRMACION = "agente_solicitar_confirmacion"

export function esNegativo(texto: string): boolean {
  const t = normalizar(texto)
  return /^(no\b|nop|nunca|cancel)/.test(t) || /\b(no confirmo|cancela|cancelar|todavia no|aun no|espera|detente)\b/.test(t)
}

export function esAfirmativo(texto: string): boolean {
  if (esNegativo(texto)) return false
  const t = normalizar(texto)
  return /\b(si|confirmo|confirmado|confirmar|ok|okay|dale|procede|proceder|adelante|envia|enviar|envialo|crea|creala|crear|registra|registrar|registralo|apruebo|autorizo|de acuerdo|hazlo|listo|correcto)\b/.test(t)
}

/** Fallback: una pregunta de confirmación escrita por el modelo aunque no haya usado la herramienta. */
function preguntaConfirmacion(texto: string): boolean {
  const preguntas = texto.match(/¿[^?]{3,300}\?/g) ?? []
  return preguntas.some((p) => /(confirm|autoriz|proced|deseas que|quieres que|apruebas|envi|registr|cre[ae])/i.test(p))
}

export async function ejecutarTurno(s: Session, mensaje: string, deps: AgentDeps): Promise<Turno> {
  const turno: Turno = { ts: new Date().toISOString(), usuario: mensaje, respuesta: "", toolCalls: [], needsConfirmation: false }
  const pendienteAnterior = s.pendiente
  const concedida = pendienteAnterior !== null && esAfirmativo(mensaje)
  s.pendiente = null

  let nota = ""
  if (pendienteAnterior && concedida) {
    nota = `\n\n[nota del sistema: el usuario CONFIRMÓ la acción pendiente "${pendienteAnterior.accion}". En este turno puedes usar confirmado=true solo para esa acción.]`
  } else if (pendienteAnterior) {
    nota = `\n\n[nota del sistema: había una confirmación pendiente ("${pendienteAnterior.accion}") y el usuario NO la confirmó. No uses confirmado=true.]`
  }
  s.mensajes.push({ role: "user", content: mensaje + nota })

  const specs: ToolSpec[] = deps.tools.map((t) => ({ name: t.nombre, description: t.tool.description, parameters: t.parameters }))
  let pendiente: Session["pendiente"] = null
  let terminado = false

  for (let i = 0; i < deps.limites.maxIteraciones && !terminado; i++) {
    const usados = s.tokens.input + s.tokens.output
    if (usados >= deps.limites.maxTokensSesion) {
      turno.error = "tope de tokens de la sesión alcanzado"
      turno.respuesta = `Esta sesión alcanzó su tope de ${deps.limites.maxTokensSesion.toLocaleString("es-CO")} tokens. Abre una sesión nueva para continuar.`
      terminado = true
      break
    }
    const respuesta = await llamarModelo(s, specs, deps)
    if ("error" in respuesta) {
      turno.error = respuesta.error
      turno.respuesta = `No pude obtener respuesta del modelo: ${respuesta.error}. La sesión sigue activa; puedes reintentar el mensaje.`
      terminado = true
      break
    }
    s.tokens.input += respuesta.usage.input
    s.tokens.output += respuesta.usage.output
    s.mensajes.push({ role: "assistant", content: respuesta.text, toolCalls: respuesta.toolCalls })

    if (!respuesta.toolCalls.length) {
      turno.respuesta = respuesta.text
      terminado = true
      break
    }
    for (const tc of respuesta.toolCalls) {
      const registro = await ejecutarLlamada(tc.id, tc.name, tc.args, concedida, s, deps)
      turno.toolCalls.push(registro)
      const content = registro.ok
        ? JSON.stringify({ ok: true, data: registro.resultado })
        : JSON.stringify({ ok: false, error: typeof registro.resultado === "string" ? registro.resultado : registro.resumen.replace(/^error: /, "") })
      s.mensajes.push({ role: "tool", toolCallId: tc.id, name: tc.name, content })
      pendiente = senalDeConfirmacion(registro) ?? pendiente
    }
  }

  if (!terminado) {
    turno.respuesta = resumenPorTope(turno.toolCalls, deps.limites.maxIteraciones)
  }
  // Solo una confirmación formal (herramienta o acción bloqueada) habilita confirmado=true en el
  // siguiente turno. Una pregunta escrita sin esa marca se resalta en el front, pero no habilita nada.
  s.pendiente = pendiente
  turno.needsConfirmation = pendiente !== null || (!turno.error && preguntaConfirmacion(turno.respuesta))
  s.turnos.push(turno)
  return turno
}

async function llamarModelo(
  s: Session,
  specs: ToolSpec[],
  deps: AgentDeps,
): Promise<Awaited<ReturnType<AgentDeps["llm"]["enviar"]>> | { error: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), deps.limites.timeoutMs)
  try {
    return await deps.llm.enviar(s.mensajes, specs, {
      system: deps.system,
      signal: ctrl.signal,
      maxTokens: deps.limites.maxTokensRespuesta,
    })
  } catch (err) {
    if (ctrl.signal.aborted) return { error: `el proveedor no respondió en ${Math.round(deps.limites.timeoutMs / 1000)} s (timeout)` }
    return { error: err instanceof Error ? err.message : "error desconocido del proveedor" }
  } finally {
    clearTimeout(timer)
  }
}

async function ejecutarLlamada(
  id: string,
  nombre: string,
  args: Record<string, unknown>,
  concedida: boolean,
  s: Session,
  deps: AgentDeps,
): Promise<ToolCallRecord> {
  const registrada = deps.tools.find((t) => t.nombre === nombre)
  if (!registrada) {
    return { id, nombre, args, ok: false, resumen: `error: la herramienta "${nombre}" no existe`, resultado: null, ms: 0 }
  }
  if (args.confirmado === true && !concedida) {
    return {
      id,
      nombre,
      args,
      ok: false,
      resumen:
        "error: requiere confirmación explícita del usuario en el turno inmediatamente anterior. Pide confirmación con agente_solicitar_confirmacion y termina el turno.",
      resultado: null,
      ms: 0,
      bloqueadaPorConfirmacion: true,
    }
  }
  const run = await runTool(nombre, registrada.tool, args, { directory: deps.directory, sessionId: s.id })
  return {
    id,
    nombre,
    args,
    ok: run.resultado.ok,
    resumen: run.resumen,
    resultado: run.resultado.ok ? run.resultado.data : run.resultado.error,
    ms: run.ms,
  }
}

/** Una llamada que quedó esperando decisión humana deja la sesión en "confirmación pendiente". */
function senalDeConfirmacion(r: ToolCallRecord): Session["pendiente"] {
  if (r.nombre === HERRAMIENTA_CONFIRMACION && r.ok) {
    const accion = typeof r.args.accion === "string" ? r.args.accion : "acción pendiente"
    const detalle = typeof r.args.detalle === "string" ? r.args.detalle : ""
    return { accion, detalle }
  }
  // Una herramienta puede declarar que su resultado exige una decisión humana (p. ej. campos en revisión).
  const data = r.ok && r.resultado && typeof r.resultado === "object" ? (r.resultado as Record<string, unknown>) : null
  const p = data?.pendiente_confirmacion as { accion?: unknown; detalle?: unknown } | undefined
  if (p && typeof p.accion === "string") return { accion: p.accion, detalle: typeof p.detalle === "string" ? p.detalle : "" }
  if (r.bloqueadaPorConfirmacion) return { accion: r.nombre, detalle: "acción bloqueada a la espera de confirmación" }
  if (!r.ok && /requiere (confirmaci[oó]n|revisi[oó]n)/i.test(r.resumen)) {
    return { accion: r.nombre, detalle: r.resumen.replace(/^error: /, "") }
  }
  return null
}

function resumenPorTope(calls: ToolCallRecord[], tope: number): string {
  const okN = calls.filter((c) => c.ok).length
  const lineas = calls.slice(-8).map((c) => `- ${c.ok ? "✔" : "✖"} \`${c.nombre}\`: ${c.resumen}`)
  return [
    `Llegué al tope de ${tope} iteraciones de este turno, así que me detengo aquí.`,
    `**Lo que tengo:** ${okN} de ${calls.length} llamadas a herramientas exitosas. Últimas:`,
    ...lineas,
    `**Lo que falta:** terminar los pasos restantes. Escribe "continúa" y sigo desde este punto.`,
  ].join("\n")
}
