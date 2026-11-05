// Implementación de LlmAdapter para APIs compatibles con OpenAI Chat Completions
// (OpenAI y otros proveedores que exponen ese formato; se configura con LLM_BASE_URL).
import {
  type ChatMessage,
  type EnviarOpciones,
  type LlmAdapter,
  type LlmResponse,
  type ToolSpec,
  LlmError,
  errorHttp,
  fetchConReintento,
} from "./adapter"

type ToolCallOpenAI = { id: string; type: "function"; function: { name: string; arguments: string } }

type MensajeOpenAI =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCallOpenAI[] }
  | { role: "tool"; tool_call_id: string; content: string }

export class OpenAICompatAdapter implements LlmAdapter {
  readonly provider: string

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {
    this.provider = baseUrl.includes("openai.com") ? "openai" : `openai-compatible (${new URL(baseUrl).host})`
  }

  async enviar(mensajes: ChatMessage[], herramientas: ToolSpec[], op: EnviarOpciones): Promise<LlmResponse> {
    const body = {
      model: this.model,
      max_tokens: op.maxTokens,
      messages: [{ role: "system", content: op.system } as MensajeOpenAI, ...convertir(mensajes)],
      tools: herramientas.map((h) => ({
        type: "function",
        function: { name: h.name, description: h.description, parameters: h.parameters },
      })),
    }
    const res = await fetchConReintento(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: op.signal,
    })
    if (!res.ok) throw await errorHttp("Proveedor OpenAI-compatible", res)
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCallOpenAI[] } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const msg = data.choices?.[0]?.message
    if (!msg) throw new LlmError("el proveedor devolvió una respuesta sin mensaje")
    const toolCalls = (msg.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      args: parseArgs(tc.function.arguments),
    }))
    return {
      text: msg.content ?? "",
      toolCalls,
      usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 },
    }
  }
}

function parseArgs(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s || "{}")
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function convertir(mensajes: ChatMessage[]): MensajeOpenAI[] {
  return mensajes.map((m): MensajeOpenAI => {
    if (m.role === "user") return { role: "user", content: m.content }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content }
    return {
      role: "assistant",
      content: m.content || null,
      ...(m.toolCalls.length
        ? {
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            })),
          }
        : {}),
    }
  })
}
