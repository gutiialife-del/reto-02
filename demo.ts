// demo.ts — procesa los 6 mensajes del buzón llamando directamente a las herramientas, SIN modelo.
// Uso: bun install && bun run demo.ts        (FECHA_REFERENCIA=YYYY-MM-DD para cambiar la fecha)
import path from "node:path"
import { rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { registrarHerramientas } from "./src/core/registry"
import { runTool } from "./src/core/run"
import { setRaiz } from "./src/core/util"
import { APP } from "./src/config"
import { extraerDeTexto, type Reglas } from "./src/lib/extraccion"
import { cargarReglas } from "./src/lib/dominio"
import { verificarModulo } from "./scripts/modulo"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
setRaiz(ROOT)
// Fecha fija por defecto (fecha del PRD): fecha de registro y alertas deterministas.
process.env.FECHA_REFERENCIA ||= "2026-09-03"
const HOY = process.env.FECHA_REFERENCIA
const tools = new Map(registrarHerramientas(APP.herramientas).map((t) => [t.nombre, t.tool]))

type Data = Record<string, unknown>
async function llamar(nombre: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: Data; error?: string }> {
  const tool = tools.get(nombre)
  if (!tool) throw new Error(`herramienta no registrada: ${nombre}`)
  const run = await runTool(nombre, tool, args, { directory: ROOT, sessionId: "demo" })
  return run.resultado.ok ? { ok: true, data: run.resultado.data as Data } : { ok: false, data: {}, error: run.resultado.error }
}
const linea = (s = "") => console.log(s)
const pendientes: Array<{ id: string; contrato: Data }> = []

async function procesar(m: Data): Promise<void> {
  const id = String(m.id)
  linea(`\n━━━ ${id} · ${String(m.asunto)}`)
  if (!m.tiene_contrato) {
    const reg = await llamar("contratos_registrar", { mensaje_id: id })
    linea(`  Clasificación: rechazado · Acción: ${reg.ok ? `ninguna (${String(reg.data.motivo)})` : reg.error}`)
    return
  }
  const ext = await llamar("contratos_extraer", { mensaje_id: id })
  if (!ext.ok) return linea(`  ✖ extracción: ${ext.error} → sigo con el siguiente mensaje`)
  const contrato = ext.data.contrato as Data
  linea(`  Extraído: ${String(ext.data.tipo_documento)} ${String(contrato.id_contrato)} · ${String(contrato.cliente)} · ${String(contrato.valor)} ${String(contrato.moneda)} · ${String(contrato.fecha_inicio)} → ${String(contrato.fecha_fin)}`)
  const val = await llamar("contratos_validar", { mensaje_id: id, contrato })
  if (!val.ok) return linea(`  ✖ validación: ${val.error}`)
  const rev = val.data.requiere_revision as string[]
  linea(`  Clasificación: ${String(val.data.clasificacion)}${val.data.id_contrato_existente ? ` (existente ${String(val.data.id_contrato_existente)})` : ""}`)
  linea(`  Campos en revisión: ${rev.length ? rev.join(", ") : "ninguno"}`)
  for (const a of val.data.advertencias as string[]) linea(`  ⚠ ${a}`)
  const reg = await llamar("contratos_registrar", { mensaje_id: id, contrato })
  if (reg.ok) linea(`  Acción: ${String(reg.data.resumen)}${reg.data.ruta_archivo ? ` → ${String(reg.data.ruta_archivo)}` : ""}`)
  else {
    linea(`  Acción: NO registrado → ${reg.error}`)
    pendientes.push({ id, contrato })
  }
}

async function erroresControlados(): Promise<void> {
  linea("\n━━━ Errores controlados (HU-6) ━━━")
  const reglas: Reglas = await cargarReglas(ROOT)
  const casos: Array<[string, string]> = [
    ["texto vacío", ""],
    ["fecha inválida", "CONTRATO No. CT-2026-099\n\nTERCERA. PLAZO. Desde el treinta (30) de febrero de 2026 hasta el uno (1) de marzo de 2027.\n"],
    ["moneda desconocida", "CONTRATO No. CT-2026-098\n\nSEGUNDA. VALOR. El valor es de MIL EUROS (EUR 1.000).\n"],
  ]
  for (const [nombre, texto] of casos) {
    try {
      extraerDeTexto(texto, reglas)
      linea(`  ${nombre}: (sin error)`)
    } catch (e) {
      linea(`  ${nombre} → { ok: false, error: "${(e as Error).message}" }`)
    }
  }
  const inexistente = await llamar("contratos_extraer", { mensaje_id: "msg-999" })
  linea(`  mensaje inexistente → ok=${inexistente.ok}: ${inexistente.error}`)
  const manipulado = await llamar("contratos_validar", { mensaje_id: "msg-001", contrato: { valor: 999 } })
  linea(`  valor alterado por el modelo → ok=${manipulado.ok}: ${manipulado.error}`)
}

async function main(): Promise<void> {
  await rm(path.join(ROOT, "out"), { recursive: true, force: true })
  linea(`Demo Reto 02 · Registro de contratos · fecha de referencia ${HOY} · sin modelo de lenguaje`)
  const buzon = await llamar("contratos_leer_buzon", {})
  if (!buzon.ok) return linea(`✖ ${buzon.error}`)
  linea(`Buzón: ${String(buzon.data.resumen)}`)
  for (const m of buzon.data.mensajes as Data[]) await procesar(m)

  linea("\n━━━ Segunda pasada: confirmación humana ━━━")
  for (const p of pendientes) {
    // Simula la respuesta del usuario: "confirmo el valor 0 y la fecha fin 2027-08-31".
    const confirmado = { ...p.contrato, valor: 0, fecha_fin: "2027-08-31" }
    linea(`  ${p.id}: el usuario confirma valor 0 y fecha_fin 2027-08-31`)
    const reg = await llamar("contratos_registrar", { mensaje_id: p.id, contrato: confirmado, confirmado: true })
    linea(`  → ${reg.ok ? `${String(reg.data.resumen)} → ${String(reg.data.ruta_archivo)}` : reg.error}`)
  }
  const resto = await llamar("contratos_leer_buzon", {})
  linea(`  Buzón después del lote: ${String(resto.data.resumen)}`)

  linea("\n━━━ Alertas ━━━")
  const al = await llamar("contratos_alertas", { hoy: HOY })
  if (al.ok) {
    linea(`  ${String(al.data.resumen)} → ${String(al.data.ruta)}`)
    for (const v of al.data.vencen as Data[]) linea(`  vence: ${String(v.id_contrato)} ${String(v.cliente)} el ${String(v.fecha_fin)} (${String(v.dias)} días)`)
    for (const p of al.data.polizas_pendientes as Data[]) linea(`  póliza ${String(p.estado_poliza)}: ${String(p.id_contrato)} ${String(p.cliente)} (${String(p.tipo_poliza)})`)
    for (const r of al.data.registrados_desde_corte as Data[]) linea(`  desde el corte: ${String(r.id_contrato)} (${String(r.accion)})`)
  } else linea(`  ✖ ${al.error}`)

  linea("\n━━━ Reproceso del mismo mensaje (idempotencia del maestro) ━━━")
  const otra = await llamar("contratos_validar", { mensaje_id: "msg-001" })
  linea(`  msg-001 otra vez → ${String(otra.data.clasificacion)} (no se duplica la fila)`)

  await erroresControlados()
  const mod = await verificarModulo(ROOT)
  linea(`\nMódulo reutilizable (modulo/) sincronizado con la app: ${mod.ok ? "sí" : `NO → ${mod.diferencias.join(", ")} (ejecuta bun run modulo)`}`)
  linea("Salidas: out/sharepoint/maestro-contratos.csv · out/sharepoint/historial.jsonl · out/procesados.json · out/alertas.md · out/log.jsonl\n")
}

main().catch((e: unknown) => {
  console.error("La demo falló:", e instanceof Error ? e.message : e)
  process.exitCode = 1
})
