# SOLUCIÓN — Reto 02 · Agente «Registro de Contratos Vigentes»

## 1. Problema en una frase

El maestro de contratos está congelado desde el 2026-05-30 porque dependía de un aprendiz y solo llegaban los contratos con póliza; le duele a la **analista administrativa** (dueña del maestro y de las pólizas) y a **gerencia**, que hoy no puede responder qué contratos están vigentes, cuáles vencen ni qué pólizas faltan.

## 2. Arquitectura

```
web/  (chat HTML + JS)  ── HTTP JSON ──▶  src/server.ts  (node:http: /api/chat, /api/sessions/:id, /api/health, /out/*)
  · historial                               └─ src/agent/loop.ts   ciclo · topes · compuerta de confirmación
  · cada llamada a herramienta                   ├─ system prompt = agent/prompt.md + src/knowledge/*.md
  · confirmación resaltada (⚠)                   ├─ src/llm/adapter.ts ──▶ anthropic.ts | openai.ts | simulado.ts
                                                 └─ src/core/run.ts (zod + log) ──▶ src/tools/contratos.ts ──▶ src/lib/*
                                                                                         │                  │
                                                                              fixtures/ (solo lectura)   out/ (escritura)
sesiones: memoria + out/sessions/<id>.json · registro: out/log.jsonl
```

| Capa | Dónde vive | Qué contiene |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Rol, reglas inquebrantables, flujo estándar y formato de respuesta. |
| **Conocimiento** | `src/knowledge/*.md` y `src/knowledge/reglas-*.json` | El proceso de negocio en Markdown (se inyecta al system prompt) y los parámetros que leen las herramientas (umbrales, tablas por país, tolerancias). Cambiar una regla no toca el servidor. |
| **Ejecución** | `src/tools/contratos.ts` (+ `src/lib/`) | Herramientas tipadas con `zod`, separadas del servidor e importables desde `demo.ts` y `modulo/`. |
| **Orquestación** | `src/agent/loop.ts` | Ciclo, topes, compuerta de confirmación, registro. No conoce el negocio. |
| **Proveedor** | `src/llm/` | Interfaz propia `LlmAdapter.enviar(mensajes, herramientas, opciones)` y una implementación por proveedor. |
| **Front** | `web/` | Chat sin dependencias: muestra cada herramienta (nombre, argumentos, resultado), resalta la confirmación pendiente y enlaza los archivos de `out/`. |

«SharePoint» es la carpeta `out/sharepoint/`: maestro (`maestro-contratos.csv`, copia del fixture, que nunca se modifica), documentos archivados (`Contratos/<año_inicio>/<cliente-slug>/<id>.txt`) e `historial.jsonl`.

## 3. Ciclo del agente

Implementado en `src/agent/loop.ts` (`ejecutarTurno`):

1. Se agrega el mensaje del usuario al historial y se llama al modelo con el system prompt (prompt + conocimiento + fecha) y el esquema JSON de cada herramienta (generado desde `zod` con `z.toJSONSchema`).
2. Si el modelo pide herramientas, cada llamada pasa por `runTool` (`src/core/run.ts`): valida los argumentos con `zod` (si no cumplen, el error vuelve al modelo como `{ ok:false }`), ejecuta la herramienta dentro de `try/catch` y escribe `{ ts, sesion, herramienta, ok, resumen }` en `out/log.jsonl` (CA4). El resultado vuelve al modelo y se repite.
3. El turno termina cuando el modelo responde sin pedir herramientas.

**Topes (CA1 y costo).** `MAX_ITERACIONES` (25 por defecto) limita las vueltas modelo → herramientas por turno; si se alcanza, el agente responde con lo que tiene (últimas llamadas y su resultado) y lo que falta, sin otra llamada al modelo. `MAX_TOKENS_SESION` corta la sesión al superar el presupuesto, `MAX_TOKENS_RESPUESTA` limita cada respuesta y `LLM_TIMEOUT_MS` aborta una llamada colgada. `ACCESS_KEY` evita que un tercero gaste la clave desde el link público.

**Confirmación humana (CA3 / regla de "confirmación en el turno inmediatamente anterior").** No depende de que el modelo se porte bien; la hace cumplir el servidor:

- Para pedir confirmación, el agente llama `agente_solicitar_confirmacion({ accion, detalle })` y termina el turno con la pregunta. También queda pendiente cuando una herramienta responde `requiere confirmación` / `requiere revisión`. La sesión guarda esa marca y el front pinta el mensaje en amarillo con botones **Confirmo / No confirmo**.
- En el turno siguiente, el servidor clasifica el mensaje del usuario (`esAfirmativo` / `esNegativo`). Solo si había una marca pendiente **y** el mensaje es afirmativo, ese turno queda habilitado para llamadas con `confirmado: true`; el modelo recibe una nota explícita indicando qué se confirmó.
- Cualquier llamada con `confirmado: true` en un turno no habilitado se bloquea **antes** de ejecutar la herramienta y vuelve al modelo como error. Una pregunta escrita sin la marca formal se resalta en el front, pero no habilita nada.

**Errores (CA5).** Un error de herramienta llega al modelo como `{ ok:false, error }` legible; un error del proveedor (clave inválida, 429, timeout) se traduce a un mensaje claro en el chat y la sesión sigue viva (se reintenta una vez ante 429/5xx).

En este reto la acción que exige confirmación es `contratos_registrar` cuando hay campos en `requiere_revision`: sin `confirmado: true` responde `requiere revisión: <campo = valor (motivo)>`, lo que deja la sesión en «confirmación pendiente». Con la confirmación del usuario, el agente vuelve a llamar con `confirmado: true` y **solo** puede cambiar los campos que estaban en revisión (cualquier otro cambio se rechaza).

## 4. Elección del modelo

- **Proveedor por defecto:** Anthropic, modelo `claude-sonnet-5-5` (configurable con `LLM_MODEL`). Motivos: buen seguimiento de instrucciones largas en español, uso de herramientas en paralelo (varias llamadas en una misma respuesta) y respuestas estructuradas. Para bajar costo se puede usar un modelo más pequeño de la misma familia cambiando solo `LLM_MODEL`; el diseño lo tolera porque los valores y las reglas los calculan las herramientas, no el modelo.
- **Alternativa sin tocar el ciclo:** `LLM_PROVIDER=openai` usa cualquier API compatible con OpenAI Chat Completions (OpenAI u otros proveedores vía `LLM_BASE_URL`).
- **Costo estimado por caso.** El contexto fijo (system prompt + esquemas de herramientas) mide aproximadamente 3 000 tokens (calculado sobre los caracteres del prompt y los esquemas; la cifra exacta depende del tokenizador). Procesar el buzón completo (6 mensajes) implica unas 18–20 llamadas a herramientas; el prompt pide agruparlas en paralelo (extraer todos, validar todos, registrar) para resolverlo en 5–8 vueltas. Como cada vuelta reenvía el historial, el orden de magnitud es de **unas decenas de miles de tokens de entrada y 2–4 mil de salida por caso**. Costo ≈ `tokens_entrada × precio_entrada + tokens_salida × precio_salida`, con el precio por millón de tokens vigente en la página de precios del proveedor. El buzón completo cuesta más que un caso individual porque el historial crece con cada mensaje. Estas cifras son una estimación previa, no una medición: el footer del chat muestra los tokens reales de la sesión, que conviene registrar en la prueba con el modelo real.
- ⚠️ PENDIENTE (Guti): reemplazar la estimación por la medición real (tokens del footer × precio vigente del modelo usado).

## 5. Estrategia de extracción

**Determinista primero (P0), en `src/lib/extraccion.ts`, sin modelo:**

| Campo | Cómo se encuentra | Confianza |
|---|---|---|
| Tipo de documento | Primera línea: `CONTRATO` u `OTROSÍ`. Si no es ninguno (p. ej. `COTIZACIÓN`) → el mensaje se rechaza. | — |
| `id_contrato` | `No. XX-AAAA-NNN` del encabezado; en un otrosí, el del contrato que modifica. | 0.98 |
| Partes | Patrón «Entre … , identificada con NIT/RUC/RTN …» y «… y …»; se descarta la parte que es Periferia. El nombre en mayúsculas se busca en el bloque de firmas para recuperar la escritura correcta. | 0.95 (0.85 si no aparece en firmas) |
| `nit_cliente` | El identificador de la contraparte, sin puntos ni dígito de verificación. | 0.95 |
| `pais` | Ciudad o país del domicilio («Quito, Ecuador», «Lima, Perú», «Bogotá D.C.») contrastado con el tipo de identificador (NIT → CO, RUC de 13 dígitos terminado en 001 → EC, RUC de 11 → PE, RTN → HN). | 0.95 si coinciden; 0.85 solo por identificador; 0.6 si se contradicen |
| `objeto` | Cláusula «OBJETO.», sin el prefijo «EL CONTRATISTA se obliga a», máximo 200 caracteres. | 0.9 (0.85 si se trunca) |
| `valor` y `moneda` | Cláusula «VALOR.»: `(COP $265.000.000)`, `(USD 120,000.00)`, `(PEN 520,000.00)`; se detecta el formato de miles y decimales. Si dice «no tiene un valor determinado» o «por demanda» → `valor = 0`, `valor_indeterminado = true`. | 0.95 · indeterminado 0.5 |
| Fechas | Cláusula «PLAZO.»: fechas «(15) de agosto de 2026». Si el plazo es «N meses desde la firma», se toma la fecha de firma; si la firma solo trae mes y año, se asume el día 1. `fecha_fin = inicio + N meses − 1 día`. En un otrosí: «se extiende hasta …». | Explícita 0.95 · firma con solo mes 0.8 · fin derivado 0.85 · con prórroga automática 0.5 |
| Pólizas | Cláusula «GARANTÍAS» o mención de póliza; tipos por diccionario (cumplimiento, responsabilidad civil, calidad, salarios y prestaciones). Póliza condicional («para cada orden cuyo valor supere…») baja la confianza. Sin mención → `requiere_poliza = false`. | 0.9 · condicional 0.85 · sin póliza 0.9 |

Las confianzas son **heurísticas de diseño**, no probabilidades calibradas: reflejan qué tan directa es la evidencia (texto explícito > derivado > supuesto). Viven en `src/knowledge/reglas-contratos.json` para ajustarlas sin tocar código. Cada campo trae su `evidencia` (fragmento del texto) para que la analista verifique en segundos.

**Dónde entra el modelo:** orquesta el lote, explica resultados y conversa con la analista sobre los campos dudosos. **Dónde no entra:** no extrae ni clasifica, y lo que propone no se registra sin pasar por `contratos_validar`, que solo acepta cambios en campos que ya estaban en revisión. Así se cumple «el valor final que se registra debe pasar por `contratos_validar`» y se evita que el modelo redondee un valor o infiera una fecha.

**Clasificación:** duplicado = mismo `id_contrato` y mismos `valor`, `fecha_inicio`, `fecha_fin`; actualización = mismo id (o mismo NIT + objeto con similitud de Dice ≥ 0.9) con cambios, o un otrosí; nuevo = sin coincidencia; rechazado = sin contrato o sin partes ni objeto. Un otrosí solo compara los campos que trae (los demás son `null` y se conservan del maestro).

**Resultado sobre los fixtures:** `msg-001` nuevo con póliza pendiente · `msg-002` nuevo sin póliza (`no_aplica`) · `msg-003` actualización de CT-2026-011 (valor 350 000 → 520 000 PEN, fin 2027-05-01 → 2027-11-01, póliza vigente → pendiente porque el otrosí exige ampliarla) · `msg-004` duplicado sin escritura · `msg-005` rechazado (cotización) · `msg-006` nuevo con revisión de `valor` y `fecha_fin`, remitente no registrado; tras confirmar, queda registrado.

## 6. Propuesta de regla de gobierno (una página)

**Objetivo:** que todo contrato firmado por Periferia exista en el maestro dentro de los 5 días hábiles siguientes a su firma, con o sin póliza.

1. **Canal único.** Buzón `contratos@periferia-ficticia.com` (dirección del fixture; en producción, la que defina TI). Lo **administra la analista administrativa**, dueña del maestro; tiene un respaldo designado en Administración para ausencias. El agente procesa el buzón a diario y la analista revisa sus excepciones.
2. **Obligación del comercial.** Enviar al buzón, **dentro de los 3 días hábiles siguientes a la firma**: el contrato firmado por ambas partes (PDF), cada otrosí, las actas de inicio y de terminación o liquidación, y las órdenes de servicio de contratos marco. Asunto obligatorio: `[CONTRATO|OTROSÍ|ACTA] <Cliente> - <N.º de contrato> - <objeto corto>`. Aplica a **todos** los contratos, no solo a los que requieren póliza.
3. **Acuse automático.** El agente responde al remitente el mismo día hábil con: clasificación (nuevo, actualización, duplicado, rechazado), datos registrados (número, valor, vigencia, póliza) y, si hay campos en revisión, cuáles y por qué. Si el remitente no está en la lista de comerciales, se copia a su jefe comercial.
4. **Excepciones y escalamiento.**
   - Contrato **sin firmar** o sin firma de ambas partes: se rechaza con motivo y se pide la versión firmada; si no llega en 5 días hábiles, se escala al director comercial.
   - Contrato **sin valor** (marco o por demanda): se registra con valor 0 tras confirmar, y las órdenes de servicio deben enviarse como documentos asociados.
   - **Póliza** exigida no constituida a los 10 días hábiles de la firma: alerta al comercial y a gerencia; a los 20, escalamiento a gerencia general.
   - Sin área legal interna: las dudas de interpretación se escalan a la asesoría jurídica externa vía gerencia.
5. **Cierre del gap (junio–agosto de 2026), en una sola campaña de dos semanas.** a) Cruzar la facturación emitida desde el 2026-05-30 contra el maestro para obtener la lista de clientes facturados sin contrato registrado; b) enviar a cada comercial su lista con plazo de 5 días hábiles para reenviar los contratos al buzón con el asunto estándar; c) el agente los procesa con `fuente = buzon` y la analista revisa las excepciones; d) lo que no aparezca se registra como `fuente = manual` con evidencia y se escala a gerencia.
6. **Indicador mensual.** *Cobertura del maestro* = facturas del mes cuyo cliente y contrato existen en el maestro ÷ facturas del mes. Meta ≥ 95 %. Indicadores de apoyo: días promedio entre firma y registro, y pólizas exigidas con más de 10 días en estado `pendiente`.

**Dueño del maestro:** la analista administrativa (responsable) con gerencia como aprobador de excepciones. Esto responde la pregunta abierta del PRD.

## 7. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | **Extracción determinista** (regex + heurísticas) con confianza y evidencia por campo. | Extraer con el modelo (JSON mode). | Repetible, auditable y gratis; `demo.ts` corre sin clave. El costo: más frágil ante formatos nuevos. En producción el modelo podría proponer valores para campos `null`, siempre pasando por `contratos_validar` y revisión humana. |
| 2 | `contratos_validar` y `contratos_registrar` **re-extraen del documento** y solo aceptan cambios en campos de baja confianza. | Registrar el objeto `contrato` tal como lo envía el modelo. | Impide que el modelo «redondee» un valor o cambie una fecha limpia (lo prueba `demo.ts`). |
| 3 | Un **otrosí** actualiza solo lo que modifica y, si exige ampliar garantías, la póliza pasa a `pendiente`. | Tratarlo como contrato completo (marcaría objeto y fechas `null` para revisión). | Refleja el negocio: el objeto no cambia, pero la póliza vigente no cubre el nuevo plazo. |
| 4 | `fecha_fin` derivada con **prórroga automática → confianza 0.5** (revisión). | Confianza alta por ser un cálculo exacto. | El cálculo es exacto, pero el contrato puede seguir vivo después de esa fecha; la analista debe decidir qué registrar. |
| 5 | **CSV y archivo con utilidades propias** (sin librería de CSV). | `papaparse`/`csv-parse`. | El formato es pequeño y conocido; se maneja bien comillas y comas (los objetos tienen comas). Una dependencia menos. |
| 6 | Mensajes rechazados y duplicados **se marcan como procesados** (`procesados.json`) sin tocar el maestro. | Dejarlos pendientes. | El buzón no los vuelve a mostrar; la trazabilidad queda en `procesados.json` y `log.jsonl`. |

## 8. Supuestos

- La fecha de la firma «en el mes de agosto de 2026» (msg-006) se interpreta como 2026-08-01 (confianza 0.8) y `fecha_fin` como 2027-07-31; la analista confirma o corrige (en el ejemplo del PRD corrige a 2027-08-31 y así se registra).
- La moneda de un contrato marco sin valor se toma de los montos de referencia del texto (COP), con confianza 0.8.
- Un remitente fuera de `comerciales.json` se registra como `(no registrado) <correo>` en la columna `comercial` y aparece en `alertas.md`.
- `fecha_registro` = fecha de referencia (actual o `FECHA_REFERENCIA`). «Registrados desde el corte» incluye inserciones y actualizaciones del historial con fecha ≥ 2026-05-30.
- El documento archivado conserva la extensión del adjunto (`.txt` en los fixtures; `.pdf` en producción). Un otrosí se archiva como `<id>-otrosi-<n>` junto al contrato original, sin sobrescribirlo, y `ruta_sharepoint` sigue apuntando al contrato.
- Las alertas incluyen, además de las tres secciones pedidas, los contratos **ya vencidos** que siguen en el maestro (p. ej. CT-2025-018 y CT-2026-002), porque son la primera pregunta de gerencia.

## 9. Cobertura

| Historia | Estado | Evidencia | Qué falta para producción |
|---|---|---|---|
| HU-1 Leer el buzón | Hecho | `contratos_leer_buzon` excluye `procesados.json`; `tiene_contrato:false` + `rechazado` con motivo. | Conexión a Exchange/Graph y lectura de adjuntos reales. |
| HU-2 Extraer | Hecho (P0 determinista) | Esquema 7.2 con `confianza` y `evidencia`; ausentes = `null` con confianza 0. | `contratos_leer_pdf` (P1) no implementado; OCR para escaneados. |
| HU-3 Validar y clasificar | Hecho | Nuevo, actualización, duplicado, rechazado; `requiere_revision`; diferencias con el maestro; comercial resuelto. | Normalización de nombres de clientes (alias) y dedupe por NIT a escala. |
| HU-4 Registrar y archivar | Hecho | Copia del maestro en `out/sharepoint/`, archivo por año y cliente, `historial.jsonl`, `procesados.json`; exige `confirmado` si hay revisión. | Escritura concurrente segura (bloqueo) y SharePoint real (Graph API). |
| HU-5 Alertas | Hecho | `out/alertas.md` con vencen ≤ 60 días, pólizas no vigentes y gap cubierto; `hoy` como argumento. | Envío programado a gerencia (correo o Teams). |
| HU-6 Errores | Hecho | Texto vacío, fecha inválida, moneda desconocida, mensaje inexistente y valor alterado devuelven `{ ok:false }` legible; el lote continúa. | Cola de reintentos y alertas operativas. |
| Bonus módulo | Hecho | `modulo/` generado desde las mismas piezas y verificado. | Publicación en la plataforma de agentes. |

## 10. Uso de IA

- **Asistente usado:** Claude (Anthropic), en una sesión agéntica, para leer los tres PRD y los fixtures, proponer la arquitectura, escribir el código TypeScript, el front, `demo.ts`, los scripts y esta documentación, y para probar todo (demos, `tsc --noEmit`, pruebas del chat de punta a punta con el proveedor simulado y capturas del front con Playwright).
- **Qué se descartó durante la construcción y por qué:**
  - *SDKs de los proveedores y un framework web (Express/Hono):* se prefirió `fetch` y `node:http` para que el adaptador fuera explícito, no hubiera dependencias que justificar y el mismo código corriera con Bun o con Node.
  - *Dejar que el modelo valide o calcule:* toda regla vive en herramientas deterministas; el modelo orquesta y explica. Por eso las herramientas recalculan desde los fixtures lo que el modelo les devuelve y rechazan valores alterados.
  - *Habilitar `confirmado: true` cuando el modelo "pregunta algo":* se descartó porque una pregunta cualquiera ("¿proceso otro caso?") seguida de "sí" habría autorizado acciones externas; solo la marca formal habilita.
  - *Extracción con el modelo como fuente principal:* descartada por trazabilidad y costo; queda como mejora con revisión obligatoria.
- ⚠️ PENDIENTE (Guti): agregar en primera persona qué revisaste línea a línea, qué cambiaste tú y qué propuestas de la IA rechazaste. El PRD exige poder explicar cada línea en la defensa.

## 11. Riesgos de llevarlo a producción

| Riesgo | Mitigación |
|---|---|
| Contratos escaneados o con formatos nuevos que la extracción no reconoce. | OCR; los campos no encontrados quedan `null` y van a revisión; métricas de campos en revisión por formato para mejorar las reglas. |
| El comercial no envía los contratos (el problema de fondo). | Regla de gobierno con indicador mensual de cobertura y escalamiento; cruce con facturación. |
| Falsos duplicados o actualizaciones por variaciones del nombre del cliente. | Dedupe por NIT antes que por nombre; similitud de objeto ≥ 0.9; conflicto de NIT con el mismo id → revisión. |
| El modelo altera valores antes de registrar. | Re-extracción y validación en la herramienta; solo campos en revisión, con confirmación del turno anterior. |
| Escrituras concurrentes sobre el maestro. | En producción, un solo proceso escritor (cola) o una lista de SharePoint con control de versiones en lugar de CSV. |
| Datos contractuales enviados al proveedor del modelo. | Revisar la política de retención del proveedor; el texto completo del contrato no viaja al modelo (solo campos y fragmentos de evidencia). |
| Costo del modelo en lotes grandes. | Llamadas en paralelo, topes de iteraciones y tokens, y procesamiento por lotes pequeños. |

