// 명조 스크린샷 인식 모듈 (시제품)
// - parseStatScreen: 게임 캐릭터 스탯 창 캡처 (이름, 레벨, 6개 기본 스탯)
// - parseBotCard: WuWa Bot 프로필 카드 (1920x1080 고정 레이아웃)
//
// 이미지 처리는 backend 로 주입한다. 브라우저는 createCanvasBackend, 테스트(Node)는 sharp 기반 backend 를 쓴다.
// backend = { width, height, crop({x,y,w,h}, scale, invert) -> tesseract 입력, goldFraction({x,y,w,h}) -> 0~1 }
// invert: 밝은 글자를 어두운 글자로 뒤집음 (봇 카드의 한글 라벨은 뒤집어야 잘 읽힘)

export const STAT_LABELS = ['HP', '공격력', '방어력', '공명 효율', '크리티컬', '크리티컬 피해'];

export const SUBSTAT_NAMES = [
  'HP', '공격력', '방어력', '공명 효율', '크리티컬', '크리티컬 피해',
  '일반 공격 피해 보너스', '강공격 피해 보너스', '공명 스킬 피해 보너스', '공명 해방 피해 보너스',
];

export const MAIN_STAT_NAMES = [
  ...SUBSTAT_NAMES, '치료 효과 보너스',
  '응결 피해 보너스', '용융 피해 보너스', '전도 피해 보너스', '기류 피해 보너스', '회절 피해 보너스', '인멸 피해 보너스',
];

// ---------- 문자열 유틸 ----------

const clean = (s) => (s || '').replace(/[\s·・.,:;'"`|_\-—~!?()<>\[\]{}*※＊+]/g, '');

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

// 후보 중 가장 비슷한 것 (유사도 0~1). 기준 미달이면 null
// 봇 카드 메인 옵션 보정. 코스트별 +25 메인 수치표
const BOT_MAIN_VALUES = {
  4: [['크리티컬', 22], ['크리티컬 피해', 44], ['공격력', 33], ['HP', 33], ['방어력', 41.5], ['치료 효과 보너스', 26.4]],
  3: [['공격력', 30], ['HP', 30], ['방어력', 38], ['공명 효율', 32]],
  1: [['공격력', 18], ['HP', 22.8], ['방어력', 18]],
};
function fixBotMain(echo) {
  const m = echo.main, tbl = BOT_MAIN_VALUES[echo.cost];
  if (!m || !tbl) return;
  const max = Math.max(...tbl.map((x) => x[1]), 30);
  // 아이콘을 숫자로 읽어 앞에 한 자리가 붙는 경우 (32% → "232", 30% → "130")
  if (m.value != null && m.value > max) { const t = String(m.value).slice(1); if (+t > 0 && +t <= max) m.value = +t; }
  // 라벨을 못 읽었으면 수치로 찾고 (값이 하나뿐일 때), 그래도 모르면 한글 모델이 못 읽는 HP 로 봄
  if (!m.stat) { const hit = tbl.filter((x) => x[1] === m.value); m.stat = hit.length === 1 ? hit[0][0] : 'HP'; }
}

export function bestMatch(text, candidates, min = 0.5) {
  const t = clean(text);
  if (!t) return null;
  let best = null, score = 0;
  for (const c of candidates) {
    const k = clean(c);
    const s = 1 - levenshtein(t, k) / Math.max(t.length, k.length);
    if (s > score) { score = s; best = c; }
  }
  return score >= min ? { value: best, score } : null;
}

// "13.8%", "2280", "9.4%" -> { value: 13.8, percent: true }
export function parseNumber(text) {
  const m = (text || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(%?)/);
  if (!m) return null;
  return { value: parseFloat(m[1]), percent: m[2] === '%' };
}

// 별칭 -> 정식 이름 (예: 표기가 다른 이름)
function resolveName(raw, names, aliases) {
  const pool = [...names, ...Object.keys(aliases)];
  const hit = bestMatch(raw, pool, 0.6);
  if (!hit) return { name: raw.trim(), matched: false };
  return { name: aliases[hit.value] || hit.value, matched: true, confidence: hit.score };
}

// ---------- Tesseract 워커 ----------

export async function createWorkers(Tesseract, langPath) {
  const opt = langPath ? { langPath } : {};
  const kor = await Tesseract.createWorker('kor', 1, opt);
  const num = await Tesseract.createWorker('eng', 1, opt);
  await num.setParameters({ tessedit_char_whitelist: '0123456789.%/', tessedit_pageseg_mode: '7' });
  return {
    kor, num,
    async terminate() { await kor.terminate(); await num.terminate(); },
  };
}

// ---------- 스탯 창 ----------

// 캡처 범위가 사람마다 달라서 좌표 대신 위치 관계로 읽는다.
// 1) 전체를 한글로 읽어 스탯 6줄의 위치를 찾고, 각 줄 오른쪽 숫자는 숫자 전용으로 다시 읽는다.
// 2) 스탯 첫 줄 위쪽을 이름 영역과 레벨 영역으로 나눠 따로 크게 읽는다.
// 이미지 전체를 한글로 읽어 줄 목록으로 (좌표는 원본 기준)
// 라벨과 숫자 사이가 넓으면 한 줄이 두 덩어리로 나뉘어 읽힘. 높이가 겹치는 덩어리를 왼쪽부터 이어 한 줄로 합침
function mergeRows(lines) {
  const rows = [];
  for (const l of [...lines].sort((a, b) => a.bbox.y0 - b.bbox.y0)) {
    const cy = (l.bbox.y0 + l.bbox.y1) / 2;
    const row = rows.find((r) => cy > r.bbox.y0 && cy < r.bbox.y1 && Math.abs(cy - (r.bbox.y0 + r.bbox.y1) / 2) < (r.bbox.y1 - r.bbox.y0) * 0.5);
    if (row) row.parts.push(l), Object.assign(row.bbox, { x0: Math.min(row.bbox.x0, l.bbox.x0), y0: Math.min(row.bbox.y0, l.bbox.y0), x1: Math.max(row.bbox.x1, l.bbox.x1), y1: Math.max(row.bbox.y1, l.bbox.y1) });
    else rows.push({ parts: [l], bbox: { ...l.bbox } });
  }
  return rows.map((r) => ({ text: r.parts.sort((a, b) => a.bbox.x0 - b.bbox.x0).map((p) => p.text).join(' '), bbox: r.bbox }));
}

// 배경이 밝고 복잡하면 자동 영역 나누기(psm 3)가 글자를 거의 못 찾음. 그럴 땐 한 덩어리 글로 보고(psm 4) 다시 읽어 더 많이 읽힌 쪽을 씀
export async function readPageLines(backend, workers, psm = '3') {
  const W = backend.width, H = backend.height, scale = Math.max(1, 1200 / W);
  await workers.kor.setParameters({ tessedit_pageseg_mode: psm });
  const page = await workers.kor.recognize(await backend.crop({ x: 0, y: 0, w: W, h: H }, scale));
  const raw = (page.data.lines || []).map((l) => ({
    text: l.text.trim(),
    bbox: { x0: l.bbox.x0 / scale, y0: l.bbox.y0 / scale, x1: l.bbox.x1 / scale, y1: l.bbox.y1 / scale },
  })).filter((l) => /[가-힣A-Za-z0-9]/.test(l.text));
  const lines = mergeRows(raw);
  if (psm !== '3') return lines;
  const score = (ls) => ls.filter((l) => /[가-힣]{2,}/.test(l.text) && /\d/.test(l.text)).length;
  if (score(lines) >= 5) return lines;
  const alt = await readPageLines(backend, workers, '4');
  return score(alt) > score(lines) ? alt : lines;
}

// 배경 그림이 복잡해 전체 읽기가 줄을 못 나눌 때: 왼쪽(라벨 쪽) 흰 글자 분포로 줄 위치를 직접 찾아 한 줄씩 읽음
export async function readBandLines(backend, workers, T = 170) {
  const W = backend.width, H = backend.height;
  const prof = await backend.rowProfile({ x: Math.floor(W * 0.08), y: 0, w: Math.floor(W * 0.45), h: H }, T);
  const bands = [];
  let start = -1, gap = 0;
  for (let y = 0; y <= H; y++) {
    const on = y < H && prof[y] >= 2;
    if (on) { if (start < 0) start = y; gap = 0; }
    else if (start >= 0 && ++gap > 3) { bands.push([start, y - gap]); start = -1; gap = 0; }
  }
  await workers.kor.setParameters({ tessedit_pageseg_mode: '7' });
  const lines = [];
  for (const [y0, y1] of bands) {
    const h = y1 - y0 + 1;
    if (h < H * 0.015 || h > H * 0.08) continue;
    const box = { x: 0, y: Math.max(0, y0 - 3), w: W, h: Math.min(H - Math.max(0, y0 - 3), h + 6) };
    const t = (await workers.kor.recognize(await backend.crop(box, Math.max(2, 48 / h)))).data.text.trim();
    if (t) lines.push({ text: t, bbox: { x0: 0, y0, x1: W, y1 } });
  }
  await workers.kor.setParameters({ tessedit_pageseg_mode: '3' });
  return lines;
}

export async function parseStatScreen(backend, workers, { names = [], aliases = {}, lines = null } = {}) {
  const W = backend.width, H = backend.height;
  if (!lines) lines = await readPageLines(backend, workers);

  const result = { kind: 'stat-screen', name: null, level: null, stats: {}, warnings: [] };
  const clip = (box) => {
    const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
    return { x, y, w: Math.max(1, Math.min(W - x, Math.ceil(box.w))), h: Math.max(1, Math.min(H - y, Math.ceil(box.h))) };
  };

  // 스탯 줄 후보: 오른쪽 끝이 숫자로 끝나는 줄
  // 라벨: 줄 앞쪽 글자만 비교 (뒤에 붙은 잡음 글자 무시). 긴 라벨 우선 ('크리티컬 피해' vs '크리티컬')
  const labelOf = (t) => {
    const c = clean(t.replace(/[^가-힣A-Za-z]/g, ' '));
    let best = null;
    for (const lab of STAT_LABELS) {
      const k = clean(lab);
      for (const n of [k.length - 1, k.length, k.length + 1]) {
        const p = c.slice(0, n);
        if (!p) continue;
        const sc = 1 - levenshtein(p, k) / Math.max(p.length, k.length);
        if (sc >= 0.7 && (!best || sc > best.score || (sc === best.score && k.length > clean(best.value).length))) best = { value: lab, score: sc };
      }
    }
    return best;
  };
  const cands = lines.filter((l) => l.bbox.y0 > H * 0.3 && (/\d[\d.,]*\s*%?\s*\S{0,2}$/.test(l.text) && l.bbox.x1 > W * 0.6 || labelOf(l.text)))
    .map((l) => ({ l, lab: labelOf(l.text) }));
  // 스탯별 형식 (% 스탯은 소수 한 자리) 과 말이 되는 범위
  const RANGE = [[300, 90000], [30, 9000], [30, 9000], [100, 500], [5, 100], [150, 600]];
  const norm = (t, i) => {
    t = (t || '').replace(/,/g, '');
    const m = i >= 3 ? t.match(/(\d{1,3})\.(\d)/) : t.match(/\d{2,6}/);
    const v = m ? (i >= 3 ? +`${m[1]}.${m[2]}` : +m[0]) : null;
    return v != null && v >= RANGE[i][0] && v <= RANGE[i][1] ? v : null;
  };
  const readNum = async (y0, h, fallbackText, i = -1) => {
    const box = clip({ x: W * 0.55, y: y0 - h * 0.2, w: W * 0.45, h: h * 1.4 }), sc = Math.max(2, 60 / h);
    const n = (await workers.num.recognize(await backend.crop(box, sc))).data.text;
    if (i < 0) return parseNumber(n) || parseNumber(fallbackText);
    if (!backend.base) {
      // 크기를 바꿔 한 번 더 읽어 같은 값이면 확정 (다르면 확인 필요 → 흰 글자만 남겨 다시 읽는 단계로)
      const v = norm(n, i), v2 = norm((await workers.num.recognize(await backend.crop(box, sc * 1.5))).data.text, i), vt = norm(fallbackText, i);
      const vw = norm((await workers.num.recognize(await backend.crop(box, sc, false, 170))).data.text, i);
      const val = v ?? v2 ?? vt;
      return val == null ? null : { value: val, percent: i >= 3, sure: v != null && v === v2 && v === vw && (vt == null || vt === v) };
    }
    // 배경이 겹친 사진: 밝기 기준 · 크기를 바꿔 여러 번 읽고 가장 많이 나온 값 (한 번만 나온 값이면 확인 필요로 표시)
    const reads = [n, fallbackText];
    for (const [T, s2] of [[0, sc], [150, sc], [0, sc * 1.5], [150, sc * 1.5], [200, sc]]) reads.push((await workers.num.recognize(await backend.base.crop(box, s2, false, T))).data.text);
    await workers.kor.setParameters({ tessedit_pageseg_mode: '7' });
    reads.push((await workers.kor.recognize(await backend.crop(box, sc))).data.text);
    const votes = new Map();
    for (const t of reads) { const v = norm(t, i); if (v != null) votes.set(v, (votes.get(v) || 0) + 1); }
    const top = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    const second = [...votes.values()].sort((a, b) => b - a)[1] || 0;
    return top ? { value: top[0], percent: i >= 3, sure: top[1] >= 3 && top[1] >= second * 2 } : null;
  };
  // 라벨로 4줄 이상 확인되면 라벨 기준으로 배치 (아래 장식 줄 같은 잡음, 못 읽은 줄이 있어도 밀리지 않음)
  // 못 찾은 줄은 확인된 줄 간격으로 위치를 추정해 숫자만 읽음
  const byIdx = new Map();
  for (const c of cands) { const i = c.lab ? STAT_LABELS.indexOf(c.lab.value) : -1; if (i >= 0 && !byIdx.has(i)) byIdx.set(i, c.l); }
  const rows = [];
  let statLines;
  if (byIdx.size >= 4) {
    const known = [...byIdx.entries()].sort((a, b) => a[0] - b[0]);
    const cy = (l) => (l.bbox.y0 + l.bbox.y1) / 2;
    const pitches = known.slice(1).map(([i, l], k) => (cy(l) - cy(known[k][1])) / (i - known[k][0])).sort((a, b) => a - b);
    const pitch = pitches[Math.floor(pitches.length / 2)];
    const hAvg = known.reduce((s, [, l]) => s + l.bbox.y1 - l.bbox.y0, 0) / known.length;
    for (let i = 0; i < STAT_LABELS.length; i++) {
      let l = byIdx.get(i);
      if (!l) {
        const [ai, al] = known.reduce((best, k) => Math.abs(k[0] - i) < Math.abs(best[0] - i) ? k : best);
        const y = cy(al) + (i - ai) * pitch;
        l = cands.find((c) => !c.lab && Math.abs(cy(c.l) - y) < pitch * 0.35)?.l || { text: '', bbox: { y0: y - hAvg / 2, y1: y + hAvg / 2 } };
      }
      if (i === 0) statLines = [l];   // 머리 영역 경계 (첫 줄 위치, 추정값 포함)
      const num = await readNum(l.bbox.y0, l.bbox.y1 - l.bbox.y0, l.text, i);
      rows.push(num ? { label: STAT_LABELS[i], num } : null);
      if (num) result.stats[STAT_LABELS[i]] = num.value;
      if (num && !num.sure) result.warnings.push(`${STAT_LABELS[i]} 값 확인 필요`);
    }
    const miss = rows.map((r, i) => r ? '' : STAT_LABELS[i]).filter(Boolean);
    if (miss.length) result.warnings.push(`${miss.join(' · ')} 값을 읽지 못함`);
  } else {
    // 라벨을 거의 못 읽었으면 아래쪽 6줄을 순서대로
    statLines = cands.map((c) => c.l).slice(-6);
    for (const l of statLines) {
      const num = await readNum(l.bbox.y0, l.bbox.y1 - l.bbox.y0, l.text);
      if (num) rows.push({ label: l.text, num });
    }
    if (rows.length < 6) result.warnings.push(`스탯 줄을 ${rows.length}개만 찾음`);
    rows.slice(0, 6).forEach((r, i) => {
      const byLabel = bestMatch(r.label.replace(/[\d.,%]+\S*$/, ''), STAT_LABELS, 0.7);
      const label = byLabel ? byLabel.value : STAT_LABELS[i];
      if (byLabel && byLabel.value !== STAT_LABELS[i]) result.warnings.push(`${i + 1}번째 줄 라벨이 순서와 다름: ${byLabel.value}`);
      result.stats[label] = r.num.value;
    });
  }
  for (const k of ['공명 효율', '크리티컬', '크리티컬 피해']) {
    const r = rows[STAT_LABELS.indexOf(k)];
    if (r && r.num && !r.num.percent) result.warnings.push(`${k} 값에 %가 없음, 확인 필요`);
  }

  // 머리 영역: 스탯 첫 줄 위. 대략 위 45% 에 속성과 이름, 그 아래에 레벨과 돌파 별
  const top = statLines.length ? statLines[0].bbox.y0 : H * 0.45;
  await workers.kor.setParameters({ tessedit_pageseg_mode: '6' });
  const headText = (await workers.kor.recognize(await backend.crop(clip({ x: 0, y: 0, w: W, h: top * 0.45 }), Math.max(2, 1000 / W)))).data.text;
  const headLines = headText.split('\n').map((t) => t.trim()).filter(Boolean);
  let named = null;
  const pageHead = lines.filter((l) => l.bbox.y1 <= top).map((l) => l.text.replace(/[^가-힣·\s]/g, '').trim()).filter((t) => t.length >= 2);
  for (const t of [...headLines, headLines.join(' '), ...pageHead]) {
    const r = resolveName(t, names, aliases);
    if (r.matched && (!named || r.confidence > named.confidence)) named = r;
  }
  if (!named) {
    const hangul = headLines.filter((t) => /[가-힣]{2,}/.test(t));
    named = { name: (hangul[hangul.length - 1] || '').replace(/[^가-힣·\s]/g, '').replace(/\s+/g, ' ').trim(), matched: false };
    result.warnings.push('캐릭터 목록에서 이름을 찾지 못해 읽은 그대로 사용');
  }
  result.name = named.name;

  // 레벨: "Lv.90/90". 글씨가 가늘어 위치를 조금씩 바꿔 가며 읽고, 말이 되는 값이 나오면 멈춤
  // ("Lv." 의 점만 읽히고 숫자가 붙어 ".90" 처럼 나오는 경우가 많음)
  const lvOf = (t) => {
    const a = t.match(/(\d{1,2})\s*\/\s*(\d{2})/), b = t.match(/\.(\d{1,2})(?!\d)/);
    const cur = a ? +a[1] : b ? +b[1] : 0, max = a ? +a[2] : null;
    if (cur < 1 || cur > 90) return null;
    return { current: cur, max: max && max >= cur && max <= 90 && max % 10 === 0 ? max : null };
  };
  // 여러 위치에서 읽어 "90/90" 처럼 최대 레벨까지 읽힌 값을 우선, 없으면 두 자리 값 중 가장 많이 나온 값
  const lvs = [];
  for (const [ys, hs] of [[0.42, 0.3], [0.5, 0.15], [0.55, 0.15], [0.45, 0.15], [0.6, 0.15]]) {
    const lv = lvOf((await workers.num.recognize(await backend.crop(clip({ x: 0, y: top * ys, w: W * 0.5, h: top * hs }), 900 / W))).data.text);
    if (lv) lvs.push(lv);
  }
  const pickLv = (list) => {
    const cnt = new Map();
    for (const l of list) cnt.set(l.current, (cnt.get(l.current) || 0) + 1);
    const best = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
    return best && list.find((l) => l.current === best[0]);
  };
  result.level = pickLv(lvs.filter((l) => l.max)) || pickLv(lvs.filter((l) => l.current >= 10)) || pickLv(lvs) || null;
  if (!result.level) {
    const lvLine = lines.find((l) => l.bbox.y0 < top && /\d{1,2}\s*\//.test(l.text));
    const m2 = lvLine && lvLine.text.match(/(\d{2})\s*\//);
    if (m2 && +m2[1] >= 1 && +m2[1] <= 90) result.level = { current: +m2[1], max: null };
  }
  if (!result.level) result.warnings.push('레벨을 찾지 못함');
  return result;
}

// ---------- WuWa Bot 카드 ----------

// 1920x1080 기준 좌표. 다른 해상도는 비율로 맞춘다.
export const BOT_CARD = {
  base: { w: 1920, h: 1080 },
  name: { x: 60, y: 15, w: 125, h: 70 },
  elementIcon: { x: 18, y: 24, w: 46, h: 48 },
  level: { x: 205, y: 40, w: 60, h: 25 },
  // 공명 체인 별 가운데. 켜진 별은 안에 체인 아이콘(밝은 금색)이 있고 꺼진 별은 가운데가 어두움
  chainStars: [190, 264, 344, 424, 504, 584].map((x) => ({ x: x - 8, y: 564, w: 16, h: 16 })),
  skills: [[1108, 198], [882, 354], [1308, 354], [962, 600], [1228, 600]].map(([x, y]) => ({ x: x - 25, y: y - 13, w: 70, h: 26 })),
  weaponName: { x: 1600, y: 452, w: 260, h: 30 },
  weaponLevel: { x: 1655, y: 508, w: 55, h: 28 },
  weaponAscension: [1618, 1643, 1668, 1693, 1718, 1743].map((x) => ({ x: x - 7, y: 592, w: 14, h: 14 })),
  echoX: [22, 397, 772, 1147, 1521],
  echo: {
    mainLabel: { dx: 225, y: 723, w: 145, h: 24 },
    mainValue: { dx: 270, y: 752, w: 100, h: 32 },
    rowsY: [857, 894, 928, 962, 996, 1030],
    rowLabel: { dx: 40, w: 230, h: 30 },
    rowValue: { dx: 255, w: 112, h: 30 },
    icon: { dx: 0, y: 650, w: 190, h: 180 },
  },
};

// 부옵 수치 범위 (5성, 최소~최대). 범위를 벗어나면 숫자를 잘못 읽은 것으로 보고 고친다
const SUB_RANGE = {
  '크리티컬%': [6.3, 10.5], '크리티컬 피해%': [12.6, 21], '공격력%': [6.4, 11.6], 'HP%': [6.4, 11.6], '방어력%': [8.1, 14.7], '공명 효율%': [6.8, 12.4],
  '일반 공격 피해 보너스%': [6.4, 11.6], '강공격 피해 보너스%': [6.4, 11.6], '공명 스킬 피해 보너스%': [6.4, 11.6], '공명 해방 피해 보너스%': [6.4, 11.6],
  '공격력': [30, 60], 'HP': [320, 580], '방어력': [40, 70],
};

// 예: 크리티컬 "71.5" -> 숫자 하나를 더 읽은 것. 한 글자씩 빼 보고 범위에 맞는 값을 고른다
function fixSubValue(stat, num, raw) {
  const range = SUB_RANGE[stat + (num.percent ? '%' : '')];
  if (!range || (num.value >= range[0] && num.value <= range[1])) return num;
  const digits = (raw.match(/[\d.]+/) || [''])[0];
  for (let i = 0; i < digits.length; i++) {
    const v = parseFloat(digits.slice(0, i) + digits.slice(i + 1));
    if (v >= range[0] && v <= range[1]) return { ...num, value: v, fixed: true };
  }
  // % 가 빠졌거나 붙은 경우: 같은 이름의 다른 쪽 범위에 맞으면 그쪽으로
  const other = SUB_RANGE[stat + (num.percent ? '' : '%')];
  if (other && num.value >= other[0] && num.value <= other[1]) return { ...num, percent: !num.percent, fixed: true, suspicious: true };
  return { ...num, suspicious: true };
}

// 코스트별 고정 메인 옵션 (5성 +25 기준)
const COST_BY_FLAT = [
  { cost: 4, label: '공격력', value: 150 },
  { cost: 3, label: '공격력', value: 100 },
  { cost: 1, label: 'HP', value: 2280 },
];

// 에코 아이콘을 12x12 색 평균으로 줄인 값 (평균을 빼고 길이 1로 맞춤). 사이트의 에코 이미지도 같은 방식으로 미리 계산해 둠
export const ECHO_FEAT_SIZE = 12;
export function decodeEchoFeat(b64) {
  const bin = atob(b64), v = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) v[i] = ((bin.charCodeAt(i) << 24) >> 24);
  return normalize(v);
}
function normalize(v) {
  let m = 0; for (const x of v) m += x; m /= v.length;
  let n = 0; for (let i = 0; i < v.length; i++) { v[i] -= m; n += v[i] * v[i]; }
  n = Math.sqrt(n) || 1; for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}
// echoDb: [{ name, cost, img, feat(Float32Array) }]. 같은 코스트 중 가장 비슷한 에코를 고른다
export function matchEcho(q, echoDb, cost) {
  const pool = echoDb.filter((e) => e.feat && (!cost || e.cost === cost));
  const scored = pool.map((e) => { let s = 0; for (let i = 0; i < q.length; i++) s += q[i] * e.feat[i]; return { e, s }; }).sort((a, b) => b.s - a.s);
  if (!scored.length) return null;
  const [a, b] = scored;
  return { echo: a.e, score: a.s, sure: a.s >= 0.9 && (!b || a.s - b.s >= 0.03 || b.e.name === a.e.name) };
}

export async function parseBotCard(backend, workers, { names = [], aliases = {}, weapons = [], echoDb = null } = {}) {
  const sx = backend.width / BOT_CARD.base.w, sy = backend.height / BOT_CARD.base.h;
  const R = (r) => ({ x: Math.round(r.x * sx), y: Math.round(r.y * sy), w: Math.round(r.w * sx), h: Math.round(r.h * sy) });
  const readKor = async (r, psm = '7', invert = true) => {
    await workers.kor.setParameters({ tessedit_pageseg_mode: psm });
    return (await workers.kor.recognize(await backend.crop(R(r), 3 / sx, invert))).data.text.trim();
  };
  const readNum = async (r, scale = 3, invert = false) => (await workers.num.recognize(await backend.crop(R(r), scale / sx, invert))).data.text.trim();

  const result = { kind: 'bot-card', warnings: [] };
  // 레벨 배지(금색)는 이름 길이에 따라 옆으로 밀리므로 위치를 찾아서 읽음
  let badge = null;
  for (let x = 140; x < 420; x += 2) if (await backend.goldFraction(R({ x, y: 42, w: 2, h: 22 })) > 0.5) { badge = x; break; }
  const nameBox = badge ? { ...BOT_CARD.name, w: Math.max(60, badge - 8 - BOT_CARD.name.x) } : BOT_CARD.name;
  result.name = resolveName(await readKor(nameBox), names, aliases).name;
  // 이름 왼쪽 속성 아이콘 색 (방랑자처럼 이름이 같고 속성만 다른 공명자 구분용)
  if (backend.vividMean) result.element = elementByColor(await backend.vividMean(R(BOT_CARD.elementIcon)));
  const lv = (await readNum(badge ? { ...BOT_CARD.level, x: badge + 21 } : BOT_CARD.level)).match(/(\d{1,2})/);
  result.level = lv ? +lv[1] : null;

  const chain = [];
  for (const r of BOT_CARD.chainStars) chain.push(await backend.brightness(R(r)));
  result.chain = chain.filter((v) => v > 134).length;   // 잠긴 별 ≈126, 열린 별(아이콘) ≈138~155

  result.skills = [];
  for (const r of BOT_CARD.skills) {
    const m = (await readNum(r)).match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
    result.skills.push(m ? +m[1] : null);
  }

  const weaponRaw = (await readKor(BOT_CARD.weaponName)).replace(/[^가-힣0-9·\s]/g, '').trim();
  const weaponHit = bestMatch(weaponRaw, weapons, 0.5);
  result.weapon = { name: weaponHit ? weaponHit.value : weaponRaw };
  const wl = (await readNum(BOT_CARD.weaponLevel)).match(/(\d{1,2})/);
  result.weapon.level = wl ? +wl[1] : null;
  const asc = [];
  for (const r of BOT_CARD.weaponAscension) asc.push(await backend.goldFraction(R(r)));
  result.weapon.ascension = asc.filter((f) => f > 0.25).length;

  result.echoes = [];
  const E = BOT_CARD.echo;
  for (const x0 of BOT_CARD.echoX) {
    const echo = { main: null, mainFlat: null, cost: null, subs: [] };
    const mainLabel = bestMatch(await readKor({ x: x0 + E.mainLabel.dx, y: E.mainLabel.y, w: E.mainLabel.w, h: E.mainLabel.h }), MAIN_STAT_NAMES, 0.5);
    const mainVal = parseNumber(await readNum({ x: x0 + E.mainValue.dx, y: E.mainValue.y, w: E.mainValue.w, h: E.mainValue.h }));
    echo.main = { stat: mainLabel ? mainLabel.value : null, value: mainVal ? mainVal.value : null, percent: true };

    for (let i = 0; i < E.rowsY.length; i++) {
      const y = E.rowsY[i] - 15;
      const box = { x: x0 + E.rowLabel.dx, y, w: E.rowLabel.w, h: E.rowLabel.h };
      const rawNum = await readNum({ x: x0 + E.rowValue.dx, y, w: E.rowValue.w, h: E.rowValue.h });
      let num = parseNumber(rawNum);
      let label = bestMatch(await readKor(box), SUBSTAT_NAMES, 0.5);
      if (!label) label = bestMatch(await readKor(box, '7', false), SUBSTAT_NAMES, 0.5); // 뒤집지 않고 한 번 더
      // 한글 모델이 "HP"를 잘 못 읽는다. 라벨이 안 맞으면 HP 로 본다 (HP 줄만 영문)
      const stat = label ? label.value : 'HP';
      if (!label) echo.uncertain = true;
      if (num && i > 0) {
        // 범위를 벗어나면 (예: 방어력 "50"을 "10"으로 읽음) 크기 · 반전을 바꿔 다시 읽고, 같은 단위로 범위에 맞는 값이 나오면 그 값을 씀
        const range = SUB_RANGE[stat + (num.percent ? '%' : '')];
        if (range && (num.value < range[0] || num.value > range[1])) {
          for (const [sc, inv] of [[4, false], [2, false], [3, true], [5, false]]) {
            const alt = parseNumber(await readNum({ x: x0 + E.rowValue.dx, y, w: E.rowValue.w, h: E.rowValue.h }, sc, inv));
            if (alt && alt.percent === num.percent && alt.value >= range[0] && alt.value <= range[1]) { num = alt; break; }
          }
        }
        num = fixSubValue(stat, num, rawNum);
        if (num.suspicious) result.warnings.push(`에코 ${result.echoes.length + 1}의 ${stat} 값(${num.value}) 확인 필요`);
      }
      const row = { stat, value: num ? num.value : null, percent: num ? num.percent : false };
      if (i === 0) echo.mainFlat = row; else echo.subs.push(row);
    }
    const c = COST_BY_FLAT.find((c) => echo.mainFlat && c.label === echo.mainFlat.stat && c.value === echo.mainFlat.value);
    echo.cost = c ? c.cost : null;
    if (echoDb && backend.feature) {
      const hit = matchEcho(await backend.feature(R({ x: x0 + E.icon.dx, y: E.icon.y, w: E.icon.w, h: E.icon.h })), echoDb, echo.cost);
      if (hit) {
        echo.name = hit.echo.name; echo.img = hit.echo.img; echo.matchScore = +hit.score.toFixed(3);
        // 아이콘이 거의 같은 에코가 있어도 가장 비슷한 것으로 넣음 (틀리면 사용자가 바꿈)
        // 강화가 덜 된 에코는 고정 메인 수치로 코스트를 못 정하므로 찾은 에코의 코스트를 씀
        if (echo.cost == null && hit.echo.cost) echo.cost = hit.echo.cost;
      }
    }
    if (echo.cost == null) result.warnings.push(`에코 ${result.echoes.length + 1}: 코스트를 판단하지 못함`);
    fixBotMain(echo);
    echo.subs = echo.subs.filter((x) => x.value != null);   // 덜 강화된 에코는 부옵 칸이 비어 있음
    result.echoes.push(echo);
  }
  return result;
}

// ---------- 에코 한 개 (게임 에코 상세 창 캡처) ----------

// 에코 이름(+강화 단계) · COST · 옵션 줄(메인, 고정 메인, 부옵 5개) 순서. 캡처 범위가 제각각이라 줄 위치로 읽는다
const COST_RE = /C\s*[O0o]\s*S\s*T/i;
const echoNameOf = (text) => text.replace(/\+\s*\d+/g, '').replace(/[^가-힣·\s]/g, '').trim();
// 맨 위 두 줄 중 하나가 에코 이름이면 에코 창 (COST 글자는 금색이라 잘 안 읽힘)
function findEchoHead(lines, echoDb) {
  if (!echoDb) return null;
  const names = echoDb.map((e) => e.name);
  for (const [i, l] of lines.slice(0, 2).entries()) {
    const hit = bestMatch(echoNameOf(l.text), names, 0.7);
    if (hit) return { index: i, name: hit.value };
  }
  return null;
}
export const isEchoPanel = (lines, echoDb) => lines.some((l) => COST_RE.test(l.text)) || !!findEchoHead(lines, echoDb);

export async function parseEchoPanel(backend, workers, { echoDb = null, lines }) {
  const W = backend.width, H = backend.height;
  const result = { kind: 'echo', echo: null, warnings: [] };
  const clip = (box) => {
    const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
    return { x, y, w: Math.max(1, Math.min(W - x, Math.ceil(box.w))), h: Math.max(1, Math.min(H - y, Math.ceil(box.h))) };
  };
  const headHit = findEchoHead(lines, echoDb);
  // COST 줄: 글자로 찾고, 못 찾으면 이름 바로 다음 줄
  const costLine = lines.find((l) => COST_RE.test(l.text)) || lines[(headHit?.index ?? 0) + 1] || lines[0];
  const echo = { name: null, img: null, cost: null, level: null, main: null, mainFlat: null, subs: [] };

  // 이름: COST 줄 위쪽 글자 (강화 단계 "+25" 는 따로)
  const head = lines.filter((l) => l.bbox.y1 <= costLine.bbox.y0 + 2).map((l) => l.text).join(' ');
  const lv = head.match(/\+\s*(\d{1,2})/);
  if (lv && +lv[1] <= 25) echo.level = +lv[1];
  const rawName = echoNameOf(head);
  const name = headHit?.name || (echoDb && bestMatch(rawName, echoDb.map((e) => e.name), 0.5)?.value);
  const db = name && echoDb.find((e) => e.name === name);
  if (db) { echo.name = db.name; echo.img = db.img; }
  else result.warnings.push(`에코 이름을 찾지 못함${rawName ? ` (${rawName})` : ''}`);
  const c = costLine.text.replace(COST_RE, ' ').match(/(?:^|\s)([134])(?=\s|$)/);
  echo.cost = db?.cost ?? (c ? +c[1] : null);

  // 옵션 줄: COST 줄 아래에서 숫자로 끝나는 줄
  const rows = lines.filter((l) => l.bbox.y0 >= costLine.bbox.y1 - 2 && /\d[\d.,]*\s*%?\s*\S{0,2}$/.test(l.text)).slice(0, 7);
  for (const [i, l] of rows.entries()) {
    const h = l.bbox.y1 - l.bbox.y0;
    const box = clip({ x: W * 0.6, y: l.bbox.y0 - h * 0.25, w: W * 0.4, h: h * 1.5 });
    const rawNum = (await workers.num.recognize(await backend.crop(box, Math.max(2, 60 / h)))).data.text.trim();
    let num = parseNumber(rawNum) || parseNumber(l.text);
    const labelText = l.text.replace(/[\d.,]+\s*%?\s*\S{0,2}$/, '').replace(/[^가-힣A-Za-z\s]/g, '').trim();
    const label = bestMatch(labelText, i === 0 ? MAIN_STAT_NAMES : SUBSTAT_NAMES, 0.5);
    const stat = label ? label.value : 'HP'; // 한글 모델이 "HP"를 잘 못 읽음
    if (num && i > 1) {
      num = fixSubValue(stat, num, rawNum);
      if (num.suspicious) result.warnings.push(`${stat} 값(${num.value}) 확인 필요`);
    }
    const row = { stat, value: num ? num.value : null, percent: num ? num.percent : false };
    if (i === 0) echo.main = { ...row, percent: true };
    else if (i === 1) echo.mainFlat = row;
    else echo.subs.push(row);
  }
  if (!echo.main) result.warnings.push('옵션을 읽지 못함');
  if (echo.cost == null && echo.mainFlat) echo.cost = COST_BY_FLAT.find((x) => x.label === echo.mainFlat.stat && x.value === echo.mainFlat.value)?.cost ?? null;
  if (echo.cost == null) result.warnings.push('코스트를 판단하지 못함');
  result.echo = echo;
  return result;
}

// 속성 아이콘의 평균 색상(색상환 각도)으로 속성을 고름
const ELEMENT_HUE = { fusion: 15, spectro: 50, aero: 155, glacio: 205, electro: 270, havoc: 330 };
function elementByColor(rgb) {
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 0.1) return null;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const dist = (a) => Math.min(Math.abs(a - h), 360 - Math.abs(a - h));
  return Object.keys(ELEMENT_HUE).sort((a, b) => dist(ELEMENT_HUE[a]) - dist(ELEMENT_HUE[b]))[0];
}

// ---------- 이미지 종류 판별 ----------

export function detectKind(backend) {
  const ratio = backend.width / backend.height;
  return Math.abs(ratio - 16 / 9) < 0.05 && backend.width >= 1280 ? 'bot-card' : 'stat-screen';
}

// ---------- 브라우저 backend ----------

export async function createCanvasBackend(file) {
  const bmp = await createImageBitmap(file);
  const src = document.createElement('canvas');
  src.width = bmp.width; src.height = bmp.height;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(bmp, 0, 0);
  return {
    width: bmp.width, height: bmp.height,
    // white: 흰 글자만 남기기 (밝고 색이 거의 없는 픽셀만 검정, 나머지는 흰색). 배경 그림이 숫자와 겹칠 때 다시 읽는 용도
    async crop({ x, y, w, h }, scale = 2, invert = false, white = 0) {
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
      // 흑백 + 대비 늘리기 (밝기 하위 1% ~ 상위 1% 를 0~255 로)
      const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data, hist = new Array(256).fill(0);
      if (white) {
        for (let i = 0; i < d.length; i += 4) {
          const mn = Math.min(d[i], d[i + 1], d[i + 2]), mx = Math.max(d[i], d[i + 1], d[i + 2]);
          d[i] = d[i + 1] = d[i + 2] = mn > white && mx - mn < 40 ? 0 : 255;
        }
        ctx.putImageData(img, 0, 0);
        return c;
      }
      for (let i = 0; i < d.length; i += 4) { const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); d[i] = g; hist[g]++; }
      const n = d.length / 4;
      let lo = 0, hi = 255, acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.01) { lo = v; break; } }
      acc = 0;
      for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.01) { hi = v; break; } }
      const k = 255 / Math.max(1, hi - lo);
      for (let i = 0; i < d.length; i += 4) { let g = Math.min(255, Math.max(0, (d[i] - lo) * k)); if (invert) g = 255 - g; d[i] = d[i + 1] = d[i + 2] = g; }
      ctx.putImageData(img, 0, 0);
      return c;
    },
    async feature({ x, y, w, h }, S = ECHO_FEAT_SIZE) {
      const d = sctx.getImageData(x, y, w, h).data, v = new Float32Array(S * S * 3);
      for (let gy = 0; gy < S; gy++) for (let gx = 0; gx < S; gx++) {
        const y0 = Math.floor(gy * h / S), y1 = Math.floor((gy + 1) * h / S), x0 = Math.floor(gx * w / S), x1 = Math.floor((gx + 1) * w / S);
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * w + xx) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
        const o = (gy * S + gx) * 3; v[o] = r / n; v[o + 1] = g / n; v[o + 2] = b / n;
      }
      return normalize(v);
    },
    // 줄마다 흰 글자 픽셀 수 (밝고 색이 거의 없는 픽셀)
    async rowProfile({ x, y, w, h }, T = 170) {
      const d = sctx.getImageData(x, y, w, h).data, out = new Array(h).fill(0);
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const i = (yy * w + xx) * 4, mn = Math.min(d[i], d[i + 1], d[i + 2]), mx = Math.max(d[i], d[i + 1], d[i + 2]);
        if (mn > T && mx - mn < 40) out[yy]++;
      }
      return out;
    },
    // 채도가 높은 픽셀만 평균 낸 색 (아이콘의 흰 테두리 · 어두운 배경 제외)
    async vividMean({ x, y, w, h }) {
      const d = sctx.getImageData(x, y, w, h).data, sum = [0, 0, 0];
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 60) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; n++; }
      return n > 10 ? sum.map((v) => v / n) : null;
    },
    async brightness({ x, y, w, h }) {
      const d = sctx.getImageData(x, y, w, h).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      return sum / (w * h);
    },
    async goldFraction({ x, y, w, h }) {
      const d = sctx.getImageData(x, y, w, h).data;
      let gold = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] - d[i + 2] > 60 && d[i] > 120) gold++;
      return gold / (w * h);
    },
  };
}

export async function parseImage(file, workers, opts) {
  const backend = await createCanvasBackend(file);
  if (detectKind(backend) === 'bot-card') return parseBotCard(backend, workers, opts);
  const lines = await readPageLines(backend, workers);
  if (isEchoPanel(lines, opts.echoDb)) return parseEchoPanel(backend, workers, { ...opts, lines });
  const r = await parseStatScreen(backend, workers, { ...opts, lines });
  // 캐릭터 머리카락 · 무기 같은 배경이 글자와 겹쳐 덜 읽혔으면 흰 글자만 남겨 한 번 더 읽고 나은 쪽을 씀
  const score = (x) => Object.keys(x.stats).length * 10 - x.warnings.length;
  if (Object.keys(r.stats).length === 6 && !r.warnings.length) return r;
  const wb = { ...backend, base: backend, crop: (box, scale, invert) => backend.crop(box, scale, invert, 170) };
  const r2 = await parseStatScreen(wb, workers, { ...opts, lines: await readBandLines(backend, workers) });
  const best = score(r2) > score(r) ? r2 : r, other = best === r ? r2 : r;
  if (!best.level && other.level) { best.level = other.level; best.warnings = best.warnings.filter((w) => w !== '레벨을 찾지 못함'); }
  return best;
}

// ---------- 사이트에서 쓰는 진입점 ----------

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
let workersPromise = null;

function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => fail(new Error('스크립트를 불러오지 못함: ' + src));
    document.head.appendChild(s);
  });
}

// 처음 한 번만 인식 엔진과 언어 데이터를 내려받는다 (이후 브라우저 캐시)
export async function getWorkers() {
  if (!workersPromise) workersPromise = (async () => {
    if (!window.Tesseract) await loadScript(TESSERACT_URL);
    return createWorkers(window.Tesseract);
  })().catch((e) => { workersPromise = null; throw e; });
  return workersPromise;
}
