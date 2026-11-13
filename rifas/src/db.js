// Banco de dados: SQLite embutido no Node (sem instalar nada).
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function abrirBanco(arquivo) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      senha_hash TEXT NOT NULL,
      chave_pix TEXT NOT NULL DEFAULT '',
      papel TEXT NOT NULL DEFAULT 'organizador',
      criado_em INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessoes (
      token TEXT PRIMARY KEY,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
      expira_em INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rifas (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      organizador_id INTEGER NOT NULL REFERENCES usuarios(id),
      titulo TEXT NOT NULL,
      descricao TEXT NOT NULL DEFAULT '',
      premio TEXT NOT NULL,
      imagem_url TEXT NOT NULL DEFAULT '',
      autorizacao TEXT NOT NULL DEFAULT '',
      preco_centavos INTEGER NOT NULL,
      total_numeros INTEGER NOT NULL,
      minimo_numeros INTEGER NOT NULL,
      prazo INTEGER NOT NULL,
      taxa_percentual REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'aberta',      -- aberta | encerrada | sorteada | cancelada
      motivo_cancelamento TEXT NOT NULL DEFAULT '',
      encerrada_em INTEGER,
      hash_lista TEXT,
      rodada_drand INTEGER,
      aleatorio_drand TEXT,
      assinatura_drand TEXT,
      sorteada_em INTEGER,
      numero_ganhador INTEGER,
      pedido_ganhador TEXT,
      arrecadado_centavos INTEGER,
      repasse_centavos INTEGER,
      taxa_centavos INTEGER,
      premio_confirmado_em INTEGER,
      repasse_status TEXT NOT NULL DEFAULT 'aguardando', -- aguardando | liberado | pago
      repasse_pago_em INTEGER,
      criada_em INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pedidos (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      rifa_id TEXT NOT NULL REFERENCES rifas(id),
      nome TEXT NOT NULL,
      telefone TEXT NOT NULL,
      email TEXT NOT NULL,
      numeros TEXT NOT NULL,                      -- JSON com os números do pedido
      codigo_publico TEXT NOT NULL DEFAULT '',    -- é isso que aparece em público, no lugar do nome
      valor_centavos INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'reservado',   -- reservado | pago | expirado | estornando | estornado
      pagamento_id TEXT,
      pix_copia_cola TEXT,
      pix_qr_base64 TEXT,
      expira_em INTEGER NOT NULL,
      pago_em INTEGER,
      estornado_em INTEGER,
      motivo_estorno TEXT NOT NULL DEFAULT '',
      criado_em INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pedidos_rifa ON pedidos(rifa_id, status);
    CREATE INDEX IF NOT EXISTS pedidos_contato ON pedidos(telefone, email);
    CREATE INDEX IF NOT EXISTS pedidos_pagamento ON pedidos(pagamento_id);

    -- Um número só pode pertencer a um pedido: a chave primária garante isso.
    CREATE TABLE IF NOT EXISTS numeros (
      rifa_id TEXT NOT NULL REFERENCES rifas(id),
      numero INTEGER NOT NULL,
      pedido_id TEXT NOT NULL REFERENCES pedidos(id),
      PRIMARY KEY (rifa_id, numero)
    );
    CREATE INDEX IF NOT EXISTS numeros_pedido ON numeros(pedido_id);

    -- Registro público: cada linha guarda o hash da linha anterior.
    CREATE TABLE IF NOT EXISTS registro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rifa_id TEXT NOT NULL REFERENCES rifas(id),
      seq INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      dados TEXT NOT NULL,
      criado_em INTEGER NOT NULL,
      hash_anterior TEXT NOT NULL,
      hash TEXT NOT NULL,
      UNIQUE (rifa_id, seq)
    );
  `);
  // Bancos criados antes do código público ganham a coluna nova.
  const colunas = db.prepare('PRAGMA table_info(pedidos)').all().map((c) => c.name);
  if (!colunas.includes('codigo_publico')) db.exec("ALTER TABLE pedidos ADD COLUMN codigo_publico TEXT NOT NULL DEFAULT ''");
  return db;
}

// Executa várias gravações como uma coisa só: ou tudo vale, ou nada vale.
function transacao(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { abrirBanco, transacao };
