// ============================================================================
// Projeto Timeline — camada de dados no Supabase
// ============================================================================
// Substitui o IndexedDB mantendo a MESMA forma de documento que o app já usa.
// O protótipo continua pensando em { topics, events, lanes, off }; aqui dentro
// isso vira linhas nas 6 tabelas do banco.
//
// Só duas funções importam para o index.html:
//   store.pullDoc()      -> devolve o doc do jeito que hydrate() espera
//   store.pushDoc(doc)   -> grava o que mudou desde o último push
//
// Nada de render, lanes ou editor precisa saber que o Supabase existe.
// ============================================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export const SUPABASE_URL = 'https://hlsbymsckxzettbqsiqh.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_YkIkfDJOGmb9VeYG1_wABA_KDydCRbS';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------- tradução --
// O app fala done/tentative/confirmed. O banco fala registrado/planejado/
// confirmado/nao_ocorreu (que cobre também o plano que não aconteceu, P5).
const PARA_BANCO = { done:'registrado', tentative:'planejado', confirmed:'confirmado' };
const PARA_APP   = { registrado:'done', planejado:'tentative', confirmado:'confirmed',
                     nao_ocorreu:'tentative' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const novoId = () =>
  (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      }));

// O banco usa uuid; o protótipo usava slugs ('viagem') e ids curtos ('e_ab12').
// Isto reescreve os ids antigos e conserta as referências, uma vez só.
export function normalizeDoc(doc) {
  const mapa = new Map();
  const trocar = id => {
    if (UUID_RE.test(id)) return id;
    if (!mapa.has(id)) mapa.set(id, novoId());
    return mapa.get(id);
  };
  const topics = (doc.topics || []).map(t => ({ ...t, id: trocar(t.id) }));
  const events = (doc.events || []).map(e => ({
    ...e,
    id: trocar(e.id),
    topic: trocar(e.topic),
    att: (e.att || []).map(a => ({ ...a, id: trocar(a.id) }))
  }));
  const lanes = (doc.lanes || []).map(l => l.map(trocar)).filter(l => l.length);
  const off = (doc.off || []).map(trocar);
  return { ...doc, topics, events, lanes, off };
}

// ----------------------------------------------------------------- sessão --
export const auth = {
  async user() {
    const { data } = await sb.auth.getUser();
    return data?.user ?? null;
  },
  // Login sem senha: o usuário recebe um link por e-mail.
  async entrar(email) {
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: location.href.split('#')[0] }
    });
    if (error) throw error;
  },
  async sair() { await sb.auth.signOut(); },
  aoMudar(fn) { return sb.auth.onAuthStateChange((_e, s) => fn(s?.user ?? null)); }
};

// ---------------------------------------------------------------- storage --
const BUCKET_ORIGINAIS = 'anexos';
const BUCKET_MINIATURAS = 'thumbs';
const TAM_MINIATURA = 96;

// Regra de ouro da seção 4.1: a miniatura vive sempre no Supabase, mesmo quando
// o original está noutro lugar. A timeline só desenha miniatura.
async function gerarMiniatura(file) {
  if (!file.type.startsWith('image/')) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const escala = Math.min(TAM_MINIATURA / bitmap.width, TAM_MINIATURA / bitmap.height, 1);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bitmap.width * escala));
    c.height = Math.max(1, Math.round(bitmap.height * escala));
    c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
    bitmap.close?.();
    return await new Promise(r => c.toBlob(r, 'image/webp', 0.8));
  } catch { return null; }
}

// A policy do bucket só olha a primeira pasta do caminho (o id do usuário),
// então não é preciso saber a marcação de antemão.
export async function enviarArquivo(file, userId) {
  const base = `${userId}/${novoId()}`;
  const nome = (file.name || 'arquivo').replace(/[^\w.\-]/g, '_');
  const caminho = `${base}-${nome}`;

  const up = await sb.storage.from(BUCKET_ORIGINAIS)
    .upload(caminho, file, { contentType: file.type, upsert: false });
  if (up.error) throw up.error;

  let thumbPath = null;
  const mini = await gerarMiniatura(file);
  if (mini) {
    thumbPath = `${base}-thumb.webp`;
    const t = await sb.storage.from(BUCKET_MINIATURAS)
      .upload(thumbPath, mini, { contentType: 'image/webp', upsert: true });
    if (t.error) thumbPath = null;
  }
  return { ref: caminho, thumbPath, mime: file.type, bytes: file.size };
}

// URLs assinadas: os buckets são privados, então nada é servido publicamente.
const cacheUrl = new Map();
export async function urlDe(bucket, caminho, segundos = 3600) {
  if (!caminho) return null;
  const chave = bucket + '|' + caminho;
  const agora = Date.now();
  const hit = cacheUrl.get(chave);
  if (hit && hit.exp > agora) return hit.url;
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(caminho, segundos);
  if (error) return null;
  cacheUrl.set(chave, { url: data.signedUrl, exp: agora + (segundos - 60) * 1000 });
  return data.signedUrl;
}

// ------------------------------------------------- linhas do banco (1 lugar) --
// pullDoc e pushDoc precisam produzir EXATAMENTE a mesma forma de linha, senão
// o diff acha que tudo mudou — e, pior, nunca detecta o que foi apagado.
const linhaTrilha = (t, i, off, uid) => ({
  id: t.id, owner_id: uid, nome: t.name, cor: t.color || '#5b8dee',
  ordem: i, visivel: !off.includes(t.id)
});

const linhaMarcacao = (e, uid) => ({
  id: e.id, owner_id: uid, trilha_id: e.topic,
  ts_ms: e.t0, fim_ms: e.t1 ?? null,
  titulo: e.title || '(sem título)',
  descricao: e.desc || null,
  tipo: e.kind || 'acontecimento',
  estado: PARA_BANCO[e.status] || 'registrado'
});

const linhaAnexo = (a, marcacaoId, uid) => {
  const ehLink = a.type === 'link';
  return {
    id: a.id, marcacao_id: marcacaoId, owner_id: uid,
    provider: ehLink ? 'link_externo' : (a._provider || 'supabase'),
    ref: ehLink ? (a.url || '') : (a._ref || ''),
    thumb_path: a._thumb || null,
    mime: a.mime || null,
    bytes: a.size || null,
    disponivel: !a.missing,
    metadados: { name: a.name || '' }
  };
};

// ------------------------------------------------------------------ leitura --
export async function pullDoc() {
  const user = await auth.user();
  if (!user) return null;

  const [tr, mc, ax, hi] = await Promise.all([
    sb.from('trilha').select('*').order('ordem'),
    sb.from('marcacao').select('*').order('ts_ms'),
    sb.from('anexo').select('*'),
    sb.from('historia').select('id,nome,eh_padrao,historia_trilha(trilha_id,lane,ordem)')
      .eq('eh_padrao', true).maybeSingle()
  ]);
  for (const r of [tr, mc, ax, hi]) if (r.error) throw r.error;
  if (!tr.data.length) return null;            // conta vazia: o app segue com o demo

  const anexosPorMarcacao = new Map();
  for (const a of ax.data) {
    if (!anexosPorMarcacao.has(a.marcacao_id)) anexosPorMarcacao.set(a.marcacao_id, []);
    anexosPorMarcacao.get(a.marcacao_id).push({
      id: a.id,
      type: a.provider === 'link_externo' ? 'link' : 'file',
      name: a.metadados?.name ?? (a.ref || '').split('/').pop(),
      url: a.provider === 'link_externo' ? a.ref : undefined,
      mime: a.mime || undefined,
      size: a.bytes || undefined,
      _ref: a.ref,
      _thumb: a.thumb_path || null,
      _provider: a.provider
    });
  }

  const events = mc.data.map(m => ({
    id: m.id, topic: m.trilha_id, title: m.titulo,
    t0: Number(m.ts_ms), t1: m.fim_ms == null ? null : Number(m.fim_ms),
    status: PARA_APP[m.estado] || 'done',
    kind: m.tipo === 'acontecimento' ? '' : (m.tipo || ''),
    desc: m.descricao || '',
    att: anexosPorMarcacao.get(m.id) || []
  }));

  const topics = tr.data.map(t => ({ id: t.id, name: t.nome, color: t.cor }));
  const off = tr.data.filter(t => !t.visivel).map(t => t.id);

  let lanes = null;
  const vinculos = hi.data?.historia_trilha || [];
  if (vinculos.length) {
    const porLane = new Map();
    for (const v of vinculos.slice().sort((a, b) => a.ordem - b.ordem)) {
      if (!porLane.has(v.lane)) porLane.set(v.lane, []);
      porLane.get(v.lane).push(v.trilha_id);
    }
    lanes = [...porLane.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids);
  }

  const doc = { format:'timeline', version:7, savedAt:Date.now(), topics, events, lanes, off };

  // Semeia o cache do diff com o que acabou de ser lido. Sem isto, uma exclusão
  // feita logo após abrir o app não chegaria ao banco.
  const uid = user.id;
  ultimoEnvio.topics = new Map(topics.map((t, i) => [t.id, linhaTrilha(t, i, off, uid)]));
  ultimoEnvio.events = new Map(events.map(e => [e.id, linhaMarcacao(e, uid)]));
  ultimoEnvio.anexos = new Map();
  for (const e of events) for (const a of e.att || []) {
    const linha = linhaAnexo(a, e.id, uid);
    if (linha.ref) ultimoEnvio.anexos.set(a.id, linha);
  }
  ultimoEnvio.visao = lanes ? lanes.map(l => l.slice()) : null;

  return doc;
}

// ------------------------------------------------------------------ escrita --
// Só sobe o que mudou. Sem isto, cada tecla digitada reenviaria o documento
// inteiro — o que funciona com 25 eventos e derruba tudo com 25 mil.
let ultimoEnvio = { topics:new Map(), events:new Map(), anexos:new Map(), visao:null };
export function esquecerCache() {
  ultimoEnvio = { topics:new Map(), events:new Map(), anexos:new Map(), visao:null };
}

const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function pushDoc(doc) {
  const user = await auth.user();
  if (!user) throw new Error('sem sessão');
  const uid = user.id;

  // ---- trilhas ----
  const off = doc.off || [];
  const trilhasAgora = new Map();
  const trilhasParaGravar = [];
  (doc.topics || []).forEach((t, i) => {
    const linha = linhaTrilha(t, i, off, uid);
    trilhasAgora.set(t.id, linha);
    if (!igual(ultimoEnvio.topics.get(t.id), linha)) trilhasParaGravar.push(linha);
  });
  const trilhasRemovidas = [...ultimoEnvio.topics.keys()].filter(id => !trilhasAgora.has(id));

  if (trilhasParaGravar.length) {
    const { error } = await sb.from('trilha').upsert(trilhasParaGravar);
    if (error) throw error;
  }
  if (trilhasRemovidas.length) {
    const { error } = await sb.from('trilha').delete().in('id', trilhasRemovidas);
    if (error) throw error;
  }

  // ---- marcações ----
  const eventosAgora = new Map();
  const eventosParaGravar = [];
  for (const e of doc.events || []) {
    const linha = linhaMarcacao(e, uid);
    eventosAgora.set(e.id, linha);
    if (!igual(ultimoEnvio.events.get(e.id), linha)) eventosParaGravar.push(linha);
  }
  const eventosRemovidos = [...ultimoEnvio.events.keys()].filter(id => !eventosAgora.has(id));

  // Em lotes: o PostgREST tem limite de tamanho de requisição.
  for (let i = 0; i < eventosParaGravar.length; i += 500) {
    const { error } = await sb.from('marcacao').upsert(eventosParaGravar.slice(i, i + 500));
    if (error) throw error;
  }
  if (eventosRemovidos.length) {
    const { error } = await sb.from('marcacao').delete().in('id', eventosRemovidos);
    if (error) throw error;
  }

  // ---- anexos ----
  const anexosAgora = new Map();
  const anexosParaGravar = [];
  for (const e of doc.events || []) {
    for (const a of e.att || []) {
      const linha = linhaAnexo(a, e.id, uid);
      if (!linha.ref) continue;               // anexo ainda subindo: espera o próximo save
      anexosAgora.set(a.id, linha);
      if (!igual(ultimoEnvio.anexos.get(a.id), linha)) anexosParaGravar.push(linha);
    }
  }
  const anexosRemovidos = [...ultimoEnvio.anexos.keys()].filter(id => !anexosAgora.has(id));

  if (anexosParaGravar.length) {
    const { error } = await sb.from('anexo').upsert(anexosParaGravar);
    if (error) throw error;
  }
  if (anexosRemovidos.length) {
    const { error } = await sb.from('anexo').delete().in('id', anexosRemovidos);
    if (error) throw error;
  }

  // ---- visão (as linhas paralelas) ----
  const visao = (doc.lanes || []).map(l => l.slice());
  if (!igual(ultimoEnvio.visao, visao)) {
    let { data: h, error: e1 } = await sb.from('historia')
      .select('id').eq('eh_padrao', true).maybeSingle();
    if (e1) throw e1;
    if (!h) {
      const r = await sb.from('historia')
        .insert({ owner_id: uid, nome: 'Visão atual', eh_padrao: true })
        .select('id').single();
      if (r.error) throw r.error;
      h = r.data;
    }
    await sb.from('historia_trilha').delete().eq('historia_id', h.id);
    const vinculos = [];
    visao.forEach((lane, iLane) => lane.forEach((trilhaId, iPos) => {
      if (trilhasAgora.has(trilhaId))
        vinculos.push({ historia_id: h.id, trilha_id: trilhaId, lane: iLane, ordem: iPos });
    }));
    if (vinculos.length) {
      const { error } = await sb.from('historia_trilha').insert(vinculos);
      if (error) throw error;
    }
    ultimoEnvio.visao = visao;
  }

  ultimoEnvio.topics = trilhasAgora;
  ultimoEnvio.events = eventosAgora;
  ultimoEnvio.anexos = anexosAgora;

  return {
    trilhas: trilhasParaGravar.length, marcacoes: eventosParaGravar.length,
    anexos: anexosParaGravar.length,
    removidos: trilhasRemovidas.length + eventosRemovidos.length + anexosRemovidos.length
  };
}

// ------------------------------------------------------------- importação --
// Um .json exportado traz as fotos embutidas em doc.files (blobId -> data URL).
// No modo nuvem elas precisam ir para o Storage, senão o anexo sobe sem arquivo.
// É por aqui que os dados do modo local chegam à nuvem: Exportar, depois Importar.
export async function importarAnexos(doc, userId, aoProgredir) {
  const arquivos = doc.files || {};
  const ids = Object.keys(arquivos);
  if (!ids.length) return { enviados: 0, falhas: 0, orfaos: 0 };

  const porBlob = new Map();
  for (const e of doc.events || []) for (const a of e.att || []) {
    if (!a.blobId) continue;
    if (!porBlob.has(a.blobId)) porBlob.set(a.blobId, []);
    porBlob.get(a.blobId).push(a);
  }

  let enviados = 0, falhas = 0, orfaos = 0, i = 0;
  for (const blobId of ids) {
    i++;
    aoProgredir?.(i, ids.length);
    const alvos = porBlob.get(blobId);
    if (!alvos?.length) { orfaos++; continue; }   // arquivo sem dono: não sobe
    try {
      const blob = await (await fetch(arquivos[blobId])).blob();
      const nome = alvos[0].name || 'arquivo';
      const tipo = alvos[0].mime || blob.type || 'application/octet-stream';
      const r = await enviarArquivo(new File([blob], nome, { type: tipo }), userId);
      for (const a of alvos) {
        delete a.blobId;
        a._ref = r.ref; a._thumb = r.thumbPath; a._provider = 'supabase';
        a.mime = a.mime || r.mime; a.size = a.size || r.bytes;
        a.url = URL.createObjectURL(blob);
        a.missing = false;
      }
      enviados++;
    } catch (err) {
      // Estourar o limite de 1 GB cai aqui: o anexo fica marcado como indisponível
      // em vez de derrubar a importação inteira no meio.
      console.error('anexo não subiu:', blobId, err);
      for (const a of alvos) a.missing = true;
      falhas++;
    }
  }
  delete doc.files;
  return { enviados, falhas, orfaos };
}

// Resolve as URLs de exibição dos anexos guardados no Storage.
export async function resolverUrls(events) {
  const jobs = [];
  for (const e of events) for (const a of e.att || []) {
    if (a.type === 'link') continue;
    if (a._thumb) jobs.push(urlDe(BUCKET_MINIATURAS, a._thumb).then(u => { if (u) a.thumbUrl = u; }));
    if (a._ref)   jobs.push(urlDe(BUCKET_ORIGINAIS, a._ref).then(u => {
      if (u) a.url = u; else a.missing = true;
    }));
  }
  await Promise.all(jobs);
}
