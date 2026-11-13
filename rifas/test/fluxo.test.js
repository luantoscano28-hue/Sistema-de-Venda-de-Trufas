// Teste do caminho completo: criar rifa, comprar, pagar, sortear, conferir, devolver.
//   node --test
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { hashDaLista, calcularGanhador, sha256 } = require('../src/sorteio');
const { dividir } = require('../src/nucleo');

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let base, processo, drandFalso, pasta;

// drand de mentira (o ambiente de teste não precisa de internet).
function iniciarDrandFalso() {
  const genesis = Math.floor(Date.now() / 1000) - 1000;
  return new Promise((ok) => {
    const s = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/info') return res.end(JSON.stringify({ genesis_time: genesis, period: 1 }));
      const rodada = Number(req.url.split('/').pop());
      const signature = crypto.createHash('sha256').update('assinatura' + rodada).digest('hex');
      const randomness = crypto.createHash('sha256').update(Buffer.from(signature, 'hex')).digest('hex');
      res.end(JSON.stringify({ round: rodada, randomness, signature }));
    });
    s.listen(0, () => ok(s));
  });
}

function cliente() {
  let cookie = '';
  return async function chamar(metodo, caminho, corpo) {
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: corpo ? JSON.stringify(corpo) : metodo === 'POST' ? '{}' : undefined,
    });
    const novo = r.headers.get('set-cookie');
    if (novo) cookie = novo.split(';')[0];
    return { status: r.status, dados: await r.json() };
  };
}

async function ate(fn, limiteMs = 8000) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    const v = await fn();
    if (v) return v;
    await espera(150);
  }
  throw new Error('Tempo esgotado esperando a condição.');
}

test.before(async () => {
  drandFalso = await iniciarDrandFalso();
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'rifas-teste-'));
  const porta = 20000 + Math.floor(Math.random() * 20000);
  base = `http://localhost:${porta}`;
  processo = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(porta), BANCO: path.join(pasta, 't.db'), PAGAMENTO: 'simulado',
      DRAND_URL: `http://localhost:${drandFalso.address().port}`, TAXA_PLATAFORMA: '10', ADMIN_EMAIL: 'admin@teste.com',
      ATRASO_SORTEIO_SEG: '0', PRAZO_MINIMO_MS: '0', ROTINA_MS: '200', NO_PROXY: 'localhost', no_proxy: 'localhost',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await ate(async () => fetch(base + '/api/config').then((r) => r.ok).catch(() => false));
});

test.after(() => {
  processo.kill();
  drandFalso.close();
  fs.rmSync(pasta, { recursive: true, force: true });
});

const comprador = (n) => ({ nome: `Pessoa Teste${n}`, telefone: `1199999000${n}`, email: `p${n}@teste.com` });

async function novaRifa(org, extra = {}) {
  const r = await org('POST', '/api/rifas', {
    titulo: 'Rifa de Teste', premio: 'Uma bicicleta', preco_centavos: 500, total_numeros: 10,
    minimo_numeros: 5, prazo: Date.now() + 3600000, ...extra,
  });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  return r.dados.slug;
}

test('divisão do dinheiro', () => {
  assert.deepEqual(dividir(10000, 10), { taxa: 1000, repasse: 9000 });
  assert.deepEqual(dividir(5000, 30), { taxa: 1500, repasse: 3500 });
  assert.deepEqual(dividir(333, 10), { taxa: 33, repasse: 300 });
});

test('rifa completa: compra, pagamento, sorteio conferível e repasse', async () => {
  const org = cliente();
  const admin = cliente();
  const anon = cliente();
  assert.equal((await org('POST', '/api/cadastro', { nome: 'Organizador Um', email: 'org@teste.com', senha: 'senha-forte-1', chave_pix: 'org@teste.com' })).status, 200);
  assert.equal((await admin('POST', '/api/cadastro', { nome: 'Dona Plataforma', email: 'admin@teste.com', senha: 'senha-forte-2', chave_pix: 'admin@teste.com' })).dados.papel, 'admin');
  assert.equal((await anon('POST', '/api/rifas', {})).status, 401);

  const slug = await novaRifa(org);

  // Dois compradores não podem ficar com o mesmo número.
  const a = await anon('POST', `/api/rifas/${slug}/pedidos`, { ...comprador(1), numeros: [1, 2, 3, 4] });
  assert.equal(a.status, 200);
  const repetido = await anon('POST', `/api/rifas/${slug}/pedidos`, { ...comprador(2), numeros: [4, 5] });
  assert.equal(repetido.status, 409);

  // Antes de pagar, o número fica só reservado.
  let rifa = (await anon('GET', `/api/rifas/${slug}`)).dados;
  assert.deepEqual(rifa.numeros_reservados, [1, 2, 3, 4]);
  assert.deepEqual(rifa.numeros_pagos, []);

  let pedidoA = (await anon('POST', `/api/pedidos/${a.dados.token}/simular-pagamento`)).dados;
  assert.equal(pedidoA.status, 'pago');
  assert.equal(pedidoA.valor_centavos, 2000);

  // Desistência: devolve o dinheiro e libera os números.
  const d = await anon('POST', `/api/rifas/${slug}/pedidos`, { ...comprador(3), numeros: [9, 10] });
  await anon('POST', `/api/pedidos/${d.dados.token}/simular-pagamento`);
  const devolvido = (await anon('POST', `/api/pedidos/${d.dados.token}/estorno`)).dados;
  assert.equal(devolvido.status, 'estornado');
  rifa = (await anon('GET', `/api/rifas/${slug}`)).dados;
  assert.deepEqual(rifa.numeros_pagos, [1, 2, 3, 4]);

  // Compra o resto com números aleatórios: a rifa enche e sorteia sozinha.
  const b = await anon('POST', `/api/rifas/${slug}/pedidos`, { ...comprador(2), quantidade: 6 });
  assert.equal(b.status, 200);
  await anon('POST', `/api/pedidos/${b.dados.token}/simular-pagamento`);

  const aud = await ate(async () => {
    const x = (await anon('GET', `/api/rifas/${slug}/auditoria`)).dados;
    return x.rifa.status === 'sorteada' ? x : null;
  });

  // Confere o sorteio do zero, só com dados públicos.
  const pagos = aud.compradores.map((c) => c.numero);
  assert.equal(pagos.length, 10);
  assert.equal(hashDaLista(pagos), aud.rifa.hash_lista);
  const beacon = await (await fetch(`${aud.rifa.rede_drand}/public/${aud.rifa.rodada_drand}`)).json();
  assert.equal(beacon.randomness, aud.rifa.aleatorio_drand);
  assert.equal(calcularGanhador(beacon.randomness, aud.rifa.id, pagos).numero, aud.rifa.numero_ganhador);

  // A rodada do sorteio foi escolhida antes de existir.
  const enc = aud.registro.find((l) => l.tipo === 'encerramento');
  assert.equal(JSON.parse(enc.dados).rodada_drand, aud.rifa.rodada_drand);

  // O registro público é uma corrente: cada linha amarra a anterior.
  let anterior = '0'.repeat(64);
  for (const l of aud.registro) {
    assert.equal(l.hash_anterior, anterior);
    assert.equal(l.hash, sha256(`${anterior}|${l.seq}|${l.tipo}|${l.criado_em}|${l.dados}`));
    anterior = l.hash;
  }
  assert.deepEqual(aud.registro.map((l) => l.tipo), ['rifa_criada', 'pagamento', 'pagamento', 'estorno', 'estorno_concluido', 'pagamento', 'encerramento', 'sorteio']);

  // Dados pessoais não aparecem na auditoria.
  assert.ok(!JSON.stringify(aud).includes('@teste.com'));
  assert.ok(!JSON.stringify(aud).includes('1199999'));

  // Dinheiro: R$ 50 arrecadados, 10% da plataforma.
  assert.equal(aud.rifa.arrecadado_centavos, 5000);
  assert.equal(aud.rifa.taxa_centavos, 500);
  assert.equal(aud.rifa.repasse_centavos, 4500);

  // Só o ganhador confirma o prêmio; aí o repasse é liberado e a plataforma paga.
  pedidoA = (await anon('GET', `/api/pedidos/${a.dados.token}`)).dados;
  const pedidoB = (await anon('GET', `/api/pedidos/${b.dados.token}`)).dados;
  const ganhador = pedidoA.ganhou ? pedidoA : pedidoB;
  const perdedor = pedidoA.ganhou ? pedidoB : pedidoA;
  assert.ok(ganhador.ganhou && !perdedor.ganhou);
  assert.equal((await anon('POST', `/api/pedidos/${perdedor.token}/premio-recebido`)).status, 403);
  assert.equal((await admin('POST', `/api/admin/rifas/${slug}/repasse-pago`)).status, 409);
  assert.equal((await anon('POST', `/api/pedidos/${ganhador.token}/premio-recebido`)).status, 200);
  assert.equal((await org('POST', `/api/admin/rifas/${slug}/repasse-pago`)).status, 403);
  assert.equal((await admin('POST', `/api/admin/rifas/${slug}/repasse-pago`)).status, 200);
  const painel = (await org('GET', '/api/painel')).dados;
  assert.equal(painel[0].repasse_status, 'pago');
  assert.equal(painel[0].ganhador.email, ganhador.ganhou ? (pedidoA.ganhou ? 'p1@teste.com' : 'p2@teste.com') : '');

  // Depois do sorteio não dá mais para comprar nem devolver.
  assert.equal((await anon('POST', `/api/rifas/${slug}/pedidos`, { ...comprador(4), quantidade: 1 })).status, 409);
  assert.equal((await anon('POST', `/api/pedidos/${a.dados.token}/estorno`)).status, 409);

  // "Meus números" acha os pedidos pelo telefone + e-mail.
  const meus = (await anon('POST', '/api/meus-numeros', { telefone: '(11) 99999-0001', email: 'P1@teste.com' })).dados;
  assert.equal(meus.length, 1);
  assert.deepEqual(meus[0].numeros, [1, 2, 3, 4]);
});

test('rifa que não bate o mínimo: cancela e devolve tudo sozinha', async () => {
  const org = cliente();
  const anon = cliente();
  await org('POST', '/api/entrar', { email: 'org@teste.com', senha: 'senha-forte-1' });
  const slug = await novaRifa(org, { prazo: Date.now() + 1500 });
  const p = await anon('POST', `/api/rifas/${slug}/pedidos`, { ...comprador(5), numeros: [7] });
  await anon('POST', `/api/pedidos/${p.dados.token}/simular-pagamento`);
  const pedido = await ate(async () => {
    const x = (await anon('GET', `/api/pedidos/${p.dados.token}`)).dados;
    return x.status === 'estornado' ? x : null;
  });
  assert.equal(pedido.rifa.status, 'cancelada');
  assert.match(pedido.motivo_estorno, /mínimo/);
});

test('rifa que bate o mínimo no prazo: sorteia entre os números pagos', async () => {
  const org = cliente();
  const anon = cliente();
  await org('POST', '/api/entrar', { email: 'org@teste.com', senha: 'senha-forte-1' });
  const slug = await novaRifa(org, { prazo: Date.now() + 1500, minimo_numeros: 2 });
  const p = await anon('POST', `/api/rifas/${slug}/pedidos`, { ...comprador(6), numeros: [3, 8] });
  await anon('POST', `/api/pedidos/${p.dados.token}/simular-pagamento`);
  const naoPago = await anon('POST', `/api/rifas/${slug}/pedidos`, { ...comprador(7), numeros: [5] });
  const rifa = await ate(async () => {
    const x = (await anon('GET', `/api/rifas/${slug}`)).dados;
    return x.status === 'sorteada' ? x : null;
  });
  assert.ok([3, 8].includes(rifa.numero_ganhador));
  assert.equal((await anon('GET', `/api/pedidos/${naoPago.dados.token}`)).dados.status, 'expirado');
});

test('organizador cancela: todo mundo recebe de volta', async () => {
  const org = cliente();
  const outro = cliente();
  const anon = cliente();
  await org('POST', '/api/entrar', { email: 'org@teste.com', senha: 'senha-forte-1' });
  await outro('POST', '/api/cadastro', { nome: 'Outra Pessoa', email: 'outro@teste.com', senha: 'senha-forte-3', chave_pix: '11999990000' });
  const slug = await novaRifa(org);
  const p = await anon('POST', `/api/rifas/${slug}/pedidos`, { ...comprador(8), numeros: [1] });
  await anon('POST', `/api/pedidos/${p.dados.token}/simular-pagamento`);
  assert.equal((await outro('POST', `/api/rifas/${slug}/cancelar`)).status, 403);
  assert.equal((await org('POST', `/api/rifas/${slug}/cancelar`)).status, 200);
  assert.equal((await anon('GET', `/api/pedidos/${p.dados.token}`)).dados.status, 'estornado');
});
