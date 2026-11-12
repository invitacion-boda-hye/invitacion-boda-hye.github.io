# Regresión de acceso administrativo

## Diagnóstico comprobado y reparación

El 503 `ADMIN_MEMBERSHIP_CHECK_FAILED` envolvía un HTTP 403 de PostgREST,
SQLSTATE `42501`, `permission denied for table rsvp_admins`.
Los registros PostgreSQL mostraban el mismo mensaje. `service_role` tenía
BYPASSRLS y EXECUTE de las RPC, pero carecía de SELECT sobre las tablas que
consulta directamente la Edge Function. La migración inicial restringía los
roles públicos y concedía EXECUTE, pero no concedía esas lecturas al servidor.

Se aplicó `202611120001_admin_read_privileges.sql` y se registró como aplicada
en el historial. Solo concede SELECT de las columnas usadas por membresía y
listado de familias. RLS sigue activo; `anon` y `authenticated` siguen sin
SELECT. No concede acceso directo a token_hash, comentarios ni escrituras.
No es necesario redesplegar funciones: la corrección es de privilegios SQL.

## Pruebas reproducibles

Desde la raíz del repositorio, con el CLI ya autenticado:

```bash
node tests/admin-flow.test.cjs
npx --no-install supabase db query --remote=ldgybrbdbpbfbgarglkt --read-only --file tests/admin-privileges.sql
node tests/admin-postgrest-check.cjs
```

La prueba SQL falla con `division_by_zero` si se rompe una garantía. Antes de
la corrección falló; después devolvió `permissions_regression_passed: 1`.

La prueba PostgREST obtiene la clave default mediante el CLI y la mantiene
exclusivamente en memoria. Comprueba formato y digest del mapa reservado
SUPABASE_SECRET_KEYS, consulta un UUID administrativo sin imprimirlo y prueba
el resumen con ese actor. No modifica registros ni muestra métricas personales.
El listado usa `limit=0` para comprobar columnas, relación y privilegios sin
descargar familias. Solo imprime estados HTTP y códigos de error.

Resultado después de aplicar: membresía 200, listado 200, resumen 200;
resumen sin actor rechazado con `P0001 / ADMIN_UNAUTHORIZED`.

Estas pruebas validan el acceso privilegiado que usa el servidor, no sustituyen
el inicio de sesión del navegador. Para comprobar el recorrido completo,
revoca primero la sesión anteriormente expuesta e inicia sesión de nuevo en
http://localhost:8086/admin/ con tus credenciales en el formulario. Comprueba
que se muestran métricas y familias. No copies tokens a este documento, al
chat, a comandos ni a registros. La validación Auth + rsvp_admins de la Edge
Function permanece sin cambios.
