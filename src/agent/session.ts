// Sesiones en memoria, con copia en out/sessions/<id>.json para poder consultarlas por la API.
import path from "node:path"
import type { ChatMessage } from "../llm/adapter"
import { readJsonOrNull, writeJson } from "../core/util"

export type ToolCallRecord = {
  id: string
  nombre: string
  args: Record<string, unknown>
  ok: boolean
  resumen: string
  resultado: unknown
  ms: number
  bloqueadaPorConfirmacion?: boolean
}

export type Turno = {
  ts: string
  usuario: string
  respuesta: string
  toolCalls: ToolCallRecord[]
  needsConfirmation: boolean
  error?: string
}

export type Session = {
  id: string
  creada: string
  mensajes: ChatMessage[]
  turnos: Turno[]
  tokens: { input: number; output: number }
  /** Confirmación pendiente pedida en el turno anterior; solo el siguiente mensaje puede concederla. */
  pendiente: { accion: string; detalle: string } | null
}

const sesiones = new Map<string, Session>()

export function idValido(id: string): boolean {
  return /^[A-Za-z0-9_-]{6,64}$/.test(id)
}

function archivo(dir: string, id: string): string {
  return path.join(dir, "out", "sessions", `${id}.json`)
}

export async function obtenerSesion(dir: string, id: string): Promise<Session> {
  const enMemoria = sesiones.get(id)
  if (enMemoria) return enMemoria
  const enDisco = await readJsonOrNull<Session>(archivo(dir, id))
  const s: Session = enDisco ?? {
    id,
    creada: new Date().toISOString(),
    mensajes: [],
    turnos: [],
    tokens: { input: 0, output: 0 },
    pendiente: null,
  }
  sesiones.set(id, s)
  return s
}

export async function buscarSesion(dir: string, id: string): Promise<Session | null> {
  return sesiones.get(id) ?? (await readJsonOrNull<Session>(archivo(dir, id)))
}

export async function guardarSesion(dir: string, s: Session): Promise<void> {
  try {
    await writeJson(archivo(dir, s.id), s)
  } catch {
    // persistencia best-effort; la sesión sigue viva en memoria
  }
}
