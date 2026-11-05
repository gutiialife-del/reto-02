// Proveedor SIMULADO: NO es un modelo de lenguaje. Sigue un guion fijo (src/llm/guion.ts) para
// probar el ciclo, la confirmación y el front sin clave de API. Se activa con LLM_PROVIDER=simulado
// y /api/health lo reporta como "simulado" para que nadie lo confunda con un modelo real.
import type { ChatMessage, EnviarOpciones, LlmAdapter, LlmResponse, ToolCall, ToolSpec } from "./adapter"

export type PasoGuion = { text: string; toolCalls: ToolCall[] }

/** Vista del turno actual que recibe el guion: último mensaje del usuario y resultados ya obtenidos. */
export type EstadoTurno = {
  usuario: string
  resultados: Array<{ name: string; args: Record<string, unknown>; data: unknown; ok: boolean }>
  historial: ChatMessage[]
}

export type Guion = (estado: EstadoTurno) => PasoGuion

export class SimuladoAdapter implements LlmAdapter {
  readonly provider = "simulado"
  readonly model = "guion-determinista (sin LLM)"
  private n = 0

  constructor(private readonly guion: Guion) {}

  async enviar(mensajes: ChatMessage[], _h: ToolSpec[], _op: EnviarOpciones): Promise<LlmResponse> {
    const estado = estadoTurno(mensajes)
    const paso = this.guion(estado)
    const toolCalls = paso.toolCalls.map((tc) => ({ ...tc, id: tc.id || `sim-${++this.n}` }))
    return { text: paso.text, toolCalls, usage: { input: 0, output: 0 } }
  }
}

function estadoTurno(mensajes: ChatMessage[]): EstadoTurno {
  let i = mensajes.length - 1
  while (i >= 0 && mensajes[i]?.role !== "user") i--
  const usuarioMsg = mensajes[i]
  // Se quita la nota que el ciclo agrega al mensaje (el guion solo debe ver lo que escribió el usuario).
  const usuario = usuarioMsg && usuarioMsg.role === "user" ? usuarioMsg.content.replace(/\n\n\[nota del sistema:[\s\S]*\]$/, "") : ""
  const llamadas = new Map<string, ToolCall>()
  const resultados: EstadoTurno["resultados"] = []
  for (const m of mensajes.slice(i + 1)) {
    if (m.role === "assistant") for (const tc of m.toolCalls) llamadas.set(tc.id, tc)
    if (m.role === "tool") {
      const tc = llamadas.get(m.toolCallId)
      let parsed: { ok?: boolean; data?: unknown } = {}
      try {
        parsed = JSON.parse(m.content) as { ok?: boolean; data?: unknown }
      } catch {
        parsed = { ok: false }
      }
      resultados.push({ name: m.name, args: tc?.args ?? {}, data: parsed.data, ok: parsed.ok === true })
    }
  }
  return { usuario, resultados, historial: mensajes }
}
