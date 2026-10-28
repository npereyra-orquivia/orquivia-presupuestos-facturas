# Supervisión pública de Orquivia

El monitor comprueba disponibilidad desde fuera del portal. No inicia sesión, no lee clientes, documentos, Storage ni buzones, no modifica el proyecto y no envía correos desde la aplicación.

## Ejecutar

Con Node.js 22 o posterior, desde la raíz del proyecto:

```text
node scripts/operations/monitor.mjs
```

La dirección está fijada a la raíz HTTPS oficial de Orquivia. `ORQUIVIA_PORTAL_URL` puede omitirse; si se indica debe ser exactamente `https://npereyra-orquivia.github.io/orquivia-presupuestos-facturas/`, sin parámetros, fragmento ni otra ruta.

Se descargan mediante GET la portada pública, `version.json` y las entradas JavaScript/CSS declaradas por la portada. No se ejecuta su código. Las redirecciones, los recursos externos, los destinos fuera de `assets/`, los formatos inesperados y las respuestas vacías o demasiado grandes hacen fallar la comprobación. Los imports dinámicos y el funcionamiento de los formularios requieren las pruebas de integración del entorno de pruebas.

Cada solicitud tiene un máximo de 10 segundos; solo los errores temporales se reintentan una vez, con una pausa breve. El presupuesto de toda la ejecución es 45 segundos. Los tamaños máximos son 128 KiB de HTML, 1 KiB de versión, 2 MiB por JavaScript y 512 KiB por CSS, con ocho entradas como máximo.

## Comprobación opcional del servicio de acceso

Configurar conjuntamente las variables públicas `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY`. Se validan con las mismas reglas que usa el portal. Se admite una clave `publishable` o la antigua clave `anon`; se rechazan las claves privilegiadas. Si ambas variables están ausentes, se omite esta parte; si solo hay una o son inválidas, el monitor falla antes de contactar con ningún destino.

La única petición adicional es GET a `/auth/v1/health` del proyecto validado, con su clave pública en `apikey`. No se manda una contraseña, un JWT de usuaria ni una clave de servidor. Esta respuesta confirma que el servicio responde; no demuestra que una usuaria pueda completar el inicio de sesión o que las políticas de datos estén bien configuradas.

## Resultado y avisos

El proceso devuelve código `0` si pasan todas las comprobaciones configuradas y `1` si alguna falla. Su salida contiene únicamente una frase resumida, la versión pública y cantidades de recursos. Los fallos usan mensajes cerrados: no se imprimen URLs obtenidas, parámetros, claves, cuerpos de respuestas, mensajes de excepciones ni documentos.

El workflow técnico puede ejecutar este comando cada seis horas en la rama operativa y manualmente. Los avisos de fallo los proporciona GitHub Actions según las preferencias de notificación de la cuenta; configurar la recepción de ejecuciones fallidas y comprobarla. No se habilita un envío automático desde el correo personal o el remitente de acceso de Orquivia.

El 28 de octubre de 2026 se comprobó en la cuenta operadora que los avisos de Actions están activados en GitHub y por correo, solo para ejecuciones fallidas. La dirección de destino coincide con la cuenta de la titular. Esto verifica la configuración, no la entrega efectiva.

Para comprobar el circuito con autorización de la destinataria, la ejecución manual admite `test_failure_notification=true`. Primero se realiza la comprobación normal del portal; después un trabajo independiente sin secretos ni permisos genera un fallo etiquetado expresamente como prueba. No se ejecuta en el horario automático, no modifica la aplicación ni comunica datos de la empresa. La destinataria debe confirmar que recibe el aviso antes de considerar verificado ese canal.

Un fallo exige revisar la ejecución y distinguir un problema transitorio de un despliegue incompleto. Si falla una entrada, revisar el último despliegue; si falla el servicio de acceso, revisar la disponibilidad del proyecto de Supabase. No repetir envíos comerciales ni cambiar datos para resolver un fallo del monitor.

## Qué no acredita

Un resultado correcto no certifica la seguridad del portal, la recepción del correo, la entrega de notificaciones, la integridad de los justificantes ni la existencia de copias completas. Las copias y sus restauraciones necesitan sus comprobaciones propias. Este monitor tampoco sustituye el seguimiento de cuota, los avisos de errores internos ni los ensayos de recuperación.

Pruebas sin red:

```text
node --test tests/operations-monitor.test.js
```
