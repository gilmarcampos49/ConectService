-- ConnectService Pro — esquema + segurança (RLS)
-- Rode este arquivo no Supabase: SQL Editor > New query > Run.
-- É seguro rodar mais de uma vez.
-- As políticas do Storage devem ser configuradas em Storage > Policies,
-- pois storage.objects é uma tabela gerenciada pelo Supabase.

create extension if not exists postgis;

-- ============ PERFIS ============
create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    full_name text,
    user_type text not null default 'client' check (user_type in ('client','provider')),
    available_for_services boolean not null default false,
    last_location geography(Point, 4326),
    last_location_updated_at timestamptz,
    vehicle_plate text,
    vehicle_type text,
    created_at timestamptz not null default now()
);
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists available_for_services boolean not null default false;
alter table public.profiles add column if not exists last_location geography(Point, 4326);
alter table public.profiles add column if not exists last_location_updated_at timestamptz;
alter table public.profiles add column if not exists vehicle_plate text;
alter table public.profiles add column if not exists vehicle_type text;
-- Categorias que o prestador atende (ex.: {Guincho,Eletricista})
alter table public.profiles add column if not exists services_offered text[] not null default '{}';

-- Cria o perfil automaticamente quando alguém se cadastra (e-mail, Google ou visitante)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    insert into public.profiles (id, full_name)
    values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(coalesce(new.email,''), '@', 1)))
    on conflict (id) do nothing;
    return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
    for each row execute function public.handle_new_user();

-- Perfis para usuários que já existiam antes deste script
insert into public.profiles (id, full_name)
select id, split_part(coalesce(email,''), '@', 1) from auth.users
on conflict (id) do nothing;

-- ============ SERVIÇOS ============
create table if not exists public.services (
    id uuid primary key default gen_random_uuid(),
    client_id uuid not null references auth.users(id) on delete cascade,
    provider_id uuid references auth.users(id) on delete set null,
    category text not null,
    price numeric(10,2) not null default 0,
    status text not null default 'awaiting_payment' check (status in ('awaiting_payment','pending','accepted','completed','cancelled')),
    target_provider_id uuid references auth.users(id) on delete set null,
    client_location geography(Point, 4326),
    service_started_at timestamptz,
    start_photo_path text,
    end_photo_path text,
    tow_stage text check (tow_stage in ('waiting_arrival','arrived','repair_selected','transport_selected','transporting')) default 'waiting_arrival',
    tow_destination text,
    created_at timestamptz not null default now()
);
alter table public.services add column if not exists tow_stage text check (tow_stage in ('waiting_arrival','arrived','repair_selected','transport_selected','transporting')) default 'waiting_arrival';
alter table public.services add column if not exists tow_destination text;
alter table public.services add column if not exists target_provider_id uuid references auth.users(id) on delete set null;
alter table public.services add column if not exists service_started_at timestamptz;
alter table public.services add column if not exists start_photo_path text;
alter table public.services add column if not exists end_photo_path text;
-- Instalações antigas: troca a regra de status para incluir 'awaiting_payment' (aguardando pagamento)
alter table public.services drop constraint if exists services_status_check;
alter table public.services add constraint services_status_check
    check (status in ('awaiting_payment','pending','accepted','completed','cancelled'));
alter table public.services alter column status set default 'awaiting_payment';
create index if not exists services_status_idx on public.services(status);

-- ============ PAGAMENTOS (PIX / Mercado Pago) ============
-- Só as Edge Functions (service_role) gravam aqui. O cliente apenas lê os próprios pagamentos.
create table if not exists public.payments (
    id uuid primary key default gen_random_uuid(),
    service_id uuid not null references public.services(id) on delete cascade,
    client_id uuid not null references auth.users(id) on delete cascade,
    provider text not null default 'mercadopago',
    mp_payment_id bigint unique,
    amount numeric(10,2) not null check (amount > 0),
    status text not null default 'pending'
        check (status in ('pending','approved','rejected','cancelled','expired','refunded')),
    qr_code text,
    qr_code_base64 text,
    ticket_url text,
    expires_at timestamptz,
    paid_at timestamptz,
    refunded_at timestamptz,
    created_at timestamptz not null default now()
);
-- No máximo um pagamento "em aberto" ou aprovado por pedido (evita cobrança duplicada)
create unique index if not exists payments_one_active_per_service
    on public.payments(service_id) where status in ('pending','approved');
create index if not exists payments_service_idx on public.payments(service_id, created_at desc);
create index if not exists profiles_provider_location_idx on public.profiles(user_type, last_location_updated_at desc);

-- Fotos privadas de início e fim dos serviços de guincho
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('service-evidence', 'service-evidence', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Checa acesso aos arquivos sem depender das políticas de leitura de services.
create or replace function public.can_access_service_evidence(object_name text, operation text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select exists (
        select 1
        from public.services s
        where s.id::text = split_part(coalesce(object_name, ''), '/', 1)
          and case
              when operation = 'read' then
                  s.client_id = auth.uid() or s.provider_id = auth.uid()
              when operation in ('insert', 'update', 'delete') then
                  s.provider_id = auth.uid()
                  and s.status = 'accepted'
                  and s.category = 'Guincho'
              else false
          end
    );
$$;
revoke all on function public.can_access_service_evidence(text, text) from public;
grant execute on function public.can_access_service_evidence(text, text) to authenticated;

-- ============ MENSAGENS ============
create table if not exists public.messages (
    id uuid primary key default gen_random_uuid(),
    service_id uuid not null references public.services(id) on delete cascade,
    sender_id uuid not null references auth.users(id) on delete cascade,
    content text not null check (char_length(content) between 1 and 500),
    created_at timestamptz not null default now()
);
create index if not exists messages_service_idx on public.messages(service_id, created_at);

-- ============ AVALIAÇÕES ============
create table if not exists public.reviews (
    id uuid primary key default gen_random_uuid(),
    service_id uuid not null references public.services(id) on delete cascade,
    client_id uuid not null references auth.users(id) on delete cascade,
    provider_id uuid not null references auth.users(id) on delete cascade,
    reviewer_id uuid references auth.users(id) on delete cascade,
    rating int not null check (rating between 1 and 5),
    comment text check (comment is null or char_length(comment) <= 300),
    created_at timestamptz not null default now()
);
alter table public.reviews add column if not exists reviewer_id uuid references auth.users(id) on delete cascade;
create unique index if not exists reviews_one_per_reviewer on public.reviews(service_id, reviewer_id);

-- ============ RLS ============
alter table public.profiles enable row level security;
alter table public.services enable row level security;
alter table public.messages enable row level security;
alter table public.reviews  enable row level security;
alter table public.payments enable row level security;

-- Limpa políticas antigas com os mesmos nomes
do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname='public' and tablename in ('profiles','services','messages','reviews','payments') loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- Perfis próprios e de participantes de serviços aceitos; localização de prestadores disponíveis
-- é consultada apenas pela função de proximidade abaixo.
create policy profiles_select on public.profiles for select to authenticated using (
    id = auth.uid()
    or exists (
        select 1 from public.services s
        where s.provider_id = public.profiles.id and s.client_id = auth.uid() and s.status = 'accepted'
    )
    or exists (
        select 1 from public.services s
        where s.provider_id = auth.uid() and s.client_id = public.profiles.id and s.status = 'accepted'
    )
);
create policy profiles_insert on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- SERVICES
-- Função auxiliar: o usuário logado atende esta categoria?
create or replace function public.provider_offers(cat text)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.user_type = 'provider'
          and cat = any(p.services_offered)
    );
$$;

create or replace function public.provider_can_receive_service(provider uuid, cat text)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (
        select 1 from public.profiles p
        where p.id = provider and p.user_type = 'provider'
          and p.available_for_services
          and cat = any(p.services_offered)
          and not exists (
              select 1 from public.services s
              where s.provider_id = provider and s.status = 'accepted'
          )
    );
$$;
revoke all on function public.provider_can_receive_service(uuid, text) from public;
grant execute on function public.provider_can_receive_service(uuid, text) to authenticated;

create or replace function public.nearest_available_provider(
    requested_category text,
    client_lat double precision,
    client_lng double precision
)
returns uuid language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare nearest_id uuid;
begin
    if auth.uid() is null then
        raise exception 'Authentication required';
    end if;
    if client_lat is null or client_lng is null
       or client_lat < -90 or client_lat > 90
       or client_lng < -180 or client_lng > 180 then
        raise exception 'Invalid client coordinates';
    end if;

    select p.id into nearest_id
    from public.profiles p
    where p.user_type = 'provider'
      and p.available_for_services
      and requested_category = any(p.services_offered)
      and p.last_location is not null
      and p.last_location_updated_at > now() - interval '2 minutes'
      and p.id <> auth.uid()
      and not exists (
          select 1 from public.services s
          where s.provider_id = p.id and s.status = 'accepted'
      )
    order by st_distance(
        p.last_location,
        st_setsrid(st_makepoint(client_lng, client_lat), 4326)::geography
    )
    limit 1;

    return nearest_id;
end $$;

revoke all on function public.nearest_available_provider(text, double precision, double precision) from public;
grant execute on function public.nearest_available_provider(text, double precision, double precision) to authenticated;

-- Vê: os próprios (cliente ou prestador) e os pendentes DAS CATEGORIAS que ele atende
create policy services_select on public.services for select to authenticated
    using (client_id = auth.uid() or provider_id = auth.uid()
           or (status = 'pending' and public.provider_offers(category)
               and (target_provider_id is null or target_provider_id = auth.uid())));
-- Cria: só como cliente de si mesmo, sempre aguardando pagamento (só o servidor libera depois do PIX)
create policy services_insert on public.services for insert to authenticated
    with check (client_id = auth.uid() and status = 'awaiting_payment' and provider_id is null
        and (target_provider_id is null or public.provider_can_receive_service(target_provider_id, category)));
-- Atualiza: cliente cancela o seu; prestador aceita pendente (vira ele) ou conclui o que aceitou
create policy services_update on public.services for update to authenticated
    using (client_id = auth.uid() or provider_id = auth.uid()
           or (status = 'pending' and client_id <> auth.uid() and public.provider_offers(category)
               and public.provider_can_receive_service(auth.uid(), category)
               and (target_provider_id is null or target_provider_id = auth.uid())))
    with check (client_id = auth.uid() or provider_id = auth.uid());

-- PAYMENTS: o cliente lê só os seus (QR Code, status). Ninguém grava pelo navegador.
create policy payments_select on public.payments for select to authenticated
    using (client_id = auth.uid());

-- Trava anti-fraude: pelo navegador ninguém libera um pedido sem pagar nem muda o valor.
create or replace function public.guard_service_update()
returns trigger language plpgsql set search_path = public as $$
begin
    -- Edge Functions (service_role) e o SQL Editor passam livres
    if coalesce(auth.role(), '') = 'service_role' or current_user in ('postgres', 'supabase_admin', 'service_role') then
        return new;
    end if;
    if new.client_id is distinct from old.client_id then
        raise exception 'Não é permitido trocar o cliente do pedido.';
    end if;
    if new.price is distinct from old.price then
        raise exception 'O valor do pedido não pode ser alterado.';
    end if;
    if new.status is distinct from old.status then
        if new.status = 'awaiting_payment' then
            raise exception 'Status inválido.';
        end if;
        if old.status = 'awaiting_payment' and new.status <> 'cancelled' then
            raise exception 'Pedido aguardando pagamento: conclua o PIX para liberar.';
        end if;
        if old.status = 'accepted' and new.status = 'cancelled' and auth.uid() = old.client_id then
            raise exception 'Pedido já aceito pelo prestador: combine o cancelamento pelo chat.';
        end if;
    end if;
    return new;
end $$;

drop trigger if exists guard_service_update on public.services;
create trigger guard_service_update before update on public.services
    for each row execute function public.guard_service_update();

-- MESSAGES: só os dois participantes do serviço
create policy messages_select on public.messages for select to authenticated
    using (exists (select 1 from public.services s where s.id = service_id and (s.client_id = auth.uid() or s.provider_id = auth.uid())));
create policy messages_insert on public.messages for insert to authenticated
    with check (sender_id = auth.uid() and exists (select 1 from public.services s where s.id = service_id and (s.client_id = auth.uid() or s.provider_id = auth.uid())));

-- REVIEWS: qualquer logado lê; só participante de serviço concluído avalia
create policy reviews_select on public.reviews for select to authenticated using (true);
create policy reviews_insert on public.reviews for insert to authenticated
    with check (reviewer_id = auth.uid() and exists (
        select 1 from public.services s
        where s.id = service_id and s.status = 'completed'
          and s.client_id = client_id and s.provider_id = provider_id
          and (s.client_id = auth.uid() or s.provider_id = auth.uid())));

-- ============ REALTIME ============
do $$ begin
  begin alter publication supabase_realtime add table public.services; exception when others then null; end;
  begin alter publication supabase_realtime add table public.messages; exception when others then null; end;
  begin alter publication supabase_realtime add table public.profiles; exception when others then null; end;
end $$;

-- ============ STORAGE: fotos de início/fim do guincho ============
-- Sem estas políticas o Supabase bloqueia o envio e a exibição das fotos
-- ("new row violates row-level security policy").
do $$
begin
    drop policy if exists service_evidence_read   on storage.objects;
    drop policy if exists service_evidence_insert on storage.objects;
    drop policy if exists service_evidence_update on storage.objects;
    drop policy if exists service_evidence_delete on storage.objects;

    create policy service_evidence_read on storage.objects for select to authenticated
        using (bucket_id = 'service-evidence' and public.can_access_service_evidence(name, 'read'));
    create policy service_evidence_insert on storage.objects for insert to authenticated
        with check (bucket_id = 'service-evidence' and public.can_access_service_evidence(name, 'insert'));
    create policy service_evidence_update on storage.objects for update to authenticated
        using (bucket_id = 'service-evidence' and public.can_access_service_evidence(name, 'update'))
        with check (bucket_id = 'service-evidence' and public.can_access_service_evidence(name, 'update'));
    create policy service_evidence_delete on storage.objects for delete to authenticated
        using (bucket_id = 'service-evidence' and public.can_access_service_evidence(name, 'delete'));
exception when insufficient_privilege then
    raise notice 'Sem permissão para criar as políticas do Storage por SQL. Crie-as em Storage > Policies (veja o README).';
end $$;

-- Atualiza o cache da API do Supabase para reconhecer colunas novas
notify pgrst, 'reload schema';
