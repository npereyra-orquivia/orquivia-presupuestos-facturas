# Verificación y publicación

La ampliación conserva GitHub Pages y el entorno `github-pages`. Los cambios de esta rama no están activos hasta incorporarlos a la rama principal y comprobar su ejecución en GitHub.

## Qué comprueba el workflow

- Los cambios propuestos a `main` ejecutan pruebas de aplicación, todas las suites `supabase/tests/*-postgres.mjs`, análisis de dependencias y revisión de secretos del historial Git.
- Las suites SQL usan bases de datos en memoria con datos ficticios y se ejecutan secuencialmente para limitar memoria. No conectan con la empresa real.
- La compilación de una propuesta usa una URL y una clave pública ficticias. No publica el artefacto ni utiliza las variables de producción.
- La publicación solo se permite desde `main`, después de superar los trabajos anteriores, y conserva el entorno `github-pages`.
- Las Actions están fijadas por SHA. El permiso de publicación y el token de identidad solo pertenecen al trabajo de despliegue; los trabajos de pruebas tienen lectura del repositorio.
- Se mantienen la comprobación del artefacto público y los recursos de compatibilidad de las versiones anteriores.

Gitleaks redacta los valores detectados y tiene desactivados los comentarios, los artefactos de resultados y el resumen de hallazgos. `.gitleaksignore` identifica exclusivamente una clave ficticia de una prueba en un commit histórico; no excluye directorios de pruebas ni futuras coincidencias. La licencia de la Action es gratuita para el propietario individual actual; comprobar sus condiciones si el repositorio se traslada a una organización.

Dependabot propone actualizaciones de npm y GitHub Actions semanalmente. Las propuestas no se incorporan automáticamente. `npm run audit:security` ejecuta el informe completo de `npm audit --json --include=dev` y bloquea incidencias altas o críticas, salvo la excepción temporal exacta documentada abajo. No omite dependencias de desarrollo. Los avisos de menor gravedad también requieren revisión, aunque no bloqueen la publicación.

## Excepción temporal de picomatch: vence el 25 de noviembre de 2026

Revisión del 18/11/2026: [GHSA-fc5q-39xc-vjpf / CVE-2026-112366](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) afecta a picomatch hasta 4.0.7 y todavía no tiene una versión corregida publicada. La vulnerabilidad permite bloquear un proceso Node mediante patrones extglob manipulados. En este proyecto se usa dentro de Vite para compilar y desarrollar: los patrones proceden del código/configuración del repositorio, no de los documentos ni de entradas de las usuarias. GitHub Pages sirve el resultado estático; no ejecuta Vite ni picomatch. Esto reduce la exposición de esta aplicación, pero no corrige la dependencia ni elimina su riesgo durante desarrollo/compilación.

El control permite exclusivamente el aviso npm `source: 1247710`, URL GHSA anterior, paquete/dependencia `picomatch`, rango `<=4.0.7`, gravedad `high`, y esta cadena revisada del lockfile: picomatch 4.0.7, fdir 6.5.0, tinyglobby 0.2.17 y Vite 7.3.7. Los cuatro deben seguir siendo exclusivamente de desarrollo (`dev: true`). Solo se aceptan sus rutas raíz exactas, sin otras instalaciones anidadas. Las alertas heredadas de fdir, tinyglobby y Vite deben resolverse recursivamente hasta ese único aviso; sus nombres no constituyen exclusiones generales.

Un aviso alto/crítico distinto, cambio de versión o alcance, nodo desconocido, referencia sin resolver, ciclo, error de red/comando o informe malformado bloquea la publicación. La excepción caduca automáticamente el **25/11/2026 a las 00:00 UTC** usando el reloj del ejecutor. Las pruebas cubren estos límites. No se ha reducido Vite a una versión anterior, desactivado npm audit ni aplicado `--omit=dev`.

Antes de esa fecha, Nicole o la persona responsable del mantenimiento debe comprobar el aviso y las versiones publicadas. En cuanto exista un parche adecuado: actualizar el lockfile, ejecutar las pruebas y la compilación y retirar la excepción del script. No renovar su fecha automáticamente. Si no hay parche al vencer, revisar de nuevo la exposición y las alternativas antes de modificar la política; CI permanecerá bloqueado mientras aparezca el aviso caducado. Un árbol ya corregido y sin incidencias altas/críticas pasa aunque haya vencido la excepción.

## Ejecutar las verificaciones localmente

```powershell
npm ci
npm test
node scripts/verify-postgres.mjs
npm run audit:security
```

Las pruebas SQL no sustituyen las comprobaciones aisladas de Supabase Auth, Storage, recuperación de acceso, concurrencia con varias conexiones y entrega real de correo. No ejecutar pruebas de importación o restauración contra producción.

## Ajustes de GitHub que deben comprobarse por separado

La configuración remota no se activa editando un archivo del repositorio. Revisar la protección de `main` y exigir los trabajos «Pruebas de aplicación y permisos», «Revisar secretos en Git» y «Comprobar publicación y compatibilidad» antes de integrar cambios. Ajustar la revisión requerida al número real de personas autorizadas; no conceder acceso a otra cuenta solo para satisfacer una regla.

Comprobar también la protección del entorno `github-pages`, los permisos de las cuentas técnicas y las preferencias de avisos de ejecuciones fallidas. Un workflow presente no demuestra que esas protecciones o avisos estén configurados.

## Alcance de la supervisión

`operations-monitor.yml` comprueba la portada, la versión publicada, los recursos públicos y, si se configuran las dos variables públicas, la salud de Auth. Se programa cada seis horas en `main`; las ejecuciones programadas pueden retrasarse o dejar de ejecutarse según las condiciones de GitHub. No sustituye una supervisión con garantía de disponibilidad.

Una ejecución correcta no acredita una copia de seguridad, una restauración, un guardado autenticado ni un envío SMTP. El workflow no envía correos a clientes; las notificaciones de fallos dependen de las preferencias de GitHub de cada responsable. Consulta `MONITORING.md` para el contrato y los límites del comprobador.
