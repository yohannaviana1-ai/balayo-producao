/* Balayó — backup, validação e importação dos dados (sem tela).
   Formato documentado em docs/ETAPA-1-PROTECAO-DADOS.md.
   Regras:
   - o backup é montado a partir de uma lista EXPLÍCITA de dados (nada de copiar todo o armazenamento);
   - nenhum arquivo leva PIN, senha, verificadores (hash) ou dados de sessão;
   - a impressão digital (SHA-256) detecta arquivo alterado ou corrompido, mas NÃO é criptografia nem prova de autoria;
   - importar nunca altera o PIN e a senha do aparelho e nunca apaga registros de operação. */
(function (raiz) {
  'use strict';
  const FORMATO = 'balayo-backup';
  const VERSAO_FORMATO = 1;
  const COLECOES = ['insumos', 'preparos', 'produtos', 'bebidas', 'checklists', 'fichas', 'embalagens', 'componentesCat'];
  const NOMES = { insumos: 'Insumos', preparos: 'Preparos', produtos: 'Produtos do cardápio', bebidas: 'Receitas do bar', checklists: 'Modelos de checklist',
    fichas: 'Fichas técnicas', embalagens: 'Formas e embalagens', componentesCat: 'Lista de componentes', config: 'Configurações',
    respostas: 'Respostas de checklist', registros: 'Registros (acessos e checklists)', producao: 'Lista de produção do dia' };
  // Campos de acesso: nunca saem do aparelho e nunca são trocados por uma importação
  const CAMPOS_ACESSO = ['pinHash', 'pinLen', 'adminHash', 'pinPadrao', 'adminPadrao'];
  const copia = o => o === undefined ? undefined : JSON.parse(JSON.stringify(o));

  /* ---------- SHA-256 (implementação própria: funciona em qualquer navegador, sem depender de HTTPS) ---------- */
  const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    const s = unescape(encodeURIComponent(str)), b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }
  function sha256(str) {
    const bytes = utf8(str), l = bytes.length;
    const tam = ((l + 9 + 63) >> 6) << 6;
    const m = new Uint8Array(tam); m.set(bytes); m[l] = 0x80;
    const dv = new DataView(m.buffer);
    dv.setUint32(tam - 8, Math.floor(l / 0x20000000)); dv.setUint32(tam - 4, (l << 3) >>> 0);
    let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Uint32Array(64);
    for (let off = 0; off < tam; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H = [H[0] + a, H[1] + b, H[2] + c, H[3] + d, H[4] + e, H[5] + f, H[6] + g, H[7] + h].map(x => x >>> 0);
    }
    return H.map(x => ('00000000' + x.toString(16)).slice(-8)).join('');
  }

  /* ---------- JSON canônico: chaves em ordem alfabética, sem espaços (base da impressão digital) ---------- */
  function canonico(v) {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'number' && !isFinite(v)) return 'null';
      return JSON.stringify(v);
    }
    if (Array.isArray(v)) return '[' + v.map(x => (x === undefined || typeof x === 'function') ? 'null' : canonico(x)).join(',') + ']';
    const ks = Object.keys(v).filter(k => v[k] !== undefined && typeof v[k] !== 'function').sort();
    return '{' + ks.map(k => JSON.stringify(k) + ':' + canonico(v[k])).join(',') + '}';
  }
  const iguais = (a, b) => canonico(a) === canonico(b);

  /* ---------- Montar o backup ---------- */
  // Cadastros sem nenhum campo de acesso. Tipo "equipe" tira também preços e custos.
  function limparCadastros(db, tipo) {
    const c = copia(db) || {};
    const cfg = c.config || {};
    CAMPOS_ACESSO.forEach(k => { delete cfg[k]; });
    const out = { version: c.version, config: cfg, semIds: Array.isArray(c.semIds) ? c.semIds : [] };
    COLECOES.forEach(col => { out[col] = Array.isArray(c[col]) ? c[col] : []; });
    if (tipo === 'equipe') {
      delete cfg.custos;
      out.insumos.forEach(i => { delete i.preco; delete i.precoHist; delete i.precoEm; });
      out.produtos.forEach(p => { delete p.preco; delete p.emb; });
    }
    return out;
  }
  function contagens(dados) {
    const c = {};
    COLECOES.forEach(col => { c[col] = (dados.cadastros[col] || []).length; });
    if (dados.operacao) {
      c.respostas = Object.keys(dados.operacao.respostas || {}).length;
      c.registros = (dados.operacao.registros || []).length;
      c.producao = ((dados.operacao.producao || {}).itens || []).length;
    }
    return c;
  }
  // entrada: { db, operacao: { producao, respostas: {chave: estado}, registros: [] } }
  // meta: { tipo: 'completo'|'equipe', appVersao, origem, observacao }
  function montarBackup(entrada, meta) {
    const tipo = meta.tipo === 'equipe' ? 'equipe' : 'completo';
    const dados = { cadastros: limparCadastros(entrada.db, tipo) };
    if (tipo === 'completo') {
      const op = entrada.operacao || {};
      dados.operacao = { producao: copia(op.producao) || null, respostas: copia(op.respostas) || {}, registros: copia(op.registros) || [] };
    }
    const agora = meta.agora || new Date();
    return {
      formato: FORMATO, versaoFormato: VERSAO_FORMATO, tipo,
      app: { nome: 'Balayó', versao: meta.appVersao || '' },
      exportadoEm: agora.toISOString(),
      idExportacao: 'exp_' + agora.getTime().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      origem: meta.origem || '',
      observacao: meta.observacao || '',
      contagens: contagens(dados),
      integridade: { algoritmo: 'SHA-256', escopo: 'dados', serializacao: 'JSON canônico: chaves em ordem alfabética, sem espaços, UTF-8', valor: sha256(canonico(dados)) },
      dados
    };
  }
  // Backup antigo (v1 = cópia direta do banco) -> estrutura atual, descartando os campos de acesso
  function converterV1(obj) {
    return { cadastros: limparCadastros(obj, 'completo'), operacao: null };
  }
  // Para voltar à versão antiga do app (formato que o "Importar backup" antigo aceita), sem campos de acesso
  function paraFormatoV1(cadastros) {
    const c = copia(cadastros); delete c.semIds; c.semIds = cadastros.semIds || []; return c;
  }

  /* ---------- Validação ---------- */
  const ehTexto = v => typeof v === 'string';
  const ehNum = v => typeof v === 'number' && isFinite(v);
  const numOuNulo = v => v === undefined || v === null || ehNum(v);
  function validarCadastros(cad, erros, avisos) {
    if (!cad || typeof cad !== 'object') { erros.push('Faltam os cadastros no arquivo.'); return; }
    if (cad.config !== undefined && (typeof cad.config !== 'object' || Array.isArray(cad.config))) erros.push('Configurações em formato inválido.');
    COLECOES.forEach(col => {
      const lista = cad[col];
      if (lista === undefined) { avisos.push(NOMES[col] + ': não vieram no arquivo.'); return; }
      if (!Array.isArray(lista)) { erros.push(NOMES[col] + ': deveria ser uma lista.'); return; }
      const vistos = {};
      lista.forEach((x, n) => {
        const onde = NOMES[col] + ' nº ' + (n + 1);
        if (!x || typeof x !== 'object' || Array.isArray(x)) { erros.push(onde + ': registro inválido.'); return; }
        if (!ehTexto(x.id) || !x.id) { erros.push(onde + ': falta o identificador (id).'); return; }
        if (vistos[x.id]) erros.push(NOMES[col] + ': identificador repetido "' + x.id + '".');
        vistos[x.id] = 1;
        if (x.nome !== undefined && !ehTexto(x.nome)) erros.push(onde + ': nome deveria ser texto.');
        if (col === 'insumos') {
          if (x.un !== undefined && ['g', 'ml', 'un'].indexOf(x.un) < 0) erros.push(onde + ' (' + (x.nome || x.id) + '): unidade inválida.');
          ['qtd', 'preco', 'pesoUn', 'dens'].forEach(k => { if (!numOuNulo(x[k])) erros.push(onde + ' (' + (x.nome || x.id) + '): "' + k + '" deveria ser número.'); });
        }
        if (col === 'preparos' || col === 'produtos') {
          if (x.itens !== undefined && !Array.isArray(x.itens)) erros.push(onde + ': ingredientes deveriam ser uma lista.');
          (x.itens || []).forEach(it => { if (!it || !numOuNulo(it.q)) erros.push(onde + ' (' + (x.nome || x.id) + '): quantidade inválida.'); });
        }
        if (col === 'fichas') {
          if (x.componentes !== undefined && !Array.isArray(x.componentes)) erros.push(onde + ': componentes deveriam ser uma lista.');
          if (x.rendimentos !== undefined && !Array.isArray(x.rendimentos)) erros.push(onde + ': rendimentos deveriam ser uma lista.');
        }
        if (col === 'checklists' && x.items !== undefined && !Array.isArray(x.items)) erros.push(onde + ': itens deveriam ser uma lista.');
      });
    });
  }
  // Referências entre registros (produto -> insumo/preparo/ficha, ficha -> preparo/embalagem...)
  function referenciasQuebradas(cad) {
    const ids = {}; COLECOES.forEach(col => { ids[col] = {}; (cad[col] || []).forEach(x => { if (x && x.id) ids[col][x.id] = 1; }); });
    const q = [];
    (cad.produtos || []).forEach(p => (p.itens || []).forEach(l => {
      const r = String(l.r || ''), id = r.slice(2), col = r[0] === 'p' ? 'preparos' : r[0] === 'f' ? 'fichas' : 'insumos';
      if (!ids[col][id]) q.push('Produto "' + p.nome + '" usa um item que não existe (' + r + ').');
      if (r[0] === 'f' && l.emb && !ids.embalagens[l.emb]) q.push('Produto "' + p.nome + '" usa uma embalagem que não existe.');
    }));
    (cad.preparos || []).forEach(p => (p.itens || []).forEach(it => {
      if (ids.preparos[it.i]) q.push('Preparo "' + p.nome + '" aponta para outro preparo (dependência não permitida).');
      else if (!ids.insumos[it.i]) q.push('Preparo "' + p.nome + '" usa um insumo que não existe (' + it.i + ').');
    }));
    (cad.fichas || []).forEach(f => {
      (f.componentes || []).forEach(c => {
        if (c.tipo === 'preparo') { if (c.p && !ids.preparos[c.p]) q.push('Ficha "' + f.nome + '": componente "' + c.nome + '" usa um preparo que não existe.'); }
        else (c.itens || []).forEach(it => { if (!ids.insumos[it.i]) q.push('Ficha "' + f.nome + '": componente "' + c.nome + '" usa um insumo que não existe (' + it.i + ').'); });
        if (c.cat && !ids.componentesCat[c.cat]) q.push('Ficha "' + f.nome + '": componente "' + c.nome + '" ligado a um nome que não está na lista (o componente continua na receita).');
      });
      (f.rendimentos || []).forEach(r => { if (r.emb && !ids.embalagens[r.emb]) q.push('Ficha "' + f.nome + '": rendimento ligado a uma embalagem que não existe.'); });
    });
    return q;
  }
  // texto: conteúdo do arquivo. Devolve { ok, formato: 'atual'|'antigo', tipo, erros, avisos, dados, cabecalho }
  function lerArquivo(texto) {
    let obj;
    try { obj = JSON.parse(texto); }
    catch (e) { return { ok: false, erros: ['O arquivo está incompleto ou corrompido (não é um JSON válido). Ele pode ter sido cortado no download ou no envio.'], avisos: [] }; }
    return validarObjeto(obj);
  }
  function validarObjeto(obj) {
    const erros = [], avisos = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, erros: ['Este arquivo não é um backup do Balayó.'], avisos };
    if (obj.formato === FORMATO) {
      if (!ehNum(obj.versaoFormato)) erros.push('Falta a versão do formato.');
      else if (obj.versaoFormato > VERSAO_FORMATO) erros.push('Este backup foi feito por uma versão mais nova do app (formato ' + obj.versaoFormato + '). Atualize o app antes de importar.');
      if (['completo', 'equipe'].indexOf(obj.tipo) < 0) erros.push('Tipo de backup desconhecido.');
      if (!ehTexto(obj.exportadoEm) || isNaN(Date.parse(obj.exportadoEm))) erros.push('Falta a data da exportação.');
      if (!obj.dados || typeof obj.dados !== 'object') erros.push('Faltam os dados do backup.');
      if (!obj.integridade || obj.integridade.algoritmo !== 'SHA-256' || !/^[0-9a-f]{64}$/.test(obj.integridade.valor || '')) erros.push('Falta a verificação de integridade.');
      if (erros.length) return { ok: false, formato: 'atual', erros, avisos, cabecalho: obj };
      if (sha256(canonico(obj.dados)) !== obj.integridade.valor) erros.push('A verificação de integridade falhou: o conteúdo foi alterado ou corrompido depois de exportado.');
      const cont = contagens({ cadastros: obj.dados.cadastros || {}, operacao: obj.dados.operacao });
      if (obj.contagens && !iguais(cont, obj.contagens)) erros.push('As quantidades de registros não batem com o cabeçalho do arquivo.');
      validarCadastros(obj.dados.cadastros, erros, avisos);
      if (obj.tipo === 'completo' && obj.dados.operacao) {
        const op = obj.dados.operacao;
        if (op.respostas && (typeof op.respostas !== 'object' || Array.isArray(op.respostas))) erros.push('Respostas de checklist em formato inválido.');
        if (op.registros && !Array.isArray(op.registros)) erros.push('Registros em formato inválido.');
      }
      if (!erros.length) referenciasQuebradas(obj.dados.cadastros).forEach(r => avisos.push(r));
      CAMPOS_ACESSO.forEach(k => { if (obj.dados.cadastros && obj.dados.cadastros.config && k in obj.dados.cadastros.config) avisos.push('O arquivo trazia dados de acesso: foram ignorados.'); });
      return { ok: !erros.length, formato: 'atual', tipo: obj.tipo, erros, avisos, dados: erros.length ? null : obj.dados, cabecalho: obj };
    }
    if (Array.isArray(obj.insumos) && Array.isArray(obj.produtos) && Array.isArray(obj.preparos)) {
      avisos.push('Backup no formato antigo: não tem verificação de integridade. Confira a prévia com atenção.');
      if (obj.config && (obj.config.pinHash || obj.config.adminHash)) avisos.push('O arquivo antigo trazia verificadores de senha: foram descartados e não serão importados.');
      const dados = converterV1(obj);
      validarCadastros(dados.cadastros, erros, avisos);
      if (!erros.length) referenciasQuebradas(dados.cadastros).forEach(r => avisos.push(r));
      return { ok: !erros.length, formato: 'antigo', tipo: 'completo', erros, avisos, dados: erros.length ? null : dados, cabecalho: null };
    }
    return { ok: false, erros: ['Este arquivo não é um backup do Balayó.'], avisos };
  }

  /* ---------- Comparar com o que está no aparelho ---------- */
  const rotulo = x => (x && (x.nome || x.titulo || x.codigo)) || (x && x.id) || '';
  function compararLista(atual, arquivo, idDe) {
    const mapa = {}; (atual || []).forEach(x => { mapa[idDe(x)] = x; });
    const r = { novos: [], identicos: [], diferentes: [], soNoAparelho: [] }, vistos = {};
    (arquivo || []).forEach(x => {
      const id = idDe(x); vistos[id] = 1;
      if (!(id in mapa)) r.novos.push(rotulo(x) || id);
      else if (iguais(mapa[id], x)) r.identicos.push(rotulo(x) || id);
      else r.diferentes.push(rotulo(x) || id);
    });
    (atual || []).forEach(x => { if (!vistos[idDe(x)]) r.soNoAparelho.push(rotulo(x) || idDe(x)); });
    return r;
  }
  // Remove de uma cópia os campos que não vêm no arquivo, para comparar só o que pode mudar
  function semFinanceiro(lista, col) {
    return (lista || []).map(x => { const c = copia(x); if (col === 'insumos') { delete c.preco; delete c.precoHist; delete c.precoEm; } if (col === 'produtos') { delete c.preco; delete c.emb; } return c; });
  }
  function comparar(atual, dados, tipo) {
    const cadA = limparCadastros(atual.db, 'completo'), cadF = dados.cadastros, res = {};
    COLECOES.forEach(col => {
      const a = tipo === 'equipe' ? semFinanceiro(cadA[col], col) : cadA[col];
      res[col] = compararLista(a, cadF[col] || [], x => x.id);
    });
    const cfgA = copia(cadA.config) || {}, cfgF = copia(cadF.config) || {};
    if (tipo === 'equipe') delete cfgA.custos;
    res.config = iguais(cfgA, cfgF) ? { identicos: ['Configurações'], novos: [], diferentes: [], soNoAparelho: [] } : { identicos: [], novos: [], diferentes: ['Configurações'], soNoAparelho: [] };
    if (dados.operacao) {
      const op = atual.operacao || {}, opF = dados.operacao;
      const lista = o => Object.keys(o || {}).map(k => ({ id: k, nome: k, v: o[k] }));
      res.respostas = compararLista(lista(op.respostas), lista(opF.respostas), x => x.id);
      res.registros = compararLista(op.registros || [], opF.registros || [], x => x.id);
      const pa = op.producao && (op.producao.itens || []).length ? op.producao : null, pf = opF.producao && (opF.producao.itens || []).length ? opF.producao : null;
      res.producao = !pf ? { novos: [], identicos: [], diferentes: [], soNoAparelho: pa ? ['Lista atual'] : [] }
        : !pa ? { novos: ['Lista do arquivo'], identicos: [], diferentes: [], soNoAparelho: [] }
        : iguais(pa, pf) ? { novos: [], identicos: ['Lista'], diferentes: [], soNoAparelho: [] } : { novos: [], identicos: [], diferentes: ['Lista'], soNoAparelho: [] };
    }
    return res;
  }

  /* ---------- Aplicar a importação (não altera os objetos recebidos) ---------- */
  // opcoes: { modo: 'juntar' | 'substituir', conflitos: 'manterAparelho' | 'usarArquivo' }
  function aplicar(atual, dados, tipo, opcoes) {
    const modo = opcoes && opcoes.modo === 'substituir' ? 'substituir' : 'juntar';
    const usarArquivo = modo === 'substituir' || (opcoes && opcoes.conflitos === 'usarArquivo');
    const db = copia(atual.db) || {}, cadF = copia(dados.cadastros);
    const acesso = {}; CAMPOS_ACESSO.forEach(k => { if (db.config && k in db.config) acesso[k] = db.config[k]; });
    // Equipe: preços e custos deste aparelho continuam valendo
    const restauraFinanceiro = (col, novo, antigo) => {
      if (tipo !== 'equipe' || !antigo) return novo;
      if (col === 'insumos') ['preco', 'precoHist', 'precoEm'].forEach(k => { if (k in antigo) novo[k] = antigo[k]; });
      if (col === 'produtos') { if ('preco' in antigo) novo.preco = antigo.preco; if ('emb' in antigo) novo.emb = antigo.emb; }
      return novo;
    };
    COLECOES.forEach(col => {
      const atualL = Array.isArray(db[col]) ? db[col] : [], mapa = {}; atualL.forEach(x => { mapa[x.id] = x; });
      const arq = cadF[col] || [];
      if (modo === 'substituir') { db[col] = arq.map(x => restauraFinanceiro(col, x, mapa[x.id])); return; }
      const res = atualL.slice(), pos = {}; res.forEach((x, i) => { pos[x.id] = i; });
      arq.forEach(x => {
        if (!(x.id in pos)) res.push(x);
        else if (usarArquivo && !iguais(semFinanceiro([res[pos[x.id]]], tipo === 'equipe' ? col : '')[0], x)) res[pos[x.id]] = restauraFinanceiro(col, x, res[pos[x.id]]);
      });
      db[col] = res;
    });
    // Configurações
    const cfgLocal = db.config || {};
    if (usarArquivo) {
      const nova = Object.assign({}, cadF.config || {});
      if (tipo === 'equipe' && cfgLocal.custos) nova.custos = cfgLocal.custos;
      db.config = nova;
    }
    db.config = Object.assign(db.config || {}, acesso);
    CAMPOS_ACESSO.forEach(k => { if (!(k in acesso)) delete db.config[k]; });
    db.semIds = Array.from(new Set((db.semIds || []).concat(cadF.semIds || [])));
    if (db.version === undefined) db.version = cadF.version;
    // Operação: registros e respostas nunca são apagados (união); lista de produção depende do modo
    const op = copia(atual.operacao) || { producao: null, respostas: {}, registros: [] };
    if (dados.operacao) {
      const opF = dados.operacao;
      op.respostas = op.respostas || {};
      Object.keys(opF.respostas || {}).forEach(k => { if (!(k in op.respostas) || usarArquivo) op.respostas[k] = copia(opF.respostas[k]); });
      const regs = op.registros || [], posR = {}; regs.forEach((r, i) => { posR[r.id] = i; });
      (opF.registros || []).forEach(r => { if (!(r.id in posR)) regs.push(copia(r)); else if (usarArquivo) regs[posR[r.id]] = copia(r); });
      op.registros = regs.sort((a, b) => String(b.quando || '').localeCompare(String(a.quando || '')));
      const temLocal = op.producao && (op.producao.itens || []).length, temArq = opF.producao && (opF.producao.itens || []).length;
      if (temArq && (modo === 'substituir' || usarArquivo || !temLocal)) op.producao = copia(opF.producao);
    }
    return { db, operacao: op };
  }

  /* ---------- Diagnóstico: o que é padrão de fábrica e o que foi cadastrado no aparelho ---------- */
  function diagnosticoSemente(db, semente) {
    const r = {};
    COLECOES.forEach(col => {
      const s = {}; (semente[col] || []).forEach(x => { s[x.id] = x; });
      const d = { total: 0, fabrica: 0, alterados: 0, criados: 0, removidos: 0 };
      const vistos = {};
      (db[col] || []).forEach(x => { d.total++; vistos[x.id] = 1; if (!(x.id in s)) d.criados++; else if (iguais(x, s[x.id])) d.fabrica++; else d.alterados++; });
      Object.keys(s).forEach(id => { if (!vistos[id]) d.removidos++; });
      r[col] = d;
    });
    return r;
  }

  raiz.BalayoBackup = {
    FORMATO, VERSAO_FORMATO, COLECOES, NOMES, CAMPOS_ACESSO,
    sha256, canonico, iguais, limparCadastros, montarBackup, lerArquivo, validarObjeto, referenciasQuebradas,
    comparar, aplicar, diagnosticoSemente, converterV1, paraFormatoV1, contagens
  };
})(typeof window !== 'undefined' ? window : globalThis);
