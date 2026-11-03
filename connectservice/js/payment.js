// Tela de pagamento PIX (QR Code + copia e cola). O servidor gera o PIX e confirma o pagamento;
// aqui só mostramos e acompanhamos o status.

const payment = {
    service: null,
    expiresAt: 0,
    pollTimer: null,
    tickTimer: null,
    loading: false,
    handledFor: null,   // evita tratar a confirmação duas vezes (consulta + tempo real)

    init() {
        $('pay-copy').addEventListener('click', () => this.copy());
        $('pay-code').addEventListener('focus', (e) => e.target.select());
        $('pay-check').addEventListener('click', () => this.check(true));
        $('pay-retry').addEventListener('click', () => this.load());
        $('pay-close').addEventListener('click', () => this.close());
        $('pay-cancel').addEventListener('click', () => {
            if (confirm('Cancelar este pedido?')) app.cancelService();
        });
    },

    async open(service) {
        if (!service) return;
        this.service = service;
        this.handledFor = null;
        $('pay-amount').textContent = '';
        $('pay-overlay').classList.remove('hidden');
        await this.load();
    },

    close() {
        this.stopTimers();
        $('pay-overlay').classList.add('hidden');
    },

    stopTimers() {
        clearInterval(this.pollTimer);
        clearInterval(this.tickTimer);
        this.pollTimer = null;
        this.tickTimer = null;
    },

    showError(message, canRetry = true) {
        $('pay-loading').classList.add('hidden');
        $('pay-body').classList.add('hidden');
        $('pay-error').textContent = message;
        $('pay-error').classList.remove('hidden');
        $('pay-retry').classList.toggle('hidden', !canRetry);
        $('pay-check').classList.add('hidden');
    },

    async load() {
        if (this.loading || !this.service) return;
        this.loading = true;
        this.stopTimers();
        $('pay-loading').classList.remove('hidden');
        $('pay-error').classList.add('hidden');
        $('pay-body').classList.add('hidden');
        $('pay-retry').classList.add('hidden');
        $('pay-check').classList.remove('hidden');

        const { data, error } = await callFn('create-pix', { service_id: this.service.id });
        this.loading = false;
        if (error) return this.showError(error);
        if (data.paid || data.payment_status === 'approved') return this.onPaid();
        this.render(data);
    },

    render(data) {
        $('pay-loading').classList.add('hidden');
        $('pay-amount').textContent = `R$ ${Number(data.amount).toFixed(2).replace('.', ',')}`;
        if (data.qr_code_base64) {
            $('pay-qr').src = `data:image/png;base64,${data.qr_code_base64}`;
            $('pay-qr').classList.remove('hidden');
        } else {
            $('pay-qr').classList.add('hidden');
        }
        $('pay-code').value = data.qr_code || '';
        $('pay-status').textContent = '⏳ Aguardando pagamento...';
        $('pay-body').classList.remove('hidden');
        this.expiresAt = data.expires_at ? new Date(data.expires_at).getTime() : Date.now() + 30 * 60000;
        this.tick();
        this.tickTimer = setInterval(() => this.tick(), 1000);
        this.pollTimer = setInterval(() => this.check(false), 5000);
    },

    tick() {
        const left = Math.max(0, Math.floor((this.expiresAt - Date.now()) / 1000));
        if (left === 0) {
            this.stopTimers();
            this.showError('Este PIX expirou. Gere um novo para pagar.');
            return;
        }
        const mm = String(Math.floor(left / 60)).padStart(2, '0');
        const ss = String(left % 60).padStart(2, '0');
        $('pay-timer').textContent = `Expira em ${mm}:${ss}`;
    },

    async check(manual) {
        if (!this.service) return;
        const { data, error } = await callFn('check-pix', { service_id: this.service.id });
        if (error) { if (manual) toast(error, true); return; }
        if (data.payment_status === 'approved' || ['pending', 'accepted'].includes(data.service_status)) {
            this.onPaid();
        } else if (manual) {
            toast('Pagamento ainda não identificado. Aguarde alguns segundos e tente de novo.');
        }
    },

    async copy() {
        const code = $('pay-code').value;
        if (!code) return;
        try {
            await navigator.clipboard.writeText(code);
        } catch {
            $('pay-code').select();
            document.execCommand('copy');
        }
        toast('Código PIX copiado. Cole no app do seu banco.');
    },

    // Pagamento confirmado (pela consulta ou pelo tempo real)
    onPaid() {
        const id = this.service?.id || app.currentService?.id;
        if (!id || this.handledFor === id) return;
        this.handledFor = id;
        this.close();
        app.onPaymentConfirmed();
    }
};
