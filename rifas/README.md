# Rifa Clara — plataforma de rifas online

Rifas com Pix, devolução automática e sorteio que qualquer pessoa confere.

## O que faz

- **Organizador** cria a rifa (prêmio, preço, quantidade de números, mínimo para valer, data).
- **Cliente** escolhe os números, paga com Pix e recebe um link de comprovante. Não precisa criar conta.
- **Pagamento confirmado sozinho.** Caiu o Pix, o número é do cliente.
- **Devolução automática** quando: o cliente desiste (até 7 dias, com a rifa ainda vendendo), a rifa não bate o mínimo, o organizador cancela, ou o Pix chega depois que a reserva venceu.
- **Sorteio automático** quando vende tudo ou quando chega a data.
- **Registro público** de tudo o que acontece, com conferência feita no celular do próprio cliente.
- **Repasse**: o organizador só recebe depois que o ganhador confirma que recebeu o prêmio.

## Rodar

Precisa só do [Node.js](https://nodejs.org) 22.13 ou mais novo. Não tem nada para instalar.

```
cd rifas
node --no-warnings server.js
```

Abra http://localhost:3000. Ele começa em **modo de teste**: aparece um botão "Simular pagamento" e nenhum dinheiro entra ou sai.

Testes automáticos: `npm test`

## Configurar

Copie `.env.example` para `.env`, preencha e rode com `node --env-file=.env --no-warnings server.js`.

| Ajuste | Para que serve | Padrão |
|---|---|---|
| `TAXA_PLATAFORMA` | % que a plataforma fica de cada rifa | `10` |
| `ADMIN_EMAIL` | Quem se cadastra com esse e-mail vira administrador | vazio |
| `PAGAMENTO` | `simulado` ou `mercadopago` | `simulado` |
| `MP_ACCESS_TOKEN` | Chave da sua conta Mercado Pago | vazio |
| `URL_BASE` | Endereço público do site | `http://localhost:3000` |

A taxa vale para as rifas criadas dali em diante. Rifa já criada mantém a taxa com que nasceu.

## A divisão do dinheiro

```
taxa da plataforma = arrecadado × TAXA_PLATAFORMA ÷ 100
organizador recebe = arrecadado − taxa da plataforma
```

A tarifa do Pix sai da parte da plataforma. Exemplo com 100 números a R$ 10 (R$ 1.000 arrecadados) e Pix a 0,99%:

| Taxa | Organizador recebe | Plataforma fica | Tarifa do Pix | Sobra para a plataforma |
|---|---|---|---|---|
| 10% | R$ 900 | R$ 100 | R$ 9,90 | R$ 90,10 |
| 20% | R$ 800 | R$ 200 | R$ 9,90 | R$ 190,10 |
| 30% | R$ 700 | R$ 300 | R$ 9,90 | R$ 290,10 |

Rifa cancelada: ninguém paga taxa. Confirme no Mercado Pago se a tarifa do Pix é devolvida no estorno.

O dinheiro das vendas entra na conta Mercado Pago da plataforma. Depois do sorteio, o administrador faz o Pix do repasse para a chave do organizador e marca como pago na "Área da plataforma". Isso fica no registro público.

## Como o sorteio funciona

1. As vendas encerram. A lista de números pagos é fechada e gravada no registro público.
2. No mesmo instante, o sistema grava qual rodada **futura** do [drand](https://drand.love) vai decidir o sorteio. O drand é uma rede pública que solta um número aleatório a cada poucos segundos. Ninguém sabe o número antes.
3. Quando a rodada sai: `ganhador = lista[ SHA256(número_do_drand + ":" + código_da_rifa) mod quantidade ]`.

A página "Conferir" de cada rifa busca o número direto no drand e refaz a conta no aparelho do cliente.

O registro é uma corrente: cada linha carrega a impressão digital da linha anterior. Mudar algo no passado quebra todas as linhas seguintes.

## Colocar no ar gastando pouco

- **Servidor**: é um programa só, com o banco num arquivo (`dados/rifas.db`). Roda em qualquer máquina pequena: uma VM gratuita (Oracle Cloud Always Free) ou uma VPS de R$ 20–30 por mês. Tem `Dockerfile`.
- **https**: é obrigatório para o Mercado Pago avisar os pagamentos e para a conferência no celular. O jeito mais simples é pôr o [Caddy](https://caddyserver.com) na frente (certificado grátis).
- **Domínio**: cerca de R$ 40 por ano (.com.br).
- **Pix**: só a tarifa por pagamento recebido. Sem mensalidade.
- **Cópia de segurança**: copie o arquivo `dados/rifas.db` todo dia.

Roda em **uma máquina só** (o banco é um arquivo). Dá conta de muita rifa; não ligue duas cópias ao mesmo tempo no mesmo banco.

## Antes de receber dinheiro de verdade

1. **Autorização legal.** No Brasil, rifa com venda de números precisa de autorização do governo federal (Lei 5.768/71; hoje pela Secretaria de Prêmios e Apostas do Ministério da Fazenda) e, em regra, só é dada a entidades sem fins lucrativos. Rifa sem autorização é contravenção penal. Fale com um advogado sobre o modelo antes de abrir ao público.
2. **Mercado Pago.** A integração foi escrita seguindo a API de pagamentos Pix, mas ainda **não foi testada com uma conta real**. Faça uma compra de R$ 1 e um estorno antes de divulgar.
3. **drand.** Os testes usam um drand de mentira. Confirme que o servidor consegue acessar `api.drand.sh` (o primeiro sorteio de teste mostra isso).
4. **Termos de uso e política de privacidade** (LGPD): o sistema guarda nome, telefone e e-mail dos compradores.
