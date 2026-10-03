/**
 * voz.js — conexión con las IAs.
 *  - voz():    texto con el SDK oficial de OpenAI contra varios proveedores compatibles
 *              (Gemini, Groq, OpenRouter, Pollinations). Si uno falla o se queda sin cuota,
 *              pasa solo al siguiente. Soporta function calling.
 *  - imagen(): genera una imagen con Pollinations y devuelve un Buffer.
 *
 * Variables de entorno (pon solo las de las IAs que quieras usar):
 *   GEMINI_API_KEY      + GEMINI_MODEL      (https://aistudio.google.com/apikey)
 *   GROQ_API_KEY        + GROQ_MODEL        (https://console.groq.com/keys)
 *   OPENROUTER_API_KEY  + OPENROUTER_MODEL  (https://openrouter.ai/keys)
 *   POLLINATIONS_API_KEY + POLLINATIONS_MODEL (respaldo final y generación de imágenes)
 *   IA_ORDEN=gemini,groq,openrouter,pollinations   (orden de prioridad)
 */
import OpenAI from 'openai';
import axios from 'axios';

// Limpia espacios, saltos de línea o comillas que se cuelan al pegar una key
const limpiarKey = (v) => String(v || '').trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/^Bearer\s+/i, '')
    .trim();

const KEY = limpiarKey(process.env.POLLINATIONS_API_KEY || process.env.POLLINATIONS_KEY || process.env.POLLINATIONS_TOKEN);
const IMG_BASE = (process.env.POLLINATIONS_IMAGE_URL || 'https://gen.pollinations.ai/image').replace(/\/+$/, '');
const IMG_MODELO = process.env.POLLINATIONS_IMAGE_MODEL || 'flux';

/* ------------------------------ Proveedores de texto ------------------------------ */

// Los límites gratuitos y los nombres de modelo cambian seguido: si alguno da 404, ajusta su *_MODEL en el .env.
const CATALOGO = {
    gemini: {
        key: limpiarKey(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        modelo: process.env.GEMINI_MODEL || 'gemini-3.6-flash'
    },
    groq: {
        key: limpiarKey(process.env.GROQ_API_KEY),
        baseURL: 'https://api.groq.com/openai/v1',
        modelo: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
    },
    openrouter: {
        key: limpiarKey(process.env.OPENROUTER_API_KEY),
        baseURL: 'https://openrouter.ai/api/v1',
        modelo: process.env.OPENROUTER_MODEL || 'openrouter/free'
    },
    pollinations: {
        key: KEY,
        baseURL: process.env.POLLINATIONS_BASE_URL || 'https://gen.pollinations.ai/v1',
        modelo: process.env.POLLINATIONS_MODEL || 'openai',
        sinKey: true // funciona (limitado) sin key
    }
};

const ORDEN = (process.env.IA_ORDEN || 'gemini,groq,openrouter,pollinations')
    .split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

const PROVEEDORES = ORDEN
    .filter((id) => CATALOGO[id] && (CATALOGO[id].key || CATALOGO[id].sinKey))
    .map((id) => ({ id, ...CATALOGO[id], cliente: null, pausa: 0 }));

function clienteDe(p) {
    if (!p.cliente) {
        p.cliente = new OpenAI({
            baseURL: p.baseURL,
            apiKey: p.key || 'sin-key',                       // el SDK exige un valor; si no hay key se quita la cabecera
            defaultHeaders: p.key ? undefined : { Authorization: null },
            timeout: 45_000,
            maxRetries: 0                                     // el respaldo lo hacemos nosotros pasando a otra IA
        });
    }
    return p.cliente;
}

export const infoVoz = () => (PROVEEDORES.length
    ? `[VOZ] IAs de texto (en orden): ${PROVEEDORES.map((p) => `${p.id}:${p.modelo}`).join(' -> ')}. Imagen: Pollinations ${IMG_MODELO}${KEY ? '' : ' (sin key)'}.`
    : '[VOZ] ATENCIÓN: no hay ninguna IA configurada. Define GEMINI_API_KEY, GROQ_API_KEY u OPENROUTER_API_KEY.');

function avisar401() {
    console.error(KEY
        ? `[VOZ] 401: Pollinations rechazó la key (empieza por "${KEY.slice(0, 3)}", ${KEY.length} caracteres). Debe ser una key de https://enter.pollinations.ai/keys (sk_...).`
        : '[VOZ] 401: no se envió ninguna key a Pollinations. Define POLLINATIONS_API_KEY en las variables de entorno y vuelve a desplegar.');
}

/* ------------------------------ Llamadas con respaldo ------------------------------ */

/** Tras un fallo, ese proveedor descansa un rato para no gastar intentos (429 = cuota, 401/403/404 = key o modelo mal). */
function pausar(p, e) {
    if (e?.vacia) return;
    const s = e?.status;
    const ms = s === 429 ? 60_000
        : (s === 401 || s === 403 || s === 404) ? 10 * 60_000
        : (!s || s >= 500) ? 15_000
        : 0;
    if (ms) p.pausa = Date.now() + ms;
}

function candidatos(preferido) {
    const base = preferido ? [preferido, ...PROVEEDORES.filter((p) => p !== preferido)] : PROVEEDORES;
    const libres = base.filter((p) => p.pausa <= Date.now());
    return libres.length ? libres : base; // si todos descansan, se prueban igual
}

// Gemini añade datos propios a las llamadas a herramientas; los demás proveedores no los aceptan
const sinExtras = (msgs) => msgs.map((m) => (m.tool_calls
    ? { ...m, tool_calls: m.tool_calls.map(({ extra_content, ...t }) => t) }
    : m));

/** Una llamada a UN proveedor. Algunos modelos rechazan ciertos parámetros (400), así que se va quitando lo opcional. */
async function llamarProveedor(p, messages, { temperature, maxTokens, extra, tools, toolChoice }) {
    const base = { temperature, max_tokens: maxTokens };
    const conTools = tools?.length ? { tools, tool_choice: toolChoice } : {};
    const intentos = [
        { ...base, ...extra, ...conTools },
        { ...base, ...conTools },
        ...(tools?.length ? [base] : []),   // el modelo no acepta herramientas: se responde solo con texto
        {}
    ];
    for (let i = 0; i < intentos.length; i++) {
        try {
            const r = await clienteDe(p).chat.completions.create({ model: p.modelo, messages, ...intentos[i] });
            const m = r?.choices?.[0]?.message;
            if (!m || (!m.content && !m.tool_calls?.length)) throw Object.assign(new Error('respuesta vacía'), { vacia: true });
            return r;
        } catch (e) {
            if (e?.status === 400 && i < intentos.length - 1) continue;
            throw e;
        }
    }
    return null;
}

/** Prueba los proveedores en orden hasta que uno responda. Devuelve la respuesta y quién la dio. */
async function llamar({ messages, ...resto }, preferido) {
    let ultimo;
    for (const p of candidatos(preferido)) {
        try {
            const r = await llamarProveedor(p, p.id === 'gemini' ? messages : sinExtras(messages), resto);
            return { r, p };
        } catch (e) {
            ultimo = e;
            pausar(p, e);
            if (e?.status === 401 && p.id === 'pollinations') avisar401();
            console.error(`[VOZ] ${p.id} (${p.modelo}) falló: ${e?.status ?? e?.code ?? ''} ${String(e?.message || '').slice(0, 160)}`);
        }
    }
    throw ultimo ?? new Error('No hay ninguna IA configurada');
}

// Algunos modelos de razonamiento devuelven su "pensamiento" entre etiquetas
const quitarPensamiento = (t) => String(t ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

const MAX_LLAMADAS_POR_RONDA = 3;

/**
 * @param {{messages: Array, temperature?: number, maxTokens?: number, extra?: object,
 *          tools?: Array, ejecutarHerramienta?: (nombre: string, args: object) => Promise<string>, maxRondas?: number}} p
 * @returns {Promise<string>}
 *
 * Sin `tools` hace una llamada y devuelve texto. Con `tools`, si el modelo pide una herramienta se ejecuta con
 * `ejecutarHerramienta`, se le devuelve el resultado y se vuelve a llamar, hasta `maxRondas`.
 */
export async function voz({ messages, temperature = 0.7, maxTokens = 800, extra = {}, tools, ejecutarHerramienta, maxRondas = 2 }) {
    const usaTools = !!(tools?.length && ejecutarHerramienta);
    const msgs = [...messages];
    let preferido = null; // la IA que respondió primero sigue con la conversación de herramientas
    for (let ronda = 0; ; ronda++) {
        const ultima = ronda >= maxRondas;
        const { r, p } = await llamar({
            messages: msgs, temperature, maxTokens, extra,
            tools: usaTools ? tools : null, toolChoice: ultima ? 'none' : 'auto'
        }, preferido);
        preferido = p;
        const m = r.choices[0].message;
        const pedidas = usaTools && !ultima ? m.tool_calls : null;
        if (!pedidas?.length) return quitarPensamiento(m.content);

        msgs.push({ role: 'assistant', content: m.content ?? null, tool_calls: pedidas });
        for (const [k, t] of pedidas.entries()) {
            let salida;
            if (k >= MAX_LLAMADAS_POR_RONDA) salida = 'omitido: demasiadas herramientas a la vez';
            else {
                let args = {};
                try { args = JSON.parse(t.function?.arguments || '{}'); } catch { /* argumentos mal formados: se llama sin ellos */ }
                try { salida = await ejecutarHerramienta(t.function?.name, args); }
                catch (e) { salida = `error: ${e.message}`; }
            }
            msgs.push({ role: 'tool', tool_call_id: t.id, content: String(salida ?? '').slice(0, 1500) });
        }
    }
}

/* ------------------------------ Imágenes ------------------------------ */

/**
 * Genera una imagen con Pollinations. Devuelve un Buffer (jpeg/png).
 * Si tu cuenta usa otra URL o modelo: POLLINATIONS_IMAGE_URL y POLLINATIONS_IMAGE_MODEL en el .env.
 */
export async function imagen(prompt, { ancho = 1024, alto = 1024 } = {}) {
    const r = await axios.get(`${IMG_BASE}/${encodeURIComponent(prompt)}`, {
        params: { model: IMG_MODELO, width: ancho, height: alto, nologo: true, seed: Math.floor(Math.random() * 1e9) },
        headers: KEY ? { Authorization: `Bearer ${KEY}` } : {},
        responseType: 'arraybuffer',
        timeout: 90_000,
        validateStatus: () => true
    });
    const tipo = String(r.headers['content-type'] || '');
    if (r.status !== 200 || !tipo.startsWith('image/')) {
        if (r.status === 401) avisar401();
        const detalle = Buffer.from(r.data || '').toString('utf8').slice(0, 200).replace(/\s+/g, ' ');
        throw new Error(`imagen Pollinations ${r.status}: ${detalle}`);
    }
    return Buffer.from(r.data);
}
