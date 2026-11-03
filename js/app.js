// Lógica principal: cliente e prestador usam a mesma conta e podem alternar de papel.

const app = {
    role: null,                // 'client' | 'provider'
    currentService: null,      // serviço ativo (objeto)
    userRating: 0,
    channel: null,
    moveTimer: null,
    locationTimer: null,
    dispatchTimer: null,
    nearestProviderLookupFailed: false,
    notifiedServiceIds: new Set(),
    movingServiceId: null,     // serviço em que o prestador já saiu ao encontro do cliente
    panelExpanded: false,
    providerPosFetched: false,
    pending: new Map(),        // id -> serviço pendente (visão do prestador)
    renderedMessages: new Set(),
    tripDistanceKm: 0,
    lastPricedDistanceKm: -1,

    init() {
        $('role-client').addEventListener('click', () => this.startApp('client'));
        $('role-provider').addEventListener('click', () => this.startApp('provider'));
        $('btn-home').addEventListener('click', () => this.goHome());
        $('btn-request').addEventListener('click', () => this.requestService());
        $('btn-cancel').addEventListener('click', () => this.cancelService());
        $('btn-pay').addEventListener('click', () => payment.open(this.currentService));
        $('btn-move').addEventListener('click', () => this.startMoving());
        $('btn-arrived').addEventListener('click', () => this.markArrived());
        $('btn-tow-repair').addEventListener('click', () => this.chooseTowSolution('repair'));
        $('btn-tow-transport').addEventListener('click', () => this.showTransportDestination());
        $('btn-tow-confirm').addEventListener('click', () => this.chooseTowSolution('transport'));
        $('btn-tow-service').addEventListener('click', () => this.startTowTransport());
        $('btn-finish').addEventListener('click', () => this.finishService());
        $('chat-toggle').addEventListener('click', () => this.toggleChat());
        $('chat-close').addEventListener('click', () => this.toggleChat());
        $('chat-form').addEventListener('submit', (e) => { e.preventDefault(); this.sendMessage(); });
        $('btn-submit-review').addEventListener('click', () => this.submitReview());
        $('btn-skip-review').addEventListener('click', () => this.goHome());
        document.querySelectorAll('#star-rating button').forEach((b) =>
            b.addEventListener('click', () => this.setRating(Number(b.dataset.star))));
        $('btn-edit-offers').addEventListener('click', () => this.openOffers(false));
        $('btn-panel-toggle').addEventListener('click', () => this.togglePanel());
        $('notification-button').addEventListener('click', () => this.toggleNotifications());
        $('notification-clear').addEventListener('click', () => this.clearNotifications());
        $('service-start-file').addEventListener('change', () => this.updatePhotoUploadButton('start'));
        $('service-end-file').addEventListener('change', () => this.updatePhotoUploadButton('end'));
        $('service-start-upload').addEventListener('click', () => this.uploadServicePhoto('start'));
        $('service-end-upload').addEventListener('click', () => this.uploadServicePhoto('end'));
        $('provider-vehicle-plate').addEventListener('input', (event) => {
            event.currentTarget.value = event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
        });
    },

    toggleNotifications() {
        const panel = $('notification-panel');
        panel.classList.toggle('hidden');
        $('notification-button').setAttribute('aria-expanded', String(!panel.classList.contains('hidden')));
        if (!panel.classList.contains('hidden')) this.updateNotificationBadge(false);
    },

    clearNotifications() {
        $('notification-list').innerHTML = '<p class="notification-empty">Nenhuma notificação</p>';
        $('notification-count').textContent = '0';
        $('notification-count').classList.add('hidden');
        menu.clearNotifs();
    },

    addNotification(message) {
        const list = $('notification-list');
        const empty = list.querySelector('.notification-empty');
        if (empty) empty.remove();
        const item = document.createElement('p');
        item.className = 'notification-item';
        item.textContent = message;
        list.prepend(item);
        menu.pushNotif(message);
        this.updateNotificationBadge(true);
    },

    updateNotificationBadge(unread) {
        const badge = $('notification-count');
        const items = $('notification-list').querySelectorAll('.notification-item');
        let count = Number(badge.textContent) || 0;
        if (unread) count += 1;
        else count = $('notification-panel').classList.contains('hidden') ? count : 0;
        badge.textContent = count;
        badge.classList.toggle('hidden', count === 0 || items.length === 0);
    },

    async onSessionReady() {
        menu.show();
        this.role = auth.profile?.user_type === 'provider' ? 'provider' : null;
        this.startRealtime();
        if (this.role === 'provider' && this.offered.length) {
            if (!await this.refreshProviderAvailability(true)) return;
            mapManager.init();
            if (mapManager.watchId === null) {
                await mapManager.setupGeo((pos) => this.updateOwnLocation(pos));
            }
            this.startLocationHeartbeat();
        }
    },

    async refreshProviderAvailability(clearLastLocation = false) {
        if (!auth.user || this.role !== 'provider') return false;
        const { data: activeService, error } = await supabaseClient.from('services')
            .select('id')
            .eq('provider_id', auth.user.id)
            .eq('status', 'accepted')
            .limit(1)
            .maybeSingle();
        if (error) {
            toast('Não foi possível verificar seus chamados ativos: ' + error.message, true);
            return false;
        }
        const available = !activeService && this.offered.length > 0;
        const update = {
            available_for_services: available,
            last_location_updated_at: available && mapManager.hasRealPosition
                ? new Date().toISOString()
                : null
        };
        if (!clearLastLocation && available && !mapManager.hasRealPosition) {
            delete update.last_location_updated_at;
        }
        const { error: availabilityError } = await supabaseClient.from('profiles')
            .update(update).eq('id', auth.user.id);
        if (availabilityError) {
            toast('Não foi possível atualizar sua disponibilidade: ' + availabilityError.message, true);
            return false;
        }
        auth.profile.available_for_services = available;
        if (available) await this.loadPending();
        return true;
    },

    onSessionEnd() {
        menu.hide();
        clearTimeout(this.dispatchTimer);
        clearInterval(this.locationTimer);
        this.dispatchTimer = null;
        this.locationTimer = null;
        mapManager.stopGeo();
        if (this.channel) {
            supabaseClient.removeChannel(this.channel);
            this.channel = null;
        }
        this.role = null;
        this.currentService = null;
        this.pending.clear();
        this.notifiedServiceIds.clear();
        this.clearNotifications();
        mapManager.hasRealPosition = false;
        mapManager.myPos = null;
        mapManager.clearPartner();
        this.movingServiceId = null;
        this.panelExpanded = false;
        this.updateRouteMode();
        $('tow-evidence').classList.add('hidden');
        ['start', 'end'].forEach((kind) => {
            const image = $(`service-${kind}-photo`);
            image.removeAttribute('src');
            image.dataset.path = '';
            image.classList.add('hidden');
            $(`service-${kind}-file`).value = '';
            $(`service-${kind}-upload`).classList.add('hidden');
        });
        if (mapManager.userMarker) {
            mapManager.userMarker.remove();
            mapManager.userMarker = null;
        }
    },

    startLocationHeartbeat() {
        clearInterval(this.locationTimer);
        this.locationTimer = setInterval(() => {
            if (this.role === 'provider' && mapManager.watchId !== null) {
                mapManager.refreshPosition((pos) => this.updateOwnLocation(pos));
            }
        }, 30000);
    },

    // ---------- Serviços que o prestador oferece ----------
    get offered() {
        return auth.profile?.services_offered || [];
    },

    updateOfferSummary() {
        const names = CATEGORIES.filter((c) => this.offered.includes(c.value)).map((c) => `${c.icon} ${c.label}`);
        $('offer-summary').textContent = names.length ? 'Você atende: ' + names.join(' • ') : 'Nenhum serviço selecionado';
    },

    toggleTowVehicleFields() {
        const selectedTow = [...$('offers-list').querySelectorAll('input:checked')]
            .some((input) => input.value === 'Guincho');
        $('tow-vehicle-fields').classList.toggle('hidden', !selectedTow);
    },

    // required = true: não deixa continuar sem escolher (primeira vez)
    openOffers(required) {
        return new Promise((resolve) => {
            const list = $('offers-list');
            list.innerHTML = '';
            CATEGORIES.forEach((c) => {
                const label = document.createElement('label');
                label.className = 'offer-item';
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.value = c.value;
                input.checked = this.offered.includes(c.value);
                input.addEventListener('change', () => this.toggleTowVehicleFields());
                const ico = document.createElement('span');
                ico.className = 'ico';
                ico.textContent = c.icon;
                const txt = document.createElement('span');
                txt.textContent = c.label;
                const check = document.createElement('span');
                check.className = 'check';
                check.textContent = '✓';
                label.append(input, ico, txt, check);
                list.appendChild(label);
            });
            $('provider-vehicle-plate').value = auth.profile?.vehicle_plate || '';
            $('provider-vehicle-type').value = auth.profile?.vehicle_type || '';
            this.toggleTowVehicleFields();
            $('offers-msg').classList.add('hidden');
            $('btn-cancel-offers').classList.toggle('hidden', required);
            $('offers-overlay').classList.remove('hidden');

            const close = (saved) => {
                $('offers-overlay').classList.add('hidden');
                $('btn-save-offers').onclick = null;
                $('btn-cancel-offers').onclick = null;
                resolve(saved);
            };

            $('btn-cancel-offers').onclick = () => close(false);
            $('btn-save-offers').onclick = async () => {
                const chosen = [...list.querySelectorAll('input:checked')].map((i) => i.value);
                if (chosen.length === 0) {
                    $('offers-msg').textContent = 'Escolha pelo menos um serviço.';
                    $('offers-msg').classList.remove('hidden');
                    return;
                }
                const offersTow = chosen.includes('Guincho');
                const vehiclePlate = $('provider-vehicle-plate').value.trim().toUpperCase();
                const vehicleType = $('provider-vehicle-type').value.trim();
                if (offersTow && !/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(vehiclePlate)) {
                    $('offers-msg').textContent = 'Informe uma placa válida (ex.: ABC1D23).';
                    $('offers-msg').classList.remove('hidden');
                    return;
                }
                if (offersTow && vehicleType.length < 2) {
                    $('offers-msg').textContent = 'Informe o tipo do veículo de guincho.';
                    $('offers-msg').classList.remove('hidden');
                    return;
                }
                $('btn-save-offers').disabled = true;
                try {
                    const { error } = await supabaseClient.from('profiles')
                        .update({
                            services_offered: chosen,
                            user_type: 'provider',
                            available_for_services: !this.currentService,
                            vehicle_plate: offersTow ? vehiclePlate : null,
                            vehicle_type: offersTow ? vehicleType : null
                        }).eq('id', auth.user.id);
                    if (error) throw error;
                    await auth.loadProfile();
                    this.updateOfferSummary();
                    if (this.role === 'provider' && !required) {
                        await this.refreshProviderAvailability();
                    }
                    close(true);
                } catch (error) {
                    $('offers-msg').textContent = 'Não foi possível salvar: ' + error.message;
                    $('offers-msg').classList.remove('hidden');
                } finally {
                    $('btn-save-offers').disabled = false;
                }
            };
        });
    },

    // ---------- Navegação ----------
    async startApp(role) {
        if (auth.user?.is_anonymous && role === 'provider') {
            toast('Crie uma conta para prestar serviços.', true);
            return;
        }
        const missingTowVehicle = this.offered.includes('Guincho')
            && (!auth.profile?.vehicle_plate || !auth.profile?.vehicle_type);
        if (role === 'provider' && (this.offered.length === 0 || missingTowVehicle)) {
            const saved = await this.openOffers(true);
            if (!saved) return;
        }
        this.role = role;
        if (role === 'client') {
            clearInterval(this.locationTimer);
            this.locationTimer = null;
            mapManager.stopGeo();
        }
        if (role === 'provider') this.updateOfferSummary();
        $('landing-page').classList.add('hidden');
        $('app-interface').classList.remove('hidden');
        $('client-view').classList.toggle('hidden', role !== 'client');
        $('driver-view').classList.toggle('hidden', role !== 'provider');

        const first = (auth.profile?.full_name || 'por aqui').split(' ')[0];
        $('client-hello').textContent = `Olá, ${first}!`;
        $('driver-hello').textContent = `Olá, ${first}!`;

        mapManager.init();
        if (mapManager.watchId === null) {
            await mapManager.setupGeo((pos) => this.updateOwnLocation(pos));
        }

        const { error: profileError } = await supabaseClient.from('profiles')
            .update({
                user_type: role === 'provider' ? 'provider' : 'client',
                available_for_services: false
            }).eq('id', auth.user.id);
        if (profileError) return toast('Não foi possível atualizar seu perfil: ' + profileError.message, true);
        auth.profile.user_type = role === 'provider' ? 'provider' : 'client';
        auth.profile.available_for_services = false;
        if (role === 'provider') this.startLocationHeartbeat();

        await this.restoreActiveService();
        if (role === 'provider') {
            await this.refreshProviderAvailability();
        }
        this.startRealtime();
    },

    async goHome() {
        clearInterval(this.moveTimer);
        this.moveTimer = null;
        if (this.role !== 'provider') {
            mapManager.stopGeo();
            clearInterval(this.locationTimer);
            this.locationTimer = null;
            if (this.channel) { supabaseClient.removeChannel(this.channel); this.channel = null; }
        }
        this.currentService = null;
        this.pending.clear();
        mapManager.clearPartner();
        this.movingServiceId = null;
        this.panelExpanded = false;
        this.updateRouteMode();
        $('chat-container').classList.add('hidden');
        $('chat-toggle').classList.add('hidden');
        $('review-overlay').classList.add('hidden');
        $('app-interface').classList.add('hidden');
        $('landing-page').classList.remove('hidden');
        this.resetClientUI();
        this.resetProviderUI();
        if (this.role === 'provider') await this.refreshProviderAvailability();
    },

    resetClientUI() {
        $('client-form').classList.remove('hidden');
        $('btn-cancel').classList.add('hidden');
        $('btn-pay').classList.add('hidden');
        $('client-status').textContent = '📍 Pronto para solicitar';
    },

    resetProviderUI() {
        $('btn-move').classList.add('hidden');
        $('btn-finish').classList.add('hidden');
        $('driver-status').textContent = '💤 Aguardando chamados';
        this.renderPending();
    },

    syncTowStage(s) {
        if (s.category !== 'Guincho') return;
        const stage = s.tow_stage || 'waiting_arrival';
        if (this.role === 'client') {
            $('tow-choice').classList.toggle('hidden', stage !== 'arrived');
            if (stage === 'repair_selected') toast('Conserto no local selecionado.');
            if (stage === 'transport_selected') toast('Transporte confirmado. Aguarde o prestador.');
        } else {
            $('btn-arrived').classList.toggle('hidden', stage !== 'waiting_arrival');
            $('btn-tow-service').classList.toggle('hidden',
                stage !== 'transport_selected' || !this.currentService?.start_photo_path);
            $('btn-finish').classList.toggle('hidden', stage !== 'repair_selected' && stage !== 'transporting');
        }
    },

    estimateTripPrice(distanceKm) {
        const basePrice = 20;
        const pricePerKm = 2.50;
        return Math.round((basePrice + Math.max(0, distanceKm) * pricePerKm) * 100) / 100;
    },

    async updateTripPrice(distanceKm) {
        if (!this.currentService) return;
        this.tripDistanceKm = Math.max(0, distanceKm);
        // O valor é fixo: é o que o cliente já pagou por PIX (o servidor não aceita mudar o preço depois).
        const price = Number(this.currentService.price) || 0;
        $('driver-status').textContent = `🛠️ Atendendo: ${this.currentService.category} • ${this.tripDistanceKm.toFixed(1)} km • R$ ${price.toFixed(2)} (pago)`;
    },

    // ---------- Retomar serviço em andamento ----------
    async restoreActiveService() {
        const col = this.role === 'client' ? 'client_id' : 'provider_id';
        const { data, error } = await supabaseClient.from('services').select('*')
            .eq(col, auth.user.id).in('status', ['awaiting_payment', 'pending', 'accepted'])
            .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (error) {
            toast('Não foi possível recuperar seu chamado ativo: ' + error.message, true);
            return;
        }
        if (data) {
            this.applyService(data);
            if (this.role === 'provider' && data.status === 'accepted') this.startMoving();
        }
    },

    applyService(s) {
        this.currentService = s;
        if (s.status !== 'pending') {
            clearTimeout(this.dispatchTimer);
            this.dispatchTimer = null;
        }
        if (this.role === 'client' && s.status === 'pending' && s.target_provider_id) {
            this.scheduleDispatchFallback(s);
        }
        this.renderedMessages.clear();
        $('chat-msgs').innerHTML = '';
        this.syncTowStage(s);
        this.renderServicePhotos(s);
        if (this.role === 'client') {
            $('client-form').classList.add('hidden');
            $('btn-cancel').classList.remove('hidden');
            $('btn-pay').classList.toggle('hidden', s.status !== 'awaiting_payment');
            if (s.status === 'awaiting_payment') {
                $('client-status').textContent = `💳 Aguardando pagamento PIX (R$ ${Number(s.price).toFixed(2)})`;
            } else if (s.status === 'pending') {
                $('client-status').textContent = `⏳ Aguardando ${s.category}... (R$ ${Number(s.price).toFixed(2)})`;
            } else {
                $('client-status').textContent = '✅ Profissional a caminho!';
                $('chat-toggle').classList.remove('hidden');
            }
        } else {
            const pos = parsePoint(s.client_location);
            $('driver-status').textContent = `🛠️ Atendendo: ${s.category}`;
            $('btn-move').classList.remove('hidden');
            $('btn-finish').classList.toggle('hidden', s.category === 'Guincho'
                && !['repair_selected', 'transporting'].includes(s.tow_stage || 'waiting_arrival'));
            $('chat-toggle').classList.remove('hidden');
            if (pos) {
                mapManager.updatePartner(pos, 'green', `Cliente: ${s.category}`);
                if (!this.isEnRoute()) mapManager.fitBoth();
                if (mapManager.myPos) {
                    this.updateTripPrice(calculateDistance(mapManager.myPos[0], mapManager.myPos[1], pos[0], pos[1]));
                }
            }
        }
        this.updateRouteMode();
    },

    async renderServicePhotos(service) {
        const section = $('tow-evidence');
        const showEvidence = service?.category === 'Guincho'
            && ['accepted', 'completed'].includes(service.status);
        section.classList.toggle('hidden', !showEvidence);
        if (!showEvidence) return true;

        const isProvider = this.role === 'provider' && service.provider_id === auth.user.id;
        const canStart = ['arrived', 'repair_selected', 'transport_selected', 'transporting']
            .includes(service.tow_stage || '');
        $('service-start-controls').classList.toggle('hidden',
            !isProvider || !canStart || Boolean(service.start_photo_path));
        $('service-end-controls').classList.toggle('hidden',
            !isProvider || !service.service_started_at || Boolean(service.end_photo_path));
        if (this.role === 'provider' && service.provider_id === auth.user.id
            && service.category === 'Guincho') {
            $('btn-tow-service').classList.toggle('hidden',
                service.tow_stage !== 'transport_selected' || !service.start_photo_path);
            $('btn-finish').classList.toggle('hidden',
                !['repair_selected', 'transporting'].includes(service.tow_stage || ''));
        }
        this.updatePhotoUploadButton('start');
        this.updatePhotoUploadButton('end');
        const photoResults = await Promise.all([
            this.showServicePhoto('start', service.start_photo_path, service.id),
            this.showServicePhoto('end', service.end_photo_path, service.id)
        ]);
        return photoResults.every(Boolean);
    },

    async showServicePhoto(kind, path, serviceId) {
        const image = $(`service-${kind}-photo`);
        if (!path) {
            image.removeAttribute('src');
            image.dataset.path = '';
            image.classList.add('hidden');
            return true;
        }
        if (image.dataset.path === path && image.getAttribute('src')) {
            image.classList.remove('hidden');
            return true;
        }
        const { data, error } = await supabaseClient.storage
            .from('service-evidence').createSignedUrl(path, 3600);
        if (error) {
            toast(`Não foi possível exibir a foto (${error.message}). Confira se a política SELECT do bucket service-evidence permite acesso aos participantes do chamado.`, true);
            return false;
        }
        if (this.currentService?.id !== serviceId) return false;
        image.src = data.signedUrl;
        image.dataset.path = path;
        image.classList.remove('hidden');
        return true;
    },

    updatePhotoUploadButton(kind) {
        const input = $(`service-${kind}-file`);
        const button = $(`service-${kind}-upload`);
        const path = kind === 'start' ? 'start_photo_path' : 'end_photo_path';
        const service = this.currentService;
        const hasFile = Boolean(input.files?.[0]);
        button.classList.toggle('hidden', !hasFile || !service || Boolean(service[path]));
        button.disabled = !hasFile;
    },

    async uploadServicePhoto(kind) {
        const service = this.currentService;
        const input = $(`service-${kind}-file`);
        const button = $(`service-${kind}-upload`);
        const file = input.files?.[0];
        if (!service || service.category !== 'Guincho' || service.status !== 'accepted'
            || this.role !== 'provider' || service.provider_id !== auth.user.id) {
            return toast('Somente o prestador do guincho pode registrar as fotos do serviço ativo.', true);
        }
        if (!file) return toast('Tire ou selecione uma foto antes de continuar.', true);
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
            return toast('A foto deve ser JPG, PNG ou WebP e ter até 8 MB.', true);
        }
        if (kind === 'start' && !['arrived', 'repair_selected', 'transport_selected', 'transporting']
            .includes(service.tow_stage || '')) {
            return toast('Confirme sua chegada ao cliente antes de registrar o início do serviço.', true);
        }
        if (kind === 'end' && (!service.service_started_at || !service.start_photo_path)) {
            return toast('Registre a foto inicial antes da foto final.', true);
        }

        button.disabled = true;
        const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
        const uid = (crypto.randomUUID ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
        const path = `${service.id}/${kind}-${uid}.${extension}`;
        let operation = 'enviar a imagem ao Storage';
        try {
            const { error: uploadError } = await supabaseClient.storage
                .from('service-evidence')
                .upload(path, file, { contentType: file.type, upsert: false });
            if (uploadError) throw uploadError;

            operation = 'salvar os dados da foto no chamado';
            const changes = kind === 'start'
                ? { start_photo_path: path, service_started_at: new Date().toISOString() }
                : { end_photo_path: path };
            const { data, error } = await supabaseClient.from('services')
                .update(changes)
                .eq('id', service.id)
                .eq('provider_id', auth.user.id)
                .eq('status', 'accepted')
                .select('*')
                .maybeSingle();
            if (error) {
                await supabaseClient.storage.from('service-evidence').remove([path]);
                throw error;
            }
            if (!data) {
                await supabaseClient.storage.from('service-evidence').remove([path]);
                throw new Error('O chamado não está mais ativo ou não pertence a você.');
            }
            this.currentService = data;
            input.value = '';
            if (!await this.renderServicePhotos(data)) return;
            toast(kind === 'start' ? 'Foto inicial registrada.' : 'Foto final registrada.');
        } catch (error) {
            toast(`Não foi possível ${operation}: ${error.message}`, true);
        } finally {
            button.disabled = false;
            this.updatePhotoUploadButton(kind);
        }
    },

    // ---------- Cliente ----------
    async requestService() {
        if (!auth.user) return toast('Faça login novamente.', true);
        if (auth.user.is_anonymous) {
            return toast('Crie uma conta com e-mail para pedir um serviço com pagamento PIX.', true);
        }
        const category = $('service-category').value;
        const price = 20; // valor provisório: o valor real é definido no servidor ao gerar o PIX

        $('btn-request').disabled = true;
        try {
            this.nearestProviderLookupFailed = false;
            const nearestProviderId = await this.findNearestProvider(category);
            const { data, error } = await supabaseClient.from('services').insert([{
                client_id: auth.user.id,
                status: 'awaiting_payment',
                target_provider_id: nearestProviderId,
                category,
                price,
                client_location: toPoint(mapManager.myPos[0], mapManager.myPos[1])
            }]).select().single();

            if (error) return toast('Erro ao solicitar: ' + error.message, true);
            this.applyService(data);
            // O pedido só chega aos prestadores depois do pagamento PIX confirmado
            payment.open(data);
        } catch (error) {
            toast('Erro ao solicitar: ' + error.message, true);
        } finally {
            $('btn-request').disabled = false;
        }
    },

    async findNearestProvider(category) {
        if (!mapManager.hasRealPosition || !mapManager.myPos) return null;
        const { data, error } = await supabaseClient.rpc('nearest_available_provider', {
            requested_category: category,
            client_lat: mapManager.myPos[0],
            client_lng: mapManager.myPos[1]
        });
        if (error) {
            this.nearestProviderLookupFailed = true;
            console.error('Não foi possível localizar o prestador mais próximo:', error);
            return null;
        }
        return data || null;
    },

    scheduleDispatchFallback(service) {
        clearTimeout(this.dispatchTimer);
        this.dispatchTimer = setTimeout(async () => {
            if (this.currentService?.id !== service.id || this.currentService.status !== 'pending') return;
            const { data, error } = await supabaseClient.from('services')
                .update({ target_provider_id: null })
                .eq('id', service.id)
                .eq('status', 'pending')
                .eq('target_provider_id', service.target_provider_id)
                .select('id')
                .maybeSingle();
            if (error) return toast('Não foi possível encaminhar o chamado aos demais prestadores: ' + error.message, true);
            if (data) toast('Sem resposta do prestador mais próximo. Chamado encaminhado aos demais profissionais.');
        }, 30000);
    },

    // Chamado depois que o PIX foi confirmado: libera o pedido para os prestadores.
    async onPaymentConfirmed() {
        const current = this.currentService;
        if (!current) return;
        const { data } = await supabaseClient.from('services').select('*').eq('id', current.id).maybeSingle();
        if (data) this.applyService(data);
        if (data?.status === 'pending') {
            toast(data.target_provider_id
                ? '✅ Pagamento confirmado! Chamando o prestador mais próximo. Se não responder, avisaremos os demais.'
                : '✅ Pagamento confirmado! Chamado enviado aos prestadores da categoria.');
        } else {
            toast('✅ Pagamento confirmado!');
        }
    },

    async cancelService() {
        if (!this.currentService) return;
        $('btn-cancel').disabled = true;
        const { data: result, error } = await callFn('cancel-service', { service_id: this.currentService.id });
        $('btn-cancel').disabled = false;
        if (error) return toast(error, true);
        payment.close();
        this.currentService = null;
        mapManager.clearPartner();
        this.updateRouteMode();
        $('chat-toggle').classList.add('hidden');
        $('chat-container').classList.add('hidden');
        this.resetClientUI();
        if (result?.refund_failed) {
            toast('Pedido cancelado, mas não foi possível devolver o PIX agora. Fale com o suporte.', true);
        } else {
            toast(result?.refunded ? 'Pedido cancelado. O valor do PIX será devolvido a você.' : 'Pedido cancelado.');
        }
    },

    // ---------- Prestador ----------
    async loadPending() {
        const { data, error } = await supabaseClient.from('services').select('*')
            .eq('status', 'pending').neq('client_id', auth.user.id)
            .in('category', this.offered.length ? this.offered : ['__nenhum__'])
            .or(`target_provider_id.is.null,target_provider_id.eq.${auth.user.id}`)
            .order('created_at', { ascending: false }).limit(20);
        if (error) return toast('Não foi possível carregar os chamados: ' + error.message, true);
        this.pending.clear();
        (data || []).forEach((s) => {
            this.pending.set(s.id, s);
            this.notifyProviderCall(s);
        });
        this.renderPending();
    },

    renderPending() {
        const ul = $('pending-list');
        ul.innerHTML = '';
        if (this.currentService || !auth.profile?.available_for_services) return;
        if (this.pending.size === 0) {
            $('driver-status').textContent = '💤 Aguardando chamados';
            return;
        }
        $('driver-status').textContent = `🚨 ${this.pending.size} chamado(s) disponível(is)`;
        [...this.pending.values()].sort((a, b) => {
            const aPos = parsePoint(a.client_location);
            const bPos = parsePoint(b.client_location);
            if (!mapManager.myPos) return 0;
            const aDistance = aPos ? calculateDistance(mapManager.myPos[0], mapManager.myPos[1], aPos[0], aPos[1]) : Infinity;
            const bDistance = bPos ? calculateDistance(mapManager.myPos[0], mapManager.myPos[1], bPos[0], bPos[1]) : Infinity;
            return aDistance - bDistance;
        }).forEach((s) => {
            const pos = parsePoint(s.client_location);
            const km = pos && mapManager.myPos ? calculateDistance(mapManager.myPos[0], mapManager.myPos[1], pos[0], pos[1]).toFixed(1) + ' km' : '';
            const li = document.createElement('li');
            const info = document.createElement('div');
            const b = document.createElement('b');
            b.textContent = s.category;
            const small = document.createElement('small');
            small.textContent = `R$ ${Number(s.price).toFixed(2)}${km ? ' • ' + km : ''}`;
            info.append(b, small);
            const btn = document.createElement('button');
            btn.className = 'btn';
            btn.type = 'button';
            btn.textContent = 'Aceitar';
            btn.addEventListener('click', () => this.acceptService(s.id));
            li.append(info, btn);
            ul.appendChild(li);
        });
    },

    async acceptService(id) {
        if (this.currentService || !auth.profile?.available_for_services) {
            return toast('Finalize o atendimento atual antes de aceitar outro chamado.', true);
        }
        // Só aceita se ainda estiver pendente (evita dois prestadores no mesmo pedido)
        const { data, error } = await supabaseClient.from('services')
            .update({ provider_id: auth.user.id, status: 'accepted' })
            .eq('id', id).eq('status', 'pending').select().maybeSingle();
        if (error) return toast(error.message, true);
        if (!data) { toast('Esse chamado já foi aceito por outro profissional.', true); this.pending.delete(id); return this.renderPending(); }
        const { error: availabilityError } = await supabaseClient.from('profiles')
            .update({ available_for_services: false }).eq('id', auth.user.id);
        if (availabilityError) toast('Chamado aceito, mas não foi possível atualizar sua disponibilidade: ' + availabilityError.message, true);
        auth.profile.available_for_services = false;
        this.pending.clear();
        $('pending-list').innerHTML = '';
        this.applyService(data);
        this.startMoving(); // pedido já está pago: o rastreamento e a rota começam sozinhos
        toast('Rastreamento iniciado. Siga a rota até o cliente.');
    },

    async updateOwnLocation(pos) {
        if (!pos) {
            if (this.role === 'provider' && auth.profile?.available_for_services) {
                const { error } = await supabaseClient.from('profiles')
                    .update({ last_location_updated_at: null }).eq('id', auth.user.id);
                if (error) toast('Não foi possível invalidar a localização desatualizada: ' + error.message, true);
            }
            return;
        }
        const service = this.currentService;
        if (this.role === 'provider' && mapManager.hasRealPosition) {
            const { error } = await supabaseClient.from('profiles')
                .update({
                    last_location: toPoint(pos[0], pos[1]),
                    ...(auth.profile?.available_for_services
                        ? { last_location_updated_at: new Date().toISOString() }
                        : {})
                }).eq('id', auth.user.id);
            if (error) toast('Não foi possível atualizar sua localização: ' + error.message, true);
        }
        if (this.role === 'provider' && service && service.provider_id === auth.user.id) {
            const clientPos = parsePoint(service.client_location);
            if (clientPos) {
                this.updateTripPrice(calculateDistance(pos[0], pos[1], clientPos[0], clientPos[1]));
            }
        } else if (this.role === 'client' && service && service.client_id === auth.user.id) {
            const { error } = await supabaseClient.from('services')
                .update({ client_location: toPoint(pos[0], pos[1]) }).eq('id', service.id);
            if (error) toast('Não foi possível atualizar sua localização: ' + error.message, true);
        }
        if (this.role === 'provider' && !service && auth.profile?.available_for_services) {
            this.renderPending();
        }
        if (this.isEnRoute()) this.refreshRoute();
    },

    startMoving() {
        if (!this.currentService) return;
        if (mapManager.watchId === null) mapManager.setupGeo((pos) => this.updateOwnLocation(pos));
        this.updateOwnLocation(mapManager.myPos);
        $('btn-move').classList.add('hidden');
        $('btn-arrived').classList.toggle('hidden',
            (this.currentService.tow_stage || 'waiting_arrival') !== 'waiting_arrival');
        this.movingServiceId = this.currentService.id;
        this.panelExpanded = false;
        this.updateRouteMode();
    },

    // ---------- Modo rota: painel compacto + linha da rota no mapa ----------
    togglePanel() {
        this.panelExpanded = !this.panelExpanded;
        this.updateRouteMode();
    },

    isEnRoute() {
        const s = this.currentService;
        if (!s || !auth.user || s.status !== 'accepted') return false;
        if ((s.tow_stage || 'waiting_arrival') !== 'waiting_arrival') return false;
        if (this.role === 'client') return s.client_id === auth.user.id;
        return this.role === 'provider' && s.provider_id === auth.user.id && this.movingServiceId === s.id;
    },

    updateRouteMode() {
        const panel = $('main-panel');
        const enRoute = this.isEnRoute();
        const compact = enRoute && !this.panelExpanded;
        panel.classList.toggle('route-mode', enRoute);
        panel.classList.toggle('expanded', enRoute && this.panelExpanded);
        document.body.classList.toggle('route-compact', compact);
        $('btn-panel-toggle').classList.toggle('hidden', !enRoute);
        $('btn-panel-toggle').textContent = this.panelExpanded ? 'Ocultar detalhes ▼' : 'Ver detalhes ▲';
        $('btn-panel-toggle').setAttribute('aria-expanded', String(this.panelExpanded));
        if (!enRoute) {
            $('route-info').classList.add('hidden');
            mapManager.clearRoute();
            this.providerPosFetched = false;
            return;
        }
        this.refreshRoute();
    },

    async refreshRoute() {
        const s = this.currentService;
        if (!s || !this.isEnRoute()) return;
        const clientPos = parsePoint(s.client_location) || (this.role === 'client' ? mapManager.myPos : null);
        let from;
        let to;
        if (this.role === 'provider') {
            from = mapManager.myPos;
            to = clientPos;
        } else {
            if (!mapManager.partnerMarker && !this.providerPosFetched && s.provider_id) {
                this.providerPosFetched = true;
                const { data } = await supabaseClient.from('profiles')
                    .select('last_location').eq('id', s.provider_id).maybeSingle();
                const pos = parsePoint(data?.last_location);
                if (pos) mapManager.updatePartner(pos, 'blue', 'Profissional');
            }
            const p = mapManager.partnerMarker?.getLatLng();
            from = p ? [p.lat, p.lng] : null;
            to = clientPos;
        }
        const label = this.role === 'provider' ? '🚗 Indo até o cliente' : '🚗 Profissional a caminho';
        const box = $('route-info');
        if (!from || !to) {
            box.textContent = this.role === 'provider' ? label : `${label} • aguardando localização dele...`;
            box.classList.remove('hidden');
            return;
        }
        const info = await mapManager.drawRoute(from, to);
        if (!this.isEnRoute() || !info) return;
        const km = info.km.toFixed(1).replace('.', ',');
        box.textContent = info.min ? `${label} • ${info.min} min • ${km} km` : `${label} • ${km} km (em linha reta)`;
        box.classList.remove('hidden');
    },

    async markArrived() {
        if (!this.currentService) return;
        const { error } = await supabaseClient.from('services')
            .update({ tow_stage: 'arrived' }).eq('id', this.currentService.id);
        if (error) return toast(error.message, true);
        this.currentService.tow_stage = 'arrived';
        this.syncTowStage(this.currentService);
        this.renderServicePhotos(this.currentService);
        toast('Chegada confirmada. Aguarde a escolha do cliente.');
    },

    showTransportDestination() {
        $('tow-destination-wrap').classList.remove('hidden');
    },

    async chooseTowSolution(solution) {
        if (!this.currentService) return;
        const destination = $('tow-destination').value.trim();
        if (solution === 'transport' && destination.length < 5) {
            return toast('Informe o endereço de destino.', true);
        }
        const { error } = await supabaseClient.from('services').update({
            tow_stage: solution === 'transport' ? 'transport_selected' : 'repair_selected',
            tow_destination: solution === 'transport' ? destination : null
        }).eq('id', this.currentService.id);
        if (error) return toast(error.message, true);
        this.currentService.tow_stage = solution === 'transport' ? 'transport_selected' : 'repair_selected';
        $('tow-choice').classList.add('hidden');
        this.syncTowStage(this.currentService);
        this.renderServicePhotos(this.currentService);
        toast(solution === 'transport' ? 'Transporte confirmado. Aguarde o prestador.' : 'Conserto local confirmado.');
    },

    async startTowTransport() {
        if (!this.currentService) return;
        if (!this.currentService.start_photo_path || !this.currentService.service_started_at) {
            return toast('Registre a foto inicial do serviço antes de iniciar o transporte.', true);
        }
        const { error } = await supabaseClient.from('services')
            .update({ tow_stage: 'transporting' }).eq('id', this.currentService.id);
        if (error) return toast('Não foi possível iniciar o transporte: ' + error.message, true);
        this.currentService.tow_stage = 'transporting';
        this.syncTowStage(this.currentService);
        this.renderServicePhotos(this.currentService);
        toast('Transporte iniciado.');
    },

    async finishService() {
        if (!this.currentService) return;
        if (this.currentService.category === 'Guincho') {
            if (!['repair_selected', 'transporting'].includes(this.currentService.tow_stage || '')) {
                return toast('Conclua o conserto ou o transporte antes de finalizar o serviço.', true);
            }
            if (!this.currentService.start_photo_path || !this.currentService.end_photo_path) {
                return toast('Registre as fotos de início e final do guincho antes de finalizar.', true);
            }
        }
        clearInterval(this.moveTimer);
        this.moveTimer = null;
        const { error } = await supabaseClient.from('services')
            .update({ status: 'completed' }).eq('id', this.currentService.id);
        if (error) return toast(error.message, true);
        this.showReview();
    },

    // ---------- Avaliação (feita pelo cliente) ----------
    showReview() {
        this.userRating = 0;
        this.setRating(0);
        $('review-comment').value = '';
        $('review-overlay').classList.remove('hidden');
    },

    setRating(n) {
        this.userRating = n;
        document.querySelectorAll('#star-rating button')
            .forEach((b) => b.classList.toggle('active', Number(b.dataset.star) <= n));
    },

    async submitReview() {
        if (this.userRating === 0) return toast('Selecione as estrelas!', true);
        const s = this.currentService;
        if (!s) return this.goHome();
        // Quem avalia é o outro lado do serviço
        const reviewerIsClient = s.client_id === auth.user.id;
        const { error } = await supabaseClient.from('reviews').insert([{
            service_id: s.id,
            client_id: s.client_id,
            provider_id: s.provider_id,
            reviewer_id: auth.user.id,
            rating: this.userRating,
            comment: $('review-comment').value.trim().slice(0, 300) || null
        }]);
        if (error) return toast('Erro ao enviar avaliação: ' + error.message, true);
        toast(reviewerIsClient ? 'Obrigado pela avaliação!' : 'Avaliação enviada!');
        this.goHome();
    },

    // ---------- Realtime ----------
    startRealtime() {
        if (this.channel) supabaseClient.removeChannel(this.channel);
        this.channel = supabaseClient.channel('connectservice')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'services' }, (p) => this.onServiceInsert(p.new))
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'services' }, (p) => this.onServiceUpdate(p.new))
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, (p) => this.onProviderMove(p.new))
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => this.onMessage(p.new))
            .subscribe((status, error) => {
                if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    toast('A conexão em tempo real falhou. Atualize a página e tente novamente.', true);
                    if (error) console.error('Falha no canal de atualizações em tempo real:', error);
                }
            });
    },

    onServiceInsert(s) {
        if (auth.profile?.user_type !== 'provider' || !auth.profile.available_for_services
            || this.currentService || s.status !== 'pending' || s.client_id === auth.user.id) return;
        if (!this.offered.includes(s.category)) return; // não é um serviço que ele presta
        if (s.target_provider_id && s.target_provider_id !== auth.user.id) return;
        this.pending.set(s.id, s);
        this.notifyProviderCall(s);
        if (this.role === 'provider') this.renderPending();
    },

    notifyProviderCall(service) {
        if (this.notifiedServiceIds.has(service.id)) return;
        this.notifiedServiceIds.add(service.id);
        const message = `Novo chamado de ${service.category}${service.target_provider_id ? ' — você é o prestador mais próximo' : ''}.`;
        this.addNotification(message);
        if (!$('landing-page').classList.contains('hidden')) toast(message);
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('🚨 Novo chamado!', { body: `Um cliente precisa de ${service.category}.` });
        }
    },

    async onServiceUpdate(s) {
        if (this.currentService?.id === s.id
            && (s.status === 'accepted' || s.status === 'cancelled' || s.status === 'completed')) {
            clearTimeout(this.dispatchTimer);
            this.dispatchTimer = null;
        }
        if (this.role === 'provider' && s.provider_id === auth.user.id
            && ['cancelled', 'completed'].includes(s.status) && this.currentService?.id !== s.id) {
            await this.refreshProviderAvailability();
        }
        if (this.role === 'provider' && s.status !== 'pending') {
            if (this.pending.delete(s.id)) this.renderPending();
        }
        if (this.role === 'provider' && auth.profile?.available_for_services && s.status === 'pending' && !this.currentService
            && !this.pending.has(s.id) && s.client_id !== auth.user.id
            && this.offered.includes(s.category)
            && (!s.target_provider_id || s.target_provider_id === auth.user.id)) {
            this.pending.set(s.id, s);
            this.notifyProviderCall(s);
            this.renderPending();
        }
        if (!this.currentService || this.currentService.id !== s.id) return;
        const previousStatus = this.currentService.status;
        this.currentService = s;
        this.syncTowStage(s);
        this.renderServicePhotos(s);
        this.updateRouteMode();

        if (this.role === 'client') {
            if (s.status === 'pending' && previousStatus === 'awaiting_payment') {
                payment.onPaid(); // o PIX caiu: fecha a tela de pagamento e chama os prestadores
            } else if (s.status === 'accepted') {
                $('client-status').textContent = `✅ Profissional a caminho! Valor pago: R$ ${Number(s.price).toFixed(2)}`;
                $('chat-toggle').classList.remove('hidden');
            } else if (s.status === 'completed') {
                $('chat-container').classList.add('hidden');
                this.showReview();
            }
        } else if (this.role === 'provider') {
            const clientPos = parsePoint(s.client_location);
            if (clientPos && s.status === 'accepted') {
                mapManager.updatePartner(clientPos, 'green', 'Cliente');
                if (!this.isEnRoute()) mapManager.fitBoth();
                if (mapManager.myPos) {
                    this.updateTripPrice(calculateDistance(mapManager.myPos[0], mapManager.myPos[1], clientPos[0], clientPos[1]));
                }
            }
            if (s.status === 'cancelled') {
                clearInterval(this.moveTimer);
                this.moveTimer = null;
                this.currentService = null;
                mapManager.clearPartner();
                this.movingServiceId = null;
                this.updateRouteMode();
                $('chat-container').classList.add('hidden');
                $('chat-toggle').classList.add('hidden');
                this.resetProviderUI();
                await this.refreshProviderAvailability();
                toast('O cliente cancelou o pedido.', true);
            }
        }
    },

    onProviderMove(p) {
        if (this.role !== 'client' || !this.currentService) return;
        if (p.id !== this.currentService.provider_id) return;
        const pos = parsePoint(p.last_location);
        if (!pos) return;
        mapManager.updatePartner(pos, 'blue', 'Profissional');
        if (this.isEnRoute()) this.refreshRoute();
        else mapManager.fitBoth();
    },

    // ---------- Chat ----------
    toggleChat() {
        const chat = $('chat-container');
        chat.classList.toggle('hidden');
        if (!chat.classList.contains('hidden')) this.loadMessages();
    },

    async sendMessage() {
        const input = $('msg-input');
        const content = input.value.trim();
        if (!content || !this.currentService) return;
        input.value = '';
        const { data, error } = await supabaseClient.from('messages').insert([{
            service_id: this.currentService.id, sender_id: auth.user.id, content: content.slice(0, 500)
        }]).select().single();
        if (error) {
            input.value = content; // devolve o texto para o usuário tentar de novo
            return toast('Não foi possível enviar: ' + error.message, true);
        }
        this.appendMessage(data); // mostra na hora, sem depender do tempo real
    },

    onMessage(m) {
        menu.onMessage(m);
        if (!this.currentService || m.service_id !== this.currentService.id) return;
        this.appendMessage(m);
        if ($('chat-container').classList.contains('hidden') && m.sender_id !== auth.user.id) {
            this.addNotification(`Nova mensagem: ${m.content}`);
            toast(`💬 Nova mensagem: ${m.content}`);
        }
    },

    appendMessage(m) {
        if (!m?.id || this.renderedMessages.has(m.id)) return;
        this.renderedMessages.add(m.id);
        const box = $('chat-msgs');
        const div = document.createElement('div');
        div.className = 'msg ' + (m.sender_id === auth.user.id ? 'sent' : 'received');
        div.textContent = m.content; // textContent: sem risco de XSS
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
    },

    async loadMessages() {
        if (!this.currentService) return;
        const { data, error } = await supabaseClient.from('messages').select('*')
            .eq('service_id', this.currentService.id).order('created_at', { ascending: true });
        if (error) {
            toast('Não foi possível carregar as mensagens.', true);
            return;
        }
        $('chat-msgs').innerHTML = '';
        this.renderedMessages.clear();
        (data || []).forEach((m) => this.appendMessage(m));
    }
};

window.addEventListener('DOMContentLoaded', () => {
    if ('Notification' in window && Notification.permission === 'default') {
        // Pede permissão só após o primeiro clique do usuário
        document.addEventListener('click', () => Notification.requestPermission(), { once: true });
    }
    app.init();
    menu.init();
    payment.init();
    auth.init();
});
