// Ejecuta una herramienta: valida argumentos con zod, la ejecuta sin dejar escapar excepciones
// y deja rastro en out/log.jsonl (y en out/<caso>/log.jsonl cuando el argumento `caso` existe).
// Lo usan tanto el ciclo del agente como demo.ts, para que ambos produzcan el mismo registro.
import path from "node:path"
import { z } from "zod/v4"
import { type AnyTool, type ToolContext, type ToolResult, fail, parseResult } from "./tool"
import { appendLine, ahora } from "./util"

export type ToolRun = {
  nombre: string
  args: Record<string, unknown>
  raw: string
  resultado: ToolResult
  resumen: string
  ms: number
}

const MAX_RESUMEN = 220

export function resumir(resultado: ToolResult): string {
  if (!resultado.ok) return `error: ${resultado.error}`.slice(0, MAX_RESUMEN)
  const data = resultado.data
  if (data && typeof data === "object" && "resumen" in data) {
    const r = (data as { resumen: unknown }).resumen
    if (typeof r === "string") return r.slice(0, MAX_RESUMEN)
  }
  const s = JSON.stringify(data) ?? ""
  return s.length > MAX_RESUMEN ? s.slice(0, MAX_RESUMEN - 1) + "…" : s
}

export async function runTool(
  nombre: string,
  tool: AnyTool,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolRun> {
  const inicio = Date.now()
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>
  const parsed = z.object(tool.args).safeParse(args)
  let raw: string
  if (!parsed.success) {
    const detalle = parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
    raw = fail(`argumentos inválidos para ${nombre}: ${detalle}`)
  } else {
    try {
      raw = await tool.execute(parsed.data as never, ctx)
    } catch (err) {
      raw = fail(`la herramienta ${nombre} falló: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const resultado = parseResult(raw)
  const run: ToolRun = { nombre, args, raw, resultado, resumen: resumir(resultado), ms: Date.now() - inicio }
  await registrarLog(ctx, run)
  return run
}

async function registrarLog(ctx: ToolContext, run: ToolRun): Promise<void> {
  const entrada: Record<string, unknown> = {
    ts: ahora(),
    sesion: ctx.sessionId,
    herramienta: run.nombre,
    ok: run.resultado.ok,
    resumen: run.resumen,
  }
  for (const clave of ["caso", "mensaje_id"]) {
    if (typeof run.args[clave] === "string") entrada[clave] = run.args[clave]
  }
  try {
    await appendLine(path.join(ctx.directory, "out", "log.jsonl"), entrada)
    const caso = run.args.caso
    if (typeof caso === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(caso) && !caso.includes("..")) {
      await appendLine(path.join(ctx.directory, "out", caso, "log.jsonl"), entrada)
    }
  } catch {
    // El log es best-effort: nunca debe tumbar una herramienta.
  }
}
