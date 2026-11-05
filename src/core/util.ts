// Utilidades sin dependencias: archivos, texto, fechas. Ninguna ejecuta comandos de shell.
import { readFile, writeFile, mkdir, appendFile, readdir, stat, copyFile } from "node:fs/promises"
import path from "node:path"
import { ToolError } from "./tool"

export async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8")
  } catch {
    return null
  }
}

/** Lee un JSON; si falta o está corrupto lanza ToolError con un mensaje legible. */
export async function readJson<T>(file: string, etiqueta: string): Promise<T> {
  const raw = await readText(file)
  if (raw === null) throw new ToolError(`no encontré ${etiqueta} (${rel(file)})`)
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new ToolError(`${etiqueta}: archivo corrupto, no es JSON válido (${rel(file)})`)
  }
}

export async function readJsonOrNull<T>(file: string): Promise<T | null> {
  const raw = await readText(file)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function writeText(file: string, content: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeText(file, JSON.stringify(value, null, 2) + "\n")
}

export async function appendLine(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, JSON.stringify(value) + "\n")
}

export async function copy(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true })
  await copyFile(from, to)
}

export async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }
}

export async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isFile()).map((e) => e.name).sort()
  } catch {
    return []
  }
}

let raizProyecto = process.cwd()
export function setRaiz(dir: string): void {
  raizProyecto = dir
}
/** Ruta relativa a la raíz del proyecto, para mensajes y salidas (nunca rutas absolutas hacia el usuario). */
export function rel(file: string): string {
  return path.relative(raizProyecto, file).split(path.sep).join("/")
}

/** Valida un identificador de carpeta (caso, mensaje) para impedir rutas tipo "../". */
export function safeId(id: string, etiqueta: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id) || id.includes("..")) {
    throw new ToolError(`${etiqueta} inválido: "${id}". Usa solo letras, números y guiones.`)
  }
  return id
}

export function sinTildes(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "")
}

export function normalizar(s: string): string {
  return sinTildes(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()
}

export function slug(s: string): string {
  return normalizar(s).replace(/ /g, "-")
}

/** Similitud de Sørensen–Dice sobre bigramas de caracteres, en [0, 1]. */
export function similitud(a: string, b: string): number {
  const x = normalizar(a).replace(/ /g, "")
  const y = normalizar(b).replace(/ /g, "")
  if (!x.length || !y.length) return 0
  if (x === y) return 1
  const bigramas = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const bx = bigramas(x)
  const by = bigramas(y)
  let inter = 0
  for (const [g, n] of bx) inter += Math.min(n, by.get(g) ?? 0)
  return (2 * inter) / (x.length - 1 + (y.length - 1))
}

/** Fecha de referencia YYYY-MM-DD: argumento explícito, o FECHA_REFERENCIA, o hoy en Colombia. */
export function fechaReferencia(explicita?: string): string {
  const f = explicita ?? process.env.FECHA_REFERENCIA
  if (f) {
    if (!esFechaISO(f)) throw new ToolError(`fecha inválida: "${f}". Usa el formato YYYY-MM-DD.`)
    return f
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date())
}

export function esFechaISO(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export function diasEntre(desde: string, hasta: string): number {
  const a = Date.parse(`${desde}T00:00:00Z`)
  const b = Date.parse(`${hasta}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}

export function ahora(): string {
  return new Date().toISOString()
}
