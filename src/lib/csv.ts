// CSV RFC 4180 mínimo (comillas, comas y saltos dentro de campos). Sin dependencias.

export function parseCsv(texto: string): string[][] {
  const filas: string[][] = []
  let fila: string[] = []
  let campo = ""
  let comillas = false
  const t = texto.replace(/^﻿/, "")
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (comillas) {
      if (c === '"' && t[i + 1] === '"') {
        campo += '"'
        i++
      } else if (c === '"') comillas = false
      else campo += c
      continue
    }
    if (c === '"') comillas = true
    else if (c === ",") {
      fila.push(campo)
      campo = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++
      fila.push(campo)
      if (fila.some((x) => x !== "")) filas.push(fila)
      fila = []
      campo = ""
    } else campo += c
  }
  if (campo !== "" || fila.length) {
    fila.push(campo)
    if (fila.some((x) => x !== "")) filas.push(fila)
  }
  return filas
}

function celda(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export function toCsv(encabezados: string[], filas: Array<Record<string, string>>): string {
  return [encabezados.join(","), ...filas.map((f) => encabezados.map((h) => celda(f[h] ?? "")).join(","))].join("\n") + "\n"
}

export function csvAObjetos(texto: string): { encabezados: string[]; filas: Array<Record<string, string>> } {
  const [cab, ...resto] = parseCsv(texto)
  const encabezados = cab ?? []
  return {
    encabezados,
    filas: resto.map((r) => Object.fromEntries(encabezados.map((h, i) => [h, r[i] ?? ""]))),
  }
}
