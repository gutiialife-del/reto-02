// Interfaz propia del proveedor de modelo. El ciclo del agente solo conoce estos tipos:
// cambiar de proveedor = escribir otra implementación de LlmAdapter, sin tocar el ciclo.

export type ToolCall = { id: string; name: string; args: Record<string, unknown> }

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string }

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> }

export type LlmResponse = {
  text: string
  toolCalls: ToolCall[]
  usage: { input: number; output: number }
}

export type EnviarOpciones = { system: string; signal: AbortSignal; maxTokens: number }

export interface LlmAdapter {
  readonly provider: string
  readonly model: string
  enviar(mensajes: ChatMessage[], herramientas: ToolSpec[], opciones: EnviarOpciones): Promise<LlmResponse>
}

/** Error del proveedor con un mensaje apto para mostrar en el chat (nunca incluye la clave). */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/** Convierte una respuesta HTTP fallida en un mensaje claro. */
export async function errorHttp(proveedor: string, res: Response): Promise<LlmError> {
  let detalle = ""
  try {
    const body: unknown = await res.json()
    const err = (body as { error?: { message?: unknown } }).error
    if (err && typeof err.message === "string") detalle = err.message.slice(0, 200)
  } catch {
    // cuerpo no JSON: se ignora
  }
  const causas: Record<number, string> = {
    400: "solicitud rechazada por el proveedor",
    401: "clave de API inválida o ausente",
    403: "la clave no tiene permiso para este modelo",
    404: "modelo o endpoint no encontrado (revisa LLM_MODEL / LLM_BASE_URL)",
    429: "límite de uso del proveedor alcanzado; intenta en un momento",
    500: "error interno del proveedor",
    529: "proveedor sobrecargado; intenta en un momento",
  }
  const causa = causas[res.status] ?? `respuesta HTTP ${res.status}`
  return new LlmError(`${proveedor}: ${causa}${detalle ? ` (${detalle})` : ""}`, res.status)
}

/** fetch con un reintento para 429/5xx. */
export async function fetchConReintento(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init)
  if (res.status !== 429 && res.status < 500) return res
  await new Promise((r) => setTimeout(r, 1500))
  return fetch(url, init)
}
