# BotNexus

Hospedagem brasileira de bots do Discord: login, planos com pagamento (Mercado Pago ou Pix manual),
deploy por ZIP, console ao vivo, reinício automático, e-mails, monitoramento e backup do banco.

## Rodar (Termux ou qualquer Linux)

Precisa de **Node.js 22.13 ou mais novo** (`node -v`). No Termux: `pkg upgrade nodejs`.

```bash
cd BotNexus/backend
npm install
npm run setup -- seu@email.com     # cria o .env com uma chave secreta; esse e-mail vira ADMIN
npm start
```

Abra `http://localhost:3000`, crie sua conta **com o e-mail do admin** e pronto.
Para conferir que tudo funciona: `npm test` (sobe um servidor de teste e roda 68 verificações).

## O que tem

| Peça | Como está |
|---|---|
| Servidor 24h | cada bot é um processo separado; religam sozinhos se o servidor reiniciar |
| Login e contas | e-mail + senha (scrypt), sessão em cookie seguro, recuperação de senha por e-mail |
| Banco | SQLite (`backend/data/botnexus.db`); cada usuário só vê os próprios bots |
| Pagamento | **AbacatePay** (Pix com QR Code dentro do painel, confirmação automática), **Mercado Pago** (Pix/cartão/boleto) ou **Pix manual** (você aprova no painel Admin). Usa o que estiver configurado no `.env` |
| Cobrança mensal | planos de 30 dias; ao vencer, volta ao Grátis e bots acima do limite são desligados (+ e-mail) |
| E-mail | SMTP; sem SMTP, os e-mails aparecem no console do servidor |
| Segredos | tokens e variáveis ficam criptografados (AES-256-GCM) e são mascarados nos logs |
| Monitoramento | reinício automático (5 tentativas/10 min), limite de memória, e-mail quando o bot cai, alerta de pouca memória |
| Backup | automático a cada 24 h em `backend/data/backups` (guarda 7) + botão no Admin |

Preços e limites dos planos: `backend/src/plans.js` (valores de exemplo, edite à vontade).

## Configurações (`backend/.env`)

Todas estão comentadas em `.env.example`. As principais:

- `APP_URL`: endereço público do site (use `https://` quando tiver domínio).
- `ABACATEPAY_API_KEY`: chave da API do AbacatePay (em Integrar > API Keys, com as permissões `TRANSPARENT:CREATE` e `TRANSPARENT:READ`). Chave de teste começa com `abc_dev_`. O painel mostra o QR Code e confere o pagamento sozinho a cada 4 segundos, então **funciona até sem domínio**. O webhook é um extra (opcional): cadastre `https://seudominio.com.br/api/billing/webhook/abacatepay?webhookSecret=SEU_SEGREDO` com o evento `transparent.completed` e coloque o mesmo segredo em `ABACATEPAY_WEBHOOK_SECRET`.
- `MP_ACCESS_TOKEN`: token do Mercado Pago (cole você mesmo; nada vem preenchido). Com `APP_URL` em https, o webhook `APP_URL/api/billing/webhook` é configurado automaticamente em cada cobrança.
- `PAYMENT_PROVIDER`: se tiver mais de um configurado, escolha `abacatepay`, `mercadopago` ou `manual`. Vazio = automático (AbacatePay primeiro).
- `PIX_MANUAL_KEY` / `PIX_MANUAL_NAME`: chave Pix usada enquanto não houver Mercado Pago.
- `SMTP_*`: dados do seu servidor de e-mail.
- Guarde o `.env`: sem o `APP_SECRET` os tokens salvos dos bots não podem ser lidos.

## Domínio

Com o servidor no celular/PC de casa, a forma mais simples é um túnel Cloudflare (`cloudflared`) apontando para a
porta 3000, com `APP_URL=https://seudominio.com.br` e `TRUST_PROXY=true`. Em uma VPS, use Nginx/Caddy na frente.

## Segurança: o que o isolamento faz e não faz

Cada bot roda com o **modo seguro do Node** (`--permission`): só lê e escreve na própria pasta, não abre outros
programas e não carrega módulos nativos. O ambiente dele é limpo: não recebe nenhuma variável do servidor.
Isso protege bem contra bots que tentam ler o banco ou o `.env`. **Não é uma máquina virtual**: não limita CPU
nem rede. Para hospedar bots de desconhecidos em escala, o próximo passo é rodar cada bot em um container.
Bots que dependem de `child_process` ou módulos nativos não funcionam no modo seguro (`BOT_SANDBOX=off` desliga,
por sua conta e risco).

## Estrutura

```
backend/   servidor Node.js (Express + Socket.IO + SQLite embutido)
frontend/  painel (HTML/CSS/JS puro, sem build)
```
