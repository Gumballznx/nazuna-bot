import axios from 'axios';
import { getCobaltApis } from '../../utils/ytHelper.js';

let _fg = null;
async function getFg() {
    if (!_fg) _fg = (await import('fg-senna')).default;
    return _fg;
}

async function downloadBuffer(url) {
    const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    return Buffer.from(res.data);
}

async function igdlCobalt(url) {
    const payload = {
        url: url,
        downloadMode: 'auto'
    };

    const apis = getCobaltApis ? getCobaltApis() : [
        'https://cobalt.api.scity.gov.mn',
        'https://co.wuk.sh',
        'https://nuko-c.meowing.de',
        'https://subito-c.meowing.de',
        'https://melon.clxxped.lol',
        'https://api-cobalt.eversiege.network'
    ];

    for (const api of apis.slice(0, 3)) {
        try {
            const response = await axios.post(api, payload, {
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0'
                },
                timeout: 5000
            });

            const data = response.data;
            if (!data) continue;

            if (data.status === 'picker' && Array.isArray(data.picker)) {
                const results = [];
                for (const item of data.picker) {
                    try {
                        const mediaUrl = item.url;
                        if (!mediaUrl) continue;
                        const buff = await downloadBuffer(mediaUrl);
                        const isVideo = mediaUrl.includes('.mp4') || mediaUrl.includes('video') || item.type === 'video';
                        results.push({
                            type: isVideo ? 'video' : 'image',
                            buff
                        });
                    } catch (e) {
                        console.error('[igdl-cobalt] Erro ao baixar item do picker:', e.message);
                    }
                }
                if (results.length > 0) {
                    return { ok: true, data: results, count: results.length };
                }
            }

            if (data.url) {
                const buff = await downloadBuffer(data.url);
                const isVideo = data.url.includes('.mp4') || data.url.includes('video') || data.filename?.includes('.mp4') || data.status === 'stream';
                return { ok: true, data: [{ type: isVideo ? 'video' : 'image', buff }], count: 1 };
            }
        } catch (error) {

        }
    }
    throw new Error('Todas as instâncias de Cobalt falharam.');
}

async function igdlInstaVideoSave(url) {
    try {
        const response = await axios.post('https://www.instavideosave.net/api/instagram', {
            url: url
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 12000
        });

        const json = response.data;
        const mediaUrl = json?.data?.[0]?.url || json?.data?.url || json?.url || json?.result?.[0]?.url;
        if (mediaUrl) {
            const buff = await downloadBuffer(mediaUrl);
            const isVideo = mediaUrl.includes('.mp4') || mediaUrl.includes('video');
            return { ok: true, data: [{ type: isVideo ? 'video' : 'image', buff }], count: 1 };
        }
    } catch (e) {}
    throw new Error('API instavideosave falhou.');
}

// Descobre o tipo pelo conteúdo (os links do rapidcdn não têm extensão)
function tipoPorBuffer(buff) {
    if (buff && buff.length > 12 && buff.toString('utf8', 4, 8) === 'ftyp') return 'video';
    return 'image';
}

// API usada pelo fg-senna, pegando TODOS os itens (carrossel)
async function igdlTioo(url) {
    const { data } = await axios.get(`https://backend1.tioo.eu.org/igdl?url=${encodeURIComponent(url)}`, { timeout: 12000 });
    if (!Array.isArray(data) || !data.length) return null;
    const results = [];
    for (const item of data) {
        if (!item?.url) continue;
        try {
            const buff = await downloadBuffer(item.url);
            results.push({ type: tipoPorBuffer(buff), buff });
        } catch (_) {}
    }
    return results.length ? { ok: true, data: results, count: results.length } : null;
}

async function igdl(url) {
    // Remove parâmetros de rastreio (?igsh=, ?dlrf=...)
    if (/instagram\.com|instagr\.am/i.test(url)) url = url.split('?')[0];

    let apiDown = false;
    try {
        const resTioo = await igdlTioo(url);
        if (resTioo && resTioo.ok) return resTioo;
    } catch (_) { apiDown = true; }

    try {
        const resCobalt = await igdlCobalt(url);
        if (resCobalt && resCobalt.ok) return resCobalt;
    } catch (_) {}

    // fg.igdl usa a mesma API do igdlTioo: se ela caiu, pula (evita mais 30 s de espera)
    if (!apiDown) try {
        const fg = await getFg();
        const res = await fg.igdl(url).catch(() => null);

        if (res) {

            if (res.result && Array.isArray(res.result) && res.result.length > 0) {
                const results = [];
                for (const item of res.result) {
                    try {
                        const mediaUrl = item.url || item.dl_url;
                        if (!mediaUrl) continue;
                        const buff = await downloadBuffer(mediaUrl);
                        results.push({ type: tipoPorBuffer(buff), buff });
                    } catch (e) {}
                }
                if (results.length > 0) {
                    return { ok: true, data: results, count: results.length };
                }
            }

            const dlUrl = res.dl_url || res.url;
            if (dlUrl) {
                const buff = await downloadBuffer(dlUrl);
                return { ok: true, data: [{ type: tipoPorBuffer(buff), buff }], count: 1 };
            }
        }
    } catch (_) {}

    try {
        const resInsta = await igdlInstaVideoSave(url);
        if (resInsta && resInsta.ok) return resInsta;
    } catch (_) {}

    return {
        ok: false,
        msg: 'Não foi possível baixar mídia do Instagram.'
    };
}

export {
    igdl as dl
};
