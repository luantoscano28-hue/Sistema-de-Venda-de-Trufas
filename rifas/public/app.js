// Telas da plataforma. JavaScript puro, sem bibliotecas.
(() => {
  const app = document.getElementById('app');
  let config = { nome: 'Rifa Clara', taxa_percentual: 10, pagamento: 'simulado', reserva_minutos: 30 };
  let eu = null;
  let temporizadores = [];

  // ---------- Utilidades ----------
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reais = (centavos) => (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const data = (ms) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const dataHoraExata = (ms) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const num = (n, total) => String(n).padStart(String(total).length, '0');
  const porcento = (v) => String(v).replace('.', ',') + '%';

  async function api(metodo, caminho, corpo) {
    let r;
    try {
      r = await fetch(caminho, {
        method: metodo,
        headers: { 'Content-Type': 'application/json' },
        body: metodo === 'POST' ? JSON.stringify(corpo || {}) : undefined,
      });
    } catch {
      throw new Error('Sem conexão. Confira sua internet e tente de novo.');
    }
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(dados.erro || 'Algo deu errado. Tente de novo.'), { status: r.status });
    return dados;
  }

  async function sha256(texto) {
    const bytes = typeof texto === 'string' ? new TextEncoder().encode(texto) : texto;
    const h = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const hexParaBytes = (hex) => new Uint8Array(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));

  function repetir(fn, ms) {
    temporizadores.push(setInterval(fn, ms));
  }

  const ETIQUETAS = {
    aberta: ['Vendendo', ''], encerrada: ['Sorteando', 'amarela'], sorteada: ['Sorteada', 'cinza'], cancelada: ['Cancelada', 'vermelha'],
  };
  const etiqueta = (status) => `<span class="etiqueta ${ETIQUETAS[status][1]}">${ETIQUETAS[status][0]}</span>`;

  const foto = (r, classe) => r.imagem_url
    ? `<img class="${classe}" src="${esc(r.imagem_url)}" alt="Foto do prêmio: ${esc(r.premio)}" loading="lazy" referrerpolicy="no-referrer">`
    : '';

  function progresso(r) {
    const pct = Math.round((r.pagos / r.total_numeros) * 100);
    return `<div class="barra" role="img" aria-label="${pct}% vendido"><i style="width:${pct}%"></i></div>
      <p class="pequeno suave">${r.pagos} de ${r.total_numeros} números vendidos (${pct}%)</p>`;
  }

  function formulario(el, aoEnviar) {
    el.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const botao = el.querySelector('button[type=submit]');
      const erro = el.querySelector('.erro');
      if (erro) erro.textContent = '';
      botao.disabled = true;
      try {
        await aoEnviar(Object.fromEntries(new FormData(el)));
      } catch (e) {
        if (erro) erro.textContent = e.message;
      } finally {
        botao.disabled = false;
      }
    });
  }

  // ---------- Início ----------
  async function telaInicio() {
    const rifas = await api('GET', '/api/rifas');
    const abertas = rifas.filter((r) => r.status === 'aberta');
    const outras = rifas.filter((r) => r.status !== 'aberta');
    const cartao = (r) => `
      <a class="rifa-item" href="#/r/${esc(r.slug)}">
        <div class="foto">${r.imagem_url ? foto(r, 'foto-cartao') : '🎁'}</div>
        <div class="corpo">
          ${etiqueta(r.status)}
          <h3>${esc(r.titulo)}</h3>
          <p class="pequeno suave">Prêmio: ${esc(r.premio)}</p>
          ${r.status === 'sorteada'
            ? `<p class="pequeno"><b>Número sorteado: ${num(r.numero_ganhador, r.total_numeros)}</b></p>`
            : `<p class="pequeno"><b>${reais(r.preco_centavos)}</b> por número</p>${progresso(r)}`}
        </div>
      </a>`;
    app.innerHTML = `
      <section class="heroi">
        <h1>Rifas online que você pode conferir.</h1>
        <p>Escolha seus números, pague com Pix e acompanhe tudo. O sorteio é público: qualquer pessoa confere o resultado.</p>
      </section>
      <div class="passos">
        <div><b>1. Escolha</b><span>Pegue os números que quiser.</span></div>
        <div><b>2. Pague com Pix</b><span>Caiu o Pix, o número é seu na hora.</span></div>
        <div><b>3. Acompanhe</b><span>Veja o sorteio e confira a conta.</span></div>
      </div>
      <h2>Rifas abertas</h2>
      ${abertas.length ? `<div class="lista-rifas">${abertas.map(cartao).join('')}</div>`
        : '<div class="cartao"><p>Nenhuma rifa aberta agora. <a href="#/painel">Que tal criar a primeira?</a></p></div>'}
      ${outras.length ? `<h2 style="margin-top:28px">Já encerradas</h2><div class="lista-rifas">${outras.map(cartao).join('')}</div>` : ''}`;
  }

  // ---------- Página da rifa ----------
  async function telaRifa(slug) {
    let r = await api('GET', `/api/rifas/${slug}`);
    const escolhidos = new Set();
    let pagina = 0;
    const POR_PAGINA = 300;

    function regras() {
      return `<div class="cartao destaque">
        <h2>Regras desta rifa</h2>
        <p>🎁 <b>Prêmio:</b> ${esc(r.premio)}</p>
        <p>📅 <b>Sorteio:</b> ${data(r.prazo)} — ou antes, se todos os números forem vendidos.</p>
        <p>✅ <b>Para valer:</b> precisa vender pelo menos ${r.minimo_numeros} de ${r.total_numeros} números até essa data.</p>
        <p>💸 <b>Se não vender o mínimo:</b> a rifa é cancelada e todo mundo recebe o dinheiro de volta no Pix, sem pedir.</p>
        <p>↩️ <b>Desistiu?</b> Você pode pedir o dinheiro de volta em até 7 dias depois de pagar, enquanto a rifa estiver vendendo.</p>
        <p>🔎 <b>Sorteio:</b> feito por computador, com um número público que ninguém controla. <a href="#/conferir/${esc(r.slug)}">Veja e confira tudo aqui.</a></p>
        ${r.autorizacao ? `<p>📄 <b>Autorização:</b> ${esc(r.autorizacao)}</p>` : ''}
        <p class="pequeno suave">Organizada por ${esc(r.organizador)}.</p>
      </div>`;
    }

    function situacao() {
      if (r.status === 'sorteada') {
        return `<div class="cartao alerta centro">
          <p>Número sorteado</p><p class="grande">${num(r.numero_ganhador, r.total_numeros)}</p>
          <p>Sorteio feito em ${data(r.sorteada_em)}.</p>
          <a class="botao" href="#/conferir/${esc(r.slug)}">Conferir o sorteio</a>
        </div>`;
      }
      if (r.status === 'encerrada') {
        return `<div class="cartao alerta centro"><h2>Vendas encerradas. Sorteio em andamento…</h2>
          <p>A lista de números já foi fechada e publicada. O resultado aparece aqui em instantes.</p>
          <a class="botao secundario" href="#/conferir/${esc(r.slug)}">Acompanhar o sorteio</a></div>`;
      }
      if (r.status === 'cancelada') {
        return `<div class="cartao perigo"><h2>Rifa cancelada</h2><p>${esc(r.motivo_cancelamento)}</p>
          <p>Quem pagou recebe o valor inteiro de volta no Pix, automaticamente.</p></div>`;
      }
      return '';
    }

    function grade() {
      const pagos = new Set(r.numeros_pagos);
      const reservados = new Set(r.numeros_reservados);
      const paginas = Math.ceil(r.total_numeros / POR_PAGINA);
      const ini = pagina * POR_PAGINA + 1;
      const fim = Math.min(r.total_numeros, ini + POR_PAGINA - 1);
      let botoes = '';
      for (let n = ini; n <= fim; n++) {
        const rotulo = num(n, r.total_numeros);
        if (r.status === 'sorteada' && n === r.numero_ganhador) botoes += `<button class="ganhador" disabled aria-label="${rotulo}, número sorteado">${rotulo}</button>`;
        else if (pagos.has(n)) botoes += `<button class="pago" disabled aria-label="${rotulo}, vendido">${rotulo}</button>`;
        else if (reservados.has(n)) botoes += `<button class="reservado" disabled aria-label="${rotulo}, reservado">${rotulo}</button>`;
        else botoes += `<button data-n="${n}" class="${escolhidos.has(n) ? 'sel' : ''}" aria-pressed="${escolhidos.has(n)}" ${r.status !== 'aberta' ? 'disabled' : ''}>${rotulo}</button>`;
      }
      let seletor = '';
      if (paginas > 1) {
        seletor = '<div class="paginas">';
        for (let p = 0; p < paginas; p++) {
          seletor += `<button data-pagina="${p}" class="${p === pagina ? 'ativa' : ''}">${p * POR_PAGINA + 1}–${Math.min(r.total_numeros, (p + 1) * POR_PAGINA)}</button>`;
        }
        seletor += '</div>';
      }
      return `${seletor}<div class="grade">${botoes}</div>`;
    }

    function carrinho() {
      const antigo = document.querySelector('.carrinho');
      if (antigo) antigo.remove();
      if (!escolhidos.size || r.status !== 'aberta') return;
      const el = document.createElement('div');
      el.className = 'carrinho';
      el.innerHTML = `<div><span>${escolhidos.size} número(s)<br><b>${reais(escolhidos.size * r.preco_centavos)}</b></span>
        <button id="continuar">Continuar</button></div>`;
      document.body.appendChild(el);
      el.querySelector('#continuar').onclick = () => document.getElementById('dados').scrollIntoView({ behavior: 'smooth' });
    }

    function resumoCompra() {
      const lista = [...escolhidos].sort((a, b) => a - b);
      const el = document.getElementById('resumo-compra');
      if (!el) return;
      el.innerHTML = lista.length
        ? `<div class="numeros-lista">${lista.map((n) => `<span>${num(n, r.total_numeros)}</span>`).join('')}</div>
           <p><b>Total: ${reais(lista.length * r.preco_centavos)}</b></p>`
        : '<p class="suave">Escolha seus números aí em cima, ou peça números sorteados.</p>';
    }

    function desenhar() {
      const livres = r.total_numeros - r.numeros_pagos.length - r.numeros_reservados.length;
      app.innerHTML = `
        ${foto(r, 'foto-grande')}
        ${etiqueta(r.status)}
        <h1>${esc(r.titulo)}</h1>
        ${r.descricao ? `<p>${esc(r.descricao).replace(/\n/g, '<br>')}</p>` : ''}
        <div class="fatos">
          <div><span>Cada número</span><b>${reais(r.preco_centavos)}</b></div>
          <div><span>Sorteio</span><b>${data(r.prazo)}</b></div>
          <div><span>Livres</span><b>${livres} de ${r.total_numeros}</b></div>
        </div>
        ${progresso(r)}
        ${situacao()}
        ${regras()}
        <div class="cartao">
          <h2>${r.status === 'aberta' ? 'Escolha seus números' : 'Números'}</h2>
          <div class="legenda"><span><i></i>Livre</span><span><i class="l-sel"></i>Escolhido</span><span><i class="l-res"></i>Reservado</span><span><i class="l-pago"></i>Vendido</span></div>
          <div id="grade">${grade()}</div>
          ${r.status === 'aberta' ? `
          <div class="linha-botoes" style="margin-top:14px">
            <button class="secundario" data-sorte="1">+1 da sorte</button>
            <button class="secundario" data-sorte="5">+5 da sorte</button>
            <button class="secundario" data-sorte="10">+10 da sorte</button>
            <button class="discreto" id="limpar">Limpar</button>
          </div>` : ''}
        </div>
        ${r.status === 'aberta' ? `
        <form class="cartao" id="dados">
          <h2>Seus dados</h2>
          <div id="resumo-compra"></div>
          <label for="nome">Nome completo</label>
          <input id="nome" name="nome" autocomplete="name" required minlength="3" maxlength="80">
          <div class="duas">
            <div><label for="telefone">WhatsApp com DDD</label>
              <input id="telefone" name="telefone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(11) 99999-0000" required></div>
            <div><label for="email">E-mail</label>
              <input id="email" name="email" type="email" autocomplete="email" required></div>
          </div>
          <p class="pequeno suave" style="margin-top:10px">Seu nome, telefone e e-mail <b>nunca aparecem em público</b>. Na lista pública você é só um código. Usamos seus dados apenas para avisar se você ganhar e para você achar seus números depois.</p>
          <p class="erro" role="alert"></p>
          <button type="submit" class="largo">Reservar e pagar com Pix</button>
          <p class="pequeno suave centro" style="margin-top:8px">Os números ficam guardados por ${config.reserva_minutos} minutos enquanto você paga.</p>
        </form>` : ''}`;

      document.getElementById('grade').onclick = (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        if (b.dataset.pagina !== undefined) {
          pagina = Number(b.dataset.pagina);
          document.getElementById('grade').innerHTML = grade();
          return;
        }
        const n = Number(b.dataset.n);
        if (!n) return;
        if (escolhidos.has(n)) escolhidos.delete(n); else if (escolhidos.size < 500) escolhidos.add(n);
        b.classList.toggle('sel', escolhidos.has(n));
        b.setAttribute('aria-pressed', escolhidos.has(n));
        carrinho(); resumoCompra();
      };
      app.querySelectorAll('[data-sorte]').forEach((b) => {
        b.onclick = () => {
          const ocupados = new Set([...r.numeros_pagos, ...r.numeros_reservados, ...escolhidos]);
          const livresAgora = [];
          for (let n = 1; n <= r.total_numeros; n++) if (!ocupados.has(n)) livresAgora.push(n);
          for (let i = 0; i < Number(b.dataset.sorte) && livresAgora.length && escolhidos.size < 500; i++) {
            const j = crypto.getRandomValues(new Uint32Array(1))[0] % livresAgora.length;
            escolhidos.add(livresAgora.splice(j, 1)[0]);
          }
          document.getElementById('grade').innerHTML = grade();
          carrinho(); resumoCompra();
        };
      });
      const limpar = document.getElementById('limpar');
      if (limpar) limpar.onclick = () => { escolhidos.clear(); document.getElementById('grade').innerHTML = grade(); carrinho(); resumoCompra(); };
      const form = document.getElementById('dados');
      if (form) {
        try {
          const salvo = JSON.parse(localStorage.getItem('comprador') || '{}');
          for (const k of ['nome', 'telefone', 'email']) if (salvo[k]) form.elements[k].value = salvo[k];
        } catch { /* sem dados salvos */ }
        formulario(form, async (d) => {
          if (!escolhidos.size) throw new Error('Escolha pelo menos um número.');
          try {
            const p = await api('POST', `/api/rifas/${slug}/pedidos`, { ...d, numeros: [...escolhidos] });
            try { localStorage.setItem('comprador', JSON.stringify(d)); } catch { /* tudo bem */ }
            location.hash = `#/pedido/${p.token}`;
          } catch (e) {
            if (e.status === 409) { await atualizar(true); }
            throw e;
          }
        });
        resumoCompra();
      }
      carrinho();
    }

    async function atualizar(forcar) {
      const novo = await api('GET', `/api/rifas/${slug}`).catch(() => null);
      if (!novo) return;
      const mudouStatus = novo.status !== r.status;
      r = novo;
      for (const n of [...r.numeros_pagos, ...r.numeros_reservados]) escolhidos.delete(n);
      if (mudouStatus) return desenhar();
      const g = document.getElementById('grade');
      if (g && (forcar || !document.hidden)) { g.innerHTML = grade(); carrinho(); resumoCompra(); }
    }

    desenhar();
    repetir(() => { if (r.status === 'aberta' || r.status === 'encerrada') atualizar(false); }, 8000);
  }

  // ---------- Pedido / pagamento ----------
  async function telaPedido(token) {
    let p = await api('GET', `/api/pedidos/${token}`);
    const NOMES = { reservado: 'Aguardando pagamento', pago: 'Pago', expirado: 'Reserva vencida', estornando: 'Devolução em andamento', estornado: 'Dinheiro devolvido' };

    function corpo() {
      const numeros = `<div class="numeros-lista">${p.numeros.map((n) => `<span>${num(n, p.rifa.total_numeros)}</span>`).join('')}</div>`;
      if (p.status === 'reservado') {
        const resta = Math.max(0, p.expira_em - Date.now());
        const min = Math.floor(resta / 60000), seg = Math.floor((resta % 60000) / 1000);
        return `<div class="cartao">
          <h1>Falta só o Pix</h1>
          <p>Seus números estão guardados por mais <b id="relogio">${min}:${String(seg).padStart(2, '0')}</b>.</p>
          ${numeros}
          <p class="grande">${reais(p.valor_centavos)}</p>
          ${p.pix_qr_base64 ? `<img class="qr" alt="QR Code do Pix" src="data:image/png;base64,${esc(p.pix_qr_base64)}">` : ''}
          <p><b>1.</b> Abra o app do seu banco e escolha <b>Pix copia e cola</b>${p.pix_qr_base64 ? ' (ou leia o QR Code)' : ''}.<br>
             <b>2.</b> Cole o código abaixo e confirme.<br>
             <b>3.</b> Pronto. Esta página avisa sozinha quando o Pix cair.</p>
          <div class="pix-codigo" id="codigo">${esc(p.pix_copia_cola)}</div>
          <button class="largo" id="copiar">Copiar código Pix</button>
          ${config.pagamento === 'simulado' ? '<button class="largo secundario" id="simular" style="margin-top:10px">Simular pagamento (modo de teste)</button>' : ''}
          <p class="pequeno suave" style="margin-top:12px">Se o tempo acabar, os números voltam a ficar livres. Se você pagar depois disso e alguém já tiver pego os números, devolvemos seu dinheiro sozinhos.</p>
        </div>`;
      }
      if (p.status === 'pago') {
        let topo;
        if (p.ganhou) {
          topo = `<div class="cartao alerta centro"><h1>🎉 Você ganhou!</h1>
            <p>Seu número <b>${num(p.rifa.numero_ganhador, p.rifa.total_numeros)}</b> foi o sorteado. Prêmio: <b>${esc(p.rifa.premio)}</b>.</p>
            <p>${esc(p.rifa.organizador)} vai falar com você pelo WhatsApp ou e-mail que você informou.</p>
            ${p.premio_confirmado ? '<p><b>Você já confirmou que recebeu o prêmio. Obrigado!</b></p>'
              : '<p>Quando o prêmio estiver na sua mão, confirme aqui. O organizador só recebe o dinheiro depois disso.</p><button id="recebi">Recebi o prêmio</button>'}
          </div>`;
        } else if (p.rifa.status === 'sorteada') {
          topo = `<div class="cartao"><h1>Não foi dessa vez</h1><p>O número sorteado foi <b>${num(p.rifa.numero_ganhador, p.rifa.total_numeros)}</b>. <a href="#/conferir/${esc(p.rifa.slug)}">Confira o sorteio.</a></p></div>`;
        } else {
          topo = `<div class="cartao destaque"><h1>✅ Pagamento confirmado</h1>
            <p>Os números são seus. Guarde o endereço desta página: é o seu comprovante.</p>
            <p>${p.rifa.status === 'encerrada' ? 'As vendas encerraram e o sorteio sai em instantes.' : `Sorteio: <b>${data(p.rifa.prazo)}</b>, ou antes se todos os números forem vendidos.`}</p></div>`;
        }
        return `${topo}<div class="cartao"><h2>Seus números</h2>${numeros}
          <p class="pequeno suave">Pago em ${data(p.pago_em)} · ${reais(p.valor_centavos)} · Pedido ${esc(p.id)}</p>
          <p class="pequeno">🔒 Na lista pública você aparece só como <b>Comprador ${esc(p.codigo_publico)}</b>. Seu nome e telefone não são mostrados.</p>
          <div class="linha-botoes">
            <a class="botao secundario" href="#/conferir/${esc(p.rifa.slug)}">Ver registro público</a>
            <button class="secundario" id="copiar-link">Copiar link do comprovante</button>
          </div>
          ${p.pode_estornar ? '<button class="discreto" id="estornar">Desisti. Quero meu dinheiro de volta.</button>' : ''}</div>`;
      }
      if (p.status === 'estornando' || p.status === 'estornado') {
        return `<div class="cartao"><h1>${p.status === 'estornado' ? 'Dinheiro devolvido' : 'Devolução em andamento'}</h1>
          <p>${esc(p.motivo_estorno)}</p>
          <p>${p.status === 'estornado'
            ? `Devolvemos <b>${reais(p.valor_centavos)}</b> para a mesma conta que fez o Pix, em ${data(p.estornado_em)}. Costuma cair na hora; em alguns bancos pode levar até 1 dia útil.`
            : `Estamos devolvendo <b>${reais(p.valor_centavos)}</b> para a mesma conta que fez o Pix. Você não precisa fazer nada.`}</p>
          <p class="pequeno suave">Pedido ${esc(p.id)}</p></div>`;
      }
      return `<div class="cartao"><h1>A reserva venceu</h1>
        <p>O tempo para pagar acabou e os números voltaram a ficar livres. Nada foi cobrado.</p>
        <p class="pequeno suave">Se você pagou o Pix nos últimos minutos, espere um pouco: ou os números voltam para você, ou o dinheiro é devolvido sozinho.</p>
        <a class="botao" href="#/r/${esc(p.rifa.slug)}">Escolher números de novo</a></div>`;
    }

    function desenhar() {
      app.innerHTML = `<p class="pequeno"><a href="#/r/${esc(p.rifa.slug)}">← ${esc(p.rifa.titulo)}</a> · ${esc(NOMES[p.status])}</p>${corpo()}`;
      const acao = (id, fn) => { const b = document.getElementById(id); if (b) b.onclick = () => fn(b); };
      const copiar = async (b, texto, ok) => {
        try { await navigator.clipboard.writeText(texto); b.textContent = ok; } catch { b.textContent = 'Selecione e copie o texto acima'; }
      };
      acao('copiar', (b) => copiar(b, p.pix_copia_cola, 'Copiado! Agora cole no app do banco'));
      acao('copiar-link', (b) => copiar(b, location.href, 'Link copiado'));
      const chamar = async (b, caminho) => {
        b.disabled = true;
        try { p = await api('POST', `/api/pedidos/${token}/${caminho}`); desenhar(); } catch (e) { alert(e.message); b.disabled = false; }
      };
      acao('simular', (b) => chamar(b, 'simular-pagamento'));
      acao('recebi', (b) => { if (confirm('Confirmar que você já recebeu o prêmio? Isso libera o pagamento ao organizador.')) chamar(b, 'premio-recebido'); });
      acao('estornar', (b) => { if (confirm(`Devolver ${reais(p.valor_centavos)} e liberar seus números?`)) chamar(b, 'estorno'); });
    }

    desenhar();
    repetir(() => {
      const el = document.getElementById('relogio');
      if (!el) return;
      const resta = Math.max(0, p.expira_em - Date.now());
      el.textContent = `${Math.floor(resta / 60000)}:${String(Math.floor((resta % 60000) / 1000)).padStart(2, '0')}`;
    }, 1000);
    repetir(async () => {
      const parado = ['estornado', 'expirado'].includes(p.status) || (p.status === 'pago' && ['sorteada', 'cancelada'].includes(p.rifa.status));
      if (parado || document.hidden) return;
      const novo = await api('GET', `/api/pedidos/${token}`).catch(() => null);
      if (novo && (novo.status !== p.status || novo.rifa.status !== p.rifa.status)) { p = novo; desenhar(); }
    }, 4000);
  }

  // ---------- Meus números ----------
  function telaMeusNumeros() {
    app.innerHTML = `<h1>Meus números</h1>
      <p class="suave">Digite o WhatsApp e o e-mail que você usou na compra.</p>
      <form class="cartao" id="busca">
        <label for="telefone">WhatsApp com DDD</label><input id="telefone" name="telefone" type="tel" inputmode="tel" required>
        <label for="email">E-mail</label><input id="email" name="email" type="email" required>
        <p class="erro" role="alert"></p>
        <button type="submit" class="largo">Ver meus números</button>
      </form><div id="resultado"></div>`;
    const form = document.getElementById('busca');
    try {
      const salvo = JSON.parse(localStorage.getItem('comprador') || '{}');
      for (const k of ['telefone', 'email']) if (salvo[k]) form.elements[k].value = salvo[k];
    } catch { /* sem dados salvos */ }
    const NOMES = { reservado: ['Aguardando Pix', 'amarela'], pago: ['Pago', ''], estornando: ['Devolvendo', 'amarela'], estornado: ['Devolvido', 'cinza'] };
    formulario(form, async (d) => {
      const pedidos = await api('POST', '/api/meus-numeros', d);
      document.getElementById('resultado').innerHTML = pedidos.length ? pedidos.map((p) => `
        <a class="cartao" style="display:block;text-decoration:none;color:inherit" href="#/pedido/${esc(p.token)}">
          <span class="etiqueta ${NOMES[p.status][1]}">${NOMES[p.status][0]}</span>
          ${p.ganhou ? '<span class="etiqueta amarela">🎉 Você ganhou</span>' : ''}
          <h3 style="margin-top:6px">${esc(p.rifa_titulo)}</h3>
          <div class="numeros-lista">${p.numeros.map((n) => `<span>${n}</span>`).join('')}</div>
          <span class="pequeno suave">${reais(p.valor_centavos)} · toque para abrir</span>
        </a>`).join('') : '<div class="cartao"><p>Não achamos compras com esses dados. Confira se o WhatsApp e o e-mail são os mesmos da compra.</p></div>';
    });
  }

  // ---------- Conferir (auditoria pública) ----------
  const FRASES = {
    rifa_criada: (d) => `Rifa criada: ${d.total_numeros} números a ${reais(d.preco_centavos)}. Mínimo para valer: ${d.minimo_numeros}. Taxa da plataforma: ${porcento(d.taxa_percentual)}.`,
    pagamento: (d) => `Comprador ${d.comprador} pagou ${reais(d.valor_centavos)} pelos números ${d.numeros.join(', ')}.`,
    estorno: (d) => `Devolução de ${reais(d.valor_centavos)} (números ${d.numeros.join(', ')}). Motivo: ${d.motivo}`,
    estorno_concluido: (d) => `Devolução de ${reais(d.valor_centavos)} concluída.`,
    rifa_cancelada: (d) => `Rifa cancelada. ${d.motivo} ${d.pedidos_devolvidos} compra(s) devolvida(s).`,
    encerramento: (d) => `Vendas encerradas com ${d.total_pagos} números pagos. Lista fechada. O sorteio vai usar a rodada ${d.rodada_drand} do drand, que ainda não tinha saído.`,
    sorteio: (d) => `Sorteio feito. Número ganhador: ${d.numero_ganhador} (Comprador ${d.ganhador}). Arrecadado: ${reais(d.arrecadado_centavos)}. Organizador: ${reais(d.repasse_organizador_centavos)}. Plataforma: ${reais(d.taxa_plataforma_centavos)}.`,
    premio_recebido: () => 'O ganhador confirmou que recebeu o prêmio. Pagamento ao organizador liberado.',
    repasse_liberado: () => 'A plataforma liberou o pagamento ao organizador.',
    repasse_pago: (d) => `Pagamento de ${reais(d.repasse_organizador_centavos)} feito ao organizador.`,
  };

  async function telaConferir(slug) {
    const a = await api('GET', `/api/rifas/${slug}/auditoria`);
    const r = a.rifa;
    const pagos = a.compradores.map((c) => c.numero);
    const sorteada = r.status === 'sorteada';

    app.innerHTML = `
      <p class="pequeno"><a href="#/r/${esc(r.slug)}">← ${esc(r.titulo)}</a></p>
      <h1>Conferir esta rifa</h1>
      <p class="suave">Tudo o que acontece na rifa fica registrado aqui, em ordem. As contas abaixo são refeitas agora, no seu aparelho — você não precisa confiar na gente.</p>
      ${sorteada ? `<div class="cartao alerta centro"><p>Número sorteado</p><p class="grande">${num(r.numero_ganhador, r.total_numeros)}</p></div>` : ''}
      <div class="cartao"><h2>Conferência automática</h2><ul class="checagem" id="checagem">
        <li id="c1"><b>O registro não foi alterado</b><small>Conferindo…</small></li>
        <li id="c2"><b>A lista de números foi fechada antes do sorteio</b><small>Conferindo…</small></li>
        <li id="c3"><b>O número público do sorteio é verdadeiro</b><small>Conferindo…</small></li>
        <li id="c4"><b>A conta do ganhador está certa</b><small>Conferindo…</small></li>
      </ul></div>
      ${sorteada ? `<div class="cartao"><h2>Para onde foi o dinheiro</h2><table>
        <tr><td>Total arrecadado</td><td class="valor">${reais(r.arrecadado_centavos)}</td></tr>
        <tr><td>Organizador recebe (${porcento(100 - r.taxa_percentual)})</td><td class="valor">${reais(r.repasse_centavos)}</td></tr>
        <tr><td>Taxa da plataforma (${porcento(r.taxa_percentual)})</td><td class="valor">${reais(r.taxa_centavos)}</td></tr>
        </table><p class="pequeno suave" style="margin-top:10px">${{ aguardando: 'O organizador só recebe depois que o ganhador confirmar que recebeu o prêmio.', liberado: 'Prêmio confirmado. Pagamento ao organizador liberado.', pago: 'Pagamento ao organizador já feito.' }[r.repasse_status]}</p></div>` : ''}
      <div class="cartao"><h2>Como o sorteio funciona</h2>
        <p><b>1.</b> Quando as vendas encerram, a lista de números pagos é fechada e publicada.</p>
        <p><b>2.</b> Na mesma hora, fica marcado qual número público vai decidir o sorteio. Ele vem do <a href="https://drand.love" target="_blank" rel="noopener">drand</a>, uma rede mantida por universidades e empresas de vários países, e <b>ainda não existe</b> nesse momento. Ninguém consegue adivinhar nem escolher.</p>
        <p><b>3.</b> Quando o número sai, uma conta fixa aponta o ganhador na lista. A conta sempre dá o mesmo resultado, para qualquer pessoa.</p>
        <details><summary>Ver a conta exata</summary>
          <p class="pequeno">semente = SHA-256( número_do_drand + ":" + código_da_rifa )<br>posição = semente ÷ quantidade de números pagos → pega o <b>resto</b> da divisão<br>ganhador = número que está nessa posição da lista (em ordem crescente, começando do zero)</p>
          <p class="pequeno">Código da rifa: <code>${esc(r.id)}</code><br>Rodada do drand: <code>${esc(r.rodada_drand ?? '—')}</code><br>Número do drand: <code>${esc(r.aleatorio_drand ?? 'ainda não saiu')}</code><br>Impressão digital da lista (SHA-256 dos números separados por vírgula): <code>${esc(r.hash_lista ?? '—')}</code></p>
          ${r.rodada_drand ? `<p class="pequeno"><a href="${esc(r.rede_drand)}/public/${esc(r.rodada_drand)}" target="_blank" rel="noopener">Abrir esta rodada direto no drand</a></p>` : ''}
        </details></div>
      <div class="cartao"><h2>Registro público</h2>
        <ol class="linha-tempo">${a.registro.map((l) => {
          const d = JSON.parse(l.dados);
          return `<li><time>${dataHoraExata(l.criado_em)} · linha ${l.seq}</time>${esc((FRASES[l.tipo] || (() => l.tipo))(d))}<br><code>${esc(l.hash)}</code></li>`;
        }).join('')}</ol>
        <p class="pequeno suave" style="margin-top:10px">O código embaixo de cada linha é a "impressão digital" dela, calculada junto com a linha anterior. Se alguém mudasse qualquer coisa no passado, todos os códigos seguintes mudariam. Quer garantia extra? Anote o último código: ele tem que continuar aparecendo aqui.</p></div>
      <div class="cartao"><h2>Números pagos (${pagos.length})</h2>
        ${pagos.length ? `<div class="rolagem"><table><tr><th>Número</th><th>Comprador (código)</th></tr>
          ${a.compradores.map((c) => `<tr><td><b>${num(c.numero, r.total_numeros)}</b>${sorteada && c.numero === r.numero_ganhador ? ' 🏆' : ''}</td><td>${esc(c.comprador)}</td></tr>`).join('')}
        </table></div>
        <p class="pequeno suave" style="margin-top:10px">Para proteger quem compra, cada pessoa aparece só como um código. O seu código está no seu comprovante.</p>` : '<p class="suave">Nenhum número pago ainda.</p>'}</div>`;

    const marcar = (id, classe, texto) => {
      const li = document.getElementById(id);
      if (!li) return;
      li.className = classe;
      li.querySelector('small').textContent = texto;
    };

    if (!window.crypto || !crypto.subtle) {
      for (const id of ['c1', 'c2', 'c3', 'c4']) marcar(id, 'espera', 'Seu navegador não permite refazer as contas nesta conexão. Abra o site com https://');
      return;
    }

    // 1. Corrente do registro
    let anterior = '0'.repeat(64), correnteOk = true;
    for (const l of a.registro) {
      const h = await sha256(`${anterior}|${l.seq}|${l.tipo}|${l.criado_em}|${l.dados}`);
      if (l.hash_anterior !== anterior || l.hash !== h) { correnteOk = false; break; }
      anterior = l.hash;
    }
    marcar('c1', correnteOk ? 'ok' : 'falha', correnteOk
      ? `${a.registro.length} linha(s) conferidas. Último código: ${anterior.slice(0, 16)}…`
      : 'ATENÇÃO: o registro não confere. Avise a plataforma.');

    // 2. Lista fechada antes do sorteio
    const enc = a.registro.find((l) => l.tipo === 'encerramento');
    if (!enc) {
      const texto = r.status === 'cancelada' ? 'Rifa cancelada: não houve sorteio.' : 'A rifa ainda está vendendo. A lista fecha quando as vendas encerrarem.';
      for (const id of ['c2', 'c3', 'c4']) marcar(id, 'espera', texto);
      return;
    }
    const dEnc = JSON.parse(enc.dados);
    const hashLista = await sha256(pagos.join(','));
    const listaOk = hashLista === r.hash_lista && dEnc.hash_lista === r.hash_lista && dEnc.rodada_drand === r.rodada_drand
      && dEnc.numeros_pagos.join(',') === pagos.join(',');
    marcar('c2', listaOk ? 'ok' : 'falha', listaOk
      ? `${pagos.length} números, fechados em ${dataHoraExata(enc.criado_em)}, antes de a rodada ${r.rodada_drand} existir.`
      : 'ATENÇÃO: a lista atual é diferente da lista fechada no encerramento.');

    if (!sorteada) {
      marcar('c3', 'espera', `Esperando sair a rodada ${r.rodada_drand} do drand…`);
      marcar('c4', 'espera', 'O ganhador aparece assim que o número público sair.');
      repetir(async () => {
        const x = await api('GET', `/api/rifas/${slug}`).catch(() => null);
        if (x && x.status === 'sorteada') rotear();
      }, 4000);
      return;
    }

    // 3. Número público, buscado direto na rede drand (sem passar pelo nosso servidor)
    let aleatorio = null;
    try {
      const resp = await fetch(`${r.rede_drand}/public/${r.rodada_drand}`);
      const b = await resp.json();
      const derivado = await sha256(hexParaBytes(b.signature));
      if (b.round === r.rodada_drand && b.randomness === r.aleatorio_drand && derivado === b.randomness) {
        aleatorio = b.randomness;
        marcar('c3', 'ok', `Buscado agora direto no drand (rodada ${b.round}) e é igual ao que usamos: ${b.randomness.slice(0, 16)}…`);
      } else {
        marcar('c3', 'falha', 'ATENÇÃO: o número que o drand publicou é diferente do que foi usado.');
      }
    } catch {
      aleatorio = r.aleatorio_drand;
      marcar('c3', 'espera', 'Não deu para consultar o drand daqui agora. Abra o link "direto no drand" mais abaixo e compare o número.');
    }

    // 4. Conta do ganhador
    if (aleatorio) {
      const semente = await sha256(`${aleatorio}:${r.id}`);
      const posicao = Number(BigInt('0x' + semente) % BigInt(pagos.length));
      const certo = pagos[posicao] === r.numero_ganhador;
      marcar('c4', certo ? 'ok' : 'falha', certo
        ? `A conta apontou a posição ${posicao} da lista, que é o número ${num(pagos[posicao], r.total_numeros)}.`
        : `ATENÇÃO: a conta aponta o número ${pagos[posicao]}, não o ${r.numero_ganhador}.`);
    } else {
      marcar('c4', 'falha', 'Sem o número público correto, a conta não fecha.');
    }
  }

  // ---------- Como funciona ----------
  function telaComoFunciona() {
    const t = config.taxa_percentual;
    app.innerHTML = `<h1>Como funciona</h1>
      <div class="cartao"><h2>Para quem compra</h2>
        <details open><summary>Como eu pago?</summary><p>Só por Pix. Você escolhe os números, a gente guarda por ${config.reserva_minutos} minutos e mostra um código Pix. Pagou, o número é seu na hora — a página avisa sozinha.</p></details>
        <details><summary>E se eu não pagar a tempo?</summary><p>Os números voltam a ficar livres e nada é cobrado. Se você pagar atrasado e outra pessoa já tiver pego os números, o dinheiro volta sozinho para a sua conta.</p></details>
        <details><summary>Posso desistir?</summary><p>Pode. Em até 7 dias depois do pagamento, enquanto a rifa estiver vendendo, abra seu comprovante e toque em "Quero meu dinheiro de volta". Devolvemos o valor inteiro no Pix. Depois que as vendas encerram, não dá mais.</p></details>
        <details><summary>E se a rifa for cancelada?</summary><p>Toda rifa tem um mínimo de números para valer. Se não vender o mínimo até a data, ou se o organizador cancelar, todo mundo recebe o valor inteiro de volta, automaticamente, na conta que fez o Pix.</p></details>
        <details><summary>Como sei que o sorteio é honesto?</summary><p>O sorteio não é feito por uma pessoa. A lista de números é fechada e publicada <b>antes</b> de existir o número que decide o ganhador. Esse número vem de uma rede pública internacional (drand), que ninguém controla. Na página "Conferir" de cada rifa, seu próprio celular refaz a conta e mostra se bate.</p></details>
        <details><summary>Meu nome aparece para todo mundo?</summary><p>Não. Em público você é só um código (por exemplo, "Comprador 482913"). Seu nome, telefone e e-mail ficam guardados e só são vistos pelo organizador se você ganhar, para combinar a entrega do prêmio.</p></details>
        <details><summary>Como acho meus números depois?</summary><p>Em <a href="#/meus-numeros">Meus números</a>, com o WhatsApp e o e-mail da compra. Ou guarde o link do comprovante.</p></details>
        <details><summary>E se eu ganhar?</summary><p>Seu comprovante mostra "Você ganhou" e o organizador entra em contato. O organizador <b>só recebe o dinheiro da rifa depois que você confirmar que recebeu o prêmio</b>.</p></details>
      </div>
      <div class="cartao"><h2>Para quem organiza</h2>
        <details open><summary>Quanto custa?</summary><p>Criar a rifa é grátis. A plataforma fica com <b>${porcento(t)}</b> do que for arrecadado e você recebe <b>${porcento(100 - t)}</b>. A tarifa do Pix já está dentro da nossa parte. Se a rifa for cancelada, ninguém paga nada.</p>
          <p>Exemplo: 100 números a R$ 10 = R$ 1.000 arrecadados. Você recebe ${reais(100000 - Math.round(1000 * t))} e a plataforma fica com ${reais(Math.round(1000 * t))}.</p></details>
        <details><summary>Quando eu recebo?</summary><p>Depois do sorteio, você entrega o prêmio. Quando o ganhador confirmar que recebeu, mandamos a sua parte por Pix para a chave do seu cadastro.</p></details>
        <details><summary>O que eu preciso ter?</summary><p>Uma conta aqui, uma chave Pix e a autorização legal para fazer a rifa. No Brasil, sorteios com venda de números precisam de autorização do governo federal. Essa responsabilidade é de quem organiza.</p></details>
        <a class="botao" href="#/painel" style="margin-top:10px">Criar minha rifa</a>
      </div>`;
  }

  // ---------- Conta ----------
  function telaEntrar() {
    app.innerHTML = `<h1>Entrar</h1>
      <form class="cartao" id="entrar">
        <label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="email" required>
        <label for="senha">Senha</label><input id="senha" name="senha" type="password" autocomplete="current-password" required>
        <p class="erro" role="alert"></p>
        <button type="submit" class="largo">Entrar</button>
      </form>
      <h2>Ainda não tem conta?</h2>
      <form class="cartao" id="cadastro">
        <label for="c-nome">Seu nome ou nome da organização</label><input id="c-nome" name="nome" autocomplete="name" required minlength="3" maxlength="80">
        <label for="c-email">E-mail</label><input id="c-email" name="email" type="email" autocomplete="email" required>
        <label for="c-senha">Senha <small>Pelo menos 8 caracteres.</small></label><input id="c-senha" name="senha" type="password" autocomplete="new-password" required minlength="8">
        <label for="c-pix">Chave Pix <small>É para onde mandamos o dinheiro das suas rifas.</small></label><input id="c-pix" name="chave_pix" required minlength="5" maxlength="140">
        <p class="erro" role="alert"></p>
        <button type="submit" class="largo">Criar conta grátis</button>
      </form>`;
    const depois = async (u) => { eu = u; cabecalho(); if (location.hash === '#/painel') rotear(); else location.hash = '#/painel'; };
    formulario(document.getElementById('entrar'), async (d) => depois(await api('POST', '/api/entrar', d)));
    formulario(document.getElementById('cadastro'), async (d) => depois(await api('POST', '/api/cadastro', d)));
  }

  const REPASSE = { aguardando: 'Aguardando o ganhador confirmar o prêmio', liberado: 'Liberado — a plataforma vai te pagar', pago: 'Pago' };

  function linhaPainel(r, admin) {
    let extra = '';
    if (r.status === 'sorteada') {
      extra = `<p><b>Ganhador:</b> número ${num(r.numero_ganhador, r.total_numeros)} — ${esc(r.ganhador.nome)}<br>
        WhatsApp: ${esc(r.ganhador.telefone)} · ${esc(r.ganhador.email)}</p>
        <p><b>Repasse:</b> ${esc(REPASSE[r.repasse_status])}</p>`;
    }
    const dinheiro = r.status === 'cancelada' ? '' : `<table>
      <tr><td>${r.status === 'sorteada' ? 'Arrecadado' : 'Arrecadado até agora'}</td><td class="valor">${reais(r.arrecadado_centavos)}</td></tr>
      <tr><td>Taxa da plataforma (${porcento(r.taxa_percentual)})</td><td class="valor">− ${reais(r.taxa_centavos)}</td></tr>
      <tr class="total"><td>${admin ? 'Organizador recebe' : 'Você recebe'}</td><td class="valor">${reais(r.repasse_centavos)}</td></tr></table>`;
    let botoes = `<a class="botao secundario" href="#/r/${esc(r.slug)}">Abrir página</a>
      <button class="secundario" data-link="${esc(r.slug)}">Copiar link</button>`;
    if (r.status === 'aberta') botoes += `<button class="vermelho" data-cancelar="${esc(r.slug)}">Cancelar e devolver tudo</button>`;
    if (admin && r.status === 'sorteada' && r.repasse_status === 'aguardando') botoes += `<button data-liberar="${esc(r.slug)}">Liberar repasse sem confirmação</button>`;
    if (admin && r.status === 'sorteada' && r.repasse_status === 'liberado') botoes += `<button data-pago="${esc(r.slug)}">Marcar repasse como pago</button>`;
    return `<div class="cartao">
      ${etiqueta(r.status)}
      <h2 style="margin-top:6px">${esc(r.titulo)}</h2>
      ${admin ? `<p class="pequeno">Organizador: ${esc(r.organizador_contato.nome)} · ${esc(r.organizador_contato.email)} · Pix: <b>${esc(r.organizador_contato.chave_pix)}</b></p>` : ''}
      ${r.status === 'cancelada' ? `<p>${esc(r.motivo_cancelamento)}</p>` : progresso(r)}
      ${r.status === 'aberta' ? `<p class="pequeno suave">Sorteio em ${data(r.prazo)}. Mínimo para valer: ${r.minimo_numeros} números.</p>` : ''}
      ${dinheiro}${extra}
      <div class="linha-botoes">${botoes}</div></div>`;
  }

  function ligarBotoesPainel(recarregar) {
    const acao = (atributo, fn) => app.querySelectorAll(`[data-${atributo}]`).forEach((b) => {
      b.onclick = async () => {
        try { await fn(b.dataset[atributo], b); } catch (e) { alert(e.message); }
      };
    });
    acao('link', async (slug, b) => {
      const link = `${location.origin}/#/r/${slug}`;
      try { await navigator.clipboard.writeText(link); b.textContent = 'Link copiado'; } catch { prompt('Copie o link:', link); }
    });
    acao('cancelar', async (slug) => {
      if (!confirm('Cancelar esta rifa? Todos os compradores recebem o dinheiro de volta. Não dá para desfazer.')) return;
      await api('POST', `/api/rifas/${slug}/cancelar`); recarregar();
    });
    acao('liberar', async (slug) => {
      if (!confirm('Liberar o repasse sem a confirmação do ganhador? Faça isso só se tiver prova de que o prêmio foi entregue.')) return;
      await api('POST', `/api/admin/rifas/${slug}/liberar-repasse`); recarregar();
    });
    acao('pago', async (slug) => {
      if (!confirm('Confirmar que você já fez o Pix para o organizador?')) return;
      await api('POST', `/api/admin/rifas/${slug}/repasse-pago`); recarregar();
    });
  }

  async function telaPainel() {
    if (!eu) return telaEntrar();
    const rifas = await api('GET', '/api/painel');
    app.innerHTML = `<h1>Minhas rifas</h1>
      <p class="suave">Olá, ${esc(eu.nome)}. Seus repasses vão para a chave Pix <b>${esc(eu.chave_pix)}</b>.</p>
      <div class="linha-botoes">
        <a class="botao" href="#/criar">+ Criar rifa</a>
        ${eu.papel === 'admin' ? '<a class="botao secundario" href="#/admin">Área da plataforma</a>' : ''}
        <button class="discreto" id="sair">Sair</button>
      </div>
      ${rifas.length ? rifas.map((r) => linhaPainel(r, false)).join('') : '<div class="cartao"><p>Você ainda não criou nenhuma rifa.</p></div>'}`;
    document.getElementById('sair').onclick = async () => { await api('POST', '/api/sair'); eu = null; cabecalho(); location.hash = '#/'; };
    ligarBotoesPainel(telaPainel);
  }

  async function telaAdmin() {
    if (!eu || eu.papel !== 'admin') return telaEntrar();
    const rifas = await api('GET', '/api/admin/rifas');
    const sorteadas = rifas.filter((r) => r.status === 'sorteada');
    const soma = (lista, campo) => lista.reduce((t, r) => t + r[campo], 0);
    const aPagar = sorteadas.filter((r) => r.repasse_status === 'liberado');
    app.innerHTML = `<h1>Área da plataforma</h1>
      <div class="fatos">
        <div><span>Rifas sorteadas</span><b>${sorteadas.length}</b></div>
        <div><span>Taxas ganhas</span><b>${reais(soma(sorteadas, 'taxa_centavos'))}</b></div>
        <div><span>Repasses a pagar agora</span><b>${reais(soma(aPagar, 'repasse_centavos'))}</b></div>
      </div>
      <p class="pequeno suave">O repasse é um Pix que você faz para a chave do organizador. Depois de fazer, marque como pago: isso fica no registro público.</p>
      ${rifas.length ? rifas.map((r) => linhaPainel(r, true)).join('') : '<div class="cartao"><p>Nenhuma rifa ainda.</p></div>'}`;
    ligarBotoesPainel(telaAdmin);
  }

  function telaCriar() {
    if (!eu) return telaEntrar();
    const amanha = new Date(Date.now() + 7 * 86400000);
    amanha.setMinutes(0, 0, 0);
    const local = new Date(amanha.getTime() - amanha.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    app.innerHTML = `<h1>Criar rifa</h1>
      <form class="cartao" id="criar">
        <label for="titulo">Nome da rifa</label><input id="titulo" name="titulo" required minlength="3" maxlength="80" placeholder="Ex.: Rifa da bicicleta">
        <label for="premio">Prêmio</label><input id="premio" name="premio" required minlength="3" maxlength="120" placeholder="Ex.: Bicicleta aro 29 nova">
        <label for="descricao">Detalhes <small>Opcional. Conte para que é a rifa e como o prêmio será entregue.</small></label>
        <textarea id="descricao" name="descricao" rows="3" maxlength="2000"></textarea>
        <label for="imagem_url">Link de uma foto do prêmio <small>Opcional. Precisa começar com https://</small></label>
        <input id="imagem_url" name="imagem_url" type="url" maxlength="500">
        <div class="duas">
          <div><label for="preco">Preço de cada número (R$)</label><input id="preco" name="preco" inputmode="decimal" required value="10,00"></div>
          <div><label for="total">Quantos números</label><input id="total" name="total_numeros" type="number" min="10" max="10000" required value="100"></div>
        </div>
        <div class="duas">
          <div><label for="minimo">Mínimo vendido para valer <small>Abaixo disso, tudo é devolvido.</small></label><input id="minimo" name="minimo_numeros" type="number" min="1" required value="50"></div>
          <div><label for="prazo">Data do sorteio <small>Sorteia antes se vender tudo.</small></label><input id="prazo" name="prazo" type="datetime-local" required value="${local}"></div>
        </div>
        <label for="autorizacao">Número da autorização <small>Certificado de autorização do sorteio, se você já tiver.</small></label>
        <input id="autorizacao" name="autorizacao" maxlength="120">
        <div class="cartao destaque" id="simulador" style="margin-top:16px"></div>
        <p class="pequeno suave">Ao criar, você confirma que tem autorização legal para esta rifa e que vai entregar o prêmio. Depois de criada, as regras não mudam mais — é isso que dá confiança para quem compra.</p>
        <p class="erro" role="alert"></p>
        <button type="submit" class="largo">Criar rifa</button>
      </form>`;
    const form = document.getElementById('criar');
    const centavos = () => Math.round(parseFloat(String(form.elements.preco.value).replace(/\./g, '').replace(',', '.')) * 100);
    function simular() {
      const preco = centavos(), total = Number(form.elements.total_numeros.value), minimo = Number(form.elements.minimo_numeros.value);
      const linha = (rotulo, qtd) => {
        const bruto = qtd * preco, taxa = Math.round(bruto * config.taxa_percentual / 100);
        return `<tr><td>${rotulo}</td><td class="valor">${reais(bruto)}</td><td class="valor">${reais(taxa)}</td><td class="valor"><b>${reais(bruto - taxa)}</b></td></tr>`;
      };
      document.getElementById('simulador').innerHTML = (preco > 0 && total > 0 && minimo > 0 && minimo <= total)
        ? `<h3>Quanto você recebe</h3><table><tr><th></th><th class="valor">Arrecada</th><th class="valor">Taxa ${porcento(config.taxa_percentual)}</th><th class="valor">Você recebe</th></tr>
           ${linha('Se vender tudo', total)}${minimo < total ? linha('Se vender só o mínimo', minimo) : ''}</table>
           <p class="pequeno suave" style="margin-top:8px">Lembre de descontar o custo do prêmio. A tarifa do Pix já está dentro da taxa.</p>`
        : '<p class="suave">Preencha preço, quantidade e mínimo para ver quanto você recebe.</p>';
    }
    form.addEventListener('input', simular);
    simular();
    formulario(form, async (d) => {
      const preco = centavos();
      if (!(preco >= 100)) throw new Error('O preço mínimo de cada número é R$ 1,00.');
      const r = await api('POST', '/api/rifas', { ...d, preco_centavos: preco, total_numeros: Number(d.total_numeros), minimo_numeros: Number(d.minimo_numeros), prazo: new Date(d.prazo).getTime() });
      location.hash = `#/r/${r.slug}`;
    });
  }

  // ---------- Roteador ----------
  function cabecalho() {
    document.getElementById('link-conta').textContent = eu ? 'Minhas rifas' : 'Criar rifa';
  }

  async function rotear() {
    temporizadores.forEach(clearInterval);
    temporizadores = [];
    const carrinho = document.querySelector('.carrinho');
    if (carrinho) carrinho.remove();
    const partes = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const [tela, arg] = partes;
    app.innerHTML = '<p class="carregando">Carregando…</p>';
    window.scrollTo(0, 0);
    try {
      if (!tela) await telaInicio();
      else if (tela === 'r' && arg) await telaRifa(arg);
      else if (tela === 'pedido' && arg) await telaPedido(arg);
      else if (tela === 'conferir' && arg) await telaConferir(arg);
      else if (tela === 'meus-numeros') telaMeusNumeros();
      else if (tela === 'como-funciona') telaComoFunciona();
      else if (tela === 'entrar') telaEntrar();
      else if (tela === 'painel') await telaPainel();
      else if (tela === 'criar') telaCriar();
      else if (tela === 'admin') await telaAdmin();
      else app.innerHTML = '<div class="cartao"><h1>Página não encontrada</h1><a class="botao" href="#/">Voltar ao início</a></div>';
    } catch (e) {
      app.innerHTML = `<div class="cartao perigo"><h1>Ops</h1><p>${esc(e.message)}</p><a class="botao" href="#/">Voltar ao início</a></div>`;
    }
  }

  (async () => {
    try {
      [config, eu] = await Promise.all([api('GET', '/api/config'), api('GET', '/api/eu')]);
    } catch { /* segue com o padrão */ }
    document.getElementById('nome-plataforma').textContent = config.nome;
    document.title = `${config.nome} — rifas online que você pode conferir`;
    document.getElementById('aviso-teste').hidden = config.pagamento !== 'simulado';
    cabecalho();
    window.addEventListener('hashchange', rotear);
    rotear();
  })();
})();
