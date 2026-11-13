// Sorteio que qualquer pessoa pode conferir.
//
// 1. Quando a rifa encerra, a lista de números pagos é congelada e publicada.
// 2. No mesmo instante, a rifa aponta para uma rodada FUTURA do drand —
//    uma rede pública que gera um número aleatório a cada poucos segundos.
//    Ninguém (nem nós) sabe esse número antes da hora.
// 3. Quando a rodada sai, a conta abaixo define o ganhador. Sempre dá o mesmo
//    resultado, então qualquer um pode refazer e conferir.
const crypto = require('node:crypto');

const sha256 = (texto) => crypto.createHash('sha256').update(texto).digest('hex');

function hashDaLista(numerosPagos) {
  return sha256(numerosPagos.join(','));
}

// numerosPagos precisa estar em ordem crescente.
function calcularGanhador(aleatorioHex, rifaId, numerosPagos) {
  const semente = sha256(`${aleatorioHex}:${rifaId}`);
  const posicao = Number(BigInt('0x' + semente) % BigInt(numerosPagos.length));
  return { semente, posicao, numero: numerosPagos[posicao] };
}

function clienteDrand(url) {
  let info = null;
  async function pegar(caminho) {
    const r = await fetch(url + caminho, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`drand respondeu ${r.status}`);
    return r.json();
  }
  return {
    url,
    async rodadaNoInstante(ms) {
      if (!info) info = await pegar('/info');
      const seg = Math.floor(ms / 1000);
      return Math.max(1, Math.floor((seg - info.genesis_time) / info.period) + 1);
    },
    async instanteDaRodada(rodada) {
      if (!info) info = await pegar('/info');
      return (info.genesis_time + (rodada - 1) * info.period) * 1000;
    },
    async buscar(rodada) {
      const b = await pegar('/public/' + rodada);
      if (b.round !== rodada) throw new Error('drand devolveu outra rodada');
      const conferido = crypto.createHash('sha256').update(Buffer.from(b.signature, 'hex')).digest('hex');
      if (conferido !== b.randomness) throw new Error('aleatório do drand não confere com a assinatura');
      return { aleatorio: b.randomness, assinatura: b.signature };
    },
  };
}

module.exports = { sha256, hashDaLista, calcularGanhador, clienteDrand };
