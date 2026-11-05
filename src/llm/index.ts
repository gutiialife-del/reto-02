// Fábrica del adaptador según variables de entorno. La clave solo se lee aquí y nunca se registra.
import type { LlmAdapter } from "./adapter"
import { AnthropicAdapter } from "./anthropic"
import { OpenAICompatAdapter } from "./openai"
import { SimuladoAdapter } from "./simulado"
import { guion } from "./guion"

export function crearAdapter(env: NodeJS.ProcessEnv = process.env): LlmAdapter {
  const provider = (env.LLM_PROVIDER ?? "anthropic").toLowerCase()
  if (provider === "simulado") return new SimuladoAdapter(guion)
  const key = env.LLM_API_KEY ?? ""
  if (!key) {
    throw new Error(
      "Falta LLM_API_KEY. Configúrala como variable de entorno del backend, o usa LLM_PROVIDER=simulado para probar sin modelo.",
    )
  }
  if (provider === "anthropic") {
    return new AnthropicAdapter(key, env.LLM_MODEL || "claude-sonnet-5-5", env.LLM_BASE_URL || undefined)
  }
  if (provider === "openai") {
    if (!env.LLM_MODEL) throw new Error("Con LLM_PROVIDER=openai debes definir LLM_MODEL.")
    return new OpenAICompatAdapter(key, env.LLM_MODEL, env.LLM_BASE_URL || undefined)
  }
  throw new Error(`LLM_PROVIDER desconocido: "${provider}". Usa anthropic, openai o simulado.`)
}
