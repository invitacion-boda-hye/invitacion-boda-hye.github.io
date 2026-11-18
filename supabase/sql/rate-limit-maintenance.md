# Mantenimiento de `rsvp_rate_limits`

La tabla conserva claves hasheadas por cada combinación de acción, IP y token, y hoy no tiene expiración. No se debe borrar en producción automáticamente desde el panel ni desde una Edge Function.

Cuando el tamaño justifique mantenimiento, un administrador puede ejecutar manualmente en SQL Editor lotes pequeños, fuera de una ventana de RSVP intensivo:

```sql
delete from public.rsvp_rate_limits
where ctid in (
  select ctid
  from public.rsvp_rate_limits
  where window_started_at < clock_timestamp() - interval '24 hours'
  limit 10000
);
```

Repetir sólo mientras haya filas afectadas. El umbral de 24 horas es mucho mayor que la ventana vigente de 10 minutos, por lo que no debilita el rate limit activo. No requiere migración ni cambios de esquema.
