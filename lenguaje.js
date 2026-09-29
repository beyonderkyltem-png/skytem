/**
 * lenguaje.js — utilidades de texto PURAS (sin base de datos ni red).
 * Aquí vive todo lo que es "procesar palabras": normalizar, raíces para recordar por tema,
 * detección de repetición/eco, estilo de escritura de cada persona y captura de nombre/hechos por reglas.
 */

export const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
export const soloNum = (j) => String(j ?? '').split('@')[0].split(':')[0];
export const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export const nombreUtil = (n) => (String(n ?? '').match(/\p{L}/gu) || []).length >= 2;
export const limpiar = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/* ------------------------- Saludos / hilos de conversación ------------------------- */

const APERTURA_FUERTE = /^(h+o+l+a+s*|holi+s*|wenas+|buenas( tardes| noches| dias)?$|buenos dias|buen dia|hello|hi|saludos|alo+)( |$)/;
const APERTURA_SUAVE = /^(hey+|ey+|epa+|que tal|q tal|que onda|que hubo|como estas|como andas|como va|como te va)( |$)/;
const CAMBIO_TEMA = /\b(cambiando de tema|cambio de tema|cambiemos de tema|cambiando de asunto|ahora otro tema|otra cosa)\b/;

export function esApertura(texto) {
    const t = norm(texto).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return false;
    if (CAMBIO_TEMA.test(t)) return true;
    const n = t.split(' ').length;
    return (n <= 6 && APERTURA_FUERTE.test(t)) || (n <= 3 && APERTURA_SUAVE.test(t));
}

/** La conversación ACTUAL: mensajes pegados al último (sin silencios largos), desde el último saludo de esta persona. */
export function hiloActual(recientes, jid, { max = 25, gap = 15 * 60 * 1000 } = {}) {
    const r = recientes || [];
    if (!r.length) return [];
    const hilo = [];
    let siguiente = r[r.length - 1].ts || 0;
    for (let i = r.length - 1; i >= 0 && hilo.length < max; i--) {
        const m = r[i];
        if (siguiente - (m.ts || 0) > gap) break;
        siguiente = m.ts || siguiente;
        if (m.b && m.p && m.p !== jid) continue; // el bot le hablaba a otro: es otra charla
        hilo.unshift(m);
        if (!m.b && m.j === jid && esApertura(m.t)) break;
    }
    return hilo;
}

/* ------------------------- Relevancia por raíces ------------------------- */

const RELLENO = new Set([
    'para', 'pero', 'como', 'esta', 'este', 'esto', 'esos', 'esas', 'estoy', 'estas', 'porque', 'cuando', 'donde',
    'tiene', 'tengo', 'solo', 'muy', 'mucho', 'poco', 'bien', 'pues', 'entonces', 'ahora', 'aqui', 'alli', 'todo',
    'todos', 'algo', 'nada', 'cosa', 'cosas', 'hacer', 'hace', 'tambien', 'aunque', 'sobre', 'desde', 'hasta',
    'entre', 'quiero', 'puedo', 'vamos', 'dime', 'digo', 'dice', 'jaja', 'jajaja', 'hola', 'gracias', 'grupo', 'hablan', 'hablar'
]);

/** Palabras con contenido recortadas a 5 letras (trabajo/trabaja/trabajando coinciden). */
export const raices = (t) => new Set(
    norm(t).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !RELLENO.has(w)).map((w) => w.slice(0, 5))
);

export const coincidencias = (t, refSet) => {
    let n = 0;
    for (const r of raices(t)) if (refSet.has(r)) n++;
    return n;
};

export function relevantes(items, referencia, { min = 1, max = 5 } = {}) {
    const ref = raices(referencia);
    if (!ref.size) return [];
    return (items || []).filter((it) => coincidencias(it, ref) >= min).slice(-max);
}

/* ------------------------- Repetición y eco ------------------------- */

const tokens = (t) => norm(t).split(/[^a-z0-9]+/).filter(Boolean);

export function esEco(salida, texto) {
    const a = tokens(salida);
    const b = tokens(texto);
    if (!a.length || !b.length) return false;
    if (b.length < 3) return a.length >= 3 && b.length === 1 && b[0].length >= 4 && a[0] === b[0];
    if (a.length < 3) return false;
    if (a.slice(0, 3).join(' ') === b.slice(0, 3).join(' ')) return true;
    const A = new Set(a);
    const B = new Set(b);
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    return inter / (A.size + B.size - inter) >= 0.6;
}

export function esRepetido(candidato, previos) {
    const a = tokens(candidato);
    if (a.length < 3) return false;
    const A = new Set(a);
    return (previos || []).some((p) => {
        const b = tokens(p);
        if (b.length < 3) return false;
        const B = new Set(b);
        let inter = 0;
        for (const w of A) if (B.has(w)) inter++;
        const jaccard = inter / (A.size + B.size - inter);
        const mismoArranque = a.length >= 5 && b.length >= 5 && a.slice(0, 4).join(' ') === b.slice(0, 4).join(' ');
        return jaccard >= 0.7 || mismoArranque;
    });
}

/* ------------------------- Preguntas de cortesía / repetidas ------------------------- */

// "y tú qué tal", "cómo estás", "qué cuentas"... (sobre texto normalizado y sin signos)
const CORTESIA = /^(y (tu|vos|usted|contigo|a ti|por ahi)\b|(tu|vos) (como|que)\b|que tal tu\b|como (estas|andas|vas|te va|te fue)\b|que cuentas\b|que me cuentas\b|en que andas\b|todo bien$)/;
const INTERROGATIVA = /^(que|como|cuando|donde|quien|cual|cuanto|por que|porque|puedes|sabes|crees)\b/;
const sentencias = (t) => String(t ?? '').split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
const sinSignos = (s) => norm(s).replace(/[¿¡?!.,;:…]/g, '').replace(/\s+/g, ' ').trim();
const esPregunta = (s) => /\?\s*$/.test(s) || CORTESIA.test(sinSignos(s)) || INTERROGATIVA.test(sinSignos(s));

/** ¿El mensaje termina preguntando algo? (el bot a veces omite el "?", así que también se mira la forma) */
export function terminaEnPregunta(texto) {
    const ult = sentencias(String(texto ?? '').split('\n').filter(Boolean).pop() || '').pop();
    return !!ult && esPregunta(ult);
}

/**
 * Quita del FINAL de la respuesta la pregunta que sobra: de cortesía ("y tú qué tal"), repetida respecto a
 * las que el bot ya hizo, o cualquier pregunta si su mensaje anterior ya terminaba en una (`seguidas`).
 * Nunca deja el mensaje vacío. Con `permitirNombre` respeta la pregunta de "cómo te dicen" (toca preguntar el nombre).
 */
const PIDE_NOMBRE = /\b(como te (dicen|llamas|digo)|tu nombre|como quieres que te)\b/;

export function quitarPreguntaFinal(texto, { previos = [], seguidas = false, permitirNombre = false } = {}) {
    const lineas = String(texto ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    const previas = previos.flatMap(sentencias).filter(esPregunta);
    const molesta = (q) => !(permitirNombre && PIDE_NOMBRE.test(sinSignos(q)))
        && (CORTESIA.test(sinSignos(q)) || seguidas || esRepetido(q, previas));
    let cambio = false;
    while (lineas.length) {
        const s = sentencias(lineas[lineas.length - 1]);
        const q = s[s.length - 1];
        const coma = q ? q.lastIndexOf(',') : -1;                       // "bien, y tú?" → "bien"
        if (coma > 0 && CORTESIA.test(sinSignos(q.slice(coma + 1)))) {
            s[s.length - 1] = q.slice(0, coma).trim();
            lineas[lineas.length - 1] = s.join(' ');
            cambio = true;
            break;
        }
        if (!q || !esPregunta(q) || !molesta(q)) break;
        const resto = s.slice(0, -1).join(' ');
        if (resto) { lineas[lineas.length - 1] = resto; cambio = true; break; }
        if (lineas.length < 2) break;
        lineas.pop();
        cambio = true;
    }
    return cambio ? lineas.join('\n') : texto;
}

/* ------------------------- Estilo de escritura ------------------------- */

const RISA = /^(?:j[aeiosj]){2,}[a-z]*$|^(?:ha){2,}h?$|^k{3,}$|^xd+$/i;
const ABREV = new Set(['q', 'pq', 'xq', 'tmb', 'tb', 'toy', 'ta', 'pa', 'ntp', 'xfa', 'bn', 'nose']);
export const ESTILO_DEFAULT = { minusculas: true, sinPunto: true, sinApertura: true, sinTildes: false, risa: '', abrevia: [], alarga: false, palabras: 0 };

export function analizarEstilo(muestras) {
    const ms = (muestras || []).map((m) => String(m || '').trim()).filter(Boolean);
    if (ms.length < 4) return null;
    const n = ms.length;
    const texto = ms.join(' ');
    const toks = texto.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const risas = {};
    const abrev = new Set();
    for (const tk of toks) {
        if (RISA.test(tk)) risas[tk] = (risas[tk] || 0) + 1;
        if (ABREV.has(tk)) abrev.add(tk);
    }
    const risa = Object.entries(risas).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const sinMayus = ms.filter((m) => !/\p{Lu}/u.test(m)).length;
    const conPunto = ms.filter((m) => /(?<!\.)\.$/.test(m)).length;
    const preguntas = ms.filter((m) => /\?/.test(m));
    const conApertura = preguntas.filter((m) => /¿/.test(m)).length;
    const letras = (texto.match(/\p{L}/gu) || []).length;
    const tildes = (texto.match(/[áéíóú]/gi) || []).length;
    return {
        minusculas: sinMayus / n >= 0.7,
        sinPunto: conPunto / n <= 0.15,
        sinApertura: preguntas.length === 0 ? true : conApertura / preguntas.length < 0.3,
        sinTildes: letras >= 150 && tildes / letras < 0.002,
        risa,
        abrevia: [...abrev].slice(0, 5),
        alarga: ms.filter((m) => /(\p{L})\1{2,}/u.test(m)).length >= 2,
        palabras: Math.round(toks.length / n)
    };
}

export function adaptarEstilo(texto, e = ESTILO_DEFAULT) {
    let t = String(texto ?? '');
    if (e.risa) t = t.replace(/\p{L}+/gu, (w) => (RISA.test(w) ? e.risa : w));
    if (e.sinApertura) t = t.replace(/[¿¡]/g, '');
    if (e.sinPunto) t = t.replace(/(?<!\.)\.\s*$/, '');
    if (e.minusculas) t = t.toLowerCase();
    if (e.sinTildes) {
        t = t.replace(/ñ/g, '\u0001').replace(/Ñ/g, '\u0002')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/\u0001/g, 'ñ').replace(/\u0002/g, 'Ñ');
    }
    return t.trim();
}

export function describirEstilo(e) {
    const l = [e.minusculas ? 'todo en minúsculas, incluidas las risas' : 'mayúsculas normales'];
    if (e.sinPunto) l.push('sin punto final');
    if (e.sinApertura) l.push('sin ¿ ni ¡');
    if (e.sinTildes) l.push('sin tildes');
    if (e.risa) l.push(`se ríe con "${e.risa}"`);
    if (e.abrevia?.length) l.push(`abrevia (${e.abrevia.join(', ')})`);
    if (e.alarga) l.push('alarga letras cuando se emociona (holaaa)');
    if (e.palabras) l.push(`mensajes de unas ${e.palabras} palabras: responde con un largo parecido`);
    return l.map((x) => `- ${x}`).join('\n');
}

/* ------------------------- Salida del modelo ------------------------- */

/** Si el modelo escribió "RESPUESTA: ..." se queda con eso; quita restos de formato interno. */
export function extraerRespuesta(bruto) {
    const t = String(bruto ?? '');
    const marcas = [...t.matchAll(/RESPUESTA\s*:/gi)];
    if (marcas.length) {
        const m = marcas[marcas.length - 1];
        return t.slice(m.index + m[0].length).trim();
    }
    return t.replace(/^\s*(PENSAR|PARA_MI)\s*:[^\n]*(\n|$)/gi, '').trim();
}

export function limpiarSalida(texto) {
    let t = String(texto ?? '').trim();
    t = t.replace(/^\s*(skytem|sky)\s*:\s*/i, '');
    t = t.replace(/\*\*/g, '');
    t = t.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu, '');
    t = t.replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n');
    return t.trim();
}

export function partirMensajes(texto, maxMensajes = 2, maxChars = 280) {
    return texto
        .split(/\n+/)
        .map((s) => s.trim().replace(/^["“”'`]+|["“”'`]+$/g, '').trim())
        .filter(Boolean)
        .slice(0, maxMensajes)
        .map((s) => s.slice(0, maxChars));
}

export function extraerJSON(texto) {
    if (!texto) return null;
    const limpio = String(texto).replace(/```json|```/gi, '');
    const ini = limpio.indexOf('{');
    const fin = limpio.lastIndexOf('}');
    if (ini === -1 || fin <= ini) return null;
    try { return JSON.parse(limpio.slice(ini, fin + 1)); } catch { return null; }
}

/* ------------------------- Extracción por reglas (sin IA) ------------------------- */

const NO_NOMBRES = new Set(['que', 'un', 'una', 'el', 'la', 'los', 'las', 'muy', 'yo', 'tu', 'asi', 'de', 'en', 'por', 'como',
    'algo', 'nada', 'todo', 'mal', 'bien', 'cuando', 'si', 'no', 'y', 'o', 'pero', 'para', 'con', 'sin', 'ya', 'solo', 'mas']);

/** "me llamo Carlos", "mi nombre es Ana", "llámame Pepe", "me dicen Toño". Devuelve el nombre o ''. */
export function capturarNombre(texto) {
    const m = String(texto ?? '').match(/\b(?:me llamo|mi nombre es|ll[aá]mame|me dicen)\s+([\p{L}][\p{L}'-]{1,19})/iu);
    if (!m) return '';
    const nom = m[1].replace(/[^\p{L}'-]/gu, '');
    if (!nombreUtil(nom) || NO_NOMBRES.has(norm(nom))) return '';
    return nom.charAt(0).toUpperCase() + nom.slice(1);
}

const FIN = '(?=[.,;!?\\n]|$)';
const PATRONES_HECHOS = [
    [new RegExp(`\\bme (gusta|gustan|encanta|encantan)\\s+(.{3,50}?)${FIN}`, 'iu'), (m) => `le ${m[1].toLowerCase()} ${m[2]}`],
    [/\btengo\s+(?:un|una|dos|tres)\s+(perro|perra|gato|gata|hamster|loro|conejo|tortuga)\b(?:\s+(?:que se llama|llamad[oa])\s+([\p{L}]{2,20}))?/iu,
        (m) => `tiene ${/a$/i.test(m[1]) ? 'una' : 'un'} ${m[1].toLowerCase()}${m[2] ? ` que se llama ${m[2]}` : ''}`],
    [new RegExp(`\\b(?:trabajo|chambeo|laburo)\\s+(en|de|como)\\s+(.{3,40}?)${FIN}`, 'iu'), (m) => `trabaja ${m[1].toLowerCase()} ${m[2]}`],
    [new RegExp(`\\bestudio\\s+(.{3,40}?)${FIN}`, 'iu'), (m) => `estudia ${m[1]}`]
];

/** Hechos personales evidentes que la persona dice de sí misma. Máx. 2 por mensaje. */
export function extraerHechos(texto) {
    const t = String(texto ?? '');
    const out = [];
    for (const [re, fmt] of PATRONES_HECHOS) {
        const m = t.match(re);
        if (m) out.push(limpiar(fmt(m), 100));
        if (out.length >= 2) break;
    }
    return out;
}
