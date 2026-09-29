/**
 * voz.js — el córtex motor / lenguaje. SOLO traduce a palabras lo que el cerebro ya decidió.
 * No guarda estado ni decide nada: recibe mensajes, devuelve texto.
 *
 * Usa el SDK oficial de OpenAI apuntando a Pollinations (API compatible con OpenAI).
 */
import OpenAI from 'openai';

// Acepta varios nombres de variable y limpia espacios, saltos de línea o comillas que se cuelan al pegar la key
const KEY = (process.env.POLLINATIONS_API_KEY || process.env.POLLINATIONS_KEY || process.env.POLLINATIONS_TOKEN || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/^Bearer\s+/i, '')
    .trim();

const MODELO = process.env.POLLINATIONS_MODEL || 'openai';

const cliente = new OpenAI({
    baseURL: process.env.POLLINATIONS_BASE_URL || 'https://gen.pollinations.ai/v1',
    apiKey: KEY || 'sin-key',                      // el SDK exige un valor; si no hay key se quita la cabecera:
    defaultHeaders: KEY ? undefined : { Authorization: null },
    timeout: 30_000,
    maxRetries: 1
});

export const infoVoz = () => (KEY
    ? `[VOZ] Pollinations key detectada (empieza por "${KEY.slice(0, 3)}", ${KEY.length} caracteres). Modelo: ${MODELO}.`
    : '[VOZ] ATENCIÓN: no hay key de Pollinations (POLLINATIONS_API_KEY). Se intentará sin autenticación.');

/** Una llamada al modelo con reintentos: algunos modelos rechazan ciertos parámetros (400), así que se va quitando lo opcional. */
async function llamar({ messages, temperature, maxTokens, extra, tools, toolChoice }) {
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
            return await cliente.chat.completions.create({ model: MODELO, messages, ...intentos[i] });
        } catch (e) {
            if (e?.status === 400 && i < intentos.length - 1) continue;
            if (e?.status === 401) {
                console.error(KEY
                    ? `[VOZ] 401: Pollinations rechazó la key (empieza por "${KEY.slice(0, 3)}", ${KEY.length} caracteres). Debe ser una key de https://enter.pollinations.ai/keys (sk_...).`
                    : '[VOZ] 401: no se envió ninguna key. Define POLLINATIONS_API_KEY en las variables de entorno de Render y vuelve a desplegar.');
            }
            throw e;
        }
    }
    return null;
}

const MAX_LLAMADAS_POR_RONDA = 3;

/**
 * @param {{messages: Array, temperature?: number, maxTokens?: number, extra?: object,
 *          tools?: Array, ejecutarHerramienta?: (nombre: string, args: object) => Promise<string>, maxRondas?: number}} p
 * @returns {Promise<string>}
 *
 * Sin `tools` se comporta como antes (una llamada, devuelve texto). Con `tools`, si el modelo pide una herramienta,
 * se ejecuta con `ejecutarHerramienta` (que decide QUÉ se permite), se le devuelve el resultado y se vuelve a llamar,
 * hasta `maxRondas`. En la última ronda se le prohíbe pedir más herramientas para que cierre con texto.
 */
export async function voz({ messages, temperature = 0.7, maxTokens = 160, extra = {}, tools, ejecutarHerramienta, maxRondas = 3 }) {
    const usaTools = !!(tools?.length && ejecutarHerramienta);
    const msgs = [...messages];
    for (let ronda = 0; ; ronda++) {
        const ultima = ronda >= maxRondas;
        const r = await llamar({
            messages: msgs, temperature, maxTokens, extra,
            tools: usaTools ? tools : null, toolChoice: ultima ? 'none' : 'auto'
        });
        const m = r?.choices?.[0]?.message;
        const pedidas = usaTools && !ultima ? m?.tool_calls : null;
        if (!pedidas?.length) return m?.content ?? '';

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
