import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import util from 'util';
const execPromise = util.promisify(exec);
import { pipeline } from 'stream/promises';
import { downloadYT, getYTInfo, resolverUrlYT, getCobaltApis } from './ytHelper.js';
import { ytResolveSized, ytResolveBest } from './savetube.js';

const VIDEO_LIMIT = 60 * 1024 * 1024; // até aqui vai como vídeo; acima, documento (qualidade máxima)

const H264_GROWTH = 1.8; // converter AV1/VP9 para h264 (veryfast) deixa ~1,8x maior

async function codecDoVideo(filePath) {
    try {
        const { stdout } = await execPromise(`ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
        return stdout.trim().toLowerCase();
    } catch { return ''; }
}

/**
 * Decide como mandar um vídeo, sempre na melhor qualidade:
 *  - h264 até 60 MB → vídeo
 *  - outro codec que, convertido, ainda caiba em 60 MB → converte e manda como vídeo
 *  - o resto → arquivo ORIGINAL como documento (sem converter)
 * Retorna { path, asDocument }.
 */
async function prepararVideo(filePath) {
    const size = fs.statSync(filePath).size;
    const codec = await codecDoVideo(filePath);
    if (/h264|avc/.test(codec) || !codec) {
        if (size <= VIDEO_LIMIT) return { path: await verificarEConverterCodec(filePath), asDocument: false };
        return { path: filePath, asDocument: true };
    }
    if (size * H264_GROWTH <= VIDEO_LIMIT) {
        // verificarEConverterCodec apaga o original quando converte; usa o convertido em qualquer caso
        const conv = await verificarEConverterCodec(filePath);
        let cs = 0;
        try { cs = fs.statSync(conv).size; } catch {}
        return { path: conv, asDocument: cs > VIDEO_LIMIT };
    }
    return { path: filePath, asDocument: true };
}

// Envia vídeo do disco na melhor qualidade (vídeo até 60 MB; acima, documento original)
async function enviarVideoInteligente(nazu, from, m, filePath, caption, fileName = 'video.mp4') {
    const { path: p, asDocument } = await prepararVideo(filePath);
    try {
    const size = fs.statSync(p).size;
    const cap = `${caption}${caption ? '\n' : ''}📦 ${(size / 1024 / 1024).toFixed(1)} MB`;
    if (!asDocument) {
        return await nazu.sendMessage(from, { video: { url: p }, mimetype: 'video/mp4', caption: cap }, { quoted: m });
    }
    return await nazu.sendMessage(from, {
        document: { url: p }, mimetype: 'video/mp4',
        fileName: /\.mp4$/i.test(fileName) ? fileName : `${fileName}.mp4`,
        caption: `${cap}\n📁 Enviado como documento (qualidade máxima)`
    }, { quoted: m });
    } finally {
        // apaga o arquivo convertido (o original é apagado por quem chamou)
        if (p !== filePath) try { fs.unlinkSync(p); } catch {}
    }
}

let _fg = null;
async function getFg() {
    if (!_fg) _fg = (await import('fg-senna')).default;
    return _fg;
}

async function baixarCobaltGenerico(url, formato = 'video') {
    const cobaltApis = getCobaltApis ? getCobaltApis() : [
        'https://cobalt.api.scity.gov.mn',
        'https://co.wuk.sh',
        'https://nuko-c.meowing.de',
        'https://subito-c.meowing.de',
        'https://melon.clxxped.lol',
        'https://api-cobalt.eversiege.network'
    ];
    for (const api of cobaltApis.slice(0, 6)) {
        try {
            console.log(`[Cobalt Generico] Tentando download via: ${api}`);
            const cobaltRes = await axios.post(api, {
                url: url,
                videoQuality: '720',
                audioFormat: 'mp3',
                downloadMode: formato === 'audio' ? 'audio' : 'auto'
            }, {
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': UA
                },
                timeout: 10000
            }).then(r => r.data);

            if (cobaltRes) {
                if ((cobaltRes.status === 'redirect' || cobaltRes.status === 'tunnel') && cobaltRes.url) {
                    if (formato === 'audio') {
                        return { type: 'audio', url: cobaltRes.url, desc: cobaltRes.filename || 'Audio' };
                    }
                    return { type: 'video', url: cobaltRes.url, desc: cobaltRes.filename || 'Video' };
                } else if (cobaltRes.status === 'picker' && cobaltRes.picker && cobaltRes.picker.length > 0) {
                    const urls = cobaltRes.picker.map(item => item.url);
                    return { type: 'images', urls: urls, desc: 'Galeria' };
                }
            }
        } catch (apiErr) {
            console.warn(`[Cobalt Generico] API ${api} falhou: ${apiErr.message}`);
        }
    }
    return null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tmpDir = path.join(__dirname, '..', '..', 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

setInterval(() => {
    try {
        const now = Date.now();
        for (const f of fs.readdirSync(tmpDir)) {
            const fp = path.join(tmpDir, f);
            if (now - fs.statSync(fp).mtimeMs > 900000) fs.unlinkSync(fp);
        }
    } catch {}
}, 900000);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function detectarPlataforma(url) {
    const u = url.toLowerCase();
    if (u.includes('tiktok.com') || u.includes('vt.tiktok') || u.includes('vm.tiktok') || u.includes('tt.site')) return 'TikTok';
    if (u.includes('youtube.com') || u.includes('youtu.be')) return 'YouTube';
    if (u.includes('instagram.com') || u.includes('instagr.am')) return 'Instagram';
    if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com')) return 'Facebook';
    if (u.includes('twitter.com') || u.includes('x.com')) return 'Twitter/X';
    if (u.includes('spotify.com')) return 'Spotify';
    if (u.includes('soundcloud.com')) return 'SoundCloud';
    if (u.includes('pinterest.com') || u.includes('pin.it')) return 'Pinterest';
    if (u.includes('reddit.com') || u.includes('redd.it')) return 'Reddit';
    if (u.includes('vimeo.com')) return 'Vimeo';
    if (u.includes('dailymotion.com') || u.includes('dai.ly')) return 'Dailymotion';
    if (u.includes('streamable.com')) return 'Streamable';
    if (u.includes('twitch.tv') || u.includes('twitch.com')) return 'Twitch';
    if (u.includes('bandcamp.com')) return 'Bandcamp';
    if (u.includes('mediafire.com')) return 'Mediafire';
    return null;
}

async function baixarTiktok(url) {
    try {
        if (url && url.includes('tt.site')) {
            try {
                const res = await fetch(url, { redirect: 'follow' });
                if (res && res.url && !res.url.includes('tt.site')) {
                    url = res.url;
                }
            } catch (redirErr) {
                console.warn('[TikTok] Falha ao resolver redirecionamento tt.site:', redirErr.message);
            }
        }
        const tiktokMod = await import('../funcs/downloads/tiktok.js');
        const dlFn = tiktokMod.dl || tiktokMod.default?.dl;
        if (typeof dlFn === 'function') {
            const res = await dlFn(url);
            if (res && res.ok && res.urls && res.urls.length > 0) {
                if (res.type === 'image' || res.type === 'images') {
                    return { type: 'images', urls: res.urls, desc: res.title || 'TikTok' };
                }
                return { type: 'video', url: res.urls[0], desc: res.title || 'TikTok' };
            }
        }
    } catch (e) {
        console.error('[TikTok Central Dl error]', e.message);
    }
    throw new Error('TikTok: Falha ao extrair mídia via módulo unificado.');
}

async function baixarInstagram(url) {
    // Remove parâmetros de rastreio (?dlrf=, ?igsh=, ?utm_...) que atrapalham alguns extratores
    if (/instagram\.com|instagr\.am/i.test(url)) url = url.split('?')[0];
    // Reel/IGTV é sempre vídeo: o yt-dlp da VPS acessa o Instagram e é o mais confiável quando as APIs caem
    if (/\/(reel|reels|tv)\//i.test(url)) {
        try {
            const ytRes = await ytdlpBaixar(url, 'video');
            if (ytRes && ytRes.filePath) {
                return { type: 'video', url: ytRes.filePath, filePath: ytRes.filePath, isFile: true, desc: 'Instagram (HD)' };
            }
        } catch (_) {}
    }
    try {

        const igdlMod = await import('../funcs/downloads/igdl.js');
        const dlFn = igdlMod.dl || igdlMod.default?.dl;
        if (typeof dlFn === 'function') {
            const res = await dlFn(url);
            if (res && res.ok && res.data && res.data.length > 0) {
                if (res.data.length === 1) {
                    const item = res.data[0];
                    const id = Date.now() + '_' + Math.random().toString(36).substring(2, 6);
                    const ext = item.type === 'video' ? 'mp4' : 'jpg';
                    const filePath = path.join(tmpDir, `ig_${id}.${ext}`);
                    fs.writeFileSync(filePath, item.buff);
                    return { type: item.type, filePath, isFile: true, desc: 'Instagram' };
                } else {
                    const filePaths = [];
                    for (const [idx, item] of res.data.entries()) {
                        const ext = item.type === 'video' ? 'mp4' : 'jpg';
                        const filePath = path.join(tmpDir, `ig_${Date.now()}_${idx}.${ext}`);
                        fs.writeFileSync(filePath, item.buff);
                        filePaths.push({ type: item.type, filePath, isFile: true });
                    }
                    return { type: 'gallery', files: filePaths, desc: 'Instagram (Galeria)' };
                }
            }
        }
    } catch (e) {
        console.error('[Instagram Central Dl Error]', e.message);
    }
    // Reserva: yt-dlp (só funciona para vídeo)
    try {
        const ytRes = await ytdlpBaixar(url, 'video');
        if (ytRes && ytRes.filePath) {
            return { type: 'video', url: ytRes.filePath, filePath: ytRes.filePath, isFile: true, desc: 'Instagram (HD)' };
        }
    } catch (_) {}
    throw new Error('Instagram: Falha ao extrair mídia via módulo unificado.');
}

async function baixarYoutube(url, formato = 'video') {
    try {
        console.log(`[baixarYoutube] Iniciando resolução híbrida para: ${url}`);

        let resolved = null;
        try {
            resolved = await resolverUrlYT(url, formato);
        } catch (resErr) {
            console.warn(`[baixarYoutube] Falha rápida ao obter URL direta: ${resErr.message}`);
        }

        if (resolved && resolved.dl_url) {
            const dl_url = resolved.dl_url;
            const title = resolved.title || 'YouTube';
            console.log(`[baixarYoutube] URL direta obtida: ${dl_url.substring(0, 80)}...`);

            let sizeBytes = 0;
            try {
                const headRes = await axios.head(dl_url, { timeout: 3000, headers: { 'User-Agent': 'Mozilla/5.0' } });
                sizeBytes = parseInt(headRes.headers['content-length'] || '0', 10);
                console.log(`[baixarYoutube] HEAD request retornou tamanho: ${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`);
            } catch (headErr) {
                console.log(`[baixarYoutube] HEAD request falhou ou não retornou tamanho: ${headErr.message}`);
            }

            const sizeMB = sizeBytes / (1024 * 1024);

            if (sizeMB > 60) {
                console.log(`[baixarYoutube] Vídeo grande (${sizeMB.toFixed(2)} MB > 60MB). Ativando Modo Ultra Velocidade (Streaming Direto + Documento)`);
                return {
                    type: 'document',
                    url: dl_url,
                    streamingDireto: true,
                    filename: `YouTube - ${title.replace(/[^a-zA-Z0-9\s-_]/g, '')}.mp4`,
                    desc: title,
                    isUltra: true
                };
            } else {
                console.log(`[baixarYoutube] Vídeo até 60MB (${sizeMB.toFixed(2)} MB). Efetuando download tradicional para reprodução em chat...`);
            }
        }

        const dl = await downloadYT(url, formato, resolved?.dl_url ? { url: resolved.dl_url, title: resolved.title } : null);
        if (dl && dl.filePath) {
            return { type: formato, url: dl.filePath, filePath: dl.filePath, desc: dl.title || 'YouTube', isFile: true };
        }
    } catch (e) {
        console.error('[YouTube ytHelper]', e.message);
    }
    throw new Error('YouTube bloqueado no Datacenter. Todos os métodos falharam.');
}

async function baixarFacebook(url) {
    const id = Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const filePath = path.join(tmpDir, `fb_${id}.mp4`);
    // 1) API externa + yt-dlp com o link real (links /share/r/ e /share/v/ funcionam)
    try {
        const { downloadFacebookToFile } = await import('./facebook.js');
        if (await downloadFacebookToFile(url, filePath) && fs.existsSync(filePath)) {
            return { type: 'video', filePath, isFile: true, desc: 'Facebook' };
        }
    } catch (e) {
        console.warn('[Facebook] módulo novo falhou:', e.message);
    }
    try {
        const cmd = `export PATH=/usr/bin:/usr/local/bin:$PATH && yt-dlp --no-playlist --no-warnings --no-check-certificate -f "b[vcodec^=avc]/b[vcodec^=h264]/hd/sd/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best" --merge-output-format mp4 -o "${filePath}" "${url}"`;
        await new Promise((resolve, reject) => {
            exec(cmd, { timeout: 120000 }, (error) => {
                if (error) {
                    try { fs.unlinkSync(filePath); } catch {}
                    return reject(error);
                }
                if (fs.existsSync(filePath)) {
                    return resolve();
                }
                const possible = fs.readdirSync(tmpDir).filter(f => f.startsWith(`fb_${id}`));
                if (possible.length > 0) {
                    return resolve();
                }
                reject(new Error('Arquivo não encontrado após download do Facebook'));
            });
        });

        const actualPath = fs.existsSync(filePath) ? filePath : path.join(tmpDir, fs.readdirSync(tmpDir).find(f => f.startsWith(`fb_${id}`)));
        if (actualPath && fs.existsSync(actualPath)) {
            return { type: 'video', filePath: actualPath, isFile: true, desc: 'Facebook' };
        }
    } catch (e) {
        console.error('[Facebook yt-dlp error]', e.message);
    }
    throw new Error('Facebook: Falha ao baixar vídeo via yt-dlp.');
}

async function baixarTwitter(url) {
    try {
        const fg = await getFg();
        const res = await fg.twitter(url);
        if (res && (res.HD || res.SD)) {
             return { type: 'video', url: res.HD || res.SD, desc: res.desc || 'Twitter/X' };
        }
    } catch (e) {
        console.error('[Twitter fg-senna]', e.message);
    }
    throw new Error('Twitter: Falha ao extrair mídia via fg-senna');
}

async function baixarMediafire(url) {
    try {

        let sip = await axios.get(`https://api.siputzx.my.id/api/d/mediafire?url=${encodeURIComponent(url)}`).then(v => v.data).catch(() => null);
        if (sip && sip.data && sip.data.url) {
            return { type: 'document', url: sip.data.url, filename: sip.data.name, ext: sip.data.ext, desc: 'Mediafire (API 1)' };
        }

        let rz = await axios.get(`https://api.ryzumi.net/api/downloader/mediafire?url=${encodeURIComponent(url)}`).then(v => v.data).catch(() => null);
        if (rz && rz.url) {
             return { type: 'document', url: rz.url, filename: rz.fileName || rz.nome || 'arquivo', ext: rz.ext || 'bin', desc: 'Mediafire (API 2)' };
        }

        const fg = await getFg();
        const res = await fg.mediafire(url);
        if (res && res.url) {
             return { type: 'document', url: res.url, filename: res.filename, ext: res.ext, desc: 'Mediafire (API 3)' };
        }
    } catch (e) {
        console.error('[Mediafire Cascade]', e.message);
    }
    throw new Error('Mediafire: Falha ao extrair arquivo em todos os motores.');
}

async function baixarPinterest(url) {
    try {
        const pinterestMod = await import('../funcs/downloads/pinterest.js');
        const dlFn = pinterestMod.dl || pinterestMod.default?.dl;
        if (typeof dlFn === 'function') {
            const res = await dlFn(url);
            if (res && res.ok && res.urls && res.urls.length > 0) {
                return {
                    type: res.type || (res.urls[0].includes('.mp4') ? 'video' : 'image'),
                    url: res.urls[0],
                    desc: res.title || 'Pinterest'
                };
            }
        }
    } catch (e) {
        console.error('[Pinterest Central Dl error]', e.message);
    }
    try { const r = await ytdlpBaixar(url); if (r) return r; } catch {}
    throw new Error('Pinterest: falhou ao extrair mídia via módulo unificado.');
}

async function baixarReddit(url) {
    try {

        const jsonUrl = url.replace(/\/$/, '') + '.json';
        const { data } = await axios.get(jsonUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (bot)' }, timeout: 10000
        });
        const post = data?.[0]?.data?.children?.[0]?.data;
        if (post) {

            if (post.is_video && post.media?.reddit_video?.fallback_url) {
                return { type: 'video', url: post.media.reddit_video.fallback_url, desc: post.title || 'Reddit' };
            }

            if (post.url_overridden_by_dest && /\.(jpg|png|gif|webp)/i.test(post.url_overridden_by_dest)) {
                return { type: 'image', url: post.url_overridden_by_dest, desc: post.title || 'Reddit' };
            }
        }
    } catch {}
    try { const r = await ytdlpBaixar(url); if (r) return r; } catch {}
    throw new Error('Reddit: falhou');
}

async function baixarGenerico(url, plataforma) {
    try {
        const result = await ytdlpBaixar(url);
        if (result && result.filePath) {
            result.url = result.filePath;
            result.isFile = true;
            return result;
        }
    } catch (e) { console.error(`[${plataforma} yt-dlp]`, e.message); }
    throw new Error(`${plataforma}: download falhou`);
}

function ytdlpBaixar(url, formato = 'video') {
    return new Promise((resolve, reject) => {
        const id = Date.now() + '_' + Math.random().toString(36).substring(2, 6);
        const ext = formato === 'audio' ? 'mp3' : 'mp4';
        const filePath = path.join(tmpDir, `dl_${id}.${ext}`);

        let formatArg;
        if (formato === 'audio') {
            formatArg = '-x --audio-format mp3 --audio-quality 0';
        } else {

            formatArg = `-f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4`;
        }

        const cmd = `export PATH=/home/ubuntu/.deno/bin:/usr/bin:/usr/local/bin:$PATH && yt-dlp --no-playlist --no-warnings --no-check-certificate --extractor-args 'youtube:player_client=android,web' --user-agent '${UA}' --sleep-requests 1 --retries 3 --socket-timeout 30 -q ${formatArg} -o '${filePath}' '${url}'`;

        const proc = exec(cmd, { timeout: 120000 }, (error) => {
            if (error) {

                try { fs.unlinkSync(filePath); } catch {}
                return reject(new Error(error.message?.substring(0, 100)));
            }

            if (fs.existsSync(filePath)) {
                const stats = fs.statSync(filePath);
                if (stats.size > 0) {
                    resolve({ type: formato === 'audio' ? 'audio' : 'video', filePath, desc: '', formato });
                    return;
                }
            }

            const possibleFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith(`dl_${id}`));
            if (possibleFiles.length > 0) {
                const actualPath = path.join(tmpDir, possibleFiles[0]);
                resolve({ type: formato === 'audio' ? 'audio' : 'video', filePath: actualPath, desc: '', formato });
                return;
            }
            reject(new Error('Arquivo não encontrado após download'));
        });
    });
}

async function baixarStreamLocal(mediaUrl, ext) {
    const filePath = path.join(tmpDir, `stm_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.${ext}`);
    const dl = await axios({
        method: 'get',
        url: mediaUrl,
        responseType: 'stream',
        headers: { 'User-Agent': UA }
    });
    if (dl.status !== 200) throw new Error(`Falha no download (Stream): HTTP ${dl.status}`);
    await pipeline(dl.data, fs.createWriteStream(filePath));
    return filePath;
}

async function verificarEConverterCodec(filePath) {
    if (!filePath || !filePath.endsWith('.mp4')) return filePath;
    try {

        const cmdProbe = `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
        const { stdout } = await execPromise(cmdProbe);
        const codec = stdout.trim().toLowerCase();

        console.log(`[Codec Sniffer] Ficheiro detectado com codec: ${codec}`);

        if (codec === 'h264' || codec === 'h264(high)') {

            const finalPath = filePath.replace('.mp4', '_ready.mp4');
            await execPromise(`ffmpeg -y -i "${filePath}" -c copy -movflags +faststart "${finalPath}"`);
            try { fs.unlinkSync(filePath); } catch {}
            return finalPath;
        } else if (codec && codec !== '') {

            console.log(`[Codec Sniffer] Codec Incompatível (${codec}). Convertendo para H.264 (yuv420p)...`);
            const finalPath = filePath.replace('.mp4', '_ready.mp4');
            await execPromise(`ffmpeg -y -i "${filePath}" -c:v libx264 -preset veryfast -crf 27 -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:a aac -b:a 128k -movflags +faststart "${finalPath}"`);
            try { fs.unlinkSync(filePath); } catch {}
            return finalPath;
        }
    } catch (e) {
        console.error(`[Codec Sniffer] Ignorado devido a erro:`, e.message);
        return filePath;
    }
}

async function refinarAudio(filePath) {
    if (!filePath) return filePath;
    try {
        // Se já é MP3 de verdade (ex.: SaveTube manda 128k), não recodifica: economiza vários segundos
        try {
            const { stdout } = await execPromise(`ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
            if (stdout.trim().toLowerCase() === 'mp3') return filePath;
        } catch {}
        const finalPath = filePath.replace('.mp3', '_ready.mp3');

        await execPromise(`ffmpeg -i "${filePath}" -vn -ar 44100 -ac 2 -b:a 128k -y "${finalPath}"`);
        try { fs.unlinkSync(filePath); } catch {}
        return finalPath;
    } catch (e) {
        console.error(`[Audio Refiner] Erro ao refinar áudio:`, e.message);
        return filePath;
    }
}

async function enviarMidia(nazu, from, m, resultado, plataforma) {

    const extraAttrs = {};
    if (resultado.thumbnail) {
        extraAttrs.contextInfo = {
            externalAdReply: {
                title: resultado.desc || plataforma,
                mediaType: resultado.type === 'audio' ? 2 : 1,
                thumbnailUrl: resultado.thumbnail,
                sourceUrl: resultado.sourceUrl || ''
            }
        };
    }

    if (resultado.type === 'video') {
        let finalFilePath = null;

        if (resultado.filePath) {

            finalFilePath = resultado.filePath;
        } else if (resultado.isStream) {

            const tmpFp = path.join(tmpDir, `yt_${Date.now()}.mp4`);
            await new Promise((resolve, reject) => {
                const dl = resultado.ytdlCore.default || resultado.ytdlCore;
                const stream = dl(resultado.ytdlUrl, { quality: 'highest', filter: 'videoandaudio' });
                const ws = fs.createWriteStream(tmpFp);
                stream.pipe(ws);
                stream.on('error', reject);
                ws.on('finish', resolve);
                ws.on('error', reject);
            });
            finalFilePath = tmpFp;
        } else {

            finalFilePath = await baixarStreamLocal(resultado.url, 'mp4');
        }

        if (finalFilePath) {

            // Acima de 60 MB vai como documento na qualidade máxima: não precisa (nem dá tempo de) converter
            const prep = await prepararVideo(finalFilePath);
            finalFilePath = prep.path;

            let stats = null;
            try { stats = fs.statSync(finalFilePath); } catch {}
            const isBig = prep.asDocument;

            const captionMsg = `✅ ${plataforma}${stats ? `\n📦 ${(stats.size / 1024 / 1024).toFixed(1)} MB` : ''}`;

            if (isBig) {

                console.log(`[enviarMidia] Vídeo muito grande (${stats ? (stats.size / 1024 / 1024).toFixed(2) : '?'}MB). Enviando como Documento (qualidade máxima).`);
                await nazu.sendMessage(from, {
                    document: { url: finalFilePath },
                    mimetype: 'video/mp4',
                    fileName: resultado.filename || path.basename(finalFilePath) || 'video.mp4',
                    caption: `${captionMsg}\n📁 Enviado como documento (qualidade máxima)`
                }, { quoted: m });
            } else {

                console.log(`[enviarMidia] Enviando como player de vídeo nativo (${stats ? (stats.size / 1024 / 1024).toFixed(2) : '?'}MB <= 60MB).`);
                await nazu.sendMessage(from, {
                    video: { url: finalFilePath },
                    mimetype: 'video/mp4',
                    caption: captionMsg
                }, { quoted: m });
            }

            try { fs.unlinkSync(finalFilePath); } catch {}
        }
    } else if (resultado.type === 'audio') {
        if (resultado.filePath) {
            await nazu.sendMessage(from, {
                audio: { url: resultado.filePath },
                mimetype: 'audio/mpeg',
                ...extraAttrs
            }, { quoted: m });
            try { fs.unlinkSync(resultado.filePath); } catch {}
        } else {
            const filePath = await baixarStreamLocal(resultado.url, 'mp3');
            await nazu.sendMessage(from, {
                audio: { url: filePath },
                mimetype: 'audio/mpeg',
                ...extraAttrs
            }, { quoted: m });
            try { fs.unlinkSync(filePath); } catch {}
        }
    } else if (resultado.type === 'document') {

        if (resultado.streamingDireto) {
            console.log(`[enviarMidia] Baixando stream da URL externa em disco para envio seguro: ${resultado.url.substring(0, 80)}...`);
            let tempPath = null;
            try {

                tempPath = await baixarStreamLocal(resultado.url, 'mp4');
                console.log(`[enviarMidia] Download do stream concluído. Enviando documento local: ${tempPath}`);

                await nazu.sendMessage(from, {
                    document: { url: tempPath },
                    mimetype: 'video/mp4',
                    fileName: resultado.filename || 'video.mp4',
                    ...extraAttrs
                }, { quoted: m });
            } catch (errStream) {
                console.error(`[enviarMidia] Erro no stream do documento:`, errStream.message);
                throw errStream;
            } finally {
                if (tempPath && fs.existsSync(tempPath)) {
                    try { fs.unlinkSync(tempPath); } catch {}
                }
            }
        } else if (resultado.filePath) {
            await nazu.sendMessage(from, {
                document: { url: resultado.filePath },
                mimetype: 'application/octet-stream',
                fileName: resultado.filename || `arquivo.${resultado.ext || 'bin'}`,
                ...extraAttrs
            }, { quoted: m });
            try { fs.unlinkSync(resultado.filePath); } catch {}
        } else {
            const filePath = await baixarStreamLocal(resultado.url, resultado.ext || 'bin');
            await nazu.sendMessage(from, {
                document: { url: filePath },
                mimetype: 'application/octet-stream',
                fileName: resultado.filename || `arquivo.${resultado.ext || 'bin'}`,
                ...extraAttrs
            }, { quoted: m });
            try { fs.unlinkSync(filePath); } catch {}
        }
    } else if (resultado.type === 'image') {
        const filePath = resultado.filePath || (resultado.url ? await baixarStreamLocal(resultado.url, 'jpg') : null);
        if (filePath) {
            await nazu.sendMessage(from, {
                image: { url: filePath },
                caption: `✅ ${plataforma}`
            }, { quoted: m });
            try { fs.unlinkSync(filePath); } catch {}
        }
    } else if (resultado.type === 'images') {
        for (const item of (resultado.urls || resultado.files || []).slice(0, 10)) {
            try {
                const filePath = typeof item === 'string' ? await baixarStreamLocal(item, 'jpg') : (item.filePath || await baixarStreamLocal(item.url, 'jpg'));
                if (filePath) {
                    await nazu.sendMessage(from, {
                        image: { url: filePath },
                        caption: `✅ ${plataforma}`
                    }, { quoted: m });
                    try { fs.unlinkSync(filePath); } catch {}
                }
            } catch {}
        }
    } else if (resultado.type === 'gallery') {
        for (const fileObj of resultado.files) {
            try {
                if (fileObj.type === 'video') {
                    let finalPath = await verificarEConverterCodec(fileObj.filePath);
                    await nazu.sendMessage(from, {
                        video: { url: finalPath },
                        mimetype: 'video/mp4',
                        caption: `✅ ${plataforma}`
                    }, { quoted: m });
                    try { fs.unlinkSync(finalPath); } catch {}
                } else {
                    await nazu.sendMessage(from, {
                        image: { url: fileObj.filePath },
                        caption: `✅ ${plataforma}`
                    }, { quoted: m });
                    try { fs.unlinkSync(fileObj.filePath); } catch {}
                }
            } catch (e) {
                console.error('[Gallery Send Error]', e.message);
            }
        }
    }
}

export default async function baixarVideoLocal(nazu, from, m, q, reply) {
    try {
        if (!q) {
            return reply('❌ Envie um link válido.\n\n📌 *Sites suportados:*\n• TikTok • YouTube • Instagram\n• Facebook • Twitter/X • Spotify\n• SoundCloud • Pinterest • Reddit\n• Vimeo • Dailymotion • Streamable');
        }

        const url = q.trim().split(' ')[0];
        const plataforma = detectarPlataforma(url);

        if (!plataforma) {
            return reply('❌ Link não suportado.\n\n📌 *Sites suportados:*\n• TikTok • YouTube • Instagram\n• Facebook • Twitter/X • Spotify\n• SoundCloud • Pinterest • Reddit\n• Vimeo • Dailymotion • Streamable');
        }

        if (m.key) await nazu.sendMessage(from, { react: { text: '⏳', key: m.key } }).catch(() => {});

        await nazu.sendMessage(from, { text: `📥 Processando mídia do ${plataforma}...` }, { quoted: m }).catch(() => {});

        let resultado;
        try {
            switch (plataforma) {
                case 'TikTok':      resultado = await baixarTiktok(url); break;
                case 'YouTube':     resultado = await baixarYoutube(url, 'video'); break;
                case 'Instagram':   resultado = await baixarInstagram(url); break;
                case 'Facebook':    resultado = await baixarFacebook(url); break;
                case 'Twitter/X':   resultado = await baixarTwitter(url); break;
                case 'Pinterest':   resultado = await baixarPinterest(url); break;
                case 'Reddit':      resultado = await baixarReddit(url); break;
                case 'Mediafire':   resultado = await baixarMediafire(url); break;
                default:            resultado = await baixarGenerico(url, plataforma); break;
            }
        } catch (err) {
            console.error(`[Download ${plataforma}] Erro:`, err.message);
            if (m.key) await nazu.sendMessage(from, { react: { text: '❌', key: m.key } }).catch(() => {});
            return nazu.sendMessage(from, { text: `❌ Falha ao baixar do ${plataforma}.` }, { quoted: m });
        }

        if (!resultado) {
            if (m.key) await nazu.sendMessage(from, { react: { text: '❌', key: m.key } }).catch(() => {});
            return nazu.sendMessage(from, { text: `❌ Não foi possível extrair mídia do ${plataforma}.` }, { quoted: m });
        }

        try {

            resultado.thumbnail = resultado.thumbnail || m?.message?.extendedTextMessage?.matchedText;
            await enviarMidia(nazu, from, m, resultado, plataforma);
            if (m.key) await nazu.sendMessage(from, { react: { text: '✅', key: m.key } }).catch(() => {});
        } catch (e) {
            console.error('Erro no enviarMidia:', e.message);
            if (m.key) await nazu.sendMessage(from, { react: { text: '❌', key: m.key } }).catch(() => {});
        }

    } catch (err) {
        console.error('Erro fatal no downloader:', err);
        if (m?.key) await nazu.sendMessage(from, { react: { text: '❌', key: m.key } }).catch(() => {});
        reply('❌ Erro interno ao iniciar download.');
    }
}

const playConfirmations = new Map();

export function getPlayConfirmations() {
    return playConfirmations;
}

export async function playAudio(nazu, from, m, q, reply) {
    try {
        if (!q) return reply(`╭━━━⊱ 🎵 *PLAY* 🎵 ⊱━━━╮
│
│ 📝 Digite o nome da música ou vídeo
│
│  *Exemplos:*
│  !play Imagine Dragons
│  !play https://youtube.com/...
│
╰━━━━━━━━━━━━━━━━━━━━━━━━━╯`);

        if (m.key) await nazu.sendMessage(from, { react: { text: '🔍', key: m.key } }).catch(() => {});

        let video = null;
        try {
            const yts = await import('yt-search');
            const searchFn = yts.default || yts;
            const res = await searchFn(q);
            if (res && res.videos && res.videos.length > 0) {
                video = res.videos[0];
            }
        } catch (e) { console.error('[yt-search error]', e.message); }

        if (!video) {
            if (m.key) nazu.sendMessage(from, { react: { text: '❌', key: m.key } }).catch(() => {});
            return reply('❌ Nenhum resultado encontrado.');
        }

        const seconds = video.seconds || 0;
        // Resolve os links já no menu: mostra o tamanho REAL e reaproveita no download
        const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);
        const [preAudio, preVideo] = await Promise.all([
            withTimeout(ytResolveSized(video.url, 'audio').catch(() => null), 25000),
            withTimeout(ytResolveBest(video.url, 'video').catch(() => null), 30000)
        ]);
        const mb = b => (b / (1024 * 1024)).toFixed(1);
        const audioSize = preAudio?.size ? `${mb(preAudio.size)} MB` : `~${(seconds * 0.016).toFixed(1)} MB`;
        const videoSize = preVideo?.size ? `${mb(preVideo.size)} MB (${preVideo.quality}p)${preVideo.size > VIDEO_LIMIT ? ' 📁 documento' : ''}` : `~${(seconds * 0.1).toFixed(1)} MB`;

        if (m.key) await nazu.sendMessage(from, { react: { text: '🎧', key: m.key } }).catch(() => {});

        const msg = `╭━━━⊱ 🎵 *NAZUNA PLAY* 🎵 ⊱━━━╮
│
│ 📌 *Título:* ${video.title}
│ 📆 *Postado:* ${video.ago || 'N/A'}
│ ⌚ *Duração:* ${video.timestamp || 'N/A'}
│ 👀 *Vistas:* ${(video.views || 0).toLocaleString()}
│
│ ━━━━━━━━━━━━━━━━━━━━━━━
│ Responda com *1* ou *2*:
│
│ 1️⃣ = MP3 (Áudio)  ${audioSize} 🎵
│ 2️⃣ = MP4 (Vídeo)  ${videoSize} 🎬
│
╰━━━━━━━━━━━━━━━━━━━━━━━━━╯`;

        const thumb = video.image || video.thumbnail;
        if (thumb) {
            try {
                await nazu.sendMessage(from, {
                    image: { url: thumb },
                    caption: msg
                }, { quoted: m });
            } catch (thumbErr) {

                console.warn(`[play] Thumbnail falhou (${thumbErr.message?.substring(0, 60)}), enviando texto`);
                await nazu.sendMessage(from, { text: msg }, { quoted: m });
            }
        } else {
            await nazu.sendMessage(from, { text: msg }, { quoted: m });
        }

        const senderJid = m.key?.participant || m.key?.remoteJid || from;
        const confirmKey = `${senderJid}_${from}`;

        if (playConfirmations.has(confirmKey)) {
            clearTimeout(playConfirmations.get(confirmKey).timeout);
        }

        playConfirmations.set(confirmKey, {
            url: video.url,
            title: video.title,
            thumb: thumb,
            preAudio,
            preVideo,
            from: from,
            m: m,
            timeout: setTimeout(() => {
                playConfirmations.delete(confirmKey);
            }, 60000)
        });

    } catch (err) {
        console.error('Erro no play:', err);
        if (m?.key) await nazu.sendMessage(from, { react: { text: '❌', key: m.key } }).catch(() => {});
        reply('❌ Erro ao processar o comando.');
    }
}

export async function handlePlayConfirmation(nazu, from, m, text, senderJid) {
    const confirmKey = `${senderJid}_${from}`;
    const pending = playConfirmations.get(confirmKey);
    if (!pending) return false;

    const choice = text.trim();
    if (choice !== '1' && choice !== '2') return false;

    clearTimeout(pending.timeout);
    playConfirmations.delete(confirmKey);

    if (m.key) await nazu.sendMessage(from, { react: { text: '⏳', key: m.key } }).catch(() => {});

    const type = choice === '1' ? 'audio' : 'video';

    (async () => {
        try {
            const dl = await downloadYT(pending.url, type, type === 'audio' ? pending.preAudio : pending.preVideo);

            if (type === 'audio') {
                let finalPath = dl.filePath;
                finalPath = await refinarAudio(finalPath);
                await nazu.sendMessage(from, {
                    audio: { url: finalPath },
                    mimetype: 'audio/mpeg',
                }, { quoted: m });
                try { fs.unlinkSync(finalPath); } catch {}
            } else {
                let finalPath = dl.filePath;
                await enviarVideoInteligente(nazu, from, m, finalPath, `🎬 ${pending.title || 'YouTube'}`, `${(pending.title || 'YouTube').replace(/[\\/:*?"<>|]/g, '')}.mp4`);
                if (finalPath !== dl.filePath) {
                    try { fs.unlinkSync(finalPath); } catch {}
                }
            }
            try { if (fs.existsSync(dl.filePath)) fs.unlinkSync(dl.filePath); } catch {}
            if (m.key) await nazu.sendMessage(from, { react: { text: '✅', key: m.key } }).catch(() => {});
        } catch (err) {
            console.error(`[play-${type}] Erro:`, err.message);
            if (m.key) await nazu.sendMessage(from, { react: { text: '❌', key: m.key } }).catch(() => {});
            await nazu.sendMessage(from, {
                text: `❌ Erro no download (${type}): ${pending.title}`
            }, { quoted: m });
        }
    })();

    return true;
}

export async function baixarDireto(nazu, from, m, url, type = 'video') {
    if (m.key) await nazu.sendMessage(from, { react: { text: '⏳', key: m.key } }).catch(() => {});

    (async () => {
        try {
            const dl = await downloadYT(url, type);
            let finalPath = dl.filePath;

            if (type === 'audio') {
                finalPath = await refinarAudio(finalPath);
                await nazu.sendMessage(from, { audio: { url: finalPath }, mimetype: 'audio/mpeg' }, { quoted: m });
                try { fs.unlinkSync(finalPath); } catch {}
            } else {
                await enviarVideoInteligente(nazu, from, m, finalPath, `🎬 ${dl.title || 'YouTube'}`, `${(dl.title || 'YouTube').replace(/[\\/:*?"<>|]/g, '')}.mp4`);
                if (finalPath !== dl.filePath) try { fs.unlinkSync(finalPath); } catch {}
            }
            try { if (fs.existsSync(dl.filePath)) fs.unlinkSync(dl.filePath); } catch {}
            if (m.key) await nazu.sendMessage(from, { react: { text: '✅', key: m.key } }).catch(() => {});
        } catch (err) {
            console.error(`[baixarDireto-${type}] Erro:`, err.message);
            if (m.key) await nazu.sendMessage(from, { react: { text: '❌', key: m.key } }).catch(() => {});
        }
    })();
}

export async function playVideo(nazu, from, m, q, reply) {
    if (!q) return reply('❌ Envie o link do vídeo.');
    await baixarDireto(nazu, from, m, q, 'video');
}
