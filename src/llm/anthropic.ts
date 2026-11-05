// Implementación de LlmAdapter para la API Messages de Anthropic (fetch directo, sin SDK).
import {
  type ChatMessage,
  type EnviarOpciones,
  type LlmAdapter,
  type LlmResponse,
  type ToolSpec,
  errorHttp,
  fetchConReintento,
} from "./adapter"

type Bloque =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string }

type MensajeAnthropic = { role: "user" | "assistant"; content: Bloque[] }

export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic"

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl = "https://api.anthropic.com",
  ) {}

  async enviar(mensajes: ChatMessage[], herramientas: ToolSpec[], op: EnviarOpciones): Promise<LlmResponse> {
    const body = {
      model: this.model,
      max_tokens: op.maxTokens,
      system: op.system,
      messages: convertir(mensajes),
      tools: herramientas.map((h) => ({ name: h.name, description: h.description, input_schema: h.parameters })),
    }
    const res = await fetchConReintento(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: op.signal,
    })
    if (!res.ok) throw await errorHttp("Anthropic", res)
    const data = (await res.json()) as {
      content: Bloque[]
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    const text = data.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
    const toolCalls = data.content
      .filter((b): b is Extract<Bloque, { type: "tool_use" }> => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }))
    return {
      text,
      toolCalls,
      usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 },
    }
  }
}

/** Formato interno → Anthropic. Resultados de herramientas consecutivos van en un solo mensaje "user". */
function convertir(mensajes: ChatMessage[]): MensajeAnthropic[] {
  const out: MensajeAnthropic[] = []
  for (const m of mensajes) {
    if (m.role === "user") {
      const bloque: Bloque = { type: "text", text: m.content || "(vacío)" }
      const ultimo = out[out.length - 1]
      // Anthropic exige alternar roles: si el turno anterior quedó en resultados de herramientas
      // (p. ej. por tope de iteraciones), el nuevo texto se agrega al mismo mensaje "user".
      if (ultimo && ultimo.role === "user") ultimo.content.push(bloque)
      else out.push({ role: "user", content: [bloque] })
    } else if (m.role === "assistant") {
      const content: Bloque[] = []
      if (m.content) content.push({ type: "text", text: m.content })
      for (const tc of m.toolCalls) content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args })
      if (!content.length) content.push({ type: "text", text: "(sin texto)" })
      out.push({ role: "assistant", content })
    } else {
      const bloque: Bloque = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content }
      const ultimo = out[out.length - 1]
      if (ultimo && ultimo.role === "user" && ultimo.content.every((b) => b.type === "tool_result")) {
        ultimo.content.push(bloque)
      } else {
        out.push({ role: "user", content: [bloque] })
      }
    }
  }
  return out
}
