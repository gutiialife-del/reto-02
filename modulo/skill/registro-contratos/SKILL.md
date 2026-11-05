---
name: registro-contratos
description: "Conocimiento del proceso de registro de contratos vigentes de Periferia: esquema del maestro, reglas de duplicado/actualización, revisión humana y alertas."
---

<!-- Generado desde src/knowledge/ por scripts/modulo.ts. No editar a mano. -->

# Proceso: registro de contratos vigentes

## Contexto
- El maestro de contratos (Excel en SharePoint) está congelado desde el **2026-05-30**. Solo llegaban a administración los contratos con póliza.
- El agente es el **punto único de recepción**: todo contrato que llegue al buzón se registra, tenga o no póliza.
- En este sistema SharePoint es la carpeta `out/sharepoint/`; el maestro es `out/sharepoint/maestro-contratos.csv` (copia del fixture, que es de solo lectura).

## Esquema del maestro (una fila por contrato)
`id_contrato, cliente, nit_cliente, pais, objeto, valor, moneda, fecha_inicio, fecha_fin, requiere_poliza, tipo_poliza, estado_poliza, comercial, ruta_sharepoint, fecha_registro, fuente`
- `id_contrato`: número del documento; si no tiene, `AUTO-<año>-<secuencia>`.
- `nit_cliente`: sin dígito de verificación ni puntos.
- `valor`: número sin separadores; `0` si el contrato es por demanda (valor indeterminado).
- `fecha_fin` puede derivarse de un plazo en meses.
- `estado_poliza`: un registro nuevo con póliza nace `pendiente`; sin póliza, `no_aplica`.
- Monedas válidas: COP, USD, PEN, PAB, HNL. Países: CO, EC, PE, PA, HN.

## Clasificación (RN1–RN4)
| Clasificación | Regla | Acción |
|---|---|---|
| `duplicado` | Mismo `id_contrato` y mismos `valor`, `fecha_inicio`, `fecha_fin`. | No se escribe nada; se reporta. |
| `actualizacion` | Mismo `id_contrato` (o mismo NIT + objeto con similitud ≥ 0.9) con algún campo distinto, o el documento es un otrosí. | Se actualiza la fila y se registra el cambio en `historial.jsonl`. |
| `nuevo` | Sin coincidencia en el maestro. | Se inserta. |
| `rechazado` | Sin adjunto de contrato, o texto sin partes ni objeto identificables. | Se reporta con motivo. |

## Revisión humana (RN5)
- Todo campo con confianza < 0.8 va a `requiere_revision`. `contratos_registrar` sin `confirmado = true` lo rechaza.
- Solo se pueden cambiar campos en revisión. Cualquier otro valor debe ser exactamente el extraído del documento.

## Cómo se calcula la confianza (extracción determinista)
- Número del contrato en el encabezado: 0.98.
- Contraparte con identificador tributario explícito: 0.95.
- País por domicilio coherente con el identificador: 0.95; solo por identificador: 0.85.
- Valor con código de moneda explícito: 0.95. Valor indeterminado (contrato marco o por demanda): 0.5.
- Fechas escritas en el plazo: 0.95. Fecha de firma con solo mes y año (se asume el día 1): 0.8. Fecha fin derivada de un plazo en meses: 0.85; si además hay prórroga automática: 0.5.
- Póliza explícita: 0.9; condicional (solo para ciertas órdenes): 0.85.

## Reglas especiales
- **Otrosí:** solo actualiza lo que modifica (p. ej. `fecha_fin`, `valor`). Si exige ampliar las garantías al nuevo plazo, la póliza pasa a `pendiente` hasta que se renueve.
- **Remitente desconocido** (no está en `comerciales.json`): se reporta y se registra como "(no registrado) <correo>", pero no bloquea.
- **Alertas** (`out/alertas.md`): contratos que vencen en ≤ 60 días desde la fecha de referencia, pólizas exigidas que no están vigentes, y contratos registrados o actualizados desde el corte (gap cubierto). También se listan los contratos ya vencidos que siguen en el maestro.
