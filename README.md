# ConnectService Pro

App de serviços sob demanda (cliente + prestador na mesma conta).

## Estrutura

```
index.html          # só a estrutura (HTML)
css/style.css       # todo o visual
js/config.js        # conexão Supabase
js/utils.js         # funções auxiliares
js/auth.js          # login, cadastro, Google, visitante
js/map.js           # mapa e GPS
js/app.js           # fluxo cliente/prestador, chat, avaliações
supabase/schema.sql # tabelas + regras de segurança (RLS)
supabase/functions/ # funções do servidor: PIX (create-pix, check-pix, cancel-service, mp-webhook)
js/payment.js       # tela de pagamento PIX
```

## Como colocar para funcionar

1. **Supabase > SQL Editor**: cole e rode `supabase/schema.sql`.
   Ao atualizar uma instalação existente, rode o script novamente para habilitar o direcionamento por proximidade, o cadastro de veículo e o bucket privado das fotos de guincho.
2. **Fotos de início e fim do guincho**: o próprio `schema.sql` já cria o bucket privado `service-evidence` e as 4 políticas do Storage (`service_evidence_read/insert/update/delete`). Se aparecer o aviso de falta de permissão ao rodar, crie-as manualmente em *Storage > Policies* para o papel `authenticated`, usando `bucket_id = 'service-evidence' and public.can_access_service_evidence(name, 'read' | 'insert' | 'update' | 'delete')`.
3. **Authentication > Providers**: deixe *Email* ativo. Para visitante, ative *Anonymous sign-ins*. Para Google, configure o provedor.
4. **Authentication > URL Configuration**: coloque a URL onde o site está hospedado em *Site URL* / *Redirect URLs*.
5. Abra o site por um servidor (não por duplo clique no arquivo), por exemplo:
   `python3 -m http.server 8000` e acesse http://localhost:8000
   (GPS e notificações exigem `localhost` ou HTTPS).
   Para aparecer como disponível na busca por proximidade, o prestador deve estar logado, com localização permitida e o app aberto. O chamado vai primeiro ao prestador online mais próximo; após 30 segundos sem aceite, é liberado aos demais da categoria.
   Prestadores que oferecem guincho precisam informar placa e tipo do veículo. Durante o atendimento, o guincheiro registra uma foto para iniciar e outra para finalizar o serviço; as fotos ficam privadas e visíveis somente aos participantes do chamado.

## Pagamento por PIX (Mercado Pago)

Fluxo: o cliente pede o serviço → o app gera um PIX (QR Code e copia e cola) → quando o pagamento cai, o pedido é liberado para os prestadores → o prestador aceita e o **rastreamento e a rota começam sozinhos**.

O pedido nasce como *aguardando pagamento* e **não aparece para nenhum prestador** até o Mercado Pago confirmar. O valor é definido no servidor (o navegador não consegue mudar o preço nem liberar o pedido sem pagar). A chave secreta do Mercado Pago fica só no servidor, em Edge Functions do Supabase (`supabase/functions/`).

### Como ativar (uma vez)

1. **Supabase > SQL Editor:** rode o `supabase/schema.sql` de novo (cria a tabela `payments` e as travas).
2. **Mercado Pago:** em [mercadopago.com.br/developers](https://www.mercadopago.com.br/developers), crie uma aplicação (pagamentos online) e copie o **Access Token de produção** (`APP_USR-...`).
3. **Webhook:** em *Suas integrações > Webhooks > Configurar notificações*, informe a URL de produção
   `https://nsltuhoefpzgosonoepg.supabase.co/functions/v1/mp-webhook`, marque o evento **Pagamentos** e copie a **assinatura secreta**.
4. **Publique as funções** (precisa do [Supabase CLI](https://supabase.com/docs/guides/cli); rode na pasta do projeto):
   ```bash
   supabase init                      # só na primeira vez, se ainda não existir supabase/config.toml
   supabase login
   supabase link --project-ref nsltuhoefpzgosonoepg
   supabase secrets set MP_ACCESS_TOKEN=APP_USR-seu-token MP_WEBHOOK_SECRET=sua-assinatura-secreta
   supabase functions deploy create-pix check-pix cancel-service
   supabase functions deploy mp-webhook --no-verify-jwt
   ```
5. **Preços:** edite `PRICES` em `supabase/functions/_shared/mp.ts` (hoje R$ 20,00 por categoria) e publique de novo as funções.
6. **Teste com valor baixo** (por exemplo R$ 1,00, o mínimo aceito) antes de abrir para clientes.

### Regras do pagamento

- O PIX vale por 30 minutos. Vencido, o app gera outro com um toque.
- Cancelou **antes de algum prestador aceitar** → o PIX em aberto é cancelado ou o valor pago é **devolvido automaticamente**.
- Depois que o prestador aceita, o cliente não cancela pelo app (combine pelo chat). Reembolsos nesse caso são feitos por você no painel do Mercado Pago.
- Se o cliente pagar um pedido que já foi cancelado, o valor é devolvido sozinho.
- Para pagar é preciso conta com e-mail (visitante não paga).
- O dinheiro cai na **sua** conta do Mercado Pago. O repasse ao prestador não é automático.

## Menu do rodapé e instalação do app

O menu fixo no rodapé tem **Perfil**, **Avisos**, **Pedidos**, **Mensagens** e **Baixar app** (`js/menu.js`).
- **Baixar app** instala o site como aplicativo (PWA): `manifest.json`, `sw.js` e a pasta `icons/`.
- A instalação só aparece em **HTTPS** ou `localhost`. Em celular, hospede o site em um endereço HTTPS (Netlify, Vercel, GitHub Pages, etc.).
- No iPhone o botão mostra o passo a passo (Safari > Compartilhar > Adicionar à Tela de Início); no Android/Chrome abre a janela de instalação.
- Depois de instalado, o botão some automaticamente.

## Rota e localização

- **Perfil > Minha localização atual:** mostra o endereço aproximado, as coordenadas e a precisão do GPS, com botão para atualizar. Vale para cliente e prestador.
- **Prestador a caminho:** quando o prestador toca em *IR ATÉ O CLIENTE* (e para o cliente, quando o pedido é aceito), o painel encolhe e o mapa mostra a rota por ruas, com tempo e distância. O botão *Ver detalhes* reabre o painel completo.
- Serviços externos usados: rota pelo OSRM (`router.project-osrm.org`) e endereço pelo Nominatim/OpenStreetMap. Ambos são públicos e gratuitos, indicados para uso leve. Para muito tráfego, troque por um serviço próprio ou pago (Mapbox, Google, OpenRouteService). Se o OSRM falhar, o mapa mostra uma linha reta tracejada.

## Segurança

A chave `sb_publishable_...` pode ficar no front-end. O que protege os dados são as políticas RLS do banco e do Storage, configuradas conforme as instruções acima.
Nunca use a chave `service_role` no navegador.
