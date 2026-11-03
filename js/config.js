// Configuração do Supabase.
// A chave "publishable" (anon) PODE ficar no front-end — a segurança real vem das
// políticas RLS definidas em supabase/schema.sql. NUNCA coloque a chave "service_role" aqui.
const SUPABASE_URL = 'https://nsltuhoefpzgosonoepg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_jwUIQUo-AGyHuw_b_-hkmg_1PZkXzti';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
