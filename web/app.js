// Front de chat sin dependencias. Muestra cada llamada a herramienta y resalta las confirmaciones.
"use strict"

const $ = (id) => document.getElementById(id)
const chat = $("chat")
const form = $("form")
const input = $("mensaje")
const btn = $("enviar")
let clave = ""
let ocupado = false

function guardado(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k)
    localStorage.setItem(k, v)
  } catch {
    return null
  }
  return null
}

function nuevoId() {
  const a = new Uint8Array(9)
  crypto.getRandomValues(a)
  return "s-" + Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("")
}

let sessionId = guardado("sessionId") || nuevoId()
guardado("sessionId", sessionId)
$("sid").textContent = sessionId

function escapar(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

/** Convierte rutas out/... en enlaces de descarga. Recibe texto YA escapado. */
function enlazarRutas(html) {
  return html.replace(/(^|[\s(>`"])(out\/[A-Za-z0-9._\-/]+\.[A-Za-z0-9]+)/g, (m, pre, ruta) => {
    const q = clave ? `?key=${encodeURIComponent(clave)}` : ""
    return `${pre}<a href="/${ruta}${q}" target="_blank" rel="noopener">${ruta}</a>`
  })
}

function enLinea(s) {
  let t = escapar(s)
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>")
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
  t = t.replace(/(^|\s)_([^_\s][^_]*)_(?=$|[\s.,;:!?)])/g, "$1<em>$2</em>")
  return enlazarRutas(t)
}

/** Markdown mínimo y seguro (escapa todo antes de dar formato): títulos, listas, tablas, código. */
function markdown(src) {
  const lineas = String(src || "").replace(/\r/g, "").split("\n")
  const out = []
  let i = 0
  while (i < lineas.length) {
    const l = lineas[i]
    if (l.startsWith("```")) {
      const buf = []
      i++
      while (i < lineas.length && !lineas[i].startsWith("```")) buf.push(lineas[i++])
      i++
      out.push(`<pre><code>${enlazarRutas(escapar(buf.join("\n")))}</code></pre>`)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lineas.length && /^\s*\|[\s:|-]+\|\s*$/.test(lineas[i + 1])) {
      const celdas = (x) => x.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
      const cab = celdas(l)
      i += 2
      const filas = []
      while (i < lineas.length && /^\s*\|.*\|\s*$/.test(lineas[i])) filas.push(celdas(lineas[i++]))
      out.push(
        "<table><thead><tr>" + cab.map((c) => `<th>${enLinea(c)}</th>`).join("") + "</tr></thead><tbody>" +
          filas.map((f) => "<tr>" + f.map((c) => `<td>${enLinea(c)}</td>`).join("") + "</tr>").join("") +
          "</tbody></table>",
      )
      continue
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      out.push(`<h3>${enLinea(h[2])}</h3>`)
      i++
      continue
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordenada = /^\s*\d+\.\s+/.test(l)
      const items = []
      while (i < lineas.length && /^\s*([-*]|\d+\.)\s+/.test(lineas[i])) {
        items.push(`<li>${enLinea(lineas[i].replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`)
        i++
      }
      out.push(ordenada ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`)
      continue
    }
    if (!l.trim()) {
      i++
      continue
    }
    const parrafo = []
    while (i < lineas.length && lineas[i].trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s|\s*\|)/.test(lineas[i])) parrafo.push(lineas[i++])
    if (!parrafo.length) parrafo.push(lineas[i++])
    out.push(`<p>${parrafo.map(enLinea).join("<br>")}</p>`)
  }
  return out.join("")
}

function bajar() {
  chat.scrollTop = chat.scrollHeight
}

function pintarUsuario(texto) {
  $("bienvenida")?.remove()
  const div = document.createElement("div")
  div.className = "msg user"
  div.innerHTML = `<div class="burbuja">${escapar(texto)}</div>`
  chat.appendChild(div)
  bajar()
}

function pintarHerramienta(tc) {
  const d = document.createElement("details")
  d.className = "tool"
  const resultado = typeof tc.resultado === "string" ? tc.resultado : JSON.stringify(tc.resultado, null, 2)
  d.innerHTML =
    `<summary><span class="estado ${tc.ok ? "ok" : "err"}">${tc.ok ? "✔" : "✖"}</span>` +
    `<span class="tool-nombre">${escapar(tc.nombre)}</span>` +
    `<span class="tool-resumen">${enlazarRutas(escapar(tc.resumen))}</span></summary>` +
    `<div class="tool-cuerpo"><h4>Argumentos</h4><pre>${escapar(JSON.stringify(tc.args, null, 2))}</pre>` +
    `<h4>Resultado</h4><pre>${enlazarRutas(escapar(resultado ?? ""))}</pre></div>`
  return d
}

function pintarAgente(r, ultimo) {
  const div = document.createElement("div")
  div.className = "msg agent" + (r.needsConfirmation ? " confirmar" : "")
  if (r.toolCalls && r.toolCalls.length) {
    const lista = document.createElement("div")
    lista.className = "herramientas"
    r.toolCalls.forEach((tc) => lista.appendChild(pintarHerramienta(tc)))
    div.appendChild(lista)
  }
  const b = document.createElement("div")
  b.className = "burbuja md"
  b.innerHTML = r.error && !r.reply ? `<p class="error-msg">${escapar(r.error)}</p>` : markdown(r.reply)
  div.appendChild(b)
  if (r.needsConfirmation && ultimo) {
    const aviso = document.createElement("div")
    aviso.className = "aviso-confirmar"
    aviso.innerHTML = `<span>⚠ El agente espera tu confirmación explícita antes de continuar.</span>`
    const si = document.createElement("button")
    si.className = "btn"
    si.type = "button"
    si.textContent = "Confirmo"
    si.onclick = () => enviar("Confirmo, procede.")
    const no = document.createElement("button")
    no.className = "btn-sec"
    no.type = "button"
    no.textContent = "No confirmo"
    no.onclick = () => enviar("No confirmo. No ejecutes esa acción.")
    aviso.append(si, no)
    div.appendChild(aviso)
  }
  chat.appendChild(div)
  bajar()
}

function quitarAvisos() {
  document.querySelectorAll(".aviso-confirmar").forEach((n) => n.remove())
}

async function api(ruta, opciones = {}) {
  const headers = { "content-type": "application/json", ...(clave ? { "x-access-key": clave } : {}) }
  const res = await fetch(ruta, { ...opciones, headers })
  const body = await res.json().catch(() => ({ ok: false, error: `respuesta inválida (${res.status})` }))
  return { status: res.status, body }
}

async function enviar(texto) {
  if (ocupado || !texto.trim()) return
  ocupado = true
  btn.disabled = true
  quitarAvisos()
  pintarUsuario(texto)
  $("pensando").hidden = false
  try {
    const { status, body } = await api("/api/chat", { method: "POST", body: JSON.stringify({ sessionId, message: texto }) })
    if (status !== 200) pintarAgente({ reply: "", error: body.error || `Error HTTP ${status}`, toolCalls: [] }, true)
    else {
      pintarAgente(body, true)
      if (body.tokens) $("tokens").textContent = (body.tokens.input + body.tokens.output).toLocaleString("es-CO")
    }
  } catch {
    pintarAgente({ reply: "", error: "No pude contactar el servidor. Revisa tu conexión e intenta de nuevo.", toolCalls: [] }, true)
  } finally {
    $("pensando").hidden = true
    ocupado = false
    btn.disabled = false
    input.focus()
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault()
  const t = input.value
  input.value = ""
  enviar(t)
})
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault()
    form.requestSubmit()
  }
})
$("nueva").addEventListener("click", () => {
  sessionId = nuevoId()
  guardado("sessionId", sessionId)
  location.reload()
})

async function iniciar() {
  const { body: h } = await api("/api/health").catch(() => ({ body: {} }))
  if (h.app) {
    $("titulo").textContent = h.app
    document.title = h.app
  }
  const badge = $("modelo")
  if (h.provider) {
    badge.textContent = `${h.provider} · ${h.model}`
    if (h.provider === "simulado") {
      badge.classList.add("aviso")
      badge.title = "Proveedor simulado: guion fijo para pruebas, no es un modelo de lenguaje."
    }
  } else {
    badge.textContent = "modelo no configurado"
    badge.classList.add("error")
    badge.title = h.error || ""
  }
  if (h.requiereClaveAcceso) {
    try { clave = sessionStorage.getItem("clave") || "" } catch { clave = "" }
    if (!clave) clave = prompt("Clave de acceso de la demo:") || ""
    try { sessionStorage.setItem("clave", clave) } catch { /* sin almacenamiento */ }
  }
  ;(h.ejemplos || []).forEach((ej) => {
    const c = document.createElement("button")
    c.type = "button"
    c.className = "chip"
    c.textContent = ej
    c.onclick = () => enviar(ej)
    $("ejemplos").appendChild(c)
  })
  const { status, body } = await api(`/api/sessions/${sessionId}`)
  if (status === 200 && body.tokens) $("tokens").textContent = (body.tokens.input + body.tokens.output).toLocaleString("es-CO")
  if (status === 200 && body.turnos && body.turnos.length) {
    body.turnos.forEach((t, idx) => {
      pintarUsuario(t.usuario)
      pintarAgente({ reply: t.respuesta, toolCalls: t.toolCalls, needsConfirmation: t.needsConfirmation, error: t.error }, idx === body.turnos.length - 1)
    })
  }
}
iniciar()
