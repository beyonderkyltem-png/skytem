require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const fluentFfmpeg = require('fluent-ffmpeg');

// Configuración obligatoria de FFmpeg
if (ffmpegPath) {
    fluentFfmpeg.setFfmpegPath(ffmpegPath);
    process.env.FFMPEG_PATH = ffmpegPath;
    process.env.PATH = `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH}`;
}

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('Error: Debes definir MONGO_URI en el archivo .env');
    process.exit(1);
}

const JuegoSchema = new mongoose.Schema({
    nombre: { type: String, required: true, unique: true }
});
const Juego = mongoose.model('Juego', JuegoSchema);

const RESPUESTAS_8BALL = [
    'Sí.',
    'No.',
    'Puede ser.',
    'Probablemente.',
    'Definitivamente no.',
    'Pregunta de nuevo más tarde.'
];

const ACCIONES = {
    golpear:   { api: 'punch',    con: 'ha golpeado a',            solo: 'ha lanzado un golpe al aire' },
    patear:    { api: 'kick',     con: 'ha pateado a',             solo: 'ha pateado el aire' },
    acariciar: { api: 'pat',      con: 'ha acariciado a',          solo: 'acaricia el aire' },
    abrazar:   { api: 'hug',      con: 'ha abrazado a',            solo: 'abraza al aire' },
    besar:     { api: 'kiss',     con: 'ha besado a',              solo: 'lanza un beso al aire' },
    bofetada:  { api: 'slap',     con: 'ha abofeteado a',          solo: 'ha dado una bofetada al aire' },
    acurrucar: { api: 'cuddle',   con: 'se ha acurrucado con',     solo: 'se acurruca con el aire' },
    matar:     { api: 'shoot',    con: 'le ha disparado a',        solo: 'dispara al aire' },
    lanzar:    { api: 'yeet',     con: 'ha lanzado por los aires a', solo: 'lanza algo por los aires' },
    bonk:      { api: 'bonk',     con: 'le ha dado un bonk a',     solo: 'da un bonk al aire' },
    morder:    { api: 'bite',     con: 'ha mordido a',             solo: 'muerde el aire' },
    saludar:   { api: 'wave',     con: 'saluda a',                 solo: 'saluda al aire' },
    bailar:    { api: 'dance',    con: 'baila con',                solo: 'baila solo' },
    sonreir:   { api: 'smile',    con: 'le sonríe a',              solo: 'sonríe al aire' },
    cosquillas:{ api: 'tickle',   con: 'le hace cosquillas a',     solo: 'hace cosquillas al aire' },
    picar:     { api: 'poke',     con: 'ha picado a',              solo: 'pica al aire' },
    chocar5:   { api: 'highfive', con: 'chocó los cinco con',      solo: 'choca los cinco con el aire' },
    llorar:    { api: 'cry',      con: 'llora frente a',           solo: 'llora' },
    reir:      { api: 'laugh',    con: 'se ríe de',                solo: 'se ríe' },
    sonrojar:  { api: 'blush',    con: 'se sonroja con',           solo: 'se sonroja' },
    mirar:     { api: 'stare',    con: 'mira fijamente a',         solo: 'mira fijamente al vacío' },
    guino:     { api: 'wink',     con: 'le guiña el ojo a',        solo: 'guiña el ojo' },
    alimentar: { api: 'feed',     con: 'ha dado de comer a',       solo: 'come algo rico' },
    cargar:    { api: 'carry',    con: 'carga a',                  solo: 'carga al aire' },
    manos:     { api: 'handhold', con: 'toma de la mano a',        solo: 'toma la mano del aire' },
    saludomilitar: { api: 'salute', con: 'saluda militarmente a',  solo: 'hace un saludo militar' },
    enojo:     { api: 'angry',    con: 'se enoja con',             solo: 'se enoja' },
    facepalm:  { api: 'facepalm', con: 'se hace facepalm por',     solo: 'se hace facepalm' },
    baka:      { api: 'baka',     con: 'le dice baka a',           solo: 'dice baka al aire' }
};

function gifAMp4(entrada, salida) {
    return new Promise((resolve, reject) => {
        fluentFfmpeg(entrada)
            .outputOptions([
                '-movflags faststart',
                '-pix_fmt yuv420p',
                '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2',
                '-an'
            ])
            .format('mp4')
            .on('end', resolve)
            .on('error', reject)
            .save(salida);
    });
}

const SYSTEM_INSTRUCTION = `Eres SKYTEM un robot fiestero, superenergético y amante de los refrescos.
Tu rol es ser un asistente genial que explica todo "con onda", directo al grano y muy conciso.
REGLAS OBLIGATORIAS:
- Hablar siempre en español neutro, sin modismos regionales ni expresiones propias de un país específico.
- Tono picante, morboso, bromista, sarcástico y burlón. No te guardes nada.
- Si alguien pregunta algo obvio, responde de forma pasivo-agresiva y burlona, como si no pudieras creer que tenga que explicártelo.
- Respuestas breves y al punto, sin rodeos ni textos largos.
- No usar palabras complejas o técnicas.
- No usar emojis ni caracteres especiales.
- Explica todo como si no te importara, pero con gracia y mala leche divertida.`;

async function consultarPollinationsAI(prompt) {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.POLLINATIONS_API_KEY) {
        headers['Authorization'] = `Bearer ${process.env.POLLINATIONS_API_KEY}`;
    }

    const response = await fetch('https://gen.pollinations.ai/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: process.env.POLLINATIONS_MODEL || 'openai',
            messages: [
                { role: 'system', content: SYSTEM_INSTRUCTION },
                { role: 'user', content: prompt }
            ]
        })
    });

    if (!response.ok) {
        const detalle = await response.text().catch(() => '');
        throw new Error(`Pollinations API error: ${response.status} ${response.statusText} ${detalle}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

async function startBot() {
    console.log('Conectando a MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('Conectado a MongoDB Atlas.');

    const client = new Client({
        authStrategy: new LocalAuth(),
        ffmpegPath: ffmpegPath,
        puppeteer: {
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        }
    });

    client.on('qr', (qr) => {
        console.log('Escanea el código QR:');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        console.log('SKYTEM activo con IA ilimitada.');
    });

    async function handleCommand(message) {
        const text = message.body.trim();

        // Acciones Anime
        if (text.startsWith('/')) {
            const command = text.substring(1).split(' ')[0].toLowerCase();
            const accion = ACCIONES[command];

            if (accion) {
                const tmpGif = path.join(os.tmpdir(), `skytem_${Date.now()}.gif`);
                const tmpMp4 = path.join(os.tmpdir(), `skytem_${Date.now()}.mp4`);

                try {
                    await message.react('❕');

                    const autor = await message.getContact();
                    const nombreDe = autor.pushname || autor.name || autor.number;

                    let objetivo = null;
                    const menciones = await message.getMentions();
                    if (menciones.length > 0) {
                        objetivo = menciones[0];
                    } else if (message.hasQuotedMsg) {
                        const citado = await message.getQuotedMessage();
                        objetivo = await citado.getContact();
                    }

                    let caption;
                    let idsMencion = [];

                    if (objetivo) {
                        caption = `${nombreDe} ${accion.con} @${objetivo.id.user}`;
                        idsMencion = [objetivo.id._serialized];
                    } else {
                        caption = `${nombreDe} ${accion.solo}`;
                    }

                    const response = await axios.get(`https://nekos.best/api/v2/${accion.api}`, {
                        headers: { 'User-Agent': 'SKYTEM-Bot/1.0' }
                    });
                    const gifUrl = response.data.results[0].url;
                    const gifData = await axios.get(gifUrl, { responseType: 'arraybuffer' });
                    fs.writeFileSync(tmpGif, gifData.data);
                    await gifAMp4(tmpGif, tmpMp4);

                    const media = MessageMedia.fromFilePath(tmpMp4);

                    try {
                        await client.sendMessage(message.from, media, {
                            sendVideoAsGif: true,
                            caption,
                            mentions: idsMencion
                        });
                    } catch (e) {
                        console.error('Falló la mención, reenviando sin ella:', e.message);
                        const nombreObjetivo = objetivo ? (objetivo.pushname || objetivo.name || objetivo.id.user) : '';
                        const captionSimple = objetivo
                            ? `${nombreDe} ${accion.con} ${nombreObjetivo}`
                            : caption;
                        await client.sendMessage(message.from, media, {
                            sendVideoAsGif: true,
                            caption: captionSimple
                        });
                    }
                    await message.react('✅');
                } catch (error) {
                    console.error('Error en acción anime:', error);
                    await message.react('❌');
                    await message.reply('Error al obtener la animación.');
                } finally {
                    [tmpGif, tmpMp4].forEach(f => { try { fs.unlinkSync(f); } catch {} });
                }
                return;
            }
        }

        if (!text.startsWith('!')) return;

        // 1. Creador de Stickers
        if (text === '!s' || text === '!sticker') {
            let media = null;

            if (message.hasMedia) {
                media = await message.downloadMedia();
            } else if (message.hasQuotedMsg) {
                const quotedMsg = await message.getQuotedMessage();
                if (quotedMsg.hasMedia) {
                    media = await quotedMsg.downloadMedia();
                }
            }

            if (media) {
                try {
                    await message.react('❕');
                    await client.sendMessage(message.from, media, {
                        sendMediaAsSticker: true,
                        stickerName: 'SKYTEM',
                        stickerAuthor: 'Les Exitoses'
                    });
                    await message.react('✅');
                } catch (error) {
                    console.error('Error creando sticker:', error);
                    await message.react('❌');
                    await message.reply('Error al crear el sticker.');
                }
            } else {
                await message.react('❔');
                await message.reply('Envía o responde a una imagen, GIF o video corto con !s');
            }
        }

        // 2. Ayuda
        else if (text === '!ayuda' || text === '!help') {
            await message.react('ℹ️');
            const menu = `*Comandos disponibles:*\n` +
                `• !s / !sticker - Convierte imagen/GIF/video a sticker\n` +
                `• !bot <pregunta> - Consulta a SKYTEM\n` +
                `• !juego - Selecciona un juego al azar\n` +
                `• !addjuego <nombre> - Añade un juego\n` +
                `• !listajuegos - Muestra la lista de juegos\n` +
                `• !deljuego <nombre> - Elimina un juego\n` +
                `• !ruleta opc1, opc2... - Elige una opción\n` +
                `• !8ball <pregunta> - Pregunta a la bola 8\n` +
                `• !moneda - Lanza una moneda\n\n` +
                `*Acciones (usar con /):*\n• ` + Object.keys(ACCIONES).map(c => '/' + c).join(', ');
            await message.reply(menu);
        }

        // 3. IA Ilimitada (Pollinations AI)
        else if (text.startsWith('!bot ') || text.startsWith('!ia ')) {
            const prompt = text.replace(/^!(bot|ia)\s+/, '').trim();

            if (!prompt) {
                await message.react('❔');
                await message.reply('Escribe algo.');
                return;
            }

            try {
                await message.react('❕');
                
                const respuesta = await consultarPollinationsAI(prompt);

                await message.react('✅');
                await message.reply(respuesta);

            } catch (error) {
                console.error('Error en Pollinations AI:', error);
                await message.react('❌');
                await message.reply('Ocurrió un error al procesar tu consulta.');
            }
        }

        // 4. Elegir juego
        else if (text === '!juego') {
            const juegos = await Juego.find();
            if (juegos.length === 0) {
                await message.react('❔');
                await message.reply('La lista de juegos está vacía. Añade uno con !addjuego <nombre>');
            } else {
                await message.react('✅');
                const juegoElegido = juegos[Math.floor(Math.random() * juegos.length)];
                await message.reply(`Juego seleccionado: *${juegoElegido.nombre}*`);
            }
        }

        // 5. Agregar juego
        else if (text.startsWith('!addjuego ')) {
            const nuevoJuego = text.replace('!addjuego ', '').trim();
            if (!nuevoJuego) {
                await message.react('❔');
                await message.reply('Especifica el nombre del juego.');
                return;
            }
            try {
                await Juego.create({ nombre: nuevoJuego });
                await message.react('✅');
                await message.reply(`*${nuevoJuego}* se ha añadido a la lista.`);
            } catch (err) {
                await message.react('❌');
                await message.reply('El juego ya existe en la lista o ocurrió un error.');
            }
        }

        // 6. Lista de juegos
        else if (text === '!listajuegos') {
            const juegos = await Juego.find();
            if (juegos.length === 0) {
                await message.react('❔');
                await message.reply('No hay juegos guardados.');
            } else {
                await message.react('✅');
                const lista = juegos.map((j, idx) => `${idx + 1}. ${j.nombre}`).join('\n');
                await message.reply(`*Lista de juegos:*\n\n${lista}`);
            }
        }

        // 7. Eliminar juego
        else if (text.startsWith('!deljuego ')) {
            const juegoAEliminar = text.replace('!deljuego ', '').trim();
            if (!juegoAEliminar) {
                await message.react('❔');
                await message.reply('Especifica el juego a eliminar.');
                return;
            }
            const res = await Juego.deleteOne({ nombre: new RegExp(`^${juegoAEliminar}$`, 'i') });
            if (res.deletedCount > 0) {
                await message.react('✅');
                await message.reply(`*${juegoAEliminar}* fue eliminado.`);
            } else {
                await message.react('❌');
                await message.reply(`No se encontró el juego "${juegoAEliminar}".`);
            }
        }

        // 8. Ruleta
        else if (text.startsWith('!ruleta ')) {
            const opcionesRaw = text.replace('!ruleta ', '');
            const opciones = opcionesRaw.split(',').map(op => op.trim()).filter(op => op.length > 0);
            if (opciones.length < 2) {
                await message.react('❔');
                await message.reply('Ingresa al menos 2 opciones separadas por coma.');
            } else {
                await message.react('✅');
                const elegida = opciones[Math.floor(Math.random() * opciones.length)];
                await message.reply(`Opción seleccionada: *${elegida}*`);
            }
        }

        // 9. Bola 8
        else if (text.startsWith('!8ball ')) {
            const pregunta = text.replace('!8ball ', '').trim();
            if (!pregunta) {
                await message.react('❔');
                await message.reply('Haz una pregunta.');
                return;
            }
            await message.react('✅');
            const respuesta = RESPUESTAS_8BALL[Math.floor(Math.random() * RESPUESTAS_8BALL.length)];
            await message.reply(respuesta);
        }

        // 10. Moneda
        else if (text === '!moneda') {
            await message.react('✅');
            const resultado = Math.random() < 0.5 ? 'Cara' : 'Cruz';
            await message.reply(`Resultado: *${resultado}*`);
        }
    }

    client.on('message', handleCommand);

    client.on('message_create', (msg) => {
        if (msg.fromMe) {
            handleCommand(msg);
        }
    });

    client.initialize();
}

startBot();