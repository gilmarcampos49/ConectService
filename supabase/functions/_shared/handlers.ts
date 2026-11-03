// Regras de pagamento PIX. Não importa nada externo: o banco, o usuário e o fetch entram por "ctx",
// o que permite testar tudo sem Supabase nem Mercado Pago de verdade.

import {
    MP_API, PIX_MINUTES, cors, isUuid, json, mapStatus, priceFor, verifySignature,
} from './mp.ts';

export interface ServiceRow {
    id: string; client_id: string; provider_id: string | null;
    status: string; category: string; price: number;
}
export interface PaymentRow {
    id: string; service_id: string; client_id: string; mp_payment_id: number | null;
    amount: number; status: string; qr_code: string | null; qr_code_base64: string | null;
    ticket_url: string | null; expires_at: string | null; paid_at: string | null;
    refunded_at: string | null; created_at: string;
}
export interface Db {
    getService(id: string): Promise<ServiceRow | null>;
    updateService(id: string, patch: Record<string, unknown>, onlyIfStatusIn?: string[]): Promise<{ id: string; status: string } | null>;
    listPayments(serviceId: string): Promise<PaymentRow[]>;
    getPaymentByMpId(mpId: number): Promise<PaymentRow | null>;
    insertPayment(row: Record<string, unknown>): Promise<PaymentRow>;
    updatePayment(id: string, patch: Record<string, unknown>): Promise<void>;
    deletePayment(id: string): Promise<void>;
}
export interface Ctx {
    db: Db;
    getUser(req: Request): Promise<{ id: string; email?: string | null; is_anonymous?: boolean } | null>;
    env: Record<string, string | undefined>;
    fetch: typeof fetch;
    now(): Date;
}

// ---------- Mercado Pago ----------
async function mp(ctx: Ctx, method: string, path: string, body?: unknown, idempotencyKey?: string) {
    const headers: Record<string, string> = {
        'Authorization': `Bearer ${ctx.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
    };
    if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
    const res = await ctx.fetch(MP_API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* resposta sem JSON */ }
    return { ok: res.ok, status: res.status, data };
}

async function readBody(req: Request): Promise<any> {
    try { return await req.json(); } catch { return {}; }
}

function paymentView(row: PaymentRow) {
    return {
        payment_status: row.status,
        amount: Number(row.amount),
        qr_code: row.qr_code,
        qr_code_base64: row.qr_code_base64,
        ticket_url: row.ticket_url,
        expires_at: row.expires_at,
    };
}

async function authenticate(req: Request, ctx: Ctx) {
    const user = await ctx.getUser(req);
    return user;
}

// Devolve o dinheiro (reembolso total). Retorna true se o reembolso foi feito.
export async function refundPayment(ctx: Ctx, row: PaymentRow): Promise<boolean> {
    if (!row.mp_payment_id) return false;
    const r = await mp(ctx, 'POST', `/v1/payments/${row.mp_payment_id}/refunds`, {}, `refund-${row.id}`);
    const already = r.status === 400 && JSON.stringify(r.data ?? {}).toLowerCase().includes('refund');
    if (r.ok || already) {
        await ctx.db.updatePayment(row.id, { status: 'refunded', refunded_at: ctx.now().toISOString() });
        return true;
    }
    console.error('Falha no reembolso', row.id, r.status, JSON.stringify(r.data));
    return false;
}

// ---------- Sincroniza um pagamento com o Mercado Pago (webhook e consulta) ----------
export async function syncPayment(ctx: Ctx, mpId: number | string) {
    const r = await mp(ctx, 'GET', `/v1/payments/${mpId}`);
    if (r.status === 404) return { found: false as const };
    if (!r.ok) throw new Error(`Mercado Pago respondeu ${r.status}`);
    const p = r.data;

    const row = await ctx.db.getPaymentByMpId(Number(p.id));
    if (!row) return { found: false as const };

    // O pagamento tem que ser exatamente o que criamos para esse pedido.
    if (String(p.external_reference) !== row.service_id
        || Math.abs(Number(p.transaction_amount) - Number(row.amount)) > 0.005) {
        console.error('Pagamento divergente', row.id);
        return { found: true as const, mismatch: true as const };
    }

    const status = mapStatus(String(p.status), p.status_detail);
    const patch: Record<string, unknown> = {};
    if (row.status !== status && row.status !== 'refunded') patch.status = status;
    if (status === 'approved' && !row.paid_at) patch.paid_at = p.date_approved ?? ctx.now().toISOString();
    if (Object.keys(patch).length) await ctx.db.updatePayment(row.id, patch);

    let serviceStatus: string | undefined;
    if (status === 'approved') {
        const svc = await ctx.db.getService(row.service_id);
        if (svc?.status === 'awaiting_payment') {
            // Libera o pedido para os prestadores (só depois do pagamento confirmado)
            await ctx.db.updateService(row.service_id, { status: 'pending', price: row.amount }, ['awaiting_payment']);
            serviceStatus = 'pending';
        } else if (svc?.status === 'cancelled') {
            // Pagou depois de cancelar: devolve o dinheiro automaticamente
            await refundPayment(ctx, { ...row, status: 'approved' });
            serviceStatus = 'cancelled';
        } else {
            serviceStatus = svc?.status;
        }
    }
    return { found: true as const, payment_status: patch.status ?? row.status, service_status: serviceStatus };
}

// ---------- POST create-pix ----------
export async function handleCreatePix(req: Request, ctx: Ctx): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    if (req.method !== 'POST') return json({ error: 'Método não permitido.' }, 405);
    const user = await authenticate(req, ctx);
    if (!user) return json({ error: 'Faça login novamente.' }, 401);
    if (!ctx.env.MP_ACCESS_TOKEN) return json({ error: 'Pagamento não configurado no servidor.' }, 500);

    const { service_id } = await readBody(req);
    if (!isUuid(service_id)) return json({ error: 'Pedido inválido.' }, 400);
    if (!user.email) return json({ error: 'Crie uma conta com e-mail para pagar com PIX.' }, 400);

    const service = await ctx.db.getService(service_id);
    if (!service || service.client_id !== user.id) return json({ error: 'Pedido não encontrado.' }, 404);

    let payments = await ctx.db.listPayments(service_id);
    if (payments.some((p) => p.status === 'approved')) return json({ paid: true, payment_status: 'approved' });
    if (service.status !== 'awaiting_payment') return json({ error: 'Este pedido não aceita mais pagamento.' }, 409);

    const nowMs = ctx.now().getTime();
    // Limpa tentativas que travaram antes de falar com o Mercado Pago
    for (const p of payments.filter((x) => x.status === 'pending' && !x.mp_payment_id
        && nowMs - new Date(x.created_at).getTime() > 2 * 60_000)) {
        await ctx.db.deletePayment(p.id);
    }
    payments = await ctx.db.listPayments(service_id);

    const open = payments.find((p) => p.status === 'pending' && p.mp_payment_id);
    if (open) {
        if (open.expires_at && new Date(open.expires_at).getTime() > nowMs) return json(paymentView(open));
        // QR Code vencido: cancela e gera um novo
        await mp(ctx, 'PUT', `/v1/payments/${open.mp_payment_id}`, { status: 'cancelled' });
        await ctx.db.updatePayment(open.id, { status: 'expired' });
    }

    const amount = priceFor(service.category);
    if (amount === null) return json({ error: 'Categoria sem preço definido.' }, 400);

    const expiresAt = new Date(nowMs + PIX_MINUTES * 60_000);
    let row: PaymentRow;
    try {
        row = await ctx.db.insertPayment({
            service_id, client_id: user.id, amount, status: 'pending', expires_at: expiresAt.toISOString(),
        });
    } catch {
        // Corrida: outro clique criou o pagamento ao mesmo tempo
        const again = (await ctx.db.listPayments(service_id)).find((p) => p.status === 'pending' && p.mp_payment_id);
        return again ? json(paymentView(again)) : json({ error: 'Já existe um pagamento em andamento. Tente de novo.' }, 409);
    }

    const r = await mp(ctx, 'POST', '/v1/payments', {
        transaction_amount: amount,
        description: `ConnectService - ${service.category}`,
        payment_method_id: 'pix',
        payer: { email: user.email },
        external_reference: service.id,
        notification_url: `${ctx.env.SUPABASE_URL}/functions/v1/mp-webhook`,
        date_of_expiration: expiresAt.toISOString().replace('Z', '+00:00'),
    }, row.id);

    const tx = r.data?.point_of_interaction?.transaction_data;
    if (!r.ok || !tx?.qr_code) {
        console.error('Falha ao criar PIX', r.status, JSON.stringify(r.data));
        await ctx.db.deletePayment(row.id);
        return json({ error: 'Não foi possível gerar o PIX agora. Tente novamente.' }, 502);
    }

    await ctx.db.updatePayment(row.id, {
        mp_payment_id: r.data.id,
        qr_code: tx.qr_code,
        qr_code_base64: tx.qr_code_base64 ?? null,
        ticket_url: tx.ticket_url ?? null,
    });
    await ctx.db.updateService(service.id, { price: amount }, ['awaiting_payment']);

    return json(paymentView({
        ...row, qr_code: tx.qr_code, qr_code_base64: tx.qr_code_base64 ?? null,
        ticket_url: tx.ticket_url ?? null, mp_payment_id: r.data.id,
    }));
}

// ---------- POST check-pix (o app pergunta "já pagou?") ----------
export async function handleCheckPix(req: Request, ctx: Ctx): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    if (req.method !== 'POST') return json({ error: 'Método não permitido.' }, 405);
    const user = await authenticate(req, ctx);
    if (!user) return json({ error: 'Faça login novamente.' }, 401);
    if (!ctx.env.MP_ACCESS_TOKEN) return json({ error: 'Pagamento não configurado no servidor.' }, 500);

    const { service_id } = await readBody(req);
    if (!isUuid(service_id)) return json({ error: 'Pedido inválido.' }, 400);
    const service = await ctx.db.getService(service_id);
    if (!service || service.client_id !== user.id) return json({ error: 'Pedido não encontrado.' }, 404);

    const payments = await ctx.db.listPayments(service_id);
    const target = payments.find((p) => p.status === 'approved') ?? payments.find((p) => p.status === 'pending' && p.mp_payment_id);
    if (!target?.mp_payment_id) return json({ payment_status: 'none', service_status: service.status });

    try {
        const result = await syncPayment(ctx, target.mp_payment_id);
        const fresh = await ctx.db.getService(service_id);
        return json({ payment_status: (result as any).payment_status ?? target.status, service_status: fresh?.status ?? service.status });
    } catch (error) {
        console.error('check-pix', (error as Error).message);
        return json({ error: 'Não foi possível consultar o pagamento agora.' }, 502);
    }
}

// ---------- POST cancel-service (cancela e devolve o dinheiro, se já pagou) ----------
export async function handleCancel(req: Request, ctx: Ctx): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    if (req.method !== 'POST') return json({ error: 'Método não permitido.' }, 405);
    const user = await authenticate(req, ctx);
    if (!user) return json({ error: 'Faça login novamente.' }, 401);

    const { service_id } = await readBody(req);
    if (!isUuid(service_id)) return json({ error: 'Pedido inválido.' }, 400);
    const service = await ctx.db.getService(service_id);
    if (!service || service.client_id !== user.id) return json({ error: 'Pedido não encontrado.' }, 404);

    if (service.status !== 'cancelled') {
        // Só cancela se ninguém aceitou ainda (condição no próprio UPDATE evita corrida com o prestador)
        const done = await ctx.db.updateService(service_id, { status: 'cancelled' }, ['awaiting_payment', 'pending']);
        if (!done) {
            return json({ error: 'Pedido já aceito pelo prestador. Combine o cancelamento pelo chat.' }, 409);
        }
    }

    let refunded = false;
    let refundFailed = false;
    const payments = await ctx.db.listPayments(service_id);
    for (const p of payments) {
        if (p.status === 'approved') {
            if (await refundPayment(ctx, p)) refunded = true; else refundFailed = true;
        } else if (p.status === 'pending' && p.mp_payment_id) {
            await mp(ctx, 'PUT', `/v1/payments/${p.mp_payment_id}`, { status: 'cancelled' });
            await ctx.db.updatePayment(p.id, { status: 'cancelled' });
        }
    }
    return json({ cancelled: true, refunded, refund_failed: refundFailed });
}

// ---------- POST mp-webhook (o Mercado Pago avisa que algo mudou) ----------
export async function handleWebhook(req: Request, ctx: Ctx): Promise<Response> {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const secret = ctx.env.MP_WEBHOOK_SECRET;
    if (!secret || !ctx.env.MP_ACCESS_TOKEN) return new Response('not configured', { status: 500 });

    const url = new URL(req.url);
    const dataId = url.searchParams.get('data.id') ?? '';
    const type = url.searchParams.get('type') ?? url.searchParams.get('topic');

    const valid = await verifySignature(secret, {
        xSignature: req.headers.get('x-signature'),
        xRequestId: req.headers.get('x-request-id'),
        dataId,
    });
    if (!valid) return new Response('invalid signature', { status: 401 });
    if (type && type !== 'payment') return new Response('ignored', { status: 200 });
    if (!dataId) return new Response('missing id', { status: 400 });

    try {
        await syncPayment(ctx, dataId);
        return new Response('ok', { status: 200 });
    } catch (error) {
        console.error('mp-webhook', (error as Error).message);
        return new Response('retry', { status: 500 }); // o Mercado Pago tenta de novo
    }
}
