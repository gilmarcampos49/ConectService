// Adaptador: traduz o "Db" do handlers.ts para o cliente do Supabase (service_role).
import type { Db, PaymentRow, ServiceRow } from './handlers.ts';

function check(error: { message: string } | null) {
    if (error) throw new Error(error.message);
}

// deno-lint-ignore no-explicit-any
export function makeDb(admin: any): Db {
    return {
        async getService(id): Promise<ServiceRow | null> {
            const { data, error } = await admin.from('services')
                .select('id,client_id,provider_id,status,category,price').eq('id', id).maybeSingle();
            check(error);
            return data;
        },
        async updateService(id, patch, onlyIfStatusIn) {
            let q = admin.from('services').update(patch).eq('id', id);
            if (onlyIfStatusIn) q = q.in('status', onlyIfStatusIn);
            const { data, error } = await q.select('id,status').maybeSingle();
            check(error);
            return data;
        },
        async listPayments(serviceId): Promise<PaymentRow[]> {
            const { data, error } = await admin.from('payments').select('*')
                .eq('service_id', serviceId).order('created_at', { ascending: false });
            check(error);
            return data ?? [];
        },
        async getPaymentByMpId(mpId): Promise<PaymentRow | null> {
            const { data, error } = await admin.from('payments').select('*').eq('mp_payment_id', mpId).maybeSingle();
            check(error);
            return data;
        },
        async insertPayment(row): Promise<PaymentRow> {
            const { data, error } = await admin.from('payments').insert(row).select().single();
            check(error);
            return data;
        },
        async updatePayment(id, patch) {
            const { error } = await admin.from('payments').update(patch).eq('id', id);
            check(error);
        },
        async deletePayment(id) {
            const { error } = await admin.from('payments').delete().eq('id', id);
            check(error);
        },
    };
}
