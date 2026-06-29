/**
 * RWYCAST — METAR/SPECI refresh (Cloudflare Worker + Cron Trigger)
 * ----------------------------------------------------------------
 * Reemplaza al job de GitHub Actions (.github/workflows/metar.yml).
 * Corre cada 1 minuto (ver crons en wrangler.toml), baja los METAR/SPECI
 * de NOAA AWC y los publica en Firebase RTDB (/runcast/metars). La app
 * RWYCAST los lee en tiempo real (subscribeMetars en index.html).
 *
 * Ventaja vs GitHub Actions: el cron mínimo aquí es de 1 min y es puntual,
 * así un SPECI llega a la app en ≤1 min en vez de hasta 10-15 min.
 *
 * Variables (wrangler.toml [vars] + secrets):
 *   RTDB_URL        URL base de la Realtime Database (sin barra final).
 *   DEFAULTS        Semilla de ICAO por si el estado aún no existe en RTDB.
 *   RTDB_SECRET     (secret, opcional) database secret / token de Firebase.
 *                   Si está definido, se anexa ?auth=... a las llamadas RTDB
 *                   para poder endurecer las reglas a solo-escritura del Worker.
 */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshMetars(env));
  },

  // Endpoint manual para probar/forzar una corrida desde el navegador o curl.
  // GET https://<worker>.workers.dev/  → ejecuta el refresco y devuelve el resumen.
  async fetch(request, env) {
    try {
      const result = await refreshMetars(env);
      return json(result, 200);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err) }, 500);
    }
  },
};

async function refreshMetars(env) {
  const RTDB_URL = (env.RTDB_URL || '').replace(/\/+$/, '');
  if (!RTDB_URL) throw new Error('Falta RTDB_URL');

  const DEFAULTS = env.DEFAULTS || 'SCEL,SCDA,SCFA,SCIE,SCTE,SCCI';
  const auth = env.RTDB_SECRET ? `?auth=${encodeURIComponent(env.RTDB_SECRET)}` : '';

  // 1) Lee los aeródromos dados de alta en la app (estado compartido en RTDB).
  //    Cualquier unidad agregada desde el módulo Catálogo aparece aquí, así su
  //    METAR se descarga sin tocar este Worker.
  let state = null;
  try {
    const r = await fetch(`${RTDB_URL}/runcast/state/v1/airports.json${auth}`, {
      cf: { cacheTtl: 0 },
    });
    if (r.ok) state = await r.json();
  } catch (_) {
    // si falla la lectura del estado seguimos con la semilla DEFAULTS
  }

  const dynamic = extractIcaos(state);

  // Une semilla + dinámica, normaliza (solo alfanumérico, mayúsculas) y deduplica.
  const stations = Array.from(
    new Set(
      `${DEFAULTS},${dynamic.join(',')}`
        .split(',')
        .map((s) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase())
        .filter(Boolean)
    )
  ).sort();

  if (!stations.length) throw new Error('Sin estaciones que consultar');

  // 2) Pide los METAR/SPECI a NOAA AWC en JSON.
  const url = `https://aviationweather.gov/api/data/metar?ids=${stations.join(',')}&format=json`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'RWYCAST/1.0 (+metar-refresh)' },
    cf: { cacheTtl: 0 },
  });
  if (!resp.ok) throw new Error(`AWC respondió ${resp.status}`);
  const raw = await resp.json();

  // 3) Transforma el arreglo de AWC a { ICAO: {raw,cat,obsTime,updatedAt} }.
  const now = Math.floor(Date.now() / 1000);
  const payload = {};
  for (const ob of Array.isArray(raw) ? raw : []) {
    if (!ob || ob.icaoId == null || ob.rawOb == null) continue;
    payload[ob.icaoId] = {
      raw: ob.rawOb,
      cat: ob.fltCat || '',
      obsTime: ob.obsTime,
      updatedAt: now,
    };
  }

  const count = Object.keys(payload).length;
  if (count === 0) {
    // No pisamos los datos anteriores con un objeto vacío.
    return { ok: false, count: 0, stations, msg: 'Sin METAR válidos; no se escribe.' };
  }

  // 4) PUT reemplaza por completo /runcast/metars con el lote más reciente.
  const put = await fetch(`${RTDB_URL}/runcast/metars.json${auth}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!put.ok) throw new Error(`RTDB PUT respondió ${put.status}`);

  return { ok: true, count, stations, updatedAt: now };
}

// Acepta el estado como arreglo [{icao}] u objeto {id:{icao}} y devuelve los ICAO.
function extractIcaos(state) {
  if (Array.isArray(state)) return state.map((a) => a && a.icao).filter(Boolean);
  if (state && typeof state === 'object') {
    return Object.values(state)
      .map((a) => a && a.icao)
      .filter(Boolean);
  }
  return [];
}

function json(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
