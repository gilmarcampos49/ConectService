// Menu do rodapé: Perfil, Notificações, Pedidos, Mensagens e Baixar app.

const STATUS_LABEL = {
    awaiting_payment: 'Aguardando pagamento',
    pending: 'Aguardando',
    accepted: 'Em andamento',
    completed: 'Concluído',
    cancelled: 'Cancelado'
};

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function fmtDate(iso) {
    try {
        return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
}

function categoryIcon(value) {
    return (CATEGORIES.find((c) => c.value === value) || { icon: '🛠️' }).icon;
}

// O navegador dispara este evento quando o app pode ser instalado (Chrome/Edge/Android)
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    menu.deferredInstall = e;
});
window.addEventListener('appinstalled', () => {
    menu.deferredInstall = null;
    menu.refreshInstallButton();
    toast('App instalado! Procure o ícone na tela inicial.');
});

const menu = {
    tab: null,
    notifs: [],
    unreadNotifs: 0,
    unreadMsgs: 0,
    conv: null,              // conversa aberta no painel
    convMessageIds: new Set(),
    deferredInstall: null,

    init() {
        document.querySelectorAll('#bottom-nav [data-tab]').forEach((b) =>
            b.addEventListener('click', () => this.open(b.dataset.tab)));
        $('nav-install').addEventListener('click', () => this.install());
        $('sheet-close').addEventListener('click', () => this.close());
        $('sheet-overlay').addEventListener('click', (e) => { if (e.target.id === 'sheet-overlay') this.close(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
        this.refreshInstallButton();

        if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
            navigator.serviceWorker.register('sw.js').catch(() => {});
        }
    },

    // ---------- Visibilidade ----------
    show() {
        $('bottom-nav').classList.remove('hidden');
        document.body.classList.add('has-nav');
    },

    hide() {
        this.close();
        $('bottom-nav').classList.add('hidden');
        document.body.classList.remove('has-nav');
        this.unreadMsgs = 0;
        this.updateBadges();
    },

    updateBadges() {
        const set = (id, n) => {
            const b = $(id);
            b.textContent = n > 9 ? '9+' : String(n);
            b.classList.toggle('hidden', n === 0);
        };
        set('nav-badge-notif', this.unreadNotifs);
        set('nav-badge-msg', this.unreadMsgs);
    },

    setActive(tab) {
        document.querySelectorAll('#bottom-nav [data-tab]').forEach((b) =>
            b.classList.toggle('active', b.dataset.tab === tab));
    },

    // ---------- Painel (bottom sheet) ----------
    open(tab) {
        if (!auth.user) return;
        this.tab = tab;
        this.conv = null;
        this.setActive(tab === 'conversation' ? 'messages' : tab);
        const titles = {
            profile: 'Meu perfil', notifications: 'Notificações', orders: 'Meus pedidos',
            messages: 'Mensagens', install: 'Baixar o app'
        };
        $('sheet-title').textContent = titles[tab] || '';
        const body = $('sheet-body');
        body.innerHTML = '';
        $('sheet-overlay').classList.remove('hidden');

        if (tab === 'profile') this.renderProfile(body);
        else if (tab === 'notifications') this.renderNotifications(body);
        else if (tab === 'orders') this.renderOrders(body);
        else if (tab === 'messages') this.renderConversations(body);
        else if (tab === 'install') this.renderInstall(body);
    },

    close() {
        this.conv = null;
        this.tab = null;
        this.setActive(null);
        $('sheet-overlay').classList.add('hidden');
    },

    // ---------- Perfil ----------
    async renderProfile(body) {
        const profile = auth.profile || {};
        const isGuest = Boolean(auth.user.is_anonymous);
        const name = profile.full_name || (isGuest ? 'Visitante' : 'Sem nome');

        const head = el('div', 'profile-head');
        head.append(el('div', 'avatar', (name[0] || '?').toUpperCase()));
        const info = el('div');
        info.append(el('strong', null, name), el('small', null, isGuest ? 'Conta de visitante' : (auth.user.email || '')));
        head.append(info);
        body.append(head);

        const roleLine = el('p', 'muted left',
            profile.user_type === 'provider' ? '🛠️ Você também atua como prestador.' : '🙋 Você usa o app como cliente.');
        body.append(roleLine);
        body.append(this.buildLocationBox());

        // Nome
        const group = el('div', 'input-group');
        const label = el('label', null, 'Seu nome');
        label.htmlFor = 'profile-name';
        const input = el('input', 'auth-input');
        input.id = 'profile-name';
        input.value = profile.full_name || '';
        input.maxLength = 60;
        input.autocomplete = 'name';
        group.append(label, input);
        const save = el('button', 'btn btn-primary', 'Salvar nome');
        save.type = 'button';
        save.addEventListener('click', async () => {
            const value = input.value.trim();
            if (value.length < 2) return toast('Informe seu nome.', true);
            save.disabled = true;
            const { error } = await supabaseClient.from('profiles')
                .update({ full_name: value }).eq('id', auth.user.id);
            save.disabled = false;
            if (error) return toast('Não foi possível salvar: ' + error.message, true);
            auth.profile.full_name = value;
            if (!isGuest) $('user-badge').textContent = value;
            toast('Nome atualizado.');
        });
        body.append(group, save);

        // Serviços do prestador
        if (profile.user_type === 'provider' && (profile.services_offered || []).length) {
            const box = el('div', 'profile-box');
            box.append(el('strong', null, 'Serviços que você atende'));
            const tags = el('div', 'tags');
            CATEGORIES.filter((c) => profile.services_offered.includes(c.value))
                .forEach((c) => tags.append(el('span', 'tag', `${c.icon} ${c.label}`)));
            box.append(tags);
            const edit = el('button', 'btn-link', 'Editar serviços');
            edit.type = 'button';
            edit.addEventListener('click', () => { this.close(); app.openOffers(false); });
            box.append(edit);
            const rating = el('p', 'muted left', '');
            box.append(rating);
            body.append(box);

            const { data } = await supabaseClient.from('reviews').select('rating').eq('provider_id', auth.user.id);
            if (data?.length) {
                const avg = data.reduce((sum, r) => sum + r.rating, 0) / data.length;
                rating.textContent = `⭐ ${avg.toFixed(1)} • ${data.length} avaliação(ões)`;
            } else {
                rating.textContent = 'Você ainda não tem avaliações.';
            }
        }

        const out = el('button', 'btn btn-outline', 'Sair da conta');
        out.type = 'button';
        out.addEventListener('click', () => auth.logout());
        body.append(out);
    },

    // ---------- Localização atual (perfil) ----------
    buildLocationBox() {
        const box = el('div', 'profile-box');
        box.append(el('strong', null, '📍 Minha localização atual'));
        const addr = el('p', 'loc-addr', 'Obtendo localização...');
        const meta = el('p', 'loc-meta', '');
        const refresh = el('button', 'btn btn-outline', '🔄 Atualizar localização');
        refresh.type = 'button';
        refresh.addEventListener('click', () => this.loadLocation(addr, meta, refresh, true));
        box.append(addr, meta);
        if (auth.profile?.user_type === 'provider') {
            box.append(el('p', 'loc-meta', auth.profile.available_for_services
                ? '🟢 Sua posição está sendo compartilhada para receber chamados próximos.'
                : '⚪ Sua posição não está sendo compartilhada (você está indisponível).'));
        }
        box.append(refresh);
        this.loadLocation(addr, meta, refresh, false);
        return box;
    },

    getPosition(fresh) {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) return reject({ code: 0 });
            navigator.geolocation.getCurrentPosition(resolve, reject,
                { enableHighAccuracy: true, timeout: 12000, maximumAge: fresh ? 0 : 30000 });
        });
    },

    async reverseGeocode(lat, lng) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 6000);
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=pt-BR&lat=${lat}&lon=${lng}`,
                { signal: ctrl.signal });
            clearTimeout(timer);
            if (!res.ok) return null;
            const a = (await res.json()).address || {};
            const street = [a.road, a.house_number].filter(Boolean).join(', ');
            const area = a.suburb || a.neighbourhood || a.quarter;
            const city = a.city || a.town || a.village || a.municipality;
            const parts = [street, area, [city, a.state].filter(Boolean).join(' - ')].filter(Boolean);
            return parts.length ? parts.join(' • ') : null;
        } catch { return null; }
    },

    async loadLocation(addrEl, metaEl, button, fresh) {
        button.disabled = true;
        addrEl.textContent = 'Obtendo localização...';
        metaEl.textContent = '';
        try {
            const pos = await this.getPosition(fresh);
            const { latitude: lat, longitude: lng, accuracy } = pos.coords;
            const address = await this.reverseGeocode(lat, lng);
            if (!addrEl.isConnected) return;
            addrEl.textContent = address || 'Endereço não encontrado para este ponto.';
            const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            metaEl.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)} • precisão ~${Math.round(accuracy)} m • atualizado às ${hora}`;
        } catch (err) {
            if (!addrEl.isConnected) return;
            addrEl.textContent = err?.code === 1
                ? 'Permissão de localização negada. Libere o acesso à localização nas configurações do navegador e toque em Atualizar.'
                : 'Não foi possível obter sua localização agora. Confira o GPS e tente de novo.';
        } finally {
            button.disabled = false;
        }
    },

    // ---------- Notificações ----------
    pushNotif(message) {
        this.notifs.unshift({ message, at: new Date().toISOString() });
        this.notifs = this.notifs.slice(0, 50);
        if (this.tab === 'notifications') this.renderNotifications($('sheet-body'));
        else { this.unreadNotifs += 1; this.updateBadges(); }
    },

    clearNotifs() {
        this.notifs = [];
        this.unreadNotifs = 0;
        this.updateBadges();
        if (this.tab === 'notifications') this.renderNotifications($('sheet-body'));
    },

    renderNotifications(body) {
        body.innerHTML = '';
        this.unreadNotifs = 0;
        this.updateBadges();

        if ('Notification' in window && Notification.permission === 'default') {
            const ask = el('button', 'btn btn-outline', '🔔 Ativar avisos neste aparelho');
            ask.type = 'button';
            ask.addEventListener('click', async () => {
                await Notification.requestPermission();
                this.renderNotifications(body);
            });
            body.append(ask);
        } else if ('Notification' in window && Notification.permission === 'denied') {
            body.append(el('p', 'muted left', 'Os avisos do aparelho estão bloqueados. Libere nas configurações do navegador.'));
        }

        if (!this.notifs.length) {
            body.append(el('p', 'empty', 'Nenhuma notificação por enquanto.'));
            return;
        }
        const list = el('ul', 'list');
        this.notifs.forEach((n) => {
            const li = el('li', 'list-item');
            const main = el('div', 'grow');
            main.append(el('span', null, n.message), el('small', null, fmtDate(n.at)));
            li.append(el('span', 'li-ico', '🔔'), main);
            list.append(li);
        });
        body.append(list);
        const clear = el('button', 'btn-link', 'Limpar notificações');
        clear.type = 'button';
        clear.addEventListener('click', () => app.clearNotifications());
        body.append(clear);
    },

    // ---------- Pedidos ----------
    async fetchMyServices(limit = 30) {
        const uid = auth.user.id;
        return supabaseClient.from('services')
            .select('id,category,status,price,created_at,client_id,provider_id')
            .or(`client_id.eq.${uid},provider_id.eq.${uid}`)
            .order('created_at', { ascending: false }).limit(limit);
    },

    async renderOrders(body) {
        body.append(el('p', 'empty', 'Carregando...'));
        const { data, error } = await this.fetchMyServices();
        if (this.tab !== 'orders') return;
        body.innerHTML = '';
        if (error) { body.append(el('p', 'empty', 'Não foi possível carregar: ' + error.message)); return; }
        if (!data.length) { body.append(el('p', 'empty', 'Você ainda não tem pedidos.')); return; }

        const list = el('ul', 'list');
        data.forEach((s) => {
            const mine = s.client_id === auth.user.id;
            const li = el('li', 'list-item');
            const main = el('div', 'grow');
            const title = el('strong', null, s.category);
            const meta = el('small', null,
                `${mine ? 'Como cliente' : 'Como prestador'} • R$ ${Number(s.price || 0).toFixed(2)} • ${fmtDate(s.created_at)}`);
            main.append(title, meta);
            li.append(el('span', 'li-ico', categoryIcon(s.category)), main,
                el('span', `status st-${s.status}`, STATUS_LABEL[s.status] || s.status));
            if (s.provider_id) {
                const chat = el('button', 'icon-btn', '💬');
                chat.type = 'button';
                chat.setAttribute('aria-label', 'Abrir conversa');
                chat.addEventListener('click', () => this.openConversation(s));
                li.append(chat);
            }
            list.append(li);
        });
        body.append(list);
    },

    // ---------- Mensagens ----------
    async renderConversations(body) {
        body.append(el('p', 'empty', 'Carregando...'));
        const { data: services, error } = await this.fetchMyServices();
        if (this.tab !== 'messages') return;
        if (error) { body.innerHTML = ''; body.append(el('p', 'empty', 'Não foi possível carregar: ' + error.message)); return; }

        const ids = (services || []).map((s) => s.id);
        let msgs = [];
        if (ids.length) {
            const res = await supabaseClient.from('messages').select('id,service_id,sender_id,content,created_at')
                .in('service_id', ids).order('created_at', { ascending: false }).limit(300);
            msgs = res.data || [];
        }
        if (this.tab !== 'messages') return;
        body.innerHTML = '';
        this.unreadMsgs = 0;
        this.updateBadges();

        const lastBy = new Map();
        msgs.forEach((m) => { if (!lastBy.has(m.service_id)) lastBy.set(m.service_id, m); });
        const convs = (services || []).filter((s) => lastBy.has(s.id));
        if (!convs.length) {
            body.append(el('p', 'empty', 'Nenhuma conversa ainda. O chat abre quando um profissional aceita seu pedido.'));
            return;
        }
        const list = el('ul', 'list');
        convs.forEach((s) => {
            const last = lastBy.get(s.id);
            const li = el('li', 'list-item clickable');
            const main = el('div', 'grow');
            const prefix = last.sender_id === auth.user.id ? 'Você: ' : '';
            main.append(el('strong', null, s.category), el('small', 'ellipsis', prefix + last.content));
            li.append(el('span', 'li-ico', categoryIcon(s.category)), main, el('small', null, fmtDate(last.created_at)));
            li.tabIndex = 0;
            li.addEventListener('click', () => this.openConversation(s));
            li.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.openConversation(s); });
            list.append(li);
        });
        body.append(list);
    },

    async openConversation(service) {
        this.tab = 'conversation';
        this.conv = service;
        this.convMessageIds = new Set();
        this.setActive('messages');
        $('sheet-title').textContent = `Chat • ${service.category}`;
        $('sheet-overlay').classList.remove('hidden');
        const body = $('sheet-body');
        body.innerHTML = '';

        const back = el('button', 'btn-link left', '← Voltar');
        back.type = 'button';
        back.addEventListener('click', () => this.open('messages'));
        const box = el('div', 'conv-box');
        const msgs = el('div', 'chat-messages');
        msgs.id = 'conv-msgs';
        box.append(msgs);
        body.append(back, box);

        const active = service.status === 'accepted';
        if (active) {
            const form = el('form', 'chat-input');
            const input = el('input');
            input.maxLength = 500;
            input.placeholder = 'Digite sua mensagem...';
            input.autocomplete = 'off';
            const send = el('button', null, '➔');
            send.type = 'submit';
            send.setAttribute('aria-label', 'Enviar');
            form.append(input, send);
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const content = input.value.trim();
                if (!content) return;
                input.value = '';
                const { data, error } = await supabaseClient.from('messages')
                    .insert([{ service_id: service.id, sender_id: auth.user.id, content: content.slice(0, 500) }])
                    .select().single();
                if (error) return toast('Não foi possível enviar: ' + error.message, true);
                this.appendConvMessage(data);
            });
            box.append(form);
        } else {
            body.append(el('p', 'muted', 'Este pedido foi encerrado. A conversa está somente para leitura.'));
        }

        const { data, error } = await supabaseClient.from('messages').select('*')
            .eq('service_id', service.id).order('created_at', { ascending: true });
        if (error) return toast('Não foi possível carregar as mensagens.', true);
        if (this.conv?.id !== service.id) return;
        msgs.innerHTML = '';
        if (!data.length) msgs.append(el('p', 'empty', 'Sem mensagens ainda.'));
        (data || []).forEach((m) => this.appendConvMessage(m));
    },

    appendConvMessage(m) {
        if (!m?.id || this.convMessageIds.has(m.id)) return;
        const box = $('conv-msgs');
        if (!box) return;
        this.convMessageIds.add(m.id);
        box.querySelector('.empty')?.remove();
        const div = el('div', 'msg ' + (m.sender_id === auth.user.id ? 'sent' : 'received'), m.content);
        box.append(div);
        box.scrollTop = box.scrollHeight;
    },

    // Chamado pelo app.js a cada mensagem nova que chega em tempo real
    onMessage(m) {
        if (this.conv && m.service_id === this.conv.id) {
            this.appendConvMessage(m);
            return;
        }
        if (m.sender_id === auth.user?.id) return;
        const chatOpenForIt = app.currentService?.id === m.service_id
            && !$('chat-container').classList.contains('hidden');
        if (chatOpenForIt) return;
        this.unreadMsgs += 1;
        this.updateBadges();
    },

    // ---------- Baixar app ----------
    isStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    },

    refreshInstallButton() {
        $('nav-install').classList.toggle('hidden', this.isStandalone());
    },

    async install() {
        if (this.isStandalone()) return toast('O app já está instalado neste aparelho.');
        if (this.deferredInstall) {
            const promptEvent = this.deferredInstall;
            this.deferredInstall = null;
            promptEvent.prompt();
            await promptEvent.userChoice.catch(() => {});
            return;
        }
        this.open('install');
    },

    renderInstall(body) {
        const ua = navigator.userAgent;
        const isIos = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const isAndroid = /android/i.test(ua);

        body.append(el('p', 'muted left', 'Instale o ConnectService Pro na tela inicial e abra como um aplicativo, sem barra do navegador.'));

        if (!window.isSecureContext) {
            body.append(el('p', 'auth-msg', 'Para instalar, o site precisa estar em HTTPS (ou em localhost).'));
        }

        let steps;
        if (isIos) {
            steps = ['Abra este site no Safari.', 'Toque no botão Compartilhar (quadrado com seta para cima).',
                'Escolha “Adicionar à Tela de Início”.', 'Confirme em “Adicionar”.'];
        } else if (isAndroid) {
            steps = ['Abra este site no Chrome.', 'Toque no menu ⋮ no canto superior.',
                'Escolha “Instalar app” ou “Adicionar à tela inicial”.', 'Confirme em “Instalar”.'];
        } else {
            steps = ['Use o Chrome ou o Edge.', 'Clique no ícone de instalação na barra de endereço (ou no menu ⋮).',
                'Escolha “Instalar ConnectService Pro”.'];
        }
        const ol = el('ol', 'install-steps');
        steps.forEach((s) => ol.append(el('li', null, s)));
        body.append(ol);
        body.append(el('p', 'muted left', 'Se a opção não aparecer, recarregue a página e tente de novo.'));
    }
};
