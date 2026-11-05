// API HTTP + archivos estáticos del chat. Sin frameworks: node:http (corre igual con Bun o Node+tsx).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { APP, cargarSystemPrompt } from "./config"
import { registrarHerramientas } from "./core/registry"
import { setRaiz } from "./core/util"
import { crearAdapter } from "./llm"
import type { LlmAdapter } from "./llm/adapter"
import { ejecutarTurno, type Limites } from "./agent/loop"
import { buscarSesion, guardarSesion, idValido, obtenerSesion } from "./agent/session"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
setRaiz(ROOT)
const env = process.env
const entero = (v: string | undefined, def: number): number => (v && /^\d+$/.test(v) ? Number(v) : def)

const limites: Limites = {
  maxIteraciones: entero(env.MAX_ITERACIONES, 25),
  maxTokensSesion: entero(env.MAX_TOKENS_SESION, 500_000),
  maxTokensRespuesta: entero(env.MAX_TOKENS_RESPUESTA, 4096),
  timeoutMs: entero(env.LLM_TIMEOUT_MS, 60_000),
}
const MAX_MENSAJE = 4000
const ACCESS_KEY = env.ACCESS_KEY ?? ""

let llm: LlmAdapter | null = null
let errorLlm = ""
try {
  llm = crearAdapter(env)
} catch (err) {
  errorLlm = err instanceof Error ? err.message : String(err)
}
const tools = registrarHerramientas(APP.herramientas)
const ocupadas = new Set<string>()

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}

async function leerCuerpo(req: IncomingMessage, max = 32_000): Promise<unknown> {
  const partes: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const b = chunk as Buffer
    total += b.length
    if (total > max) throw new Error("cuerpo demasiado grande")
    partes.push(b)
  }
  return JSON.parse(Buffer.concat(partes).toString("utf8") || "{}")
}

/** Sirve un archivo dentro de `base`, rechazando cualquier intento de salir de esa carpeta. */
async function servirArchivo(res: ServerResponse, base: string, relativo: string, descarga = false): Promise<void> {
  const destino = path.resolve(base, "." + path.posix.normalize("/" + decodeURIComponent(relativo)))
  if (!destino.startsWith(base + path.sep) && destino !== base) return json(res, 403, { ok: false, error: "ruta no permitida" })
  if (destino.includes(`${path.sep}sessions${path.sep}`)) return json(res, 403, { ok: false, error: "ruta no permitida" })
  try {
    const contenido = await readFile(destino)
    const ext = path.extname(destino).toLowerCase()
    const headers: Record<string, string> = { "content-type": TIPOS[ext] ?? "application/octet-stream", "cache-control": "no-store" }
    if (descarga && [".xlsx", ".pdf"].includes(ext)) headers["content-disposition"] = `attachment; filename="${path.basename(destino)}"`
    res.writeHead(200, headers)
    res.end(contenido)
  } catch {
    json(res, 404, { ok: false, error: "no encontrado" })
  }
}

function autorizado(req: IncomingMessage, url: URL): boolean {
  if (!ACCESS_KEY) return true
  return req.headers["x-access-key"] === ACCESS_KEY || url.searchParams.get("key") === ACCESS_KEY
}

async function manejar(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")
  const ruta = url.pathname

  if (req.method === "GET" && ruta === "/api/health") {
    return json(res, 200, {
      ok: llm !== null,
      app: APP.nombre,
      provider: llm?.provider ?? null,
      model: llm?.model ?? null,
      herramientas: tools.map((t) => t.nombre),
      ejemplos: APP.ejemplos,
      requiereClaveAcceso: ACCESS_KEY !== "",
      ...(llm ? {} : { error: errorLlm }),
    })
  }
  if (ruta.startsWith("/api/") && !autorizado(req, url)) return json(res, 401, { ok: false, error: "clave de acceso inválida" })

  if (req.method === "POST" && ruta === "/api/chat") {
    let body: { sessionId?: unknown; message?: unknown }
    try {
      body = (await leerCuerpo(req)) as typeof body
    } catch {
      return json(res, 400, { ok: false, error: "cuerpo JSON inválido" })
    }
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : ""
    const message = typeof body.message === "string" ? body.message.trim() : ""
    if (!idValido(sessionId)) return json(res, 400, { ok: false, error: "sessionId inválido (6–64 caracteres: letras, números, - o _)" })
    if (!message) return json(res, 400, { ok: false, error: "el mensaje está vacío" })
    if (message.length > MAX_MENSAJE) return json(res, 400, { ok: false, error: `el mensaje supera ${MAX_MENSAJE} caracteres` })
    if (!llm) return json(res, 503, { ok: false, error: `el modelo no está configurado: ${errorLlm}` })
    if (ocupadas.has(sessionId)) return json(res, 409, { ok: false, error: "la sesión ya está procesando un mensaje" })
    ocupadas.add(sessionId)
    try {
      const sesion = await obtenerSesion(ROOT, sessionId)
      const system = await cargarSystemPrompt(ROOT)
      const turno = await ejecutarTurno(sesion, message, { llm, tools, system, directory: ROOT, limites })
      await guardarSesion(ROOT, sesion)
      return json(res, 200, {
        reply: turno.respuesta,
        toolCalls: turno.toolCalls,
        needsConfirmation: turno.needsConfirmation,
        confirmacion: sesion.pendiente,
        tokens: sesion.tokens,
        error: turno.error ?? null,
      })
    } catch (err) {
      return json(res, 500, { ok: false, error: `error inesperado del servidor: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      ocupadas.delete(sessionId)
    }
  }

  const m = ruta.match(/^\/api\/sessions\/([^/]+)$/)
  if (req.method === "GET" && m) {
    const id = m[1] ?? ""
    if (!idValido(id)) return json(res, 400, { ok: false, error: "sessionId inválido" })
    const s = await buscarSesion(ROOT, id)
    if (!s) return json(res, 404, { ok: false, error: "sesión no encontrada" })
    return json(res, 200, { id: s.id, creada: s.creada, tokens: s.tokens, pendiente: s.pendiente, turnos: s.turnos })
  }

  if (req.method === "GET" && ruta.startsWith("/out/")) {
    if (!autorizado(req, url)) return json(res, 401, { ok: false, error: "clave de acceso inválida" })
    return servirArchivo(res, path.join(ROOT, "out"), ruta.slice("/out/".length), url.searchParams.has("descargar"))
  }
  if (req.method === "GET") {
    return servirArchivo(res, path.join(ROOT, "web"), ruta === "/" ? "index.html" : ruta.slice(1))
  }
  json(res, 404, { ok: false, error: "ruta no encontrada" })
}

const PORT = entero(env.PORT, 3000)
createServer((req, res) => {
  manejar(req, res).catch(() => json(res, 500, { ok: false, error: "error inesperado del servidor" }))
}).listen(PORT, () => {
  const estado = llm ? `${llm.provider} / ${llm.model}` : `SIN MODELO (${errorLlm})`
  console.log(`${APP.nombre} escuchando en http://localhost:${PORT} · modelo: ${estado} · herramientas: ${tools.length}`)
})
