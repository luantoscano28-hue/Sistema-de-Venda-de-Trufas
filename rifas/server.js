// Servidor da plataforma de rifas. Não precisa instalar nada além do Node 22+.
//   node server.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { abrirBanco } = require('./src/db');
const { criarProvedor } = require('./src/pagamentos');
const { clienteDrand } = require('./src/sorteio');
const { criarNucleo, Erro } = require('./src/nucleo');

const env = process.env;
const cfg = {
  porta: Number(env.PORT || 3000),
  urlBase: (env.URL_BASE || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  banco: env.BANCO || path.join(__dirname, 'dados', 'rifas.db'),
  pagamento: env.PAGAMENTO || 'simulado',
  mpToken: env.MP_ACCESS_TOKEN || '',
  taxaPercentual: Number(env.TAXA_PLATAFORMA || 10),
  adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
  reservaMinutos: Number(env.RESERVA_MINUTOS || 30),
  atrasoSorteioSeg: Number(env.ATRASO_SORTEIO_SEG || 60),
  prazoMinimoMs: Number(env.PRAZO_MINIMO_MS ?? 3600 * 1000),
  rotinaMs: Number(env.ROTINA_MS || 20000),
  drandUrl: (env.DRAND_URL || 'https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971').replace(/\/$/, ''),
  nomePlataforma: env.NOME_PLATAFORMA || 'Rifa Clara',
};
if (!(cfg.taxaPercentual >= 0 && cfg.taxaPercentual <= 90)) throw new Error('TAXA_PLATAFORMA precisa ficar entre 0 e 90.');

const db = abrirBanco(cfg.banco);
const provedor = criarProvedor(cfg);
const nucleo = criarNucleo({ db, provedor, drand: clienteDrand(cfg.drandUrl), cfg });

// ---------- Utilidades HTTP ----------
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const PUBLICO = path.join(__dirname, 'public');

function responder(res, status, corpo, cabecalhos = {}) {
  const dados = JSON.stringify(corpo);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cabecalhos });
  res.end(dados);
}

function lerCorpo(req) {
  return new Promise((ok, falha) => {
    let tamanho = 0;
    const partes = [];
    req.on('data', (c) => {
      tamanho += c.length;
      if (tamanho > 200000) { falha(new Erro('Pedido grande demais.', 413)); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => {
      if (!partes.length) return ok({});
      try { ok(JSON.parse(Buffer.concat(partes).toString('utf8'))); } catch { falha(new Erro('Dados inválidos.')); }
    });
    req.on('error', falha);
  });
}

function tokenDaSessao(req) {
  const m = /(?:^|;\s*)sessao=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
const cookieSessao = (token, segundos) =>
  `sessao=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${segundos}${cfg.urlBase.startsWith('https://') ? '; Secure' : ''}`;

// Freio simples contra abuso: poucas tentativas por minuto por endereço.
const tentativas = new Map();
function limitar(req, chave, maximo) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  const k = `${chave}:${ip}`;
  const t = Date.now();
  const lista = (tentativas.get(k) || []).filter((x) => t - x < 60000);
  if (lista.length >= maximo) throw new Erro('Muitas tentativas. Espere um minuto e tente de novo.', 429);
  lista.push(t);
  tentativas.set(k, lista);
}
setInterval(() => tentativas.clear(), 10 * 60000).unref();

function exigirLogin(req) {
  const u = nucleo.usuarioDaSessao(tokenDaSessao(req));
  if (!u) throw new Erro('Entre na sua conta para continuar.', 401);
  return u;
}
function exigirAdmin(req) {
  const u = exigirLogin(req);
  if (u.papel !== 'admin') throw new Erro('Área restrita.', 403);
  return u;
}

// ---------- Rotas ----------
const rotas = [];
const rota = (metodo, padrao, fn) => rotas.push({ metodo, padrao: new RegExp(`^${padrao}$`), fn });

rota('GET', '/api/config', async () => ({
  nome: cfg.nomePlataforma, taxa_percentual: cfg.taxaPercentual, pagamento: provedor.nome,
  reserva_minutos: cfg.reservaMinutos, rede_drand: cfg.drandUrl,
}));

rota('POST', '/api/cadastro', async (req, _p, corpo, res) => {
  limitar(req, 'cadastro', 5);
  const { token, usuario } = nucleo.cadastrar(corpo);
  res.setHeader('Set-Cookie', cookieSessao(token, 30 * 86400));
  return usuario;
});
rota('POST', '/api/entrar', async (req, _p, corpo, res) => {
  limitar(req, 'entrar', 8);
  const { token, usuario } = nucleo.entrar(corpo);
  res.setHeader('Set-Cookie', cookieSessao(token, 30 * 86400));
  return usuario;
});
rota('POST', '/api/sair', async (req, _p, _c, res) => {
  nucleo.sair(tokenDaSessao(req));
  res.setHeader('Set-Cookie', cookieSessao('', 0));
  return { ok: true };
});
rota('GET', '/api/eu', async (req) => nucleo.usuarioDaSessao(tokenDaSessao(req)));

rota('GET', '/api/rifas', async () => nucleo.listarRifas());
rota('POST', '/api/rifas', async (req, _p, corpo) => nucleo.criarRifa(exigirLogin(req), corpo));
rota('GET', '/api/rifas/([a-z0-9-]+)', async (_r, [slug]) => nucleo.rifaPublica(slug));
rota('GET', '/api/rifas/([a-z0-9-]+)/auditoria', async (_r, [slug]) => nucleo.auditoria(slug));
rota('POST', '/api/rifas/([a-z0-9-]+)/pedidos', async (req, [slug], corpo) => {
  limitar(req, 'pedido', 12);
  return nucleo.criarPedido(slug, corpo);
});
rota('POST', '/api/rifas/([a-z0-9-]+)/cancelar', async (req, [slug]) => {
  const u = exigirLogin(req);
  const r = nucleo.rifaPorSlug(slug);
  if (r.organizador_id !== u.id && u.papel !== 'admin') throw new Erro('Esta rifa não é sua.', 403);
  await nucleo.cancelarRifa(r, u.papel === 'admin' && r.organizador_id !== u.id ? 'Cancelada pela plataforma.' : 'Cancelada pelo organizador.');
  return { ok: true };
});

rota('GET', '/api/pedidos/([a-f0-9]{48})', async (_r, [token]) => nucleo.verPedido(token));
rota('POST', '/api/pedidos/([a-f0-9]{48})/estorno', async (req, [token]) => {
  limitar(req, 'estorno', 6);
  await nucleo.pedirEstorno(token);
  return nucleo.verPedido(token);
});
rota('POST', '/api/pedidos/([a-f0-9]{48})/premio-recebido', async (_r, [token]) => {
  nucleo.confirmarPremio(token);
  return nucleo.verPedido(token);
});
rota('POST', '/api/pedidos/([a-f0-9]{48})/simular-pagamento', async (_r, [token]) => {
  if (provedor.nome !== 'simulado') throw new Erro('Disponível só no modo de teste.', 404);
  const p = nucleo.pedidoPorToken(token);
  provedor.simularPagamento(p.pagamento_id);
  await nucleo.confirmarPagamento(p.id);
  return nucleo.verPedido(token);
});
rota('POST', '/api/meus-numeros', async (req, _p, corpo) => {
  limitar(req, 'meus', 10);
  return nucleo.meusNumeros(corpo);
});

rota('GET', '/api/painel', async (req) => nucleo.painel(exigirLogin(req)));
rota('GET', '/api/admin/rifas', async (req) => { exigirAdmin(req); return nucleo.painelAdmin(); });
rota('POST', '/api/admin/rifas/([a-z0-9-]+)/liberar-repasse', async (req, [slug]) => {
  exigirAdmin(req); nucleo.liberarRepasse(slug); return { ok: true };
});
rota('POST', '/api/admin/rifas/([a-z0-9-]+)/repasse-pago', async (req, [slug]) => {
  exigirAdmin(req); nucleo.marcarRepassePago(slug); return { ok: true };
});

// Aviso do Mercado Pago: não confiamos no aviso em si; consultamos o pagamento direto no Mercado Pago.
rota('POST', '/api/webhooks/mercadopago', async (req, _p, corpo) => {
  const url = new URL(req.url, cfg.urlBase);
  const id = String((corpo.data && corpo.data.id) || url.searchParams.get('data.id') || url.searchParams.get('id') || '');
  if (/^\d{1,30}$/.test(id)) {
    const p = db.prepare('SELECT id FROM pedidos WHERE pagamento_id = ?').get(id);
    if (p) nucleo.confirmarPagamento(p.id).catch((e) => console.error('Webhook:', e.message));
  }
  return { ok: true };
});

function servirArquivo(req, res, caminho) {
  let arquivo = path.normalize(path.join(PUBLICO, caminho === '/' ? 'index.html' : caminho));
  if (!arquivo.startsWith(PUBLICO + path.sep) || !fs.existsSync(arquivo) || fs.statSync(arquivo).isDirectory()) {
    arquivo = path.join(PUBLICO, 'index.html');
  }
  res.writeHead(200, {
    'Content-Type': TIPOS[path.extname(arquivo)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  fs.createReadStream(arquivo).pipe(res);
}

const servidor = http.createServer(async (req, res) => {
  const caminho = new URL(req.url, cfg.urlBase).pathname;
  try {
    if (!caminho.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new Erro('Não permitido.', 405);
      return servirArquivo(req, res, caminho);
    }
    for (const r of rotas) {
      const m = r.metodo === req.method && r.padrao.exec(caminho);
      if (!m) continue;
      let corpo = {};
      if (req.method === 'POST') {
        const webhook = caminho.startsWith('/api/webhooks/');
        if (!webhook && !(req.headers['content-type'] || '').startsWith('application/json')) throw new Erro('Formato inválido.', 415);
        corpo = await lerCorpo(req).catch((e) => { if (webhook) return {}; throw e; });
        if (corpo === null || typeof corpo !== 'object') corpo = {};
      }
      return responder(res, 200, await r.fn(req, m.slice(1), corpo, res));
    }
    throw new Erro('Não encontrado.', 404);
  } catch (e) {
    if (e instanceof Erro) return responder(res, e.status, { erro: e.message });
    console.error(e);
    responder(res, 500, { erro: 'Algo deu errado do nosso lado. Tente de novo em instantes.' });
  }
});

servidor.listen(cfg.porta, () => {
  console.log(`${cfg.nomePlataforma} no ar: ${cfg.urlBase}`);
  console.log(`Pagamento: ${provedor.nome} | Taxa da plataforma: ${cfg.taxaPercentual}%`);
  if (provedor.nome === 'simulado') console.log('ATENÇÃO: modo de teste. Nenhum dinheiro de verdade entra ou sai.');
});

const relogio = setInterval(() => nucleo.rotina().catch((e) => console.error('Rotina:', e)), cfg.rotinaMs);
process.on('SIGTERM', () => { clearInterval(relogio); servidor.close(() => { db.close(); process.exit(0); }); });
