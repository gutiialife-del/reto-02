// Guion del proveedor SIMULADO (no es un LLM). Reproduce el flujo del prompt de ejemplo para probar
// el ciclo, la compuerta de confirmación y el front sin clave de API.
import type { ChatMessage } from "./adapter"
import type { EstadoTurno, Guion, PasoGuion } from "./simulado"

type Data = Record<string, unknown>
const llamar = (name: string, args: Record<string, unknown>): PasoGuion => ({ text: "", toolCalls: [{ id: "", name, args }] })
const decir = (text: string): PasoGuion => ({ text: text + "\n\n_Respuesta del proveedor simulado (guion de pruebas, sin LLM)._", toolCalls: [] })

function resultado(e: EstadoTurno, name: string, msg?: string): { ok: boolean; data: Data } | null {
  const r = e.resultados.find((x) => x.name === name && (msg === undefined || x.args.mensaje_id === msg))
  return r ? { ok: r.ok, data: (r.data ?? {}) as Data } : null
}

/** Última validación con campos en revisión que quedó en el historial de la sesión. */
function pendienteEnHistorial(h: ChatMessage[]): { mensaje_id: string; contrato: Data } | null {
  for (let i = h.length - 1; i >= 0; i--) {
    const m = h[i]
    if (m?.role !== "tool" || m.name !== "contratos_validar") continue
    try {
      const d = (JSON.parse(m.content) as { data?: Data }).data
      if (d && Array.isArray(d.requiere_revision) && d.requiere_revision.length) return { mensaje_id: String(d.mensaje_id), contrato: (d.contrato ?? {}) as Data }
    } catch {
      // contenido no JSON: se ignora
    }
  }
  return null
}

export const guion: Guion = (e) => {
  const t = e.usuario.toLowerCase()
  const hoy = e.usuario.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "2026-09-03"

  if (/confirmo/.test(t)) {
    const p = pendienteEnHistorial(e.historial)
    if (!p) return decir("No tengo nada pendiente de confirmar.")
    const reg = resultado(e, "contratos_registrar", p.mensaje_id)
    if (!reg) {
      const valor = t.match(/valor\s+(\d+)/)?.[1]
      const fin = t.match(/fecha fin\s+(\d{4}-\d{2}-\d{2})/)?.[1]
      const contrato = { ...p.contrato, ...(valor !== undefined ? { valor: Number(valor) } : {}), ...(fin ? { fecha_fin: fin } : {}) }
      return llamar("contratos_registrar", { mensaje_id: p.mensaje_id, contrato, confirmado: true })
    }
    if (!resultado(e, "contratos_alertas")) return llamar("contratos_alertas", { hoy })
    return decir(reg.ok ? `Registrado: **${String(reg.data.id_contrato)}** (${String(reg.data.accion)}). Archivo: \`${String(reg.data.ruta_archivo)}\`. Alertas actualizadas en \`out/alertas.md\`.` : `No se registró: ${JSON.stringify(reg.data)}`)
  }

  if (/alerta/.test(t) && !/buz[oó]n/.test(t)) {
    const a = resultado(e, "contratos_alertas")
    if (!a) return llamar("contratos_alertas", { hoy })
    return decir(`Reporte en \`${String(a.data.ruta)}\`: ${String(a.data.resumen)}`)
  }

  const buzon = resultado(e, "contratos_leer_buzon")
  if (!buzon) return llamar("contratos_leer_buzon", {})
  if (!/procesa/.test(t)) return decir(`Pendientes: ${String(buzon.data.resumen)}`)

  const filas: string[] = []
  const revisiones: string[] = []
  for (const m of (buzon.data.mensajes as Data[]) ?? []) {
    const id = String(m.id)
    if (!m.tiene_contrato) {
      const reg = resultado(e, "contratos_registrar", id)
      if (!reg) return llamar("contratos_registrar", { mensaje_id: id })
      filas.push(`| ${id} | — | rechazado | ${String(reg.data.motivo ?? "")} |`)
      continue
    }
    const ext = resultado(e, "contratos_extraer", id)
    if (!ext) return llamar("contratos_extraer", { mensaje_id: id })
    if (!ext.ok) {
      filas.push(`| ${id} | — | error | ${JSON.stringify(ext.data)} |`)
      continue
    }
    const val = resultado(e, "contratos_validar", id)
    if (!val) return llamar("contratos_validar", { mensaje_id: id, contrato: ext.data.contrato })
    const rev = (val.data.requiere_revision as string[]) ?? []
    if (rev.length) {
      filas.push(`| ${id} | ${String((ext.data.contrato as Data).id_contrato)} | ${String(val.data.clasificacion)} | **en revisión** (${rev.join(", ")}) |`)
      for (const d of (val.data.detalle_revision as Data[]) ?? []) revisiones.push(`- ${id} · \`${String(d.campo)}\` = ${JSON.stringify(d.valor)} — ${String(d.motivo)}`)
      continue
    }
    const reg = resultado(e, "contratos_registrar", id)
    if (!reg) return llamar("contratos_registrar", { mensaje_id: id, contrato: ext.data.contrato })
    filas.push(`| ${id} | ${String(reg.data.id_contrato ?? "—")} | ${String(val.data.clasificacion)} | ${String(reg.data.resumen ?? "")} |`)
  }
  const al = resultado(e, "contratos_alertas")
  if (!al) return llamar("contratos_alertas", { hoy })
  if (revisiones.length && !resultado(e, "agente_solicitar_confirmacion")) {
    return llamar("agente_solicitar_confirmacion", { accion: "registrar contratos en revisión", detalle: revisiones.join(" ") })
  }
  return decir(
    [
      "| Mensaje | Contrato | Clasificación | Acción |",
      "|---|---|---|---|",
      ...filas,
      "",
      `**Alertas** (\`${String(al.data.ruta)}\`): ${String(al.data.resumen)}`,
      ...(revisiones.length ? ["", "**Requieren revisión:**", ...revisiones, "", "¿Confirmas o corriges estos valores para registrarlo?"] : []),
    ].join("\n"),
  )
}
