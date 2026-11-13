// Pagamentos por Pix.
// Dois modos:
//   - "simulado": para testar sem dinheiro de verdade (padrão).
//   - "mercadopago": Pix real, com confirmação e estorno automáticos.
const crypto = require('node:crypto');

function simulado() {
  const pagos = new Set();
  const estornados = new Set();
  return {
    nome: 'simulado',
    async criar(pedido) {
      const id = 'SIM-' + crypto.randomBytes(6).toString('hex');
      return { id, copiaCola: `PIX-DE-TESTE-${id}-NAO-PAGAR`, qrBase64: '' };
    },
    async situacao(id) {
      if (estornados.has(id)) return { status: 'estornado' };
      return { status: pagos.has(id) ? 'pago' : 'pendente' };
    },
    async estornar(id) {
      estornados.add(id);
      return true;
    },
    simularPagamento(id) {
      pagos.add(id);
    },
  };
}

function dataMercadoPago(ms) {
  // Formato exigido: 2026-01-31T12:00:00.000-03:00 (horário de Brasília)
  const d = new Date(ms - 3 * 3600 * 1000);
  return d.toISOString().replace('Z', '-03:00');
}

function mercadoPago({ token, urlBase }) {
  const api = 'https://api.mercadopago.com';
  async function chamar(metodo, caminho, corpo, chaveUnica) {
    const cabecalhos = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (chaveUnica) cabecalhos['X-Idempotency-Key'] = chaveUnica;
    const r = await fetch(api + caminho, {
      method: metodo,
      headers: cabecalhos,
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const texto = await r.text();
    let json = {};
    try { json = JSON.parse(texto); } catch { /* resposta sem JSON */ }
    if (!r.ok) throw new Error(`Mercado Pago respondeu ${r.status}: ${json.message || texto.slice(0, 200)}`);
    return json;
  }
  return {
    nome: 'mercadopago',
    async criar(pedido, descricao) {
      const corpo = {
        transaction_amount: pedido.valor_centavos / 100,
        description: descricao.slice(0, 200),
        payment_method_id: 'pix',
        external_reference: pedido.id,
        date_of_expiration: dataMercadoPago(pedido.expira_em),
        payer: { email: pedido.email, first_name: pedido.nome.split(' ')[0] },
      };
      if (urlBase.startsWith('https://')) corpo.notification_url = urlBase + '/api/webhooks/mercadopago';
      const p = await chamar('POST', '/v1/payments', corpo, 'pedido-' + pedido.id);
      const dados = (p.point_of_interaction && p.point_of_interaction.transaction_data) || {};
      if (!p.id || !dados.qr_code) throw new Error('Mercado Pago não devolveu o código Pix.');
      return { id: String(p.id), copiaCola: dados.qr_code, qrBase64: dados.qr_code_base64 || '' };
    },
    async situacao(id) {
      const p = await chamar('GET', '/v1/payments/' + encodeURIComponent(id));
      const mapa = { approved: 'pago', refunded: 'estornado', cancelled: 'cancelado', rejected: 'cancelado' };
      return {
        status: mapa[p.status] || 'pendente',
        valor_centavos: Math.round((p.transaction_amount || 0) * 100),
        referencia: p.external_reference,
      };
    },
    async estornar(id) {
      await chamar('POST', `/v1/payments/${encodeURIComponent(id)}/refunds`, {}, 'estorno-' + id);
      return true;
    },
  };
}

function criarProvedor(cfg) {
  if (cfg.pagamento === 'mercadopago') {
    if (!cfg.mpToken) throw new Error('Faltou MP_ACCESS_TOKEN para usar o Mercado Pago.');
    return mercadoPago({ token: cfg.mpToken, urlBase: cfg.urlBase });
  }
  return simulado();
}

module.exports = { criarProvedor };
