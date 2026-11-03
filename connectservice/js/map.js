// Mapa (Leaflet) e geolocalização

const DEFAULT_POS = [-27.5954, -48.5480]; // Florianópolis (fallback)

const mapManager = {
    map: null,
    userMarker: null,
    partnerMarker: null,
    myPos: null,
    ready: false,
    watchId: null,
    hasRealPosition: false,
    routeGroup: null,
    routeToken: 0,
    routeAt: 0,
    routeFetching: false,
    routeDestKey: '',
    routeInfo: null,
    routeFitted: false,

    init() {
        if (this.ready) { this.map.invalidateSize(); return; }
        this.map = L.map('map', { zoomControl: false }).setView(DEFAULT_POS, 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap'
        }).addTo(this.map);
        this.ready = true;
    },

    setupGeo(onPosition) {
        return new Promise((resolve) => {
            let gotWatchPosition = false;
            const fallback = () => {
                if (gotWatchPosition) { resolve(); return; }
                this.hasRealPosition = false;
                this.setMyPos(DEFAULT_POS);
                this.map.setView(DEFAULT_POS, 13);
                resolve();
            };
            if (!navigator.geolocation) return fallback();

            const handlePosition = (pos, centerMap = false) => {
                this.handlePosition(pos, onPosition, centerMap);
            };

            navigator.geolocation.getCurrentPosition(
                (pos) => { handlePosition(pos, true); resolve(); },
                () => {
                    if (gotWatchPosition) { resolve(); return; }
                    toast('Não foi possível obter sua localização. Usando posição padrão.', true);
                    fallback();
                },
                { enableHighAccuracy: true, timeout: 8000 }
            );
            this.watchId = navigator.geolocation.watchPosition(
                (pos) => { gotWatchPosition = true; handlePosition(pos); },
                (error) => toast(error.code === 1
                    ? 'Ative a localização para compartilhar sua posição.'
                    : 'Não foi possível acompanhar sua localização.', true),
                { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
            );
        });
    },

    refreshPosition(onPosition) {
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(
            (pos) => this.handlePosition(pos, onPosition),
            () => {
                this.hasRealPosition = false;
                if (typeof onPosition === 'function') onPosition(null);
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 5000 }
        );
    },

    handlePosition(pos, onPosition, centerMap = false) {
        const location = [pos.coords.latitude, pos.coords.longitude];
        this.hasRealPosition = true;
        this.setMyPos(location);
        if (centerMap) this.map.setView(location, 15);
        if (typeof onPosition === 'function') onPosition(location);
    },

    stopGeo() {
        if (this.watchId !== null && navigator.geolocation) {
            navigator.geolocation.clearWatch(this.watchId);
            this.watchId = null;
        }
    },

    setMyPos(pos) {
        this.myPos = pos;
        if (!this.userMarker) this.userMarker = L.marker(pos).addTo(this.map).bindPopup('Você');
        else this.userMarker.setLatLng(pos);
    },

    createIcon(color) {
        return new L.Icon({
            iconUrl: `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-${color}.png`,
            shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
            iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
        });
    },

    updatePartner(pos, color = 'blue', label = '') {
        if (!pos) return;
        if (!this.partnerMarker) {
            this.partnerMarker = L.marker(pos, { icon: this.createIcon(color) }).addTo(this.map);
            if (label) this.partnerMarker.bindPopup(label);
        } else {
            this.partnerMarker.setLatLng(pos);
        }
    },

    clearPartner() {
        if (this.partnerMarker) { this.partnerMarker.remove(); this.partnerMarker = null; }
    },

    // ---------- Rota (linha no mapa) ----------
    clearRoute() {
        this.routeToken += 1;
        if (this.routeGroup) { this.routeGroup.remove(); this.routeGroup = null; }
        this.routeAt = 0;
        this.routeDestKey = '';
        this.routeInfo = null;
        this.routeFitted = false;
        this.routeFetching = false;
    },

    // Desenha a rota por ruas (OSRM). Se o serviço de rotas falhar, usa uma linha reta tracejada.
    // Retorna { km, min } (min é null quando for linha reta).
    async drawRoute(from, to) {
        if (!this.map || !from || !to) return this.routeInfo;
        const key = `${to[0].toFixed(4)},${to[1].toFixed(4)}`;
        const fresh = this.routeGroup && key === this.routeDestKey && Date.now() - this.routeAt < 15000;
        if (fresh || this.routeFetching) return this.routeInfo;

        const token = this.routeToken;
        this.routeFetching = true;
        let latlngs = [from, to];
        let info = { km: calculateDistance(from[0], from[1], to[0], to[1]), min: null };
        let dashed = true;
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 6000);
            const url = `https://router.project-osrm.org/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`;
            const res = await fetch(url, { signal: ctrl.signal });
            clearTimeout(timer);
            if (!res.ok) throw new Error('rota indisponível');
            const route = (await res.json()).routes?.[0];
            if (!route) throw new Error('sem rota');
            latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
            info = { km: route.distance / 1000, min: Math.max(1, Math.round(route.duration / 60)) };
            dashed = false;
        } catch { /* mantém a linha reta */ }
        this.routeFetching = false;
        if (token !== this.routeToken || !this.map) return this.routeInfo; // rota foi limpa enquanto buscava

        if (this.routeGroup) this.routeGroup.remove();
        const line = { color: '#00a88f', weight: 6, opacity: .95, lineCap: 'round', lineJoin: 'round' };
        if (dashed) line.dashArray = '2 12';
        this.routeGroup = L.layerGroup([
            L.polyline(latlngs, { color: '#ffffff', weight: 11, opacity: .9, lineCap: 'round', lineJoin: 'round' }),
            L.polyline(latlngs, line)
        ]).addTo(this.map);
        this.routeAt = Date.now();
        this.routeDestKey = key;
        this.routeInfo = info;
        if (!this.routeFitted) {
            this.routeFitted = true;
            this.map.fitBounds(L.latLngBounds(latlngs), { paddingTopLeft: [40, 70], paddingBottomRight: [40, 190] });
        }
        return info;
    },

    fitBoth() {
        if (this.myPos && this.partnerMarker) {
            this.map.fitBounds(L.latLngBounds([this.myPos, this.partnerMarker.getLatLng()]), { padding: [60, 60] });
        }
    }
};
