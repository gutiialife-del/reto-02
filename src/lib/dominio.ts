// Lógica del registro de contratos: buzón, maestro (CSV), clasificación y registro.
import path from "node:path"
import { ToolError } from "../core/tool"
import { exists, listDirs, readJson, readJsonOrNull, readText, safeId, similitud, slug, normalizar, writeJson, writeText, copy } from "../core/util"
import { csvAObjetos, toCsv } from "./csv"
import { CAMPOS, type Campo, type DatosContrato, type Extraccion, type Reglas, extraerDeTexto, tipoDocumento } from "./extraccion"

export type Correo = { id: string; de: string; para: string; asunto: string; fecha: string; cuerpo: string; adjuntos: string[] }
export type Comercial = { email: string; nombre: string; region: string }
export type Fila = Record<string, string>
export type Clasificacion = "nuevo" | "actualizacion" | "duplicado" | "rechazado"
export type Procesado = { ts: string; clasificacion: Clasificacion; accion: string; id_contrato: string | null; motivo?: string }

export const ENCABEZADOS = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin",
  "requiere_poliza", "tipo_poliza", "estado_poliza", "comercial", "ruta_sharepoint", "fecha_registro", "fuente",
]

export const rutas = (dir: string) => {
  const base = path.join(dir, "fixtures", "reto-02")
  return {
    buzon: path.join(base, "buzon"),
    mensaje: (id: string) => path.join(base, "buzon", id),
    maestroFixture: path.join(base, "maestro-contratos.csv"),
    comerciales: path.join(base, "comerciales.json"),
    reglas: path.join(dir, "src", "knowledge", "reglas-contratos.json"),
    sharepoint: path.join(dir, "out", "sharepoint"),
    maestro: path.join(dir, "out", "sharepoint", "maestro-contratos.csv"),
    historial: path.join(dir, "out", "sharepoint", "historial.jsonl"),
    procesados: path.join(dir, "out", "procesados.json"),
    extracciones: path.join(dir, "out", "extracciones"),
    alertas: path.join(dir, "out", "alertas.md"),
  }
}

export async function cargarReglas(dir: string): Promise<Reglas> {
  return readJson<Reglas>(rutas(dir).reglas, "las reglas de negocio")
}

export async function leerCorreo(dir: string, id: string): Promise<Correo> {
  safeId(id, "mensaje_id")
  const archivo = path.join(rutas(dir).mensaje(id), "correo.json")
  if (!(await exists(archivo))) {
    const disponibles = await listDirs(rutas(dir).buzon)
    throw new ToolError(`el mensaje "${id}" no existe en el buzón. Mensajes: ${disponibles.join(", ")}`)
  }
  return readJson<Correo>(archivo, `el correo ${id}`)
}

export type Adjunto = { nombre: string; texto: string | null; tipo: "contrato" | "otrosi" | null }

export async function adjuntos(dir: string, correo: Correo): Promise<Adjunto[]> {
  const out: Adjunto[] = []
  for (const nombre of correo.adjuntos ?? []) {
    if (!/^[A-Za-z0-9._-]+$/.test(nombre)) continue
    const texto = await readText(path.join(rutas(dir).mensaje(correo.id), nombre))
    out.push({ nombre, texto, tipo: texto ? tipoDocumento(texto) : null })
  }
  return out
}

export function adjuntoContrato(lista: Adjunto[]): Adjunto | null {
  return lista.find((a) => a.tipo !== null) ?? null
}

export async function procesados(dir: string): Promise<Record<string, Procesado>> {
  return (await readJsonOrNull<Record<string, Procesado>>(rutas(dir).procesados)) ?? {}
}

export async function marcarProcesado(dir: string, id: string, p: Procesado): Promise<void> {
  const actuales = await procesados(dir)
  actuales[id] = p
  await writeJson(rutas(dir).procesados, actuales)
}

/** RN6: el fixture es de solo lectura; la primera escritura trabaja sobre una copia en out/sharepoint/. */
export async function asegurarMaestro(dir: string): Promise<void> {
  const r = rutas(dir)
  if (!(await exists(r.maestro))) await copy(r.maestroFixture, r.maestro)
}

export async function leerMaestro(dir: string): Promise<Fila[]> {
  const r = rutas(dir)
  const texto = (await readText(r.maestro)) ?? (await readText(r.maestroFixture))
  if (texto === null) throw new ToolError("no encontré el maestro de contratos")
  return csvAObjetos(texto).filas
}

export async function guardarMaestro(dir: string, filas: Fila[]): Promise<void> {
  await writeText(rutas(dir).maestro, toCsv(ENCABEZADOS, filas))
}

export async function extraerMensaje(dir: string, id: string): Promise<{ correo: Correo; adjunto: Adjunto; extraccion: Extraccion }> {
  const correo = await leerCorreo(dir, id)
  const lista = await adjuntos(dir, correo)
  const adj = adjuntoContrato(lista)
  if (!adj) {
    const nombres = lista.map((a) => a.nombre).join(", ") || "ninguno"
    throw new ToolError(`el mensaje ${id} no trae un contrato ni un otrosí (adjuntos: ${nombres})`)
  }
  const extraccion = extraerDeTexto(adj.texto ?? "", await cargarReglas(dir))
  await writeJson(path.join(rutas(dir).extracciones, `${id}.json`), extraccion)
  return { correo, adjunto: adj, extraccion }
}

/** Nombre del cliente sin sufijo societario, para la carpeta: "Industrias Delta S.A.S." → "industrias-delta". */
export function slugCliente(cliente: string): string {
  const sin = cliente.replace(/\s*(S\.?\s?A\.?\s?S\.?|S\.?\s?A\.?\s?C\.?|S\.?\s?A\.?|LTDA\.?|S\.\s?de\s?R\.?\s?L\.?)\s*$/i, "")
  return slug(sin)
}

function aTexto(v: unknown): string {
  if (v === null || v === undefined) return ""
  return typeof v === "boolean" ? (v ? "true" : "false") : String(v)
}

export type ItemRevision = { campo: string; valor: unknown; confianza: number | null; motivo: string }

export type Validacion = {
  mensaje_id: string
  clasificacion: Clasificacion
  motivo?: string
  tipo_documento: "contrato" | "otrosi" | null
  id_contrato_existente?: string
  requiere_revision: string[]
  detalle_revision: ItemRevision[]
  diferencias?: Array<{ campo: string; antes: string; despues: string }>
  comercial: { email: string; nombre: string | null; registrado: boolean }
  advertencias: string[]
  contrato: DatosContrato | null
  extraccion: Extraccion | null
}

/**
 * Clasifica un mensaje (RN1–RN5). `propuesto` es el contrato que envía el agente: solo puede diferir de la
 * extracción en campos de baja confianza o en conflicto, y esos cambios quedan en revisión humana.
 */
export async function validar(dir: string, id: string, propuesto: Partial<DatosContrato> | null): Promise<Validacion> {
  const reglas = await cargarReglas(dir)
  const correo = await leerCorreo(dir, id)
  const comerciales = await readJson<Comercial[]>(rutas(dir).comerciales, "comerciales.json")
  const com = comerciales.find((c) => c.email.toLowerCase() === correo.de.toLowerCase())
  const comercial = { email: correo.de, nombre: com?.nombre ?? null, registrado: !!com }
  const advertencias = com ? [] : [`remitente no registrado en comerciales.json: ${correo.de} (se reporta, no bloquea)`]
  const base = { mensaje_id: id, comercial, advertencias, requiere_revision: [] as string[], detalle_revision: [] as ItemRevision[] }

  const lista = await adjuntos(dir, correo)
  const adj = adjuntoContrato(lista)
  if (!adj) {
    const nombres = lista.map((a) => a.nombre).join(", ") || "sin adjuntos"
    return { ...base, clasificacion: "rechazado", motivo: `sin adjunto de contrato (adjuntos: ${nombres})`, tipo_documento: null, contrato: null, extraccion: null }
  }
  const extraccion = extraerDeTexto(adj.texto ?? "", reglas)
  const ext = extraccion.contrato
  if (!ext.cliente && !ext.id_contrato) {
    return { ...base, clasificacion: "rechazado", motivo: "el texto no permite identificar las partes ni el contrato", tipo_documento: extraccion.tipo_documento, contrato: null, extraccion }
  }
  if (extraccion.tipo_documento === "contrato" && !ext.objeto) {
    return { ...base, clasificacion: "rechazado", motivo: "el contrato no tiene un objeto identificable", tipo_documento: extraccion.tipo_documento, contrato: null, extraccion }
  }

  // Campos de baja confianza (en un otrosí solo cuentan los campos que el documento modifica).
  const revision: ItemRevision[] = []
  for (const c of CAMPOS) {
    if (c === "id_contrato") continue
    const valor = ext[c]
    const conf = extraccion.confianza[c]
    if (extraccion.tipo_documento === "otrosi" && valor === null) continue
    if (c === "tipo_poliza" && ext.requiere_poliza === false) continue
    if (conf < reglas.umbral_confianza) {
      revision.push({ campo: c, valor, confianza: conf, motivo: valor === null ? "no aparece en el documento" : `confianza ${conf} < ${reglas.umbral_confianza}` })
    }
  }

  // Cambios propuestos por el agente/usuario respecto de lo extraído.
  const final: DatosContrato = { ...ext }
  const enRevision = new Set(revision.map((r) => r.campo))
  for (const c of CAMPOS) {
    if (!propuesto || !(c in propuesto)) continue
    const p = propuesto[c]
    if (aTexto(p) === aTexto(ext[c])) continue
    if (!enRevision.has(c)) {
      throw new ToolError(`el campo "${c}" no está en revisión: su valor debe ser el extraído del documento (${aTexto(ext[c]) || "vacío"}), no "${aTexto(p)}"`)
    }
    ;(final as Record<string, unknown>)[c] = p
    const item = revision.find((r) => r.campo === c)
    if (item) item.motivo += `; valor propuesto en el chat: ${aTexto(p)}`
  }
  if (final.valor !== null && (typeof final.valor !== "number" || Number.isNaN(final.valor) || final.valor < 0)) {
    throw new ToolError(`valor inválido: ${aTexto(final.valor)} (debe ser un número ≥ 0)`)
  }
  if (final.moneda && !reglas.monedas.includes(final.moneda)) throw new ToolError(`moneda desconocida: ${final.moneda}`)

  // Comparación con el maestro.
  const maestro = await leerMaestro(dir)
  const porId = ext.id_contrato ? maestro.find((f) => f.id_contrato === ext.id_contrato) : undefined
  const porNitObjeto =
    !porId && ext.nit_cliente && ext.objeto
      ? maestro.find((f) => f.nit_cliente === ext.nit_cliente && similitud(f.objeto ?? "", ext.objeto ?? "") >= reglas.similitud_objeto_actualizacion)
      : undefined
  const existente = porId ?? porNitObjeto
  const diferencias = existente ? diferenciasConMaestro(existente, final, extraccion) : []

  let clasificacion: Clasificacion = "nuevo"
  if (existente) {
    const mismos = ["valor", "fecha_inicio", "fecha_fin"].every((c) => {
      const v = final[c as Campo]
      return v === null || aTexto(v) === (existente[c] ?? "")
    })
    clasificacion = extraccion.tipo_documento === "contrato" && porId && mismos ? "duplicado" : "actualizacion"
    if (clasificacion === "actualizacion" && !diferencias.length) clasificacion = "duplicado"
    // Conflictos de identidad: mismo número de contrato pero otra contraparte.
    if (porId && ext.nit_cliente && existente.nit_cliente && ext.nit_cliente !== existente.nit_cliente) {
      revision.push({ campo: "nit_cliente", valor: ext.nit_cliente, confianza: null, motivo: `conflicto con el maestro: ${existente.id_contrato} pertenece al NIT ${existente.nit_cliente}` })
    }
  }
  const resultado: Validacion = {
    ...base,
    clasificacion,
    tipo_documento: extraccion.tipo_documento,
    requiere_revision: clasificacion === "duplicado" ? [] : revision.map((r) => r.campo),
    detalle_revision: clasificacion === "duplicado" ? [] : revision,
    contrato: final,
    extraccion,
  }
  if (existente) {
    resultado.id_contrato_existente = existente.id_contrato ?? ""
    resultado.diferencias = diferencias
  }
  if (extraccion.notas.length) resultado.advertencias.push(...extraccion.notas)
  return resultado
}

function diferenciasConMaestro(fila: Fila, c: DatosContrato, e: Extraccion): Array<{ campo: string; antes: string; despues: string }> {
  const out: Array<{ campo: string; antes: string; despues: string }> = []
  for (const campo of CAMPOS) {
    const v = c[campo]
    if (v === null) continue
    if (campo === "cliente" && normalizar(aTexto(v)) === normalizar(fila.cliente ?? "")) continue
    if (campo === "objeto" && similitud(aTexto(v), fila.objeto ?? "") >= 0.9) continue
    if (aTexto(v) !== (fila[campo] ?? "")) out.push({ campo, antes: fila[campo] ?? "", despues: aTexto(v) })
  }
  if (e.polizas_por_ampliar && fila.requiere_poliza === "true" && fila.estado_poliza !== "pendiente") {
    out.push({ campo: "estado_poliza", antes: fila.estado_poliza ?? "", despues: "pendiente" })
  }
  return out
}

