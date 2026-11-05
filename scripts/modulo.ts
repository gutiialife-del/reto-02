// Genera (o verifica con --check) la carpeta modulo/ a partir de las MISMAS piezas que usa la app:
//   agent/prompt.md            → modulo/agent.md (frontmatter + system prompt)
//   src/knowledge/<x>.md       → modulo/skill/<skill>/SKILL.md (frontmatter + conocimiento)
//   src/tools/<x>.ts           → modulo/tools/<x>.ts (re-export: mismo código, sin servidor)
import path from "node:path"
import { fileURLToPath } from "node:url"
import { MODULO } from "../src/config"
import { readText, writeText } from "../src/core/util"

type Archivo = { ruta: string; contenido: string }

async function esperado(root: string): Promise<Archivo[]> {
  const prompt = (await readText(path.join(root, "agent", "prompt.md"))) ?? ""
  const archivos: Archivo[] = [
    {
      ruta: "modulo/agent.md",
      contenido: [
        "---",
        `description: ${JSON.stringify(MODULO.descripcion)}`,
        "mode: primary",
        "permission:",
        "  edit: deny",
        "  bash: deny",
        "---",
        "",
        "<!-- Generado desde agent/prompt.md por scripts/modulo.ts. No editar a mano. -->",
        "",
        prompt.trim(),
        "",
      ].join("\n"),
    },
  ]
  const conocimiento: string[] = []
  for (const f of MODULO.conocimiento) conocimiento.push(((await readText(path.join(root, f))) ?? "").trim())
  archivos.push({
    ruta: `modulo/skill/${MODULO.skill}/SKILL.md`,
    contenido: [
      "---",
      `name: ${MODULO.skill}`,
      `description: ${JSON.stringify(MODULO.descripcionSkill)}`,
      "---",
      "",
      "<!-- Generado desde src/knowledge/ por scripts/modulo.ts. No editar a mano. -->",
      "",
      conocimiento.join("\n\n"),
      "",
    ].join("\n"),
  })
  for (const t of MODULO.herramientas) {
    archivos.push({
      ruta: `modulo/tools/${t}.ts`,
      contenido: `// Re-export de src/tools/${t}.ts: son las mismas herramientas que usa la app, importables sin el servidor.\nexport * from "../../src/tools/${t}"\n`,
    })
  }
  return archivos
}

export async function verificarModulo(root: string): Promise<{ ok: boolean; diferencias: string[] }> {
  const diferencias: string[] = []
  for (const a of await esperado(root)) {
    if ((await readText(path.join(root, a.ruta))) !== a.contenido) diferencias.push(a.ruta)
  }
  return { ok: diferencias.length === 0, diferencias }
}

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  if (process.argv.includes("--check")) {
    const r = await verificarModulo(root)
    console.log(r.ok ? "modulo/ está sincronizado con la app." : `modulo/ desactualizado: ${r.diferencias.join(", ")}`)
    process.exitCode = r.ok ? 0 : 1
    return
  }
  for (const a of await esperado(root)) await writeText(path.join(root, a.ruta), a.contenido)
  console.log("modulo/ generado.")
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
}
