/**
 * neuro.js — el "sistema límbico" del cerebro. Funciones PURAS (sin E/S), fáciles de probar.
 *
 * Traducción del modelo micro-neuronal (ticks de 0.1 ms, pasoQuimica) a nivel macro-cognitivo:
 *  - Los neuromoduladores ya no se integran cada tick: se actualizan POR EVENTO (cada mensaje).
 *  - Entre eventos, el estado vuelve a su basal con la MISMA ley exponencial que usaba pasoQuimica:
 *        c(t+Δt) = basal + (c(t) − basal) · exp(−Δt/τ)
 *    pero calculada de golpe (perezosa) con el Δt real transcurrido, no paso a paso.
 */
import { norm, clamp } from './lenguaje.js';

export const NEURO = ['dopamina', 'serotonina', 'cortisol', 'energia', 'humor'];
export const BASAL = { dopamina: 0.5, serotonina: 0.6, cortisol: 0.2, humor: 0.2 }; // energía: ver basalEnergia()
export const TAU_H = { dopamina: 0.5, serotonina: 6, cortisol: 1.5, energia: 3, humor: 2 }; // horas

/** Ritmo circadiano: la energía basal sube de día y baja de madrugada. */
export function basalEnergia(hora) {
    if (hora >= 9 && hora <= 21) return 0.85;
    if (hora >= 6 && hora < 9) return 0.65;
    if (hora === 22 || hora === 23) return 0.55;
    return 0.35;
}

export const estadoInicial = (ahora) => ({
    dopamina: BASAL.dopamina, serotonina: BASAL.serotonina, cortisol: BASAL.cortisol,
    energia: 0.8, humor: BASAL.humor, ts: ahora, ultimo_evento: '', n_eventos: 0
});

function acotar(est) {
    for (const k of NEURO) est[k] = k === 'humor' ? clamp(est[k], -1, 1) : clamp(est[k], 0, 1);
    return est;
}

/** Decaimiento exponencial hacia el basal con el tiempo real transcurrido. Muta y devuelve `est`. */
export function decaer(est, ahora, basalE = 0.8) {
    const dt = (ahora - (est.ts ?? ahora)) / 3.6e6; // horas
    if (dt > 0) {
        for (const k of NEURO) {
            const b = k === 'energia' ? basalE : BASAL[k];
            est[k] = b + (est[k] - b) * Math.exp(-dt / TAU_H[k]);
        }
    }
    est.ts = ahora;
    return acotar(est);
}

/* ------------------------------ Amígdala: evaluar un mensaje ------------------------------ */

const POSITIVAS = new Set(['gracias', 'genial', 'excelente', 'buenisimo', 'buenisima', 'brutal', 'crack', 'chevere', 'vacano',
    'bacano', 'perfecto', 'increible', 'amo', 'encanta', 'lindo', 'linda', 'nice', 'top', 'capo', 'feliz', 'divertido',
    'divertida', 'buenazo', 'buenaza', 'gracioso', 'graciosa', 'bravo', 'campeon', 'mejor']);
const NEGATIVAS = new Set(['triste', 'feo', 'fea', 'horrible', 'odio', 'molesto', 'molesta', 'aburrido', 'aburrida', 'pesimo',
    'malisimo', 'malisima', 'fastidio', 'harto', 'harta', 'asco', 'terrible', 'fatal', 'peor']);
const INSULTOS = new Set(['idiota', 'estupido', 'estupida', 'imbecil', 'inutil', 'basura', 'mierda', 'puto', 'puta', 'pendejo',
    'pendeja', 'cabron', 'maldito', 'maldita', 'asqueroso', 'asquerosa', 'tarado', 'tarada', 'retrasado', 'retrasada',
    'gilipollas', 'callate', 'lacra', 'estorbo']);
const FRASES_INSULTO = /\b(vete a (la|hacer)|hijo de|cierra la boca|te odio|me caes mal|no sirves|das asco)\b/;
const FRASES_POSITIVAS = /\b(te quiero|te adoro|eres (el|la) mejor|buen trabajo|muy bien hecho|me caes bien)\b/;
const ACUSE = /^(ok+|okey|vale|dale|listo|aja|ya|bn|gracias|thx|grax|k|xd+|jaj\w*|jej\w*|jsj\w*|ajaj\w*|haha\w*|ah|oh|uf|wow|nice|jum)$/;

/** Evalúa el impacto emocional de un texto con reglas léxicas (sin IA). */
export function evaluar(texto) {
    const crudo = String(texto ?? '');
    const t = norm(crudo);
    const toks = t.split(/[^a-z0-9]+/).filter(Boolean);
    let pos = 0, neg = 0, ins = 0;
    for (const w of toks) {
        if (POSITIVAS.has(w)) pos++;
        else if (NEGATIVAS.has(w)) neg++;
        else if (INSULTOS.has(w)) ins++;
    }
    if (FRASES_INSULTO.test(t)) ins++;
    if (FRASES_POSITIVAS.test(t)) pos += 2;

    const risa = /\b(?:ja|je|ji|jo|js){2,}\w*\b|\b(?:ha){2,}\b|\bxd+\b|\bk{3,}\b/.test(t);
    const gratitud = /\bgracias|\bgrax\b|\bmil gracias/.test(t);
    const letras = crudo.replace(/[^\p{L}]/gu, '');
    const gritando = letras.length >= 8 && letras.replace(/[^\p{Lu}]/gu, '').length / letras.length > 0.7;
    const exclam = (crudo.match(/!/g) || []).length;
    const sinMedia = t.replace(/\[[^\]]+\]/g, '').trim();

    const valencia = clamp(pos * 0.35 - neg * 0.3 - ins * 0.7 + (risa ? 0.15 : 0), -1, 1);
    const intensidad = clamp(0.12 + 0.25 * (pos + neg + ins) + (exclam >= 2 ? 0.1 : 0) + (gritando ? 0.2 : 0) + (ins ? 0.25 : 0), 0, 1);
    return {
        valencia, intensidad, insulto: ins > 0, gratitud, risa,
        pregunta: /\?/.test(crudo) || /^(que|como|cuando|donde|por que|porque|quien|cual|cuanto|puedes|sabes|crees)\b/.test(t),
        saludo: /^(h+o+l+a+s*|holi+|buenas|buenos dias|buen dia|hey+|epa+|que tal|q tal|que onda)\b/.test(t),
        acuse: !sinMedia || (toks.length <= 3 && toks.every((w) => ACUSE.test(w)))
    };
}

/* ------------------------------ Dinámica por evento ------------------------------ */

/**
 * Aplica el efecto de un estímulo sobre los neuromoduladores. `peso` = cuánto le afecta:
 * 0.2 para mensajes ambientales del grupo (contagio de ánimo), 1 para los que le hablan a él.
 * Un insulto duele menos entre amigos (afinidad alta).
 */
export function estimular(est, ev, afinidad = 10, peso = 1) {
    const amistad = clamp(afinidad, 0, 100) / 100;
    const w = peso;
    if (ev.insulto) {
        const dur = 1 - 0.5 * amistad;
        est.cortisol += 0.14 * dur * w;
        est.serotonina -= 0.05 * dur * w;
        est.humor -= 0.15 * dur * w;
        est.dopamina -= 0.03 * w;
    } else if (ev.valencia < -0.25) {
        est.serotonina -= 0.02 * w;
        est.humor -= 0.05 * w;
    }
    if (ev.gratitud || ev.valencia > 0.3) {
        est.dopamina += 0.06 * w;
        est.serotonina += 0.02 * w;
        est.humor += 0.08 * w;
        est.cortisol -= 0.03 * w;
    }
    if (ev.risa) { est.dopamina += 0.03 * w; est.humor += 0.04 * w; }
    if (ev.pregunta) est.dopamina += 0.01 * w;
    est.energia -= 0.006 * w; // cada interacción cuesta un poco
    est.n_eventos = (est.n_eventos || 0) + 1;
    return acotar(est);
}

/** Cuánto sube o baja la afinidad (0-100) con una persona tras un mensaje suyo dirigido al bot. */
export function deltaAfinidad(ev, dirigido = true) {
    let d = dirigido ? 0.4 : 0;
    if (ev.insulto) d -= 3;
    else if (ev.gratitud) d += 1;
    else if (ev.valencia > 0.3) d += 0.5;
    return d;
}

export function descripcionAfinidad(c = 10) {
    if (c < 20) return 'apenas se conocen: tono amable y neutro, sin asumir confianza ni apodos burlones.';
    if (c < 50) return 'ya se conocen: puedes bromear con confianza ligera y, si encaja, picarle con algún apodo burlón obvio.';
    if (c < 75) return 'hay buena confianza: bromas más directas y apodos burlones cuando vengan al caso.';
    return 'son panas de verdad: burla cariñosa y total confianza.';
}

/* ------------------------------ Estado mental (decisión, no generación) ------------------------------ */

const MENTALES = {
    agotado:  { factor: 0.5, temp: 0.4, prob: 0,   directiva: 'Estás sin batería: contestas lo mínimo indispensable, en pocas palabras, sin chistes.' },
    tenso:    { factor: 0.6, temp: 0.5, prob: 0.3, directiva: 'Estás tenso y con poca paciencia: respuestas cortas y secas, sin chistes, sin dejarte pisar pero sin insultar a nadie.' },
    apagado:  { factor: 0.7, temp: 0.5, prob: 0.3, directiva: 'Estás con el ánimo bajo: tono más callado y sobrio, sin entusiasmo exagerado, pero amable.' },
    cansado:  { factor: 0.7, temp: 0.5, prob: 0.4, directiva: 'Estás cansado: respuestas más cortas y relajadas, poca energía.' },
    tranquilo:{ factor: 1.0, temp: 0.6, prob: 1.0, directiva: 'Estás tranquilo y de buen humor normal.' },
    animado:  { factor: 1.0, temp: 0.7, prob: 1.1, directiva: 'Estás animado y con ganas de charlar: más chispa y humor cuando encaje.' },
    euforico: { factor: 1.2, temp: 0.8, prob: 1.5, directiva: 'Estás eufórico y muy juguetón: mucha energía, bromas y entusiasmo (sin pasarte del largo).' }
};

/** Decide el estado mental a partir de los neuromoduladores. Es una tabla, no un modelo de lenguaje. */
export function estadoMental(est, tokensBase = 140) {
    let nombre = 'tranquilo';
    if (est.energia < 0.15) nombre = 'agotado';
    else if (est.cortisol > 0.6) nombre = 'tenso';
    else if (est.humor < -0.25 || est.serotonina < 0.35) nombre = 'apagado';
    else if (est.dopamina > 0.65 && est.humor > 0.25) nombre = 'euforico';
    else if (est.energia < 0.35) nombre = 'cansado';
    else if (est.humor > 0.15) nombre = 'animado';
    const m = MENTALES[nombre];
    return { nombre, directiva: m.directiva, temp: m.temp, probEspontanea: m.prob, maxTokens: Math.round(tokensBase * m.factor) };
}
