// Utilitários compartilhados

const $ = (id) => document.getElementById(id);

// Categorias de serviço (usadas pelo cliente e pelo prestador)
const CATEGORIES = [
    { value: 'Guincho',     icon: '🚚', label: 'Guincho / Reboque' },
    { value: 'Eletricista', icon: '⚡', label: 'Eletricista' },
    { value: 'Encanador',   icon: '🚰', label: 'Encanador' },
    { value: 'Mecânico',    icon: '🔧', label: 'Mecânico' },
    { value: 'Outros',      icon: '✨', label: 'Outros serviços' }
];

// Escapa HTML para evitar XSS (usado nas mensagens do chat)
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
}

// Mensagem rápida na tela (substitui alert)
let toastTimer;
function toast(msg, isError = false) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// Converte "POINT(lng lat)" ou GeoJSON em [lat, lng]
function parsePoint(loc) {
    if (!loc) return null;
    if (typeof loc === 'object' && loc.coordinates) return [loc.coordinates[1], loc.coordinates[0]];
    const m = /POINT\(([-\d.]+) ([-\d.]+)\)/i.exec(loc);
    return m ? [parseFloat(m[2]), parseFloat(m[1])] : null;
}

function toPoint(lat, lng) {
    return `SRID=4326;POINT(${lng} ${lat})`;
}

// Distância em km (Haversine)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Chama uma Edge Function do Supabase (pagamento PIX). Retorna { data, error } com a mensagem em português.
async function callFn(name, body) {
    try {
        const { data, error } = await supabaseClient.functions.invoke(name, { body });
        if (error) {
            let message = error.message;
            try { message = (await error.context.json()).error || message; } catch { /* sem JSON */ }
            if (/failed to send|fetch/i.test(message)) message = 'Sem conexão com o servidor de pagamento. Verifique se as funções foram publicadas.';
            return { data: null, error: message };
        }
        return { data, error: null };
    } catch (err) {
        return { data: null, error: err.message || 'Erro de conexão.' };
    }
}
