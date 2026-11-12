# Configuración futura de Supabase — RSVP de Hector & Elisbe

Esta etapa deja preparada la base de datos y las Edge Functions, pero **no se
ha conectado a ningún proyecto Supabase, no se han usado credenciales reales y
la invitación pública aún no llama a estas funciones**.

## Datos que se deben decidir antes de conectar

1. El proyecto Supabase que alojará los datos, su región y su URL.
2. El dominio definitivo de la invitación, por ejemplo
   `https://hector-elisbe.example`. Debe ser HTTPS y no llevar `/` al final.
3. Los orígenes permitidos: normalmente el dominio público y, si corresponde,
   su versión con `www`.
4. Al menos un correo de administrador. La contraseña se crea únicamente en
   Supabase Auth; nunca se añade a este repositorio.
5. La fecha y hora límite de RSVP en zona horaria de Chile. Mientras esté
   vacía, las respuestas podrán modificarse.

La capacidad inicial ya queda definida en **50 personas**. El endpoint
administrativo preparado permite modificarla, pero nunca por debajo de las
personas ya confirmadas ni de los pases de la familia activa con más cupos.
La suma de pases asignados puede ser superior a la capacidad: es una métrica
distinta y permite invitar más familias de las que finalmente confirmarán. Solo
los asistentes confirmados consumen cupos.

## 1. Crear el proyecto y obtener las claves correctas

1. Crea un proyecto PostgreSQL en el panel de Supabase.
2. En **Settings → API**, copia la URL del proyecto y la clave
   **publishable**. Esta última puede estar en un navegador cuando RLS está
   activo; no concede acceso directo a las tablas de este proyecto.
3. No copies una clave **secret** al sitio, al repositorio, a WhatsApp ni a
   este chat. Supabase la inyecta en las Edge Functions como
   `SUPABASE_SECRET_KEYS`. En proyectos antiguos puede aparecer bajo el nombre
   `SUPABASE_SERVICE_ROLE_KEY`; se usa solo como compatibilidad de servidor.

## 2. Configuración local, sin publicar secretos

Cuando se vaya a probar de forma local, crea el archivo ignorado
`supabase/functions/.env` a partir de
[`supabase/functions/.env.example`](supabase/functions/.env.example). Reemplaza
todos los ejemplos únicamente en tu copia local.

El repositorio ignora `.env` y sus variantes. Nunca agregues una clave real en
`js/`, `css/`, `index.html`, `admin/` ni en una migración SQL.

Variables propias necesarias en la función:

| Variable | Ejemplo | Dónde vive |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | `https://invitacion.example,https://www.invitacion.example` | secreto de Edge Function |
| `PUBLIC_INVITATION_URL` | `https://invitacion.example` | secreto de Edge Function |

`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEYS` y `SUPABASE_SECRET_KEYS` los
proporciona la plataforma. El último nunca llega al navegador.

## 3. Aplicar la base de datos cuando esté aprobado

Los siguientes comandos son una guía para el momento de la configuración; no
se ejecutaron durante esta etapa:

```bash
supabase login
supabase link --project-ref TU_PROJECT_REF
supabase db push
supabase functions deploy public-rsvp
supabase functions deploy admin-rsvp
```

La migración crea:

- `event_settings`, con el matrimonio del 9 de enero de 2027 y capacidad 50.
- `invitations`, con grupo, pases, estado y solo `token_hash`.
- `rsvp_responses` y `rsvp_attendees`, una fila por asistente.
- `rsvp_admins`, `rsvp_audit_log` y límites de solicitudes hasheados.

RLS queda activo en cada tabla y no existe una política de acceso directo para
`anon` ni `authenticated`. Las operaciones se realizan mediante funciones SQL
ejecutables únicamente con la clave de servidor desde las Edge Functions.

## 4. Crear administradores

1. Crea el usuario en **Authentication → Users** desde el panel de Supabase.
   Decide allí su método de inicio de sesión y contraseña o invitación por
   correo.
2. Copia su UUID y, desde el SQL Editor con una cuenta propietaria del
   proyecto, ejecútalo una sola vez:

```sql
insert into public.rsvp_admins (user_id)
values ('UUID_DEL_USUARIO_AUTH')
on conflict (user_id) do nothing;
```

3. Desactiva el registro público de nuevos usuarios de Auth. Solo las personas
   incluidas en `rsvp_admins` podrán utilizar el endpoint administrativo.

## 5. Cómo se comportan los enlaces de familia

La función administrativa crea 32 bytes aleatorios y entrega un enlace como:

```text
https://tu-dominio.example/#i=TOKEN_ALEATORIO
```

El fragmento `#i=` no viaja en las solicitudes HTTP habituales ni en el
referer. Al servidor solo llega el token dentro del cuerpo JSON de una llamada
con HTTPS. PostgreSQL conserva el hash SHA-256, no el token original.

Por decisión de seguridad, un enlace anterior **no puede recuperarse** desde
el panel. El panel de la siguiente etapa podrá copiar el enlace recién creado
o, si se perdió, generar uno nuevo. La regeneración invalida de inmediato el
anterior y conserva la familia y su respuesta.

## 6. Límites y validaciones ya preparados

- El enlace debe ser activo y válido; los revocados devuelven el mismo error
  que un enlace desconocido.
- Resolver un enlace se limita a 30 solicitudes por 10 minutos y enviar una
  respuesta a 8 por 10 minutos. Las claves de límite se guardan hasheadas.
- Las cantidades, pases, nombres completos y plazo se validan en PostgreSQL.
- `event_settings` se bloquea con `FOR UPDATE` durante cada confirmación,
  revocación o reactivación. Así, las solicitudes concurrentes no pueden
  superar la capacidad ni reactivar una familia con cupos ya ocupados.
- Una sola respuesta está permitida por familia. Al modificarla, se actualiza
  esa misma respuesta y se reemplaza su lista de asistentes de forma atómica.
- Los comentarios no se interpretan como una cifra oficial ni se guardan en la
  bitácora de auditoría.

## 7. Pruebas posteriores a la conexión

Con una instalación local de Supabase y Docker disponibles:

```bash
supabase start
supabase db reset
supabase test db
deno test --allow-none supabase/functions/_shared/security_test.ts
```

La prueba de base de datos está en
[`supabase/tests/001_rsvp_invariants.sql`](supabase/tests/001_rsvp_invariants.sql).
La prueba manual de dos sesiones para concurrencia está documentada en
[`supabase/tests/CONCURRENCY_TEST.md`](supabase/tests/CONCURRENCY_TEST.md).

La etapa siguiente conectará el formulario existente a `public-rsvp` y creará
el panel visual en `admin/`, sin introducir claves privadas en el frontend.
