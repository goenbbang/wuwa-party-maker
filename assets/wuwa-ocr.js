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
export async function parseStatScreen(backend, workers, { names = [], aliases = {} } = {}) {
  const W = backend.width, H = backend.height;
  const scale = Math.max(1, 1200 / W);
  await workers.kor.setParameters({ tessedit_pageseg_mode: '3' });
  const page = await workers.kor.recognize(await backend.crop({ x: 0, y: 0, w: W, h: H }, scale));
  const lines = (page.data.lines || []).map((l) => ({
    text: l.text.trim(),
    bbox: { x0: l.bbox.x0 / scale, y0: l.bbox.y0 / scale, x1: l.bbox.x1 / scale, y1: l.bbox.y1 / scale },
  })).filter((l) => l.text);

  const result = { kind: 'stat-screen', name: null, level: null, stats: {}, warnings: [] };
  const clip = (box) => {
    const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
    return { x, y, w: Math.max(1, Math.min(W - x, Math.ceil(box.w))), h: Math.max(1, Math.min(H - y, Math.ceil(box.h))) };
  };

  // 스탯 줄: 오른쪽 끝이 숫자로 끝나는 줄 중 아래쪽 6개 (스탯 목록이 창 맨 아래에 있음)
  const statLines = lines.filter((l) => /\d[\d.,]*\s*%?\s*\S{0,2}$/.test(l.text) && l.bbox.x1 > W * 0.6 && l.bbox.y0 > H * 0.3).slice(-6);
  const rows = [];
  for (const l of statLines) {
    const h = l.bbox.y1 - l.bbox.y0;
    const box = clip({ x: W * 0.55, y: l.bbox.y0 - h * 0.2, w: W * 0.45, h: h * 1.4 });
    const n = await workers.num.recognize(await backend.crop(box, Math.max(2, 60 / h)));
    const num = parseNumber(n.data.text) || parseNumber(l.text);
    if (num) rows.push({ label: l.text, num });
  }
  if (rows.length < 6) result.warnings.push(`스탯 줄을 ${rows.length}개만 찾음`);
  rows.slice(0, 6).forEach((r, i) => {
    const byLabel = bestMatch(r.label.replace(/[\d.,%]+\S*$/, ''), STAT_LABELS, 0.7);
    const label = byLabel ? byLabel.value : STAT_LABELS[i];
    if (byLabel && byLabel.value !== STAT_LABELS[i]) result.warnings.push(`${i + 1}번째 줄 라벨이 순서와 다름: ${byLabel.value}`);
    result.stats[label] = r.num.value;
  });
  for (const k of ['공명 효율', '크리티컬', '크리티컬 피해']) {
    const r = rows[STAT_LABELS.indexOf(k)];
    if (r && !r.num.percent) result.warnings.push(`${k} 값에 %가 없음, 확인 필요`);
  }

  // 머리 영역: 스탯 첫 줄 위. 대략 위 45% 에 속성과 이름, 그 아래에 레벨과 돌파 별
  const top = statLines.length ? statLines[0].bbox.y0 : H * 0.45;
  await workers.kor.setParameters({ tessedit_pageseg_mode: '6' });
  const headText = (await workers.kor.recognize(await backend.crop(clip({ x: 0, y: 0, w: W, h: top * 0.45 }), Math.max(2, 1000 / W)))).data.text;
  const headLines = headText.split('\n').map((t) => t.trim()).filter(Boolean);
  let named = null;
  for (const t of [...headLines, headLines.join(' ')]) {
    const r = resolveName(t, names, aliases);
    if (r.matched && (!named || r.confidence > named.confidence)) named = r;
  }
  if (!named) {
    const hangul = headLines.filter((t) => /[가-힣]{2,}/.test(t));
    named = { name: (hangul[hangul.length - 1] || '').replace(/[^가-힣·\s]/g, '').replace(/\s+/g, ' ').trim(), matched: false };
    result.warnings.push('캐릭터 목록에서 이름을 찾지 못해 읽은 그대로 사용');
  }
  result.name = named.name;

  // 레벨: "Lv.90/90"
  const lvText = (await workers.num.recognize(await backend.crop(clip({ x: 0, y: top * 0.42, w: W * 0.45, h: top * 0.3 }), Math.max(2, 900 / W)))).data.text;
  const m = lvText.match(/(\d{1,2})\s*\/\s*(\d{2})/), m1 = lvText.match(/(\d{2})/);
  if (m) result.level = { current: +m[1], max: +m[2] };
  else if (m1 && +m1[1] <= 90) result.level = { current: +m1[1], max: null };
  else {
    const lvLine = lines.find((l) => l.bbox.y0 < top && /\d{1,2}\s*\//.test(l.text));
    const m2 = lvLine && lvLine.text.match(/(\d{2})\s*\//);
    if (m2) result.level = { current: +m2[1], max: null };
  }
  if (!result.level) result.warnings.push('레벨을 찾지 못함');
  return result;
}

// ---------- WuWa Bot 카드 ----------

// 1920x1080 기준 좌표. 다른 해상도는 비율로 맞춘다.
export const BOT_CARD = {
  base: { w: 1920, h: 1080 },
  name: { x: 60, y: 15, w: 125, h: 70 },
  level: { x: 205, y: 40, w: 60, h: 25 },
  chainStars: [190, 264, 344, 424, 504, 584].map((x) => ({ x: x - 22, y: 550, w: 44, h: 44 })),
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
  if (other && num.value >= other[0] && num.value <= other[1]) return { ...num, percent: !num.percent, fixed: true };
  return { ...num, suspicious: true };
}

// 코스트별 고정 메인 옵션 (5성 +25 기준)
const COST_BY_FLAT = [
  { cost: 4, label: '공격력', value: 150 },
  { cost: 3, label: '공격력', value: 100 },
  { cost: 1, label: 'HP', value: 2280 },
];

export async function parseBotCard(backend, workers, { names = [], aliases = {}, weapons = [] } = {}) {
  const sx = backend.width / BOT_CARD.base.w, sy = backend.height / BOT_CARD.base.h;
  const R = (r) => ({ x: Math.round(r.x * sx), y: Math.round(r.y * sy), w: Math.round(r.w * sx), h: Math.round(r.h * sy) });
  const readKor = async (r, psm = '7', invert = true) => {
    await workers.kor.setParameters({ tessedit_pageseg_mode: psm });
    return (await workers.kor.recognize(await backend.crop(R(r), 3 / sx, invert))).data.text.trim();
  };
  const readNum = async (r) => (await workers.num.recognize(await backend.crop(R(r), 3 / sx))).data.text.trim();

  const result = { kind: 'bot-card', warnings: [] };
  result.name = resolveName(await readKor(BOT_CARD.name), names, aliases).name;
  const lv = (await readNum(BOT_CARD.level)).match(/(\d{1,2})/);
  result.level = lv ? +lv[1] : null;

  const chain = [];
  for (const r of BOT_CARD.chainStars) chain.push(await backend.goldFraction(R(r)));
  result.chain = chain.filter((f) => f > 0.25).length;

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
        num = fixSubValue(stat, num, rawNum);
        if (num.suspicious) result.warnings.push(`에코 ${result.echoes.length + 1}의 ${stat} 값(${num.value}) 확인 필요`);
      }
      const row = { stat, value: num ? num.value : null, percent: num ? num.percent : false };
      if (i === 0) echo.mainFlat = row; else echo.subs.push(row);
    }
    const c = COST_BY_FLAT.find((c) => echo.mainFlat && c.label === echo.mainFlat.stat && c.value === echo.mainFlat.value);
    echo.cost = c ? c.cost : null;
    if (!c) result.warnings.push(`에코 ${result.echoes.length + 1}: 코스트를 판단하지 못함`);
    result.echoes.push(echo);
  }
  return result;
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
    async crop({ x, y, w, h }, scale = 2, invert = false) {
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
      // 흑백 + 대비 늘리기 (밝기 하위 1% ~ 상위 1% 를 0~255 로)
      const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data, hist = new Array(256).fill(0);
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
  return detectKind(backend) === 'bot-card' ? parseBotCard(backend, workers, opts) : parseStatScreen(backend, workers, opts);
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
