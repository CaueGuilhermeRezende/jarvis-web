/**
 * JARVIS · Captura automática de transações
 * ==========================================
 * Recebe os lançamentos enviados pelos Atalhos do iPhone (Apple Pay, Pix
 * pelo atalho) e guarda na aba "Captura" desta planilha. O JARVIS busca os
 * pendentes quando é aberto. Roda na SUA conta Google, sem servidor nosso.
 *
 * Como instalar: veja o README do JARVIS ("Captura automática").
 * Depois de mudar este código: Implantar > Gerenciar implantações > editar >
 * Versão: "Nova versão" > Implantar (a URL continua a mesma).
 *
 * Segurança:
 *  - Só aceita pedidos com a chave gerada no JARVIS. A planilha guarda apenas
 *    o hash SHA-256 das chaves (aba oculta "Config"), nunca a chave.
 *  - O Apps Script não deixa ler o cabeçalho Authorization; por isso a chave
 *    vai no corpo JSON ("token"). A conexão é sempre HTTPS.
 *  - Nada é registrado em log.
 *
 * IMPORTANTE: chaveEstabelecimento_ e valorCentavos_ são cópias de
 * merchantKey/parseCaptureAmount (lib/domain/finance/capture.dart). Os casos
 * em test/fixtures/capture_cases.json valem para as duas.
 *
 * @OnlyCurrentDoc
 */

var VERSAO_SCRIPT = '1';
var ABA_CAPTURA = 'Captura';
var ABA_REGRAS = 'Regras';
var ABA_CONFIG = 'Config';
var SEM_CATEGORIA = 'Sem categoria';
var JANELA_DUPLICADO_MS = 3 * 60 * 1000;
var ORIGENS = ['apple_pay', 'pix', 'manual', 'sms', 'email'];
var CABECALHO_CAPTURA = ['ID', 'Recebido em', 'Data/hora', 'Tipo', 'Valor (R$)', 'Descrição', 'Origem', 'Conta',
  'Categoria sugerida', 'Revisar', 'Chave', 'Trazido ao JARVIS em'];

// ------------------------------------------------------------- entrada --

function doGet() {
  return json_({ ok: true, mensagem: 'JARVIS · captura ativa (script v' + VERSAO_SCRIPT + ').' });
}

function doPost(e) {
  var corpo;
  try {
    corpo = lerCorpo_(e);
  } catch (err) {
    return json_({ ok: false, mensagem: 'Pedido inválido: envie um JSON.' });
  }
  return json_(processar_(corpo, servicosGoogle_()));
}

function lerCorpo_(e) {
  var txt = e && e.postData && e.postData.contents;
  if (txt) return JSON.parse(txt);
  return (e && e.parameter) || {};
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Toda a regra, sem depender do Google (os testes passam serviços falsos). */
function processar_(corpo, s) {
  try {
    if (!corpo || typeof corpo !== 'object') return { ok: false, mensagem: 'Pedido inválido: envie um JSON.' };
    var acao = String(corpo.acao || 'capturar');
    var token = String(corpo.token || '');
    var cfg = s.lerConfig();
    if (acao === 'capturar') {
      if (!tokenOk_(token, cfg.captura, s)) return { ok: false, mensagem: 'Chave inválida ou revogada. Gere uma nova no JARVIS (Ajustes > Captura automática).' };
      return s.travar(function () { return capturar_(corpo, s); });
    }
    if (acao === 'pendentes' || acao === 'confirmar') {
      if (!tokenOk_(token, cfg.app, s)) return { ok: false, mensagem: 'Chave do app inválida ou revogada.' };
      if (acao === 'pendentes') return pendentes_(s);
      return s.travar(function () { return confirmar_(corpo, s); });
    }
    return { ok: false, mensagem: 'Ação desconhecida.' };
  } catch (err) {
    return { ok: false, mensagem: 'Erro no script: ' + ((err && err.message) || err) };
  }
}

function tokenOk_(token, hashEsperado, s) {
  if (!token || !hashEsperado) return false;
  return s.sha256Hex(token) === String(hashEsperado).toLowerCase();
}

// ------------------------------------------------------------- captura --

function capturar_(c, s) {
  var tipo = tipo_(c.tipo);
  if (!tipo) return { ok: false, mensagem: 'Tipo inválido: use "saida" ou "entrada".' };
  var centavos = valorCentavos_(c.valor);
  if (centavos === null) return { ok: false, mensagem: 'Valor inválido: "' + String(c.valor === undefined ? '' : c.valor).slice(0, 30) + '".' };
  var origem = String(c.origem || 'manual').trim().toLowerCase();
  if (ORIGENS.indexOf(origem) < 0) return { ok: false, mensagem: 'Origem inválida: use ' + ORIGENS.join(', ') + '.' };
  var descricao = String(c.descricao || c.comerciante || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (origem === 'apple_pay' && !descricao) return { ok: false, mensagem: 'Falta o nome do estabelecimento (Comerciante).' };
  var conta = String(c.conta || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  var agora = s.agora();
  var quando = agora;
  if (c.data) {
    quando = new Date(String(c.data));
    if (isNaN(quando.getTime())) return { ok: false, mensagem: 'Data inválida: use o formato ISO 8601.' };
    if (quando.getTime() > agora.getTime() + 24 * 3600 * 1000) return { ok: false, mensagem: 'Data no futuro.' };
  }
  var chave = chaveEstabelecimento_(descricao);

  // Idempotência: mesmo tipo, valor e lugar em até 3 minutos = repetição.
  var anteriores = s.lerCapturas();
  for (var i = 0; i < anteriores.length; i++) {
    var a = anteriores[i];
    if (a.tipo === tipo && a.centavos === centavos && a.chave === chave &&
        Math.abs(a.quando - quando.getTime()) <= JANELA_DUPLICADO_MS) {
      return { ok: true, duplicado: true, id: a.id, mensagem: 'Já estava registrado: ' + frase_(tipo, origem, centavos, descricao) + '.' };
    }
  }

  var cat = descricao ? categoria_(chave, tipo, s.lerRegras()) : { categoria: SEM_CATEGORIA, revisar: true };
  var id = s.uuid();
  s.anexarCaptura([id, agora.toISOString(), quando.toISOString(), tipo, (tipo === 'saida' ? -centavos : centavos) / 100,
    texto_(descricao), origem, texto_(conta), cat.categoria, cat.revisar ? 'sim' : '', texto_(chave), '']);
  return { ok: true, id: id, categoria: cat.categoria, revisar: cat.revisar, mensagem: mensagem_(tipo, origem, centavos, descricao, cat) };
}

function tipo_(v) {
  var t = semAcento_(String(v || '').trim().toLowerCase());
  if (['saida', 'gasto', 'pagamento', 'enviado', 'enviei', 'fiz'].indexOf(t) >= 0) return 'saida';
  if (['entrada', 'recebido', 'recebi', 'recebimento'].indexOf(t) >= 0) return 'entrada';
  return null;
}

/** Texto que a planilha não pode confundir com fórmula. */
function texto_(v) {
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function frase_(tipo, origem, centavos, descricao) {
  var v = brl_(centavos);
  if (origem === 'pix') {
    var base = tipo === 'entrada' ? 'Você recebeu um Pix de ' + v : 'Você fez um Pix de ' + v;
    return descricao ? base + ' (' + descricao + ')' : base;
  }
  if (tipo === 'entrada') return 'Entrada de ' + v + (descricao ? ' (' + descricao + ')' : '');
  return v + (descricao ? ' em ' + descricao : '');
}

function mensagem_(tipo, origem, centavos, descricao, cat) {
  var f = frase_(tipo, origem, centavos, descricao);
  var verbo = (tipo === 'entrada' && origem !== 'pix') ? 'registrada' : 'registrado';
  if (!descricao) return f + ', ' + verbo + '. Complete a descrição e a categoria no JARVIS.';
  if (cat.categoria === SEM_CATEGORIA) return f + ' ' + verbo + '. Escolha a categoria no JARVIS.';
  return f + ' ' + verbo + ' como ' + cat.categoria + (cat.revisar ? ' (confira no JARVIS).' : '.');
}

/** 1) loja já conhecida; 2) palavra-chave (confira); 3) sem categoria. */
function categoria_(chave, tipo, regras) {
  if (chave && regras.lojas[chave]) return { categoria: regras.lojas[chave], revisar: false };
  var natureza = tipo === 'entrada' ? 'entrada' : 'gasto';
  var txt = ' ' + chave.toLowerCase() + ' ';
  for (var i = 0; i < regras.palavras.length; i++) {
    var p = regras.palavras[i];
    if (p.natureza === natureza && txt.indexOf(' ' + p.palavra + ' ') >= 0) return { categoria: p.categoria, revisar: true };
  }
  return { categoria: SEM_CATEGORIA, revisar: true };
}

// ------------------------------------------------------ para o JARVIS --

function pendentes_(s) {
  var itens = [];
  var todas = s.lerCapturas();
  for (var i = 0; i < todas.length && itens.length < 200; i++) {
    var a = todas[i];
    if (a.trazido) continue;
    itens.push({ id: a.id, tipo: a.tipo, centavos: a.centavos, descricao: a.descricao, dataHora: new Date(a.quando).toISOString(), origem: a.origem, conta: a.conta });
  }
  return { ok: true, itens: itens };
}

function confirmar_(c, s) {
  var ids = Array.isArray(c.ids) ? c.ids.map(String) : [];
  var n = ids.length ? s.marcarTrazidos(ids, s.agora().toISOString()) : 0;
  return { ok: true, confirmados: n };
}

// ------------------------------------------------- regras compartilhadas --

var ACENTOS_ = { 'Á': 'A', 'À': 'A', 'Â': 'A', 'Ã': 'A', 'Ä': 'A', 'É': 'E', 'È': 'E', 'Ê': 'E', 'Ë': 'E',
  'Í': 'I', 'Ì': 'I', 'Î': 'I', 'Ï': 'I', 'Ó': 'O', 'Ò': 'O', 'Ô': 'O', 'Õ': 'O', 'Ö': 'O',
  'Ú': 'U', 'Ù': 'U', 'Û': 'U', 'Ü': 'U', 'Ç': 'C', 'Ñ': 'N' };
var INTERMEDIARIOS_ = { PAG: 1, PAGSEGURO: 1, PG: 1, MP: 1, MERCADOPAGO: 1, IFD: 1, SUMUP: 1, STONE: 1, CIELO: 1, GETNET: 1,
  EBANX: 1, PAYPAL: 1, PICPAY: 1, SQ: 1, EC: 1, ZP: 1, ZOOP: 1, PIX: 1 };
var RUIDO_ = { LTDA: 1, ME: 1, EPP: 1, EIRELI: 1, MEI: 1, SA: 1, CIA: 1, FILIAL: 1, LOJA: 1, UNIDADE: 1 };

function semAcento_(s) {
  return s.toUpperCase().split('').map(function (c) { return ACENTOS_[c] || c; }).join('').toLowerCase();
}

/** "Armazzem Conveniência Ltda." → "ARMAZZEM CONVENIENCIA" (ver merchantKey). */
function chaveEstabelecimento_(raw) {
  var s = String(raw || '').toUpperCase();
  s = s.split('').map(function (c) { return ACENTOS_[c] || c; }).join('');
  var m = /^\s*([A-Z0-9]{1,12})\s*\*\s*(.+)$/.exec(s);
  if (m && INTERMEDIARIOS_[m[1]]) s = m[2];
  s = s.split('S/A').join(' SA ').replace(/[^A-Z0-9]+/g, ' ').trim();
  var w = s.split(' ').filter(function (x) { return x.length > 0; });
  while (w.length > 1 && (/^\d+$/.test(w[w.length - 1]) || RUIDO_[w[w.length - 1]])) w.pop();
  return w.join(' ');
}

/** "R$ 6,59" / "1.234,56" / "1,234.56" / 6.59 → centavos; inválido → null (ver parseCaptureAmount). */
function valorCentavos_(raw) {
  if (typeof raw === 'number') {
    var cn = Math.round(Math.abs(raw) * 100);
    return cn > 0 && cn <= 10000000000 ? cn : null;
  }
  if (typeof raw !== 'string') return null;
  var s = raw.replace(/[^0-9.,]/g, '');
  if (!s || !/\d/.test(s)) return null;
  var last = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  var inteiro;
  var frac = '';
  if (last < 0) {
    inteiro = s;
  } else {
    var depois = s.slice(last + 1);
    var outro = s[last] === '.' ? ',' : '.';
    var soUmTipo = s.slice(0, last).indexOf(outro) < 0;
    if ((depois.length === 3 && soUmTipo) || depois.length === 0) {
      inteiro = s.replace(/[.,]/g, '');
    } else if (depois.length <= 2) {
      inteiro = s.slice(0, last).replace(/[.,]/g, '');
      frac = depois;
    } else {
      return null;
    }
  }
  if (!inteiro) inteiro = '0';
  if (inteiro.length > 12) return null;
  var c = parseInt(inteiro, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
  return c > 0 && c <= 10000000000 ? c : null;
}

function brl_(centavos) {
  var reais = String(Math.floor(centavos / 100));
  var b = '';
  for (var i = 0; i < reais.length; i++) {
    if (i > 0 && (reais.length - i) % 3 === 0) b += '.';
    b += reais[i];
  }
  return 'R$ ' + b + ',' + ('0' + (centavos % 100)).slice(-2);
}

/** Bytes com sinal (Utilities.computeDigest) → hex minúsculo. */
function hex_(bytes) {
  return bytes.map(function (b) { var v = b < 0 ? b + 256 : b; return (v < 16 ? '0' : '') + v.toString(16); }).join('');
}

// ------------------------------------------------- serviços do Google --

function servicosGoogle_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  function abaCaptura() {
    var sh = ss.getSheetByName(ABA_CAPTURA);
    if (!sh) {
      sh = ss.insertSheet(ABA_CAPTURA);
      sh.appendRow(CABECALHO_CAPTURA);
      sh.setFrozenRows(1);
    }
    return sh;
  }
  function ms(v) { return v instanceof Date ? v.getTime() : Date.parse(String(v)); }
  return {
    agora: function () { return new Date(); },
    uuid: function () { return Utilities.getUuid(); },
    sha256Hex: function (t) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, t, Utilities.Charset.UTF_8)); },
    travar: function (fn) {
      var lock = LockService.getScriptLock();
      lock.waitLock(15000);
      try { return fn(); } finally { lock.releaseLock(); }
    },
    lerConfig: function () {
      var cfg = {};
      var sh = ss.getSheetByName(ABA_CONFIG);
      if (!sh || sh.getLastRow() < 1) return cfg;
      var v = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
      for (var i = 0; i < v.length; i++) cfg[String(v[i][0])] = String(v[i][1] || '');
      return cfg;
    },
    lerRegras: function () {
      var r = { lojas: {}, palavras: [] };
      var sh = ss.getSheetByName(ABA_REGRAS);
      if (!sh || sh.getLastRow() < 2) return r;
      var v = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
      for (var i = 0; i < v.length; i++) {
        var tipo = String(v[i][0]), chave = String(v[i][1]), cat = String(v[i][2]);
        if (!chave || !cat) continue;
        if (tipo === 'loja') r.lojas[chave] = cat;
        else if (tipo === 'palavra') r.palavras.push({ palavra: chave, categoria: cat, natureza: String(v[i][3]) });
      }
      return r;
    },
    lerCapturas: function () {
      var sh = abaCaptura();
      if (sh.getLastRow() < 2) return [];
      var v = sh.getRange(2, 1, sh.getLastRow() - 1, CABECALHO_CAPTURA.length).getValues();
      var out = [];
      for (var i = 0; i < v.length; i++) {
        var l = v[i];
        if (!l[0]) continue;
        out.push({ id: String(l[0]), quando: ms(l[2]), tipo: String(l[3]), centavos: Math.round(Math.abs(Number(l[4])) * 100),
          descricao: String(l[5]), origem: String(l[6]), conta: String(l[7]), chave: String(l[10]), trazido: !!l[11] });
      }
      return out;
    },
    anexarCaptura: function (linha) { abaCaptura().appendRow(linha); },
    marcarTrazidos: function (ids, quando) {
      var sh = abaCaptura();
      if (sh.getLastRow() < 2) return 0;
      var col = CABECALHO_CAPTURA.length;
      var idsPlan = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
      var marc = sh.getRange(2, col, sh.getLastRow() - 1, 1).getValues();
      var n = 0;
      for (var i = 0; i < idsPlan.length; i++) {
        if (ids.indexOf(String(idsPlan[i][0])) >= 0 && !marc[i][0]) { marc[i][0] = quando; n++; }
      }
      if (n) sh.getRange(2, col, marc.length, 1).setValues(marc);
      return n;
    },
  };
}
