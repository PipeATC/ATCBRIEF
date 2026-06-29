# RWYCAST — METAR refresh en Cloudflare Worker (refresco al minuto)

Reemplaza al job de GitHub Actions (`.github/workflows/metar.yml`). Baja los
METAR/SPECI de NOAA AWC **cada 1 minuto** y los publica en Firebase RTDB
(`/runcast/metars`), que la app RWYCAST lee en tiempo real.

**Por qué:** el cron de GitHub Actions tiene un mínimo real de ~5 min y se
retrasa/omite con frecuencia. El Cron Trigger de Cloudflare corre cada 1 min y
es puntual, así un **SPECI** llega a la app en ≤1 min en vez de hasta 10-15 min.

La lógica es la misma del YAML, portada a JavaScript en `worker.js`.

---

## Requisitos

- Una cuenta de Cloudflare (gratis). No necesitas tener tu dominio en Cloudflare:
  el Worker corre en `https://rwycast-metar.<tu-subdominio>.workers.dev`.
- Node.js instalado (para usar `wrangler`, la CLI de Cloudflare).

## Despliegue (paso a paso)

Desde esta carpeta (`cloudflare/`):

```bash
# 1. Instalar la CLI (una sola vez)
npm install -g wrangler

# 2. Iniciar sesión en Cloudflare (abre el navegador)
wrangler login

# 3. (Opcional, ver más abajo) guardar el secret de Firebase
wrangler secret put RTDB_SECRET

# 4. Desplegar
wrangler deploy
```

`wrangler deploy` registra automáticamente el Cron Trigger (`* * * * *`).

## Probar sin esperar al cron

El Worker expone un endpoint manual: abre en el navegador o con curl la URL que
te dio `wrangler deploy`:

```bash
curl https://rwycast-metar.<tu-subdominio>.workers.dev/
```

Devuelve un JSON con `{ ok, count, stations, updatedAt }`. Si `count > 0`, ya
escribió en RTDB y la app debería actualizarse al instante.

Para ver los logs en vivo del cron:

```bash
wrangler tail
```

## Variables

| Nombre        | Dónde            | Descripción                                            |
|---------------|------------------|--------------------------------------------------------|
| `RTDB_URL`    | `wrangler.toml`  | URL base de la RTDB, sin barra final.                  |
| `DEFAULTS`    | `wrangler.toml`  | Semilla de ICAO por si el estado aún no existe.        |
| `RTDB_SECRET` | `wrangler secret`| (Opcional) token de Firebase para escribir con auth.   |

## Endurecer Firebase (recomendado)

Hoy las reglas de `/runcast` están abiertas: cualquiera puede escribir los METAR.
Al migrar conviene cerrar la escritura para que **solo el Worker** pueda hacerlo:

1. En Firebase Console → **Project Settings → Service accounts → Database secrets**
   copia (o genera) un *database secret*.
2. Guárdalo en el Worker: `wrangler secret put RTDB_SECRET` y pega el secret.
   Con `RTDB_SECRET` definido, el Worker anexa `?auth=<secret>` a sus llamadas.
3. En las reglas de RTDB, deja `/runcast/metars` de **solo lectura** para el
   público y escritura solo con auth. Ejemplo:

   ```json
   {
     "rules": {
       "runcast": {
         "metars": {
           ".read": true,
           ".write": "auth != null"
         }
       }
     }
   }
   ```

   (El database secret se autentica como admin, así que `auth != null` se cumple
   para el Worker pero no para los clientes anónimos de la app.)

## Apagar el job viejo de GitHub Actions

Una vez verificado el Worker, desactiva el cron de GitHub para no escribir dos
veces. Opciones:

- Comentar el bloque `schedule:` en `.github/workflows/metar.yml`, **o**
- Deshabilitar el workflow desde la pestaña *Actions* del repo en GitHub.

(Conviene dejarlo unos días en paralelo como respaldo antes de apagarlo.)
