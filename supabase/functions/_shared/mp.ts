// Utilitários do Mercado Pago (sem dependências externas, para poder ser testado).

export const MP_API = 'https://api.mercadopago.com';
export const PIX_MINUTES = 30; // validade do QR Code (o Mercado Pago aceita de 30 min a 30 dias)

// Valor cobrado por categoria, definido AQUI no servidor (o navegador nunca decide o preço).
// Altere os valores conforme a sua tabela de preços.
export const PRICES: Record<string, number> = {
    'Guincho': 20,
    'Eletricista': 20,
    'Encanador': 20,
    'Mecânico': 20,
    'Outros': 20,
};

export function priceFor(category: string): number | null {
    const value = PRICES[category];
    return typeof value === 'number' && value >= 1 ? Math.round(value * 100) / 100 : null;
}

export const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
    });
}

export function isUuid(value: unknown): value is string {
    return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export type PaymentStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'refunded';

// Converte o status do Mercado Pago para o nosso.
export function mapStatus(status: string, detail?: string): PaymentStatus {
    switch (status) {
        case 'approved': return 'approved';
        case 'refunded':
        case 'charged_back': return 'refunded';
        case 'rejected': return 'rejected';
        case 'cancelled': return detail === 'expired' ? 'expired' : 'cancelled';
        default: return 'pending'; // pending, in_process, authorized...
    }
}

export function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Confere a assinatura x-signature do webhook:
//   header:   x-signature: ts=...,v1=...
//   manifesto: id:<data.id minúsculo>;request-id:<x-request-id>;ts:<ts>;   (HMAC-SHA256 hex)
export async function verifySignature(
    secret: string,
    input: { xSignature: string | null; xRequestId: string | null; dataId: string },
): Promise<boolean> {
    if (!secret || !input.xSignature) return false;
    const parts: Record<string, string> = {};
    for (const piece of input.xSignature.split(',')) {
        const i = piece.indexOf('=');
        if (i > 0) parts[piece.slice(0, i).trim()] = piece.slice(i + 1).trim();
    }
    if (!parts.ts || !parts.v1) return false;
    const id = /^[a-z0-9]+$/i.test(input.dataId) ? input.dataId.toLowerCase() : input.dataId;
    let manifest = '';
    if (id) manifest += `id:${id};`;
    if (input.xRequestId) manifest += `request-id:${input.xRequestId};`;
    manifest += `ts:${parts.ts};`;
    const expected = await hmacHex(secret, manifest);
    return timingSafeEqual(expected, parts.v1.toLowerCase());
}

// Para testes: gera um x-signature válido.
export async function signForTest(secret: string, dataId: string, requestId: string, ts: string): Promise<string> {
    const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
    return `ts=${ts},v1=${await hmacHex(secret, `id:${id};request-id:${requestId};ts:${ts};`)}`;
}
