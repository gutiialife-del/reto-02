// Extracción determinista (regex + heurísticas) de un contrato u otrosí en texto plano.
// Cada campo trae `confianza` en [0,1] y la `evidencia` (fragmento del texto) que lo sustenta.
// Un campo que no aparece en el texto es null con confianza 0: nunca se inventa.
import { ToolError } from "../core/tool"
import { esFechaISO, normalizar, sinTildes } from "../core/util"

export type Reglas = {
  umbral_confianza: number
  similitud_objeto_actualizacion: number
  dias_alerta_vencimiento: number
  fecha_corte_maestro: string
  monedas: string[]
  paises: string[]
  nombre_propio: string
  pais_por_nombre: Record<string, string>
  tipos_poliza: Record<string, string>
  confianza: Record<string, number>
}

export const CAMPOS = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
] as const
export type Campo = (typeof CAMPOS)[number]

export type DatosContrato = {
  id_contrato: string | null
  cliente: string | null
  nit_cliente: string | null
  pais: string | null
  objeto: string | null
  valor: number | null
  valor_indeterminado: boolean
  moneda: string | null
  fecha_inicio: string | null
  fecha_fin: string | null
  requiere_poliza: boolean | null
  tipo_poliza: string | null
}

export type Extraccion = {
  tipo_documento: "contrato" | "otrosi"
  numero_otrosi: number | null
  contrato: DatosContrato
  confianza: Record<Campo, number>
  evidencia: Partial<Record<Campo, string>>
  notas: string[]
  polizas_por_ampliar: boolean
}

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
}

export function tipoDocumento(texto: string): "contrato" | "otrosi" | null {
  const primera = sinTildes(texto.trim().split("\n")[0] ?? "").toUpperCase()
  if (/OTROSI/.test(primera)) return "otrosi"
  if (/\bCONTRATO\b/.test(primera)) return "contrato"
  return null
}

function iso(dia: number, mes: number, anio: number): string {
  const s = `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`
  if (!esFechaISO(s)) throw new ToolError(`fecha inválida en el documento: ${dia}/${mes}/${anio}`)
  return s
}

function sumarMesesMenosUnDia(desde: string, meses: number): string {
  const [a, m, d] = desde.split("-").map(Number) as [number, number, number]
  const fecha = new Date(Date.UTC(a, m - 1 + meses, d))
  fecha.setUTCDate(fecha.getUTCDate() - 1)
  return fecha.toISOString().slice(0, 10)
}

/** "265.000.000" → 265000000 · "120,000.00" → 120000 · "1.234,50" → 1234.5 */
export function parseMonto(s: string): number | null {
  const t = s.trim()
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) return Number(t.replace(/\./g, "").replace(",", "."))
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) return Number(t.replace(/,/g, ""))
  if (/^\d+([.,]\d{1,2})?$/.test(t)) return Number(t.replace(",", "."))
  return null
}

/** Texto de una cláusula con encabezado "SEGUNDA. VALOR." hasta el siguiente párrafo (nombre sin tildes). */
function clausula(texto: string, nombre: string): string | null {
  const plano = sinTildes(texto)
  const m = plano.match(new RegExp(`(?:^|\\n)\\s*[A-Z]+\\.\\s*${nombre}\\.\\s*([\\s\\S]+?)(?:\\n\\s*\\n|$)`))
  if (!m || m.index === undefined || m[1] === undefined) return null
  // Se recorta sobre el texto original (con tildes) usando las mismas posiciones (texto en NFC).
  const inicio = m.index + m[0].indexOf(m[1])
  return texto.slice(inicio, inicio + m[1].length).trim()
}

function fechasEn(fragmento: string): string[] {
  const out: string[] = []
  for (const m of sinTildes(fragmento).matchAll(/\((\d{1,2})\)\s+de\s+([a-z]+)\s+de\s+(\d{4})/gi)) {
    const mes = MESES[(m[2] ?? "").toLowerCase()]
    if (!mes) throw new ToolError(`fecha inválida en el documento: mes "${m[2]}" desconocido`)
    out.push(iso(Number(m[1]), mes, Number(m[3])))
  }
  return out
}

function titulo(s: string): string {
  return s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, p: string, l: string) => p + l.toUpperCase())
}

type Parte = { nombre: string; tipoId: string; id: string; posicion: number }

function partes(texto: string): Parte[] {
  const re = /(?:Entre\s+(?:los suscritos,\s*)?|\by\s+)([A-ZÁÉÍÓÚÑ][^,\n]{2,90}?),\s*(?:identificad[ao] con\s+)?(NIT|RUC|RTN)\s+([\d.\-]+\d)/g
  return [...texto.matchAll(re)].map((m) => ({ nombre: (m[1] ?? "").trim(), tipoId: m[2] ?? "", id: m[3] ?? "", posicion: m.index ?? 0 }))
}

/** Busca el nombre de la contraparte escrito en mayúsculas/minúsculas (bloque de firmas). */
function nombreEnFirmas(texto: string, nombreMayus: string): string | null {
  const escapado = nombreMayus.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")
  for (const m of texto.matchAll(new RegExp(escapado, "gi"))) {
    if (m[0] !== m[0].toUpperCase()) return m[0].replace(/\s+/g, " ")
  }
  return null
}

function limpiarId(tipo: string, id: string): string {
  const sinDv = tipo === "NIT" && /-\d$/.test(id) ? id.replace(/-\d$/, "") : id
  return sinDv.replace(/[.\-\s]/g, "")
}

function paisPorId(tipo: string, id: string): string | null {
  if (tipo === "NIT") return "CO"
  if (tipo === "RTN") return "HN"
  if (tipo === "RUC" && /^\d{13}$/.test(id) && id.endsWith("001")) return "EC"
  if (tipo === "RUC" && /^(10|20)\d{9}$/.test(id)) return "PE"
  return null
}

export function extraerDeTexto(textoOriginal: string, reglas: Reglas): Extraccion {
  const texto = (textoOriginal ?? "").normalize("NFC")
  if (!texto.trim()) throw new ToolError("el documento está vacío: no hay texto que extraer")
  const tipo = tipoDocumento(texto)
  if (!tipo) throw new ToolError("el adjunto no es un contrato ni un otrosí (no tiene encabezado de contrato)")
  const C = reglas.confianza
  const k = (n: string): number => C[n] ?? 0.5
  const conf = Object.fromEntries(CAMPOS.map((c) => [c, 0])) as Record<Campo, number>
  const ev: Partial<Record<Campo, string>> = {}
  const notas: string[] = []
  const d: DatosContrato = {
    id_contrato: null, cliente: null, nit_cliente: null, pais: null, objeto: null, valor: null, valor_indeterminado: false,
    moneda: null, fecha_inicio: null, fecha_fin: null, requiere_poliza: null, tipo_poliza: null,
  }
  const primera = texto.trim().split("\n")[0] ?? ""

  // Número del contrato (en un otrosí: el del contrato que modifica).
  const ids = [...texto.matchAll(/No\.\s*([A-Z]{2,4}-\d{4}-\d{1,4})/g)].map((m) => m[1] ?? "")
  const idDoc = tipo === "otrosi" ? (texto.match(/AL CONTRATO[^\n]*?No\.\s*([A-Z]{2,4}-\d{4}-\d{1,4})/i)?.[1] ?? ids[0]) : ids[0]
  if (idDoc) {
    d.id_contrato = idDoc
    conf.id_contrato = k("id_documento")
    ev.id_contrato = primera.trim()
  }
  const numeroOtrosi = tipo === "otrosi" ? Number(texto.match(/OTROS[IÍ]\s+No\.\s*(\d+)/i)?.[1] ?? "0") || null : null

  // Contraparte: la parte que no es Periferia.
  const contraparte = partes(texto).find((p) => !normalizar(p.nombre).includes(normalizar(reglas.nombre_propio)))
  if (contraparte) {
    const firmado = nombreEnFirmas(texto, contraparte.nombre)
    d.cliente = firmado ?? titulo(contraparte.nombre)
    conf.cliente = firmado ? k("parte_con_identificador") : k("nombre_sin_firma")
    ev.cliente = `${contraparte.nombre}, ${contraparte.tipoId} ${contraparte.id}`
    d.nit_cliente = limpiarId(contraparte.tipoId, contraparte.id)
    conf.nit_cliente = k("parte_con_identificador")
    ev.nit_cliente = `${contraparte.tipoId} ${contraparte.id}`
    const tramo = texto.slice(contraparte.posicion, contraparte.posicion + 260)
    const dom = sinTildes(tramo).match(/domicilio en ([^,\n]+)(?:,\s*([A-Za-z .]+?))?(?:,|\s+representad)/i)
    const candidatos = [dom?.[2], dom?.[1]].filter((x): x is string => !!x).map((x) => normalizar(x))
    const porNombre = candidatos
      .map((c) => Object.entries(reglas.pais_por_nombre).find(([nombre]) => c === nombre || c.startsWith(`${nombre} `))?.[1])
      .find(Boolean)
    const porId = paisPorId(contraparte.tipoId, d.nit_cliente)
    if (porNombre && (!porId || porId === porNombre)) {
      d.pais = porNombre
      conf.pais = k("pais_por_domicilio")
      ev.pais = dom?.[0] ?? ""
    } else if (porId) {
      d.pais = porId
      conf.pais = porNombre ? 0.6 : k("pais_por_identificador")
      ev.pais = `${contraparte.tipoId} ${contraparte.id}`
      if (porNombre) notas.push(`el domicilio sugiere ${porNombre} pero el identificador sugiere ${porId}`)
    }
  }

  // Objeto (no aplica a un otrosí, que no lo modifica).
  const objeto = tipo === "contrato" ? clausula(texto, "OBJETO") : null
  if (objeto) {
    let o = objeto.replace(/\s+/g, " ").replace(/^EL CONTRATISTA\s+(se obliga a\s+)?/i, "")
    o = o.charAt(0).toUpperCase() + o.slice(1)
    d.objeto = o.length > 200 ? o.slice(0, 199).trimEnd() + "…" : o
    conf.objeto = o.length > 200 ? k("objeto_truncado") : k("objeto")
    ev.objeto = objeto.slice(0, 160)
    if (o.length > 200) notas.push("objeto truncado a 200 caracteres")
  }

  // Valor y moneda.
  const fuenteValor = tipo === "contrato" ? (clausula(texto, "VALOR") ?? texto) : texto
  const monto = fuenteValor.match(/\(([A-Z]{3})\s*\$?\s*([\d.,]+\d)\)/)
  if (monto) {
    const codigo = monto[1] ?? ""
    if (!reglas.monedas.includes(codigo)) throw new ToolError(`moneda desconocida en el documento: "${codigo}". Monedas válidas: ${reglas.monedas.join(", ")}`)
    const v = parseMonto(monto[2] ?? "")
    if (v === null) throw new ToolError(`no pude interpretar el monto "${monto[2]}" del documento`)
    d.valor = v
    d.moneda = codigo
    conf.valor = k("valor_con_moneda")
    conf.moneda = k("valor_con_moneda")
    ev.valor = monto[0]
    ev.moneda = monto[0]
  } else if (/no tiene (un )?valor determinado|valor indeterminado|por demanda|seg[uú]n (las )?[oó]rdenes de servicio/i.test(fuenteValor)) {
    d.valor = 0
    d.valor_indeterminado = true
    conf.valor = k("valor_indeterminado")
    ev.valor = fuenteValor.slice(0, 160)
    notas.push("contrato de valor indeterminado (por demanda): se registra valor 0 si se confirma")
    if (/pesos|COP/i.test(texto)) {
      d.moneda = "COP"
      conf.moneda = 0.8
      ev.moneda = "montos de referencia del contrato expresados en pesos (COP)"
    }
  }

  // Fechas.
  if (tipo === "otrosi") {
    const ext = texto.match(/(?:se extiende|se prorroga|se ampl[ií]a)[^\n"]*?hasta el ([^".\n]+)/i)
    const f = ext ? fechasEn(ext[0]) : []
    if (f[0]) {
      d.fecha_fin = f[0]
      conf.fecha_fin = k("fecha_explicita")
      ev.fecha_fin = ext?.[0] ?? ""
    }
  } else {
    const plazo = clausula(texto, "PLAZO") ?? ""
    const fechas = fechasEn(plazo)
    const meses = Number(plazo.match(/\((\d{1,3})\)\s+meses/i)?.[1] ?? "0")
    if (fechas[0]) {
      d.fecha_inicio = fechas[0]
      conf.fecha_inicio = k("fecha_explicita")
      ev.fecha_inicio = plazo.slice(0, 160)
    } else if (/fecha de (su )?firma|suscripci[oó]n/i.test(plazo)) {
      const exacta = texto.match(/a los [^(]*\((\d{1,2})\)\s+d[ií]as del mes de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i)
      const soloMes = texto.match(/en el mes de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i)
      if (exacta) {
        d.fecha_inicio = iso(Number(exacta[1]), MESES[sinTildes(exacta[2] ?? "").toLowerCase()] ?? 0, Number(exacta[3]))
        conf.fecha_inicio = k("fecha_firma_exacta")
        ev.fecha_inicio = exacta[0]
      } else if (soloMes) {
        d.fecha_inicio = iso(1, MESES[sinTildes(soloMes[1] ?? "").toLowerCase()] ?? 0, Number(soloMes[2]))
        conf.fecha_inicio = k("fecha_solo_mes")
        ev.fecha_inicio = soloMes[0]
        notas.push("la fecha de firma solo indica mes y año: se asume el día 1 como inicio")
      }
    }
    if (fechas[1]) {
      d.fecha_fin = fechas[1]
      conf.fecha_fin = k("fecha_explicita")
      ev.fecha_fin = plazo.slice(0, 160)
    } else if (meses > 0 && d.fecha_inicio) {
      d.fecha_fin = sumarMesesMenosUnDia(d.fecha_inicio, meses)
      const prorroga = /prorrogable[s]? autom[aá]ticamente|pr[oó]rroga autom[aá]tica/i.test(plazo)
      conf.fecha_fin = Math.min(conf.fecha_inicio, prorroga ? k("fecha_con_prorroga_automatica") : k("fecha_derivada_plazo"))
      ev.fecha_fin = plazo.slice(0, 160)
      notas.push(`fecha_fin derivada: inicio + ${meses} meses${prorroga ? "; el contrato tiene prórroga automática, la fecha fin real puede ser posterior" : ""}`)
    }
  }

  // Pólizas.
  const textoSin = sinTildes(texto).toLowerCase()
  if (tipo === "otrosi") {
    if (/garant[ií]as?|p[oó]liza/.test(textoSin) && /deberan ampliarse|ampliar(se)? en vigencia/.test(textoSin)) {
      notas.push("el otrosí exige ampliar la vigencia de las pólizas existentes al nuevo plazo")
      return { tipo_documento: tipo, numero_otrosi: numeroOtrosi, contrato: d, confianza: conf, evidencia: ev, notas, polizas_por_ampliar: true }
    }
  } else {
    const garantias = clausula(texto, "GARANTIAS") ?? (/(poliza)/.test(textoSin) ? texto : null)
    if (garantias && /p[oó]liza/i.test(garantias)) {
      const g = sinTildes(garantias).toLowerCase()
      const tipos = Object.entries(reglas.tipos_poliza).filter(([frase]) => g.includes(frase)).map(([, codigo]) => codigo)
      d.requiere_poliza = true
      d.tipo_poliza = tipos.length ? tipos.join(";") : null
      const condicional = /para cada orden|cuyo valor supere|en caso de que/.test(g)
      conf.requiere_poliza = condicional ? k("poliza_condicional") : k("poliza_explicita")
      conf.tipo_poliza = tipos.length ? conf.requiere_poliza : 0
      ev.requiere_poliza = garantias.slice(0, 160)
      ev.tipo_poliza = ev.requiere_poliza
      if (condicional) notas.push("la póliza es condicional (aplica solo a ciertas órdenes de servicio)")
    } else {
      d.requiere_poliza = false
      d.tipo_poliza = ""
      conf.requiere_poliza = k("sin_poliza")
      conf.tipo_poliza = k("sin_poliza")
      ev.requiere_poliza = "el documento no menciona garantías ni pólizas"
    }
  }
  return { tipo_documento: tipo, numero_otrosi: numeroOtrosi, contrato: d, confianza: conf, evidencia: ev, notas, polizas_por_ampliar: false }
}
