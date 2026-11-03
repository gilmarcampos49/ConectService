// Login, cadastro, Google e visitante (Supabase Auth)

const auth = {
    mode: 'login', // 'login' | 'signup'
    user: null,
    profile: null,
    sessionUserId: null,
    sessionVersion: 0,

    init() {
        $('tab-login').addEventListener('click', () => this.setMode('login'));
        $('tab-signup').addEventListener('click', () => this.setMode('signup'));
        $('auth-form').addEventListener('submit', (e) => { e.preventDefault(); this.submit(); });
        $('btn-google').addEventListener('click', () => this.loginGoogle());
        $('btn-guest').addEventListener('click', () => this.loginGuest());
        $('btn-logout').addEventListener('click', () => this.logout());

        supabaseClient.auth.onAuthStateChange((_event, session) => {
            // Evita chamadas assíncronas dentro do callback
            setTimeout(() => this.handleSession(session), 0);
        });
        supabaseClient.auth.getSession()
            .then(({ data, error }) => {
                if (error) throw error;
                return this.handleSession(data.session);
            })
            .catch((error) => toast('Não foi possível verificar sua sessão: ' + error.message, true));
    },

    setMode(mode) {
        this.mode = mode;
        const signup = mode === 'signup';
        $('tab-login').classList.toggle('active', !signup);
        $('tab-signup').classList.toggle('active', signup);
        $('group-name').classList.toggle('hidden', !signup);
        $('auth-submit').textContent = signup ? 'Criar conta' : 'Entrar';
        $('auth-pass').autocomplete = signup ? 'new-password' : 'current-password';
        this.showMsg('');
    },

    showMsg(text, ok = false) {
        const el = $('auth-msg');
        el.textContent = text;
        el.classList.toggle('hidden', !text);
        el.classList.toggle('ok', ok);
    },

    async submit() {
        const email = $('auth-email').value.trim();
        const password = $('auth-pass').value;
        const name = $('auth-name').value.trim();

        if (!/^\S+@\S+\.\S+$/.test(email)) return this.showMsg('Informe um e-mail válido.');
        if (password.length < 6) return this.showMsg('A senha precisa ter pelo menos 6 caracteres.');
        if (this.mode === 'signup' && name.length < 2) return this.showMsg('Informe seu nome.');

        const btn = $('auth-submit');
        btn.disabled = true;
        this.showMsg('');

        try {
            if (this.mode === 'signup') {
                const { data, error } = await supabaseClient.auth.signUp({
                    email, password,
                    options: { data: { full_name: name }, emailRedirectTo: window.location.origin + window.location.pathname }
                });
                if (error) throw error;
                if (!data.session) {
                    this.showMsg('Conta criada! Confirme seu e-mail para entrar.', true);
                    this.setMode('login');
                    this.showMsg('Conta criada! Confirme seu e-mail e depois faça login.', true);
                }
            } else {
                const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err) {
            this.showMsg(this.translate(err.message));
        } finally {
            btn.disabled = false;
        }
    },

    translate(msg = '') {
        const m = msg.toLowerCase();
        if (m.includes('invalid login')) return 'E-mail ou senha incorretos.';
        if (m.includes('already registered')) return 'Este e-mail já está cadastrado. Faça login.';
        if (m.includes('email not confirmed')) return 'Confirme seu e-mail antes de entrar.';
        if (m.includes('rate limit')) return 'Muitas tentativas. Aguarde um pouco.';
        if (m.includes('password')) return 'Senha inválida (mínimo 6 caracteres).';
        return msg || 'Ocorreu um erro. Tente novamente.';
    },

    async loginGoogle() {
        const { error } = await supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.origin + window.location.pathname }
        });
        if (error) this.showMsg('Google indisponível: ative o provedor no painel do Supabase.');
    },

    async loginGuest() {
        const { error } = await supabaseClient.auth.signInAnonymously();
        if (error) this.showMsg("Ative 'Anonymous sign-ins' em Authentication > Providers no Supabase.");
    },

    async logout() {
        const { error } = await supabaseClient.auth.signOut();
        if (error) return toast('Não foi possível sair: ' + error.message, true);
        location.reload();
    },

    async handleSession(session) {
        const user = session?.user ?? null;
        const userId = user?.id ?? null;
        if (userId === this.sessionUserId) return;
        if (this.sessionUserId) app.onSessionEnd();
        this.profile = null;
        this.sessionUserId = userId;
        const version = ++this.sessionVersion;
        this.user = user;
        if (!this.user) {
            this.profile = null;
            app.onSessionEnd();
            $('auth-overlay').classList.remove('hidden');
            $('landing-page').classList.add('hidden');
            $('app-interface').classList.add('hidden');
            return;
        }
        try {
            await this.loadProfile();
        } catch (error) {
            if (version !== this.sessionVersion) return;
            this.sessionUserId = null;
            $('auth-overlay').classList.remove('hidden');
            toast('Não foi possível carregar seu perfil: ' + error.message, true);
            return;
        }
        if (version !== this.sessionVersion) return;
        $('auth-overlay').classList.add('hidden');
        if ($('app-interface').classList.contains('hidden')) $('landing-page').classList.remove('hidden');

        const isGuest = this.user.is_anonymous;
        const name = this.profile?.full_name || this.user.email || 'Visitante';
        $('user-badge').textContent = isGuest ? 'Visitante' : name;
        await app.onSessionReady();
    },

    async loadProfile() {
        if (!this.user) throw new Error('Nenhuma sessão autenticada.');
        const { data, error } = await supabaseClient.from('profiles')
            .select('*').eq('id', this.user.id).maybeSingle();
        if (error) throw error;
        if (!data) throw new Error('Perfil não encontrado. Verifique se o script do Supabase foi executado.');
        this.profile = data;
    }
};
