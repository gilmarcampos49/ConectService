// Monta o contexto real (Supabase + fetch). É a única parte que depende do ambiente Deno.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { makeDb } from './db.ts';
import type { Ctx } from './handlers.ts';

export function buildContext(): Ctx {
    const env = Deno.env.toObject();
    const admin = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    return {
        db: makeDb(admin),
        env,
        fetch,
        now: () => new Date(),
        async getUser(req) {
            const header = req.headers.get('Authorization') ?? '';
            const token = header.replace(/^Bearer\s+/i, '');
            if (!token) return null;
            const { data, error } = await admin.auth.getUser(token);
            if (error || !data.user) return null;
            return { id: data.user.id, email: data.user.email, is_anonymous: data.user.is_anonymous };
        },
    };
}
