/* Balayó — motor de cálculo das fichas técnicas.
   Funções puras: recebem os dados e devolvem resultados, sem mexer na tela.
   Regras:
   - as quantidades ficam como foram cadastradas; arredondar só na hora de mostrar;
   - nunca supor 1 ml = 1 g: sem densidade cadastrada, o peso fica "pendente";
   - rendimento só vale se foi calibrado; sem isso, o cálculo avisa em vez de inventar. */
(function (raiz) {
  'use strict';
  const copia = o => JSON.parse(JSON.stringify(o));
  const positivo = v => typeof v === 'number' && isFinite(v) && v > 0;

  const acharInsumo = (db, id) => (db.insumos || []).find(x => x.id === id) || null;
  const acharPreparo = (db, id) => (db.preparos || []).find(x => x.id === id) || null;
  const acharFicha = (db, id) => (db.fichas || []).find(x => x.id === id) || null;
  const acharEmbalagem = (db, id) => (db.embalagens || []).find(x => x.id === id) || null;

  // Peso em gramas de uma quantidade. null = falta densidade (ml) ou peso unitário (un).
  function emGramas(ins, q, u) {
    u = u || ins.un;
    if (u === 'g') return q;
    if (u === 'ml') return positivo(ins.dens) ? q * ins.dens : null;
    if (u === 'un') return positivo(ins.pesoUn) ? q * ins.pesoUn : null;
    return null;
  }
  // Quantidade na unidade em que o insumo é comprado (para o custo). null = falta conversão.
  function naUnidadeDeCompra(ins, q, u) {
    u = u || ins.un;
    if (u === ins.un) return q;
    const g = emGramas(ins, q, u);
    if (g === null) return null;
    if (ins.un === 'g') return g;
    if (ins.un === 'ml') return positivo(ins.dens) ? g / ins.dens : null;
    if (ins.un === 'un') return positivo(ins.pesoUn) ? g / ins.pesoUn : null;
    return null;
  }
  // Preço por unidade de compra. 0 = item sem custo (ex.: água). null = sem preço cadastrado.
  function precoPorUnidade(ins) {
    if (ins.zero) return 0;
    return positivo(ins.preco) && positivo(ins.qtd) ? ins.preco / ins.qtd : null;
  }

  // Uma linha de ingrediente multiplicada pelo fator.
  function linhaInsumo(db, it, fator) {
    const ins = acharInsumo(db, it.i);
    const q = (Number(it.q) || 0) * fator;
    if (!ins) return { ins: null, nome: '(ingrediente removido)', q, u: it.u || 'g', g: null, custo: null, avisos: ['ingrediente removido'] };
    const u = it.u || ins.un;
    const avisos = [];
    const g = emGramas(ins, q, u);
    if (g === null) avisos.push(u === 'ml' ? 'falta densidade' : 'falta peso unitário');
    if (u === 'un' && positivo(ins.pesoUn) && !ins.pesoUnConf) avisos.push('peso médio a confirmar');
    if (it.medida && !it.conf) avisos.push('medida caseira a confirmar');
    const pu = precoPorUnidade(ins);
    const qc = naUnidadeDeCompra(ins, q, u);
    let custo = null;
    if (pu === null) avisos.push('sem preço');
    else if (qc === null) avisos.push('custo: falta conversão de unidade');
    else custo = qc * pu;
    return { ins, nome: ins.nome, q, u, g, custo, avisos };
  }
  function linhasPreparo(db, prep, fator) {
    return (prep.itens || []).map(it => linhaInsumo(db, { i: it.i, q: it.q, u: it.u }, fator));
  }
  function pesoTotal(linhas) {
    let g = 0, pendente = false;
    linhas.forEach(l => { if (l.g === null) pendente = true; else g += l.g; });
    return { g, pendente };
  }

  // Rendimento pronto de um preparo: medido (calibração) > perda cadastrada > nenhum.
  function rendimentoPreparo(db, prep) {
    const base = pesoTotal(linhasPreparo(db, prep, 1));
    const r = { cruBase: base.g, pesoPendente: base.pendente };
    const c = prep.calib;
    if (c && positivo(c.antes) && positivo(c.depois)) {
      const util = positivo(c.aprov) ? c.aprov : c.depois;
      return Object.assign(r, { fonte: 'medido', perda: 1 - c.depois / c.antes, aproveitamento: util / c.antes, prontoBase: base.g * util / c.antes });
    }
    if (typeof prep.perda === 'number' && isFinite(prep.perda) && prep.perda >= 0 && prep.perda < 100 && (prep.itens || []).length) {
      const f = 1 - prep.perda / 100;
      return Object.assign(r, { fonte: prep.est ? 'estimado' : 'informado', perda: prep.perda / 100, aproveitamento: f, prontoBase: base.g * f });
    }
    return Object.assign(r, { fonte: 'nenhum' });
  }

  // Ficha técnica multiplicada: grupos por componente (Creme, Calda...).
  function expandirFicha(db, ficha, mult, excluidos) {
    excluidos = excluidos || [];
    return (ficha.componentes || []).map((c, k) => {
      const g = { k, nome: c.nome || 'Componente', opcional: !!c.opcional, incluido: !(c.opcional && excluidos.indexOf(k) >= 0), linhas: [], avisos: [] };
      if (c.tipo === 'preparo') {
        const p = acharPreparo(db, c.p);
        if (!p) g.avisos.push('preparo não encontrado');
        else {
          g.prep = p;
          g.linhas = linhasPreparo(db, p, (Number(c.fator) || 0) * mult);
          if (!(p.itens || []).length) g.avisos.push('receita do preparo ainda não cadastrada');
        }
      } else {
        g.linhas = (c.itens || []).map(it => linhaInsumo(db, it, mult));
        if (!g.linhas.length) g.avisos.push('ingredientes ainda não cadastrados');
      }
      return g;
    });
  }
  function rendimentoEmbalagem(ficha, embId) {
    const r = (ficha.rendimentos || []).find(x => x.emb === embId);
    return r && positivo(r.unidades) ? r : null;
  }
  function multPorUnidades(ficha, embId, unidades) {
    const r = rendimentoEmbalagem(ficha, embId);
    if (!r) return { ok: false, motivo: 'Rendimento não calibrado' };
    if (!positivo(unidades)) return { ok: false, motivo: 'Informe a quantidade' };
    return { ok: true, mult: unidades / r.unidades, rendimento: r.unidades };
  }
  function multPorPronto(db, prep, gramas) {
    const r = rendimentoPreparo(db, prep);
    if (r.fonte === 'nenhum') return { ok: false, motivo: 'Rendimento não calibrado' };
    if (r.pesoPendente || !positivo(r.prontoBase)) return { ok: false, motivo: 'Peso da receita incompleto: falta densidade ou peso unitário de algum ingrediente' };
    if (!positivo(gramas)) return { ok: false, motivo: 'Informe a quantidade' };
    return { ok: true, mult: gramas / r.prontoBase, fonte: r.fonte, prontoBase: r.prontoBase };
  }

  // Custos (só soma o que tem preço; o resto vira "pendente", nunca zero silencioso).
  function custoGrupos(grupos) {
    let total = 0; const pendentes = [];
    grupos.forEach(g => {
      if (!g.incluido) return;
      g.linhas.forEach(l => { if (l.custo === null) { if (pendentes.indexOf(l.nome) < 0) pendentes.push(l.nome); } else total += l.custo; });
    });
    return { total, pendentes };
  }
  function custoFicha(db, ficha, mult, excluidos) { return custoGrupos(expandirFicha(db, ficha, mult == null ? 1 : mult, excluidos)); }
  function custoPorUnidade(db, ficha, embId) {
    const r = rendimentoEmbalagem(ficha, embId);
    if (!r) return { ok: false, motivo: 'Rendimento não calibrado' };
    const c = custoFicha(db, ficha, 1);
    return { ok: true, valor: c.total / r.unidades, pendentes: c.pendentes };
  }
  function custoPreparo(db, prep, fator) { return custoGrupos([{ incluido: true, linhas: linhasPreparo(db, prep, fator == null ? 1 : fator) }]); }

  // Catálogo de componentes (nomes reutilizáveis: Massa, Molho, Xarope...).
  // As receitas guardam uma cópia do nome e o vínculo (cat). Excluir do catálogo nunca apaga ingredientes das receitas.
  function dependenciasComponente(db, catId) {
    return (db.fichas || []).filter(f => (f.componentes || []).some(c => c.cat === catId));
  }
  function renomearComponente(db, catId, novoNome) {
    const cat = (db.componentesCat || []).find(x => x.id === catId);
    if (!cat || !String(novoNome || '').trim()) return 0;
    cat.nome = String(novoNome).trim();
    let n = 0;
    (db.fichas || []).forEach(f => (f.componentes || []).forEach(c => { if (c.cat === catId) { c.nome = cat.nome; n++; } }));
    return n;
  }
  function excluirComponenteCat(db, catId) {
    db.componentesCat = (db.componentesCat || []).filter(x => x.id !== catId);
    let n = 0;
    (db.fichas || []).forEach(f => (f.componentes || []).forEach(c => { if (c.cat === catId) { delete c.cat; n++; } }));
    return n; // receitas que continuam com o componente, agora como nome livre
  }
  // Peso e custo de cada componente e da receita inteira (para a administração e o Diário)
  function resumoComponentes(grupos) {
    const comps = grupos.filter(g => g.incluido).map(g => { const p = pesoTotal(g.linhas), c = custoGrupos([g]); return { nome: g.nome, g: p.g, pesoPendente: p.pendente, custo: c.total, custoPendente: c.pendentes.length > 0 }; });
    return { comps, g: comps.reduce((s, x) => s + x.g, 0), pesoPendente: comps.some(x => x.pesoPendente), custo: comps.reduce((s, x) => s + x.custo, 0) };
  }

  // Migração: acrescenta itens novos de fábrica sem mexer no que já existe.
  // Um item de fábrica apagado pelo dono não volta (fica anotado em semIds).
  function migrar(db, sementes) {
    db.semIds = Array.isArray(db.semIds) ? db.semIds : [];
    ['insumos', 'preparos', 'fichas', 'embalagens', 'componentesCat'].forEach(col => {
      if (!Array.isArray(db[col])) db[col] = [];
      (sementes[col] || []).forEach(s => {
        const chave = col + ':' + s.id;
        if (db.semIds.indexOf(chave) >= 0) return;
        if (!db[col].some(x => x.id === s.id)) db[col].push(copia(s));
        db.semIds.push(chave);
      });
    });
    return db;
  }

  raiz.BalayoCalc = {
    acharInsumo, acharPreparo, acharFicha, acharEmbalagem,
    emGramas, naUnidadeDeCompra, precoPorUnidade, linhaInsumo, linhasPreparo, pesoTotal,
    rendimentoPreparo, expandirFicha, rendimentoEmbalagem, multPorUnidades, multPorPronto,
    custoGrupos, custoFicha, custoPorUnidade, custoPreparo, migrar,
    dependenciasComponente, renomearComponente, excluirComponenteCat, resumoComponentes
  };
})(typeof window !== 'undefined' ? window : globalThis);
