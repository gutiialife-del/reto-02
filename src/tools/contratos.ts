// Herramientas del agente "Registro de Contratos Vigentes". Cada export se publica como contratos_<export>.
// Son la única fuente de valores que el agente puede afirmar.
import path from "node:path"
import { z } from "zod/v4"
import { defineTool, fail, guard, ok } from "../core/tool"
import { ahora, appendLine, copy, diasEntre, esFechaISO, fechaReferencia, listDirs, readText, rel, writeText } from "../core/util"
import {
  type Fila,
  adjuntoContrato,
  adjuntos,
  asegurarMaestro,
  cargarReglas,
  extraerMensaje,
  guardarMaestro,
  leerCorreo,
  leerMaestro,
  marcarProcesado,
  procesados,
  rutas,
  slugCliente,
  validar as validarMensaje,
} from "../lib/dominio"
import type { DatosContrato } from "../lib/extraccion"

const mensajeArg = z.string().describe("Id del mensaje (carpeta en fixtures/reto-02/buzon/), p. ej. 'msg-001'")

const contratoArg = z
  .object({
    id_contrato: z.string().nullable(),
    cliente: z.string().nullable(),
    nit_cliente: z.string().nullable(),
    pais: z.string().nullable(),
    objeto: z.string().nullable(),
    valor: z.number().nullable(),
    valor_indeterminado: z.boolean(),
    moneda: z.string().nullable(),
    fecha_inicio: z.string().nullable(),
    fecha_fin: z.string().nullable(),
    requiere_poliza: z.boolean().nullable(),
    tipo_poliza: z.string().nullable(),
  })
  .partial()
  .describe(
    "data.contrato devuelto por contratos_extraer. Solo se pueden cambiar campos en requiere_revision, y únicamente con el valor que el usuario confirmó.",
  )

export const leer_buzon = defineTool({
  description: "Lista los mensajes del buzón que aún no se han procesado, con remitente, asunto, adjuntos y si traen contrato.",
  args: {},
  async execute(_args, ctx) {
    return guard(async () => {
      const r = rutas(ctx.directory)
      const hechos = await procesados(ctx.directory)
      const ids = (await listDirs(r.buzon)).filter((id) => !hechos[id])
      const mensajes = []
      for (const id of ids) {
        try {
          const correo = await leerCorreo(ctx.directory, id)
          const adj = await adjuntos(ctx.directory, correo)
          const contrato = adjuntoContrato(adj)
          mensajes.push({
            id,
            de: correo.de,
            asunto: correo.asunto,
            fecha: correo.fecha,
            adjuntos: correo.adjuntos,
            tiene_contrato: contrato !== null,
            tipo_documento: contrato?.tipo ?? null,
            ...(contrato ? {} : { clasificacion: "rechazado", motivo: `sin adjunto de contrato (adjuntos: ${correo.adjuntos.join(", ") || "ninguno"})` }),
          })
        } catch (e) {
          mensajes.push({ id, error: `no pude leer el mensaje: ${(e as Error).message}` })
        }
      }
      return ok({
        mensajes,
        ya_procesados: Object.keys(hechos).length,
        resumen: `${mensajes.length} mensaje(s) pendiente(s): ${mensajes.map((m) => `${m.id}${"tiene_contrato" in m && !m.tiene_contrato ? " (sin contrato)" : ""}`).join(", ") || "ninguno"}`,
      })
    })
  },
})

export const extraer = defineTool({
  description: "Extrae del contrato u otrosí adjunto los datos del maestro con confianza por campo (0–1) y la evidencia textual; lo ausente es null con confianza 0.",
  args: { mensaje_id: mensajeArg },
  async execute(args, ctx) {
    return guard(async () => {
      const { correo, adjunto, extraccion } = await extraerMensaje(ctx.directory, args.mensaje_id)
      const reglas = await cargarReglas(ctx.directory)
      const bajos = Object.entries(extraccion.confianza).filter(([c, v]) => v < reglas.umbral_confianza && extraccion.contrato[c as keyof DatosContrato] !== null)
      return ok({
        mensaje_id: args.mensaje_id,
        remitente: correo.de,
        adjunto: adjunto.nombre,
        ...extraccion,
        resumen: `${extraccion.tipo_documento} ${extraccion.contrato.id_contrato ?? "(sin número)"} · ${extraccion.contrato.cliente ?? "?"}${bajos.length ? ` · baja confianza: ${bajos.map(([c]) => c).join(", ")}` : ""}`,
      })
    })
  },
})

export const validar = defineTool({
  description: "Clasifica el contrato como nuevo, actualizacion, duplicado o rechazado frente al maestro y lista los campos que requieren revisión humana.",
  args: { mensaje_id: mensajeArg, contrato: contratoArg.optional() },
  async execute(args, ctx) {
    return guard(async () => {
      const v = await validarMensaje(ctx.directory, args.mensaje_id, args.contrato ?? null)
      const { extraccion: _e, ...visible } = v
      return ok({
        ...visible,
        ...(v.requiere_revision.length
          ? { pendiente_confirmacion: { accion: `registrar ${args.mensaje_id} con los campos en revisión confirmados por el usuario`, detalle: v.detalle_revision.map((r) => `${r.campo} = ${JSON.stringify(r.valor)} (${r.motivo})`).join("; ") } }
          : {}),
        resumen: `${v.clasificacion}${v.id_contrato_existente ? ` (existente ${v.id_contrato_existente})` : ""}${v.requiere_revision.length ? ` · revisar: ${v.requiere_revision.join(", ")}` : ""}${v.motivo ? ` · ${v.motivo}` : ""}`,
      })
    })
  },
})

export const registrar = defineTool({
  description:
    "Escribe o actualiza el contrato en out/sharepoint/maestro-contratos.csv, archiva el documento y deja historial; si hay campos en revisión exige confirmado=true.",
  args: {
    mensaje_id: mensajeArg,
    contrato: contratoArg.optional(),
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente los campos en revisión en su último mensaje"),
  },
  async execute(args, ctx) {
    return guard(async () => {
      const dir = ctx.directory
      const v = await validarMensaje(dir, args.mensaje_id, args.contrato ?? null)
      const ts = ahora()
      if (v.clasificacion === "rechazado") {
        await marcarProcesado(dir, args.mensaje_id, { ts, clasificacion: "rechazado", accion: "ninguna", id_contrato: null, motivo: v.motivo ?? "" })
        return ok({ id_contrato: null, accion: "rechazado", motivo: v.motivo, ruta_archivo: null, resumen: `rechazado: ${v.motivo}` })
      }
      if (v.clasificacion === "duplicado") {
        await marcarProcesado(dir, args.mensaje_id, { ts, clasificacion: "duplicado", accion: "ninguna", id_contrato: v.id_contrato_existente ?? null })
        return ok({ id_contrato: v.id_contrato_existente, accion: "sin_cambios", clasificacion: "duplicado", ruta_archivo: null, resumen: `duplicado de ${v.id_contrato_existente}: no se escribió nada` })
      }
      if (v.requiere_revision.length && args.confirmado !== true) {
        const detalle = v.detalle_revision.map((r) => `${r.campo} = ${JSON.stringify(r.valor)} (${r.motivo})`).join("; ")
        return fail(`requiere revisión: ${detalle}. Pide al usuario que confirme o corrija estos campos y vuelve a llamar con confirmado=true.`)
      }
      const c = v.contrato
      const correo = await leerCorreo(dir, args.mensaje_id)
      const adj = adjuntoContrato(await adjuntos(dir, correo))
      if (!c || !adj) return fail("no hay contrato que registrar")
      await asegurarMaestro(dir)
      const filas = await leerMaestro(dir)
      const r = rutas(dir)
      const ext = path.extname(adj.nombre) || ".txt"
      const comercial = v.comercial.nombre ?? `(no registrado) ${v.comercial.email}`
      const confirmados = args.confirmado ? v.requiere_revision : []

      if (v.clasificacion === "nuevo") {
        const anio = (c.fecha_inicio ?? fechaReferencia()).slice(0, 4)
        const id = c.id_contrato ?? autoId(filas, anio)
        const rutaRel = `Contratos/${anio}/${slugCliente(c.cliente ?? "sin-cliente")}/${id}${ext}`
        await copy(path.join(r.mensaje(args.mensaje_id), adj.nombre), path.join(r.sharepoint, rutaRel))
        const fila: Fila = {
          id_contrato: id,
          cliente: c.cliente ?? "",
          nit_cliente: c.nit_cliente ?? "",
          pais: c.pais ?? "",
          objeto: (c.objeto ?? "").slice(0, 200),
          valor: String(c.valor ?? 0),
          moneda: c.moneda ?? "",
          fecha_inicio: c.fecha_inicio ?? "",
          fecha_fin: c.fecha_fin ?? "",
          requiere_poliza: String(c.requiere_poliza === true),
          tipo_poliza: c.requiere_poliza ? (c.tipo_poliza ?? "") : "",
          estado_poliza: c.requiere_poliza ? "pendiente" : "no_aplica",
          comercial,
          ruta_sharepoint: rutaRel,
          fecha_registro: fechaReferencia(),
          fuente: "buzon",
        }
        filas.push(fila)
        await guardarMaestro(dir, filas)
        await appendLine(r.historial, {
          ts, id_contrato: id, accion: "nuevo", cambios: fila, mensaje_id: args.mensaje_id,
          ...(confirmados.length ? { confirmado_por_usuario: confirmados } : {}),
          ...(v.comercial.registrado ? {} : { remitente_no_registrado: v.comercial.email }),
        })
        await marcarProcesado(dir, args.mensaje_id, { ts, clasificacion: "nuevo", accion: "insertado", id_contrato: id })
        return ok({ id_contrato: id, accion: "insertado", ruta_archivo: `out/sharepoint/${rutaRel}`, estado_poliza: fila.estado_poliza, confirmado_por_usuario: confirmados, advertencias: v.advertencias, resumen: `nuevo ${id} registrado (${fila.estado_poliza})` })
      }

      // Actualización (otrosí o mismo contrato con datos distintos).
      const idx = filas.findIndex((f) => f.id_contrato === v.id_contrato_existente)
      const fila = filas[idx]
      if (idx < 0 || !fila) return fail(`no encontré ${v.id_contrato_existente} en el maestro para actualizarlo`)
      const cambios = v.diferencias ?? []
      for (const cambio of cambios) fila[cambio.campo] = cambio.despues
      const anio = (fila.fecha_inicio || fechaReferencia()).slice(0, 4)
      const sufijo = v.tipo_documento === "otrosi" ? `otrosi-${v.extraccion?.numero_otrosi ?? args.mensaje_id}` : args.mensaje_id
      const rutaRel = `Contratos/${anio}/${slugCliente(fila.cliente ?? "")}/${fila.id_contrato}-${sufijo}${ext}`
      await copy(path.join(r.mensaje(args.mensaje_id), adj.nombre), path.join(r.sharepoint, rutaRel))
      await guardarMaestro(dir, filas)
      await appendLine(r.historial, {
        ts, id_contrato: fila.id_contrato, accion: "actualizacion", cambios, documento: rutaRel, mensaje_id: args.mensaje_id,
        ...(confirmados.length ? { confirmado_por_usuario: confirmados } : {}),
        ...(v.comercial.registrado ? {} : { remitente_no_registrado: v.comercial.email }),
      })
      await marcarProcesado(dir, args.mensaje_id, { ts, clasificacion: "actualizacion", accion: "actualizado", id_contrato: fila.id_contrato ?? null })
      return ok({
        id_contrato: fila.id_contrato,
        accion: "actualizado",
        cambios,
        ruta_archivo: `out/sharepoint/${rutaRel}`,
        advertencias: v.advertencias,
        resumen: `${fila.id_contrato} actualizado: ${cambios.map((x) => `${x.campo} ${x.antes}→${x.despues}`).join(", ")}`,
      })
    })
  },
})

function autoId(filas: Fila[], anio: string): string {
  const n = filas.filter((f) => (f.id_contrato ?? "").startsWith(`AUTO-${anio}-`)).length + 1
  return `AUTO-${anio}-${String(n).padStart(3, "0")}`
}

type Historial = { ts: string; id_contrato: string; accion: string; mensaje_id: string; remitente_no_registrado?: string }

export const alertas = defineTool({
  description:
    "Genera out/alertas.md con contratos que vencen en ≤ 60 días, pólizas exigidas no vigentes y contratos registrados desde el corte del maestro (2026-05-30).",
  args: { hoy: z.string().describe("Fecha de referencia YYYY-MM-DD (p. ej. la que indique el usuario)") },
  async execute(args, ctx) {
    return guard(async () => {
      if (!esFechaISO(args.hoy)) return fail(`fecha inválida: "${args.hoy}". Usa YYYY-MM-DD`)
      const reglas = await cargarReglas(ctx.directory)
      const filas = await leerMaestro(ctx.directory)
      const r = rutas(ctx.directory)
      const historial = ((await readText(r.historial)) ?? "")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Historial)
      const conFin = filas.filter((f) => esFechaISO(f.fecha_fin ?? "")).map((f) => ({ f, dias: diasEntre(args.hoy, f.fecha_fin ?? "") }))
      const vencen = conFin
        .filter((x) => x.dias >= 0 && x.dias <= reglas.dias_alerta_vencimiento)
        .sort((a, b) => a.dias - b.dias)
        .map((x) => ({ id_contrato: x.f.id_contrato, cliente: x.f.cliente, fecha_fin: x.f.fecha_fin, dias: x.dias, comercial: x.f.comercial }))
      const vencidos = conFin
        .filter((x) => x.dias < 0)
        .map((x) => ({ id_contrato: x.f.id_contrato, cliente: x.f.cliente, fecha_fin: x.f.fecha_fin, dias_vencido: -x.dias }))
      const polizas = filas
        .filter((f) => f.requiere_poliza === "true" && f.estado_poliza !== "vigente")
        .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, tipo_poliza: f.tipo_poliza, estado_poliza: f.estado_poliza, comercial: f.comercial }))
      const corte = reglas.fecha_corte_maestro
      const desdeCorte = historial
        .filter((h) => h.ts.slice(0, 10) >= corte && (h.accion === "nuevo" || h.accion === "actualizacion"))
        .map((h) => ({ id_contrato: h.id_contrato, accion: h.accion, mensaje_id: h.mensaje_id, fecha: h.ts.slice(0, 10) }))
      for (const f of filas) {
        if ((f.fecha_registro ?? "") >= corte && !desdeCorte.some((d) => d.id_contrato === f.id_contrato)) {
          desdeCorte.push({ id_contrato: f.id_contrato ?? "", accion: "registrado", mensaje_id: "", fecha: f.fecha_registro ?? "" })
        }
      }
      const remitentes = [...new Set(historial.map((h) => h.remitente_no_registrado).filter((x): x is string => !!x))]
      const md = [
        `# Alertas de contratos — ${args.hoy}`,
        "",
        `Fuente: ${rel(r.maestro)} (${filas.length} contratos) · generado ${ahora()}`,
        "",
        `## 1. Vencen en ≤ ${reglas.dias_alerta_vencimiento} días`,
        ...(vencen.length
          ? ["| Contrato | Cliente | Fecha fin | Días | Comercial |", "|---|---|---|---|---|", ...vencen.map((v) => `| ${v.id_contrato} | ${v.cliente} | ${v.fecha_fin} | ${v.dias} | ${v.comercial} |`)]
          : ["Ninguno."]),
        ...(vencidos.length ? ["", "**Ya vencidos y aún en el maestro (confirmar cierre o renovación):**", ...vencidos.map((v) => `- ${v.id_contrato} · ${v.cliente} · venció ${v.fecha_fin} (hace ${v.dias_vencido} días)`)] : []),
        "",
        "## 2. Pólizas exigidas que no están vigentes",
        ...(polizas.length
          ? ["| Contrato | Cliente | Tipo | Estado | Comercial |", "|---|---|---|---|---|", ...polizas.map((p) => `| ${p.id_contrato} | ${p.cliente} | ${p.tipo_poliza} | ${p.estado_poliza} | ${p.comercial} |`)]
          : ["Ninguna."]),
        "",
        `## 3. Registrados desde el corte (${corte}) — gap cubierto`,
        ...(desdeCorte.length ? desdeCorte.map((d) => `- ${d.id_contrato} · ${d.accion} · ${d.fecha}${d.mensaje_id ? ` · ${d.mensaje_id}` : ""}`) : ["Ninguno todavía."]),
        ...(remitentes.length ? ["", "## Remitentes no registrados en comerciales.json", ...remitentes.map((x) => `- ${x}`)] : []),
        "",
      ].join("\n")
      await writeText(r.alertas, md)
      return ok({
        ruta: rel(r.alertas),
        vencen,
        vencidos,
        polizas_pendientes: polizas,
        registrados_desde_corte: desdeCorte,
        remitentes_no_registrados: remitentes,
        resumen: `${vencen.length} vencen ≤ ${reglas.dias_alerta_vencimiento} días · ${polizas.length} pólizas pendientes · ${desdeCorte.length} registrados desde el corte`,
      })
    })
  },
})
