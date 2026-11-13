// Regras do negócio: rifas, pedidos, pagamentos, estornos, sorteio e repasse.
const crypto = require('node:crypto');
const { transacao } = require('./db');
const { sha256, hashDaLista, calcularGanhador } = require('./sorteio');

class Erro extends Error {
  constructor(mensagem, status = 400) {
    super(mensagem);
    this.status = status;
  }
}

const agora = () => Date.now();
const idAleatorio = (bytes) => crypto.randomBytes(bytes).toString('hex');
const DIA = 24 * 3600 * 1000;

function texto(v, min, max, campo) {
  const s = String(v ?? '').trim();
  if (s.length < min || s.length > max) throw new Erro(`${campo}: use de ${min} a ${max} letras.`);
  return s;
}
function inteiro(v, min, max, campo) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Erro(`${campo}: use um número de ${min} a ${max}.`);
  return n;
}
function emailValido(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 120) throw new Erro('E-mail inválido.');
  return s;
}
function telefoneValido(v) {
  const s = String(v ?? '').replace(/\D/g, '');
  if (s.length < 10 || s.length > 11) throw new Erro('Telefone inválido. Use DDD + número.');
  return s;
}
function mascararNome(nome) {
  const p = nome.trim().split(/\s+/);
  return p.length > 1 ? `${p[0]} ${p[p.length - 1][0].toUpperCase()}.` : p[0];
}
const mascararTelefone = (t) => `(••) •••••-${t.slice(-4)}`;

function hashSenha(senha, sal = idAleatorio(16)) {
  return `${sal}:${crypto.scryptSync(senha, sal, 32).toString('hex')}`;
}
function senhaConfere(senha, guardado) {
  const [sal, h] = guardado.split(':');
  const a = Buffer.from(h, 'hex');
  const b = crypto.scryptSync(senha, sal, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Divide o dinheiro arrecadado entre organizador e plataforma.
function dividir(arrecadadoCentavos, taxaPercentual) {
  const taxa = Math.round((arrecadadoCentavos * taxaPercentual) / 100);
  return { taxa, repasse: arrecadadoCentavos - taxa };
}

function criarNucleo({ db, provedor, drand, cfg }) {
  const q = (sql) => db.prepare(sql);

  // ---------- Registro público (cada linha amarra a anterior) ----------
  function registrar(rifaId, tipo, dados) {
    const ultimo = q('SELECT seq, hash FROM registro WHERE rifa_id = ? ORDER BY seq DESC LIMIT 1').get(rifaId);
    const seq = ultimo ? ultimo.seq + 1 : 1;
    const hashAnterior = ultimo ? ultimo.hash : '0'.repeat(64);
    const criadoEm = agora();
    const json = JSON.stringify(dados);
    const hash = sha256(`${hashAnterior}|${seq}|${tipo}|${criadoEm}|${json}`);
    q('INSERT INTO registro (rifa_id, seq, tipo, dados, criado_em, hash_anterior, hash) VALUES (?,?,?,?,?,?,?)')
      .run(rifaId, seq, tipo, json, criadoEm, hashAnterior, hash);
    return hash;
  }

  // ---------- Contas ----------
  function cadastrar({ nome, email, senha, chave_pix }) {
    nome = texto(nome, 3, 80, 'Nome');
    email = emailValido(email);
    senha = String(senha ?? '');
    if (senha.length < 8 || senha.length > 200) throw new Erro('A senha precisa ter pelo menos 8 caracteres.');
    chave_pix = texto(chave_pix, 5, 140, 'Chave Pix');
    if (q('SELECT 1 FROM usuarios WHERE email = ?').get(email)) throw new Erro('Já existe uma conta com esse e-mail.', 409);
    const papel = cfg.adminEmail && email === cfg.adminEmail ? 'admin' : 'organizador';
    q('INSERT INTO usuarios (nome, email, senha_hash, chave_pix, papel, criado_em) VALUES (?,?,?,?,?,?)')
      .run(nome, email, hashSenha(senha), chave_pix, papel, agora());
    return entrar({ email, senha });
  }

  function entrar({ email, senha }) {
    const u = q('SELECT * FROM usuarios WHERE email = ?').get(String(email ?? '').trim().toLowerCase());
    if (!u || !senhaConfere(String(senha ?? ''), u.senha_hash)) throw new Erro('E-mail ou senha incorretos.', 401);
    const token = idAleatorio(32);
    q('INSERT INTO sessoes (token, usuario_id, expira_em) VALUES (?,?,?)').run(token, u.id, agora() + 30 * DIA);
    return { token, usuario: usuarioPublico(u) };
  }

  const usuarioPublico = (u) => ({ id: u.id, nome: u.nome, email: u.email, chave_pix: u.chave_pix, papel: u.papel });

  function usuarioDaSessao(token) {
    if (!token) return null;
    const u = q(`SELECT u.* FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
                 WHERE s.token = ? AND s.expira_em > ?`).get(token, agora());
    return u ? usuarioPublico(u) : null;
  }

  function sair(token) {
    if (token) q('DELETE FROM sessoes WHERE token = ?').run(token);
  }

  // ---------- Rifas ----------
  function criarRifa(usuario, d) {
    const titulo = texto(d.titulo, 3, 80, 'Título');
    const premio = texto(d.premio, 3, 120, 'Prêmio');
    const descricao = texto(d.descricao ?? '', 0, 2000, 'Descrição');
    const autorizacao = texto(d.autorizacao ?? '', 0, 120, 'Autorização');
    let imagem = String(d.imagem_url ?? '').trim();
    if (imagem && (!/^https:\/\/[^\s"'<>]+$/.test(imagem) || imagem.length > 500)) {
      throw new Erro('Link da foto inválido. Use um endereço que comece com https://');
    }
    const preco = inteiro(d.preco_centavos, 100, 100000, 'Preço por número (em centavos)');
    const total = inteiro(d.total_numeros, 10, 10000, 'Quantidade de números');
    const minimo = inteiro(d.minimo_numeros, 1, total, 'Mínimo de números vendidos');
    const prazo = Number(d.prazo);
    if (!Number.isFinite(prazo) || prazo < agora() + cfg.prazoMinimoMs) throw new Erro('A data do sorteio precisa ser no futuro.');
    if (prazo > agora() + 180 * DIA) throw new Erro('A data do sorteio pode ser no máximo daqui a 180 dias.');

    const id = idAleatorio(8);
    const base = titulo.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'rifa';
    const slug = `${base}-${idAleatorio(2)}`;

    transacao(db, () => {
      q(`INSERT INTO rifas (id, slug, organizador_id, titulo, descricao, premio, imagem_url, autorizacao,
           preco_centavos, total_numeros, minimo_numeros, prazo, taxa_percentual, criada_em)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, slug, usuario.id, titulo, descricao, premio, imagem, autorizacao,
          preco, total, minimo, prazo, cfg.taxaPercentual, agora());
      registrar(id, 'rifa_criada', {
        titulo, premio, preco_centavos: preco, total_numeros: total, minimo_numeros: minimo,
        prazo, taxa_percentual: cfg.taxaPercentual, organizador: usuario.nome,
      });
    });
    return { slug };
  }

  function rifaPorSlug(slug) {
    const r = q('SELECT * FROM rifas WHERE slug = ?').get(String(slug));
    if (!r) throw new Erro('Rifa não encontrada.', 404);
    return r;
  }

  const contarPagos = (rifaId) => q(`SELECT COUNT(*) c FROM numeros n JOIN pedidos p ON p.id = n.pedido_id
                                     WHERE n.rifa_id = ? AND p.status = 'pago'`).get(rifaId).c;

  function resumoRifa(r) {
    const org = q('SELECT nome FROM usuarios WHERE id = ?').get(r.organizador_id);
    return {
      slug: r.slug, titulo: r.titulo, descricao: r.descricao, premio: r.premio, imagem_url: r.imagem_url,
      autorizacao: r.autorizacao, preco_centavos: r.preco_centavos, total_numeros: r.total_numeros,
      minimo_numeros: r.minimo_numeros, prazo: r.prazo, status: r.status,
      motivo_cancelamento: r.motivo_cancelamento, organizador: org.nome,
      pagos: contarPagos(r.id), numero_ganhador: r.numero_ganhador, sorteada_em: r.sorteada_em,
      encerrada_em: r.encerrada_em, criada_em: r.criada_em,
    };
  }

  function listarRifas() {
    const linhas = q(`SELECT * FROM rifas WHERE status IN ('aberta','encerrada','sorteada')
                      ORDER BY CASE status WHEN 'aberta' THEN 0 WHEN 'encerrada' THEN 1 ELSE 2 END, criada_em DESC
                      LIMIT 60`).all();
    return linhas.map(resumoRifa);
  }

  function liberarReservasVencidas() {
    const vencidos = q("SELECT id FROM pedidos WHERE status = 'reservado' AND expira_em < ?").all(agora());
    for (const p of vencidos) {
      transacao(db, () => {
        q('DELETE FROM numeros WHERE pedido_id = ?').run(p.id);
        q("UPDATE pedidos SET status = 'expirado' WHERE id = ? AND status = 'reservado'").run(p.id);
      });
    }
  }

  function rifaPublica(slug) {
    const r = rifaPorSlug(slug);
    const ocupados = q(`SELECT n.numero, p.status FROM numeros n JOIN pedidos p ON p.id = n.pedido_id
                        WHERE n.rifa_id = ? ORDER BY n.numero`).all(r.id);
    return {
      ...resumoRifa(r),
      numeros_pagos: ocupados.filter((o) => o.status === 'pago').map((o) => o.numero),
      numeros_reservados: ocupados.filter((o) => o.status !== 'pago').map((o) => o.numero),
    };
  }

  // ---------- Pedidos ----------
  async function criarPedido(slug, d) {
    const nome = texto(d.nome, 3, 80, 'Nome');
    const telefone = telefoneValido(d.telefone);
    const email = emailValido(d.email);
    const r = rifaPorSlug(slug);
    liberarReservasVencidas();

    const pedido = transacao(db, () => {
      const rifa = q('SELECT * FROM rifas WHERE id = ?').get(r.id);
      if (rifa.status !== 'aberta' || rifa.prazo <= agora()) throw new Erro('Esta rifa não está mais vendendo números.', 409);

      const ocupados = new Set(q('SELECT numero FROM numeros WHERE rifa_id = ?').all(rifa.id).map((x) => x.numero));
      let numeros;
      if (Array.isArray(d.numeros) && d.numeros.length) {
        numeros = [...new Set(d.numeros.map(Number))];
        if (numeros.length > 500) throw new Erro('Escolha no máximo 500 números por compra.');
        for (const n of numeros) {
          if (!Number.isInteger(n) || n < 1 || n > rifa.total_numeros) throw new Erro('Número inválido.');
          if (ocupados.has(n)) throw new Erro(`O número ${n} acabou de ser pego por outra pessoa. Escolha outro.`, 409);
        }
      } else {
        const quantidade = inteiro(d.quantidade, 1, 500, 'Quantidade');
        const livres = [];
        for (let n = 1; n <= rifa.total_numeros; n++) if (!ocupados.has(n)) livres.push(n);
        if (livres.length < quantidade) throw new Erro(`Só restam ${livres.length} números livres.`, 409);
        numeros = [];
        for (let i = 0; i < quantidade; i++) {
          const j = crypto.randomInt(livres.length);
          numeros.push(livres[j]);
          livres[j] = livres[livres.length - 1];
          livres.pop();
        }
      }
      numeros.sort((a, b) => a - b);

      const p = {
        id: idAleatorio(5), token: idAleatorio(24), rifa_id: rifa.id, nome, telefone, email, numeros,
        valor_centavos: numeros.length * rifa.preco_centavos,
        expira_em: Math.min(agora() + cfg.reservaMinutos * 60000, Math.max(rifa.prazo, agora() + 60000)),
      };
      q(`INSERT INTO pedidos (id, token, rifa_id, nome, telefone, email, numeros, valor_centavos, expira_em, criado_em)
         VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(p.id, p.token, p.rifa_id, nome, telefone, email, JSON.stringify(numeros), p.valor_centavos, p.expira_em, agora());
      const inserir = q('INSERT INTO numeros (rifa_id, numero, pedido_id) VALUES (?,?,?)');
      for (const n of numeros) inserir.run(rifa.id, n, p.id);
      return p;
    });

    try {
      const pix = await provedor.criar(pedido, `Rifa: ${r.titulo} (${pedido.numeros.length} número(s))`);
      q('UPDATE pedidos SET pagamento_id = ?, pix_copia_cola = ?, pix_qr_base64 = ? WHERE id = ?')
        .run(pix.id, pix.copiaCola, pix.qrBase64, pedido.id);
    } catch (e) {
      transacao(db, () => {
        q('DELETE FROM numeros WHERE pedido_id = ?').run(pedido.id);
        q("UPDATE pedidos SET status = 'expirado' WHERE id = ?").run(pedido.id);
      });
      console.error('Erro ao gerar Pix:', e.message);
      throw new Erro('Não conseguimos gerar o Pix agora. Seus números foram liberados. Tente de novo em instantes.', 502);
    }
    return { token: pedido.token };
  }

  // Confere com o banco se o Pix caiu. Se caiu, os números passam a ser do comprador.
  async function confirmarPagamento(pedidoId) {
    const antes = q('SELECT * FROM pedidos WHERE id = ?').get(pedidoId);
    if (!antes || !antes.pagamento_id || !['reservado', 'expirado'].includes(antes.status)) return;
    const s = await provedor.situacao(antes.pagamento_id);
    if (s.status !== 'pago') return;
    if (s.valor_centavos !== undefined && s.valor_centavos !== antes.valor_centavos) {
      console.error(`Pedido ${antes.id}: valor pago (${s.valor_centavos}) diferente do pedido (${antes.valor_centavos}).`);
      return;
    }

    const rifaId = transacao(db, () => {
      const p = q('SELECT * FROM pedidos WHERE id = ?').get(pedidoId);
      if (!['reservado', 'expirado'].includes(p.status)) return null;
      const rifa = q('SELECT * FROM rifas WHERE id = ?').get(p.rifa_id);
      const numeros = JSON.parse(p.numeros);
      let aceitar = rifa.status === 'aberta';
      if (aceitar && p.status === 'expirado') {
        // A reserva tinha vencido: só vale se todos os números ainda estiverem livres.
        const ocupados = new Set(q('SELECT numero FROM numeros WHERE rifa_id = ?').all(rifa.id).map((x) => x.numero));
        aceitar = numeros.every((n) => !ocupados.has(n));
        if (aceitar) {
          const inserir = q('INSERT INTO numeros (rifa_id, numero, pedido_id) VALUES (?,?,?)');
          for (const n of numeros) inserir.run(rifa.id, n, p.id);
        }
      }
      if (aceitar) {
        q("UPDATE pedidos SET status = 'pago', pago_em = ? WHERE id = ?").run(agora(), p.id);
        registrar(rifa.id, 'pagamento', {
          pedido: p.id, numeros, valor_centavos: p.valor_centavos, comprador: mascararNome(p.nome),
        });
      } else {
        q("UPDATE pedidos SET pago_em = ? WHERE id = ?").run(agora(), p.id);
        iniciarEstorno(p, 'O pagamento chegou depois que a reserva venceu. Devolvemos o valor inteiro.');
      }
      return rifa.id;
    });
    if (rifaId) {
      await verificarRifa(rifaId);
      await processarEstornos();
    }
  }

  function pedidoPorToken(token) {
    const p = q('SELECT * FROM pedidos WHERE token = ?').get(String(token));
    if (!p) throw new Erro('Pedido não encontrado.', 404);
    return p;
  }

  async function verPedido(token) {
    let p = pedidoPorToken(token);
    if (p.status === 'reservado') {
      try { await confirmarPagamento(p.id); } catch (e) { console.error('Consulta de pagamento falhou:', e.message); }
      p = pedidoPorToken(token);
    }
    const r = q('SELECT * FROM rifas WHERE id = ?').get(p.rifa_id);
    const ganhou = r.status === 'sorteada' && r.pedido_ganhador === p.id;
    return {
      id: p.id, token: p.token, nome: p.nome, numeros: JSON.parse(p.numeros), valor_centavos: p.valor_centavos,
      status: p.status, pix_copia_cola: p.status === 'reservado' ? p.pix_copia_cola : null,
      pix_qr_base64: p.status === 'reservado' ? p.pix_qr_base64 : null,
      expira_em: p.expira_em, pago_em: p.pago_em, estornado_em: p.estornado_em, motivo_estorno: p.motivo_estorno,
      criado_em: p.criado_em, pode_estornar: podeEstornar(p, r), ganhou,
      premio_confirmado: ganhou && !!r.premio_confirmado_em,
      rifa: resumoRifa(r),
    };
  }

  function meusNumeros({ telefone, email }) {
    const linhas = q(`SELECT p.token FROM pedidos p WHERE p.telefone = ? AND p.email = ?
                      AND p.status != 'expirado' ORDER BY p.criado_em DESC LIMIT 100`)
      .all(telefoneValido(telefone), emailValido(email));
    return linhas.map((l) => {
      const p = pedidoPorToken(l.token);
      const r = q('SELECT * FROM rifas WHERE id = ?').get(p.rifa_id);
      return {
        token: p.token, numeros: JSON.parse(p.numeros), valor_centavos: p.valor_centavos, status: p.status,
        rifa_titulo: r.titulo, rifa_slug: r.slug, rifa_status: r.status,
        ganhou: r.status === 'sorteada' && r.pedido_ganhador === p.id,
      };
    });
  }

  // ---------- Estornos ----------
  // Desistência: até 7 dias depois do pagamento, enquanto a rifa estiver vendendo.
  const podeEstornar = (p, r) => p.status === 'pago' && r.status === 'aberta' && agora() - p.pago_em <= 7 * DIA;

  // Precisa ser chamado dentro de uma transação.
  function iniciarEstorno(p, motivo) {
    q('DELETE FROM numeros WHERE pedido_id = ?').run(p.id);
    q("UPDATE pedidos SET status = 'estornando', motivo_estorno = ? WHERE id = ?").run(motivo, p.id);
    registrar(p.rifa_id, 'estorno', {
      pedido: p.id, numeros: JSON.parse(p.numeros), valor_centavos: p.valor_centavos, motivo,
    });
  }

  async function pedirEstorno(token) {
    transacao(db, () => {
      const p = pedidoPorToken(token);
      const r = q('SELECT * FROM rifas WHERE id = ?').get(p.rifa_id);
      if (!podeEstornar(p, r)) {
        throw new Erro('Este pedido não pode mais ser devolvido. A devolução vale até 7 dias depois do pagamento e só antes de a rifa encerrar.', 409);
      }
      iniciarEstorno(p, 'O comprador desistiu da compra.');
    });
    await processarEstornos();
  }

  async function processarEstornos() {
    const pendentes = q("SELECT * FROM pedidos WHERE status = 'estornando' LIMIT 200").all();
    for (const p of pendentes) {
      try {
        await provedor.estornar(p.pagamento_id);
        transacao(db, () => {
          const feito = q("UPDATE pedidos SET status = 'estornado', estornado_em = ? WHERE id = ? AND status = 'estornando'")
            .run(agora(), p.id);
          if (feito.changes) registrar(p.rifa_id, 'estorno_concluido', { pedido: p.id, valor_centavos: p.valor_centavos });
        });
      } catch (e) {
        console.error(`Estorno do pedido ${p.id} falhou (vamos tentar de novo):`, e.message);
      }
    }
  }

  async function cancelarRifa(rifa, motivo) {
    transacao(db, () => {
      const r = q('SELECT * FROM rifas WHERE id = ?').get(rifa.id);
      if (r.status !== 'aberta') throw new Erro('Só dá para cancelar uma rifa que ainda está vendendo.', 409);
      q("UPDATE rifas SET status = 'cancelada', motivo_cancelamento = ? WHERE id = ?").run(motivo, r.id);
      const pagos = q("SELECT * FROM pedidos WHERE rifa_id = ? AND status = 'pago'").all(r.id);
      registrar(r.id, 'rifa_cancelada', { motivo, pedidos_devolvidos: pagos.length });
      for (const p of pagos) iniciarEstorno(p, `Rifa cancelada: ${motivo}`);
      // Reservas ainda não pagas: os números são liberados. Se o Pix cair depois, é devolvido.
      q("DELETE FROM numeros WHERE rifa_id = ?").run(r.id);
      q("UPDATE pedidos SET status = 'expirado' WHERE rifa_id = ? AND status = 'reservado'").run(r.id);
    });
    await processarEstornos();
  }

  // ---------- Encerramento e sorteio ----------
  async function verificarRifa(rifaId) {
    const r = q('SELECT * FROM rifas WHERE id = ?').get(rifaId);
    if (r.status === 'aberta') {
      const pagos = contarPagos(r.id);
      if (pagos >= r.total_numeros) return encerrar(r);
      if (agora() >= r.prazo) {
        if (pagos >= r.minimo_numeros) return encerrar(r);
        return cancelarRifa(r, 'Não atingiu o mínimo de números vendidos até a data combinada.');
      }
    } else if (r.status === 'encerrada') {
      return sortear(r);
    }
  }

  async function encerrar(r) {
    // A rodada escolhida ainda não existe: ninguém sabe o número que vai sair.
    const rodada = await drand.rodadaNoInstante(agora() + cfg.atrasoSorteioSeg * 1000) + 1;
    transacao(db, () => {
      const atual = q('SELECT status FROM rifas WHERE id = ?').get(r.id);
      if (atual.status !== 'aberta') return;
      q(`DELETE FROM numeros WHERE rifa_id = ? AND pedido_id IN
           (SELECT id FROM pedidos WHERE rifa_id = ? AND status = 'reservado')`).run(r.id, r.id);
      q("UPDATE pedidos SET status = 'expirado' WHERE rifa_id = ? AND status = 'reservado'").run(r.id);
      const pagos = q('SELECT numero FROM numeros WHERE rifa_id = ? ORDER BY numero').all(r.id).map((x) => x.numero);
      const hash = hashDaLista(pagos);
      q("UPDATE rifas SET status = 'encerrada', encerrada_em = ?, hash_lista = ?, rodada_drand = ? WHERE id = ?")
        .run(agora(), hash, rodada, r.id);
      registrar(r.id, 'encerramento', {
        numeros_pagos: pagos, total_pagos: pagos.length, hash_lista: hash, rodada_drand: rodada, rede_drand: drand.url,
        regra: 'ganhador = lista[ SHA256(aleatorio + ":" + id_da_rifa) mod total_pagos ]', id_da_rifa: r.id,
      });
    });
  }

  async function sortear(r) {
    if (agora() < await drand.instanteDaRodada(r.rodada_drand)) return;
    const { aleatorio, assinatura } = await drand.buscar(r.rodada_drand);
    transacao(db, () => {
      const atual = q('SELECT status FROM rifas WHERE id = ?').get(r.id);
      if (atual.status !== 'encerrada') return;
      const pagos = q('SELECT numero FROM numeros WHERE rifa_id = ? ORDER BY numero').all(r.id).map((x) => x.numero);
      if (hashDaLista(pagos) !== r.hash_lista) throw new Error(`Rifa ${r.id}: lista de números mudou depois do encerramento!`);
      const g = calcularGanhador(aleatorio, r.id, pagos);
      const dono = q('SELECT pedido_id FROM numeros WHERE rifa_id = ? AND numero = ?').get(r.id, g.numero);
      const p = q('SELECT * FROM pedidos WHERE id = ?').get(dono.pedido_id);
      const arrecadado = q("SELECT COALESCE(SUM(valor_centavos),0) t FROM pedidos WHERE rifa_id = ? AND status = 'pago'").get(r.id).t;
      const { taxa, repasse } = dividir(arrecadado, r.taxa_percentual);
      q(`UPDATE rifas SET status = 'sorteada', sorteada_em = ?, aleatorio_drand = ?, assinatura_drand = ?,
           numero_ganhador = ?, pedido_ganhador = ?, arrecadado_centavos = ?, taxa_centavos = ?, repasse_centavos = ?
         WHERE id = ?`).run(agora(), aleatorio, assinatura, g.numero, p.id, arrecadado, taxa, repasse, r.id);
      registrar(r.id, 'sorteio', {
        rodada_drand: r.rodada_drand, aleatorio, semente: g.semente, posicao_na_lista: g.posicao,
        numero_ganhador: g.numero, pedido: p.id, ganhador: mascararNome(p.nome),
        arrecadado_centavos: arrecadado, taxa_plataforma_centavos: taxa, repasse_organizador_centavos: repasse,
      });
    });
  }

  // ---------- Prêmio e repasse ----------
  function confirmarPremio(token) {
    transacao(db, () => {
      const p = pedidoPorToken(token);
      const r = q('SELECT * FROM rifas WHERE id = ?').get(p.rifa_id);
      if (r.status !== 'sorteada' || r.pedido_ganhador !== p.id) throw new Erro('Só o ganhador pode confirmar o prêmio.', 403);
      if (r.premio_confirmado_em) return;
      q("UPDATE rifas SET premio_confirmado_em = ?, repasse_status = 'liberado' WHERE id = ?").run(agora(), r.id);
      registrar(r.id, 'premio_recebido', { pedido: p.id, confirmado_por: 'ganhador' });
    });
  }

  function liberarRepasse(slug) {
    transacao(db, () => {
      const r = rifaPorSlug(slug);
      if (r.status !== 'sorteada' || r.repasse_status !== 'aguardando') throw new Erro('Este repasse não está aguardando liberação.', 409);
      q("UPDATE rifas SET repasse_status = 'liberado' WHERE id = ?").run(r.id);
      registrar(r.id, 'repasse_liberado', { confirmado_por: 'plataforma' });
    });
  }

  function marcarRepassePago(slug) {
    transacao(db, () => {
      const r = rifaPorSlug(slug);
      if (r.status !== 'sorteada' || r.repasse_status !== 'liberado') throw new Erro('Este repasse ainda não foi liberado.', 409);
      q("UPDATE rifas SET repasse_status = 'pago', repasse_pago_em = ? WHERE id = ?").run(agora(), r.id);
      registrar(r.id, 'repasse_pago', { repasse_organizador_centavos: r.repasse_centavos });
    });
  }

  function painelLinha(r, comContatoOrganizador) {
    const base = resumoRifa(r);
    const arrecadado = r.arrecadado_centavos ??
      q("SELECT COALESCE(SUM(valor_centavos),0) t FROM pedidos WHERE rifa_id = ? AND status = 'pago'").get(r.id).t;
    const { taxa, repasse } = dividir(arrecadado, r.taxa_percentual);
    const linha = {
      ...base, taxa_percentual: r.taxa_percentual, arrecadado_centavos: arrecadado, taxa_centavos: taxa,
      repasse_centavos: repasse, repasse_status: r.repasse_status, premio_confirmado: !!r.premio_confirmado_em,
    };
    if (r.pedido_ganhador) {
      const p = q('SELECT nome, telefone, email FROM pedidos WHERE id = ?').get(r.pedido_ganhador);
      linha.ganhador = { nome: p.nome, telefone: p.telefone, email: p.email };
    }
    if (comContatoOrganizador) {
      const u = q('SELECT nome, email, chave_pix FROM usuarios WHERE id = ?').get(r.organizador_id);
      linha.organizador_contato = u;
    }
    return linha;
  }

  const painel = (usuario) => q('SELECT * FROM rifas WHERE organizador_id = ? ORDER BY criada_em DESC').all(usuario.id)
    .map((r) => painelLinha(r, false));

  const painelAdmin = () => q('SELECT * FROM rifas ORDER BY criada_em DESC LIMIT 300').all().map((r) => painelLinha(r, true));

  // ---------- Auditoria pública ----------
  function auditoria(slug) {
    const r = rifaPorSlug(slug);
    const linhas = q('SELECT seq, tipo, dados, criado_em, hash_anterior, hash FROM registro WHERE rifa_id = ? ORDER BY seq').all(r.id);
    const compradores = q(`SELECT n.numero, p.nome, p.telefone FROM numeros n JOIN pedidos p ON p.id = n.pedido_id
                           WHERE n.rifa_id = ? AND p.status = 'pago' ORDER BY n.numero`).all(r.id);
    return {
      rifa: { ...resumoRifa(r), id: r.id, hash_lista: r.hash_lista, rodada_drand: r.rodada_drand,
        aleatorio_drand: r.aleatorio_drand, assinatura_drand: r.assinatura_drand, rede_drand: drand.url,
        arrecadado_centavos: r.arrecadado_centavos, taxa_centavos: r.taxa_centavos, repasse_centavos: r.repasse_centavos,
        taxa_percentual: r.taxa_percentual, repasse_status: r.repasse_status },
      registro: linhas.map((l) => ({ ...l })),
      compradores: compradores.map((c) => ({ numero: c.numero, nome: mascararNome(c.nome), telefone: mascararTelefone(c.telefone) })),
    };
  }

  // ---------- Rotina automática ----------
  let rodando = false;
  async function rotina() {
    if (rodando) return;
    rodando = true;
    try {
      // 1. Pix que caiu e ainda não foi visto (inclui reservas que venceram há pouco).
      const pendentes = q(`SELECT id FROM pedidos WHERE pagamento_id IS NOT NULL AND
                             (status = 'reservado' OR (status = 'expirado' AND expira_em > ?))
                           ORDER BY criado_em LIMIT 200`).all(agora() - 2 * 3600 * 1000);
      for (const p of pendentes) {
        try { await confirmarPagamento(p.id); } catch (e) { console.error('Consulta de pagamento falhou:', e.message); }
      }
      // 2. Reservas vencidas voltam a ficar livres.
      liberarReservasVencidas();
      // 3. Rifas que precisam encerrar, cancelar ou sortear.
      const rifas = q("SELECT id FROM rifas WHERE status IN ('aberta','encerrada')").all();
      for (const r of rifas) {
        try { await verificarRifa(r.id); } catch (e) { console.error(`Rifa ${r.id}:`, e.message); }
      }
      // 4. Devoluções pendentes.
      await processarEstornos();
      q('DELETE FROM sessoes WHERE expira_em < ?').run(agora());
    } finally {
      rodando = false;
    }
  }

  return {
    cadastrar, entrar, sair, usuarioDaSessao, criarRifa, listarRifas, rifaPublica, rifaPorSlug, criarPedido,
    confirmarPagamento, verPedido, pedidoPorToken, meusNumeros, pedirEstorno, cancelarRifa, confirmarPremio,
    liberarRepasse, marcarRepassePago, painel, painelAdmin, auditoria, rotina,
  };
}

module.exports = { criarNucleo, Erro, dividir };
