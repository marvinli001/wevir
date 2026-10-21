// 写作风格的文体统计（0.95.0，domain-model §3.43）：把用户自己写的样本按“落点”（email / chat / dm / doc，Wevir 的聊天记录归 chat）
// 分组，去掉别人的文字（引用的回信、转发、签名），算每组的句长、标点、缩写、问候与落款、虚词频率、常用短语与 AI 腔的基线，再挑几篇
// 有代表性又彼此不同的范文。Agent 拿结果去写档案，所以这里只做能数出来的事，语气由 Agent 读范文判断。
//
// 方法照维护者提供的 setup-writing-style 技能附带的 stylometry.py（清理规则、按会话合并短消息、长度门槛、TF-IDF 加最远点选范文、
// 按受众分层），用 TypeScript 重写，不依赖 Python。按 Wevir 的用户补了中文：汉字与假名一个字算一个词（中文没有空格，按 Python 版的
// 正则一整句会成一个词，长度门槛与句长都失效），句末的。！？也断句，统计全角标点、中文问候与落款、语气词与常用连接词，中文的转发、
// 引用回信与签名格式，以及中文的 AI 腔词与“不是……而是”句式。

/** 聊天类的落点：用 `chatMinWords`，同一段对话的短消息合并成一份样本。 */
const CHAT_REGISTERS = /^(dm|internal_msg|slack|chat)/i;

const FORWARD_MARKERS = [
  '---------- forwarded message',
  'begin forwarded message',
  '-----original message-----',
  '转发的邮件',
  '原始邮件',
];
const AUTOREPLY_MARKERS = [
  'out of office',
  'automatic reply',
  'auto-reply',
  'ooo until',
  '自动回复',
];
/** 引用的回信（“On … wrote:” / “于 … 写道：”）连同后面的全部，是别人的文字。 */
const QUOTED_TAIL = /\n+(?:On .{5,80}wrote:|.{0,80}写道[:：])\s*\n/s;
/** 回信里的邮件头与签名分隔，也不是用户写的。 */
const REPLY_HEADER =
  /^(?:(?:from|to|cc|subject|date|sent):\s|(?:发件人|收件人|抄送|主题|日期|发送时间)[:：])/i;
const SIG_DELIM = /^(?:--\s*$|sent from my |get outlook for |发自我的)/i;
/** Outlook / M365 用一长串下划线或连字符隔开引用的部分。 */
const OUTLOOK_SEP = /^\s*[_-]{8,}\s*$/;

const CONTRACTION =
  /\b\w+'(?:t|re|ve|ll|d|m)\b|\b(?:it|that|there|he|she|what|who|let|here|where|how)'s\b/gi;
const GREETING =
  /^(?:hi|hey|hello|dear|good (?:morning|afternoon)|yo|howdy|你好|您好|嗨|哈喽|早上好|下午好|各位)/i;
const CLOSING =
  /^(?:thanks|thank you|best|cheers|regards|talk soon|warmly|sincerely|ty|thx|谢谢|感谢|多谢|辛苦了|祝好|此致|顺祝)/i;
const BULLET = /^\s*(?:[-*•]|\d+[.)、])\s+\S/m;
const EMOJI = /[\u{1f300}-\u{1faff}\u{2600}-\u{27bf}]|:[a-z_]+:|[:;]-?[)(DPp]/gu;
const SENT_SPLIT = /(?<=[.!?])\s+|(?<=[。！？])|\n{2,}/;
/** 汉字与假名一个字一个词；其余文字是连续的字母（可带撇号），不含数字与下划线。 */
const CJK_CLASS = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]`;
const LETTER = String.raw`(?:(?!${CJK_CLASS})[\p{L}\p{M}])`;
const WORD = new RegExp(`${CJK_CLASS}|${LETTER}+(?:['’]${LETTER}+)*`, 'gu');
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u;

/** 英文的虚词与语气词：相对频率是一个人的指纹。 */
const FUNCTION_WORDS = new Set(
  (
    'the a an and but or so because though although just really actually ' +
    'maybe probably definitely honestly basically pretty quite very also ' +
    'however therefore anyway plus btw fwiw imo tbh kinda sorta gonna'
  ).split(' '),
);
/** 中文的语气词与常用连接词（按出现次数数，每千字）。 */
const CJK_MARKERS = [
  '吧',
  '呢',
  '啊',
  '嘛',
  '呀',
  '哈',
  '啦',
  '哦',
  '其实',
  '然后',
  '所以',
  '但是',
  '不过',
  '就是',
  '感觉',
  '可能',
  '应该',
  '反正',
  '毕竟',
  '总之',
  '而且',
  '因为',
];

/** 常见的 AI 腔：记下用户自己的基线，而不是一律禁用。 */
const AI_TELL_WORDS = new Set(
  (
    'delve leverage robust seamless streamline pivotal crucial crucially ' +
    'notably furthermore moreover additionally comprehensive holistic ' +
    'landscape ecosystem utilize foster empower elevate'
  ).split(' '),
);
const CJK_AI_TELLS = [
  '赋能',
  '抓手',
  '闭环',
  '颗粒度',
  '底层逻辑',
  '助力',
  '值得注意的是',
  '总而言之',
  '综上所述',
  '此外',
  '至关重要',
  '不可或缺',
  '无缝',
  '全方位',
  '深入探讨',
  '彰显',
  '携手',
  '打造',
];
const NOT_X_BUT_Y =
  /\bnot (?:just|only|merely)\b.{3,60}\bbut\b|不是.{1,30}而是|不仅.{1,30}(?:而且|更)/gis;

const STOPWORDS = new Set(
  (
    'the a an and or but if then than so to of in on at for with from by as is ' +
    'are was were be been being it its this that these those i you he she we ' +
    'they them his her my your our their me us do does did have has had will ' +
    'would can could should may might not no yes what which who when where how ' +
    'there here all any some more most other into about over after before ' +
    'out up down off just also very ' +
    '的 了 是 我 你 他 她 它 们 在 和 就 也 都 这 那 有 一 不 个 吗 把 被 给 让 跟 与 及 或 而 上 下 中 到 说 要 会 能 对'
  ).split(' '),
);
const ENGLISH_STOPWORDS = new Set([...STOPWORDS].filter((word) => !CJK.test(word)));

export function tokenize(text: string): string[] {
  return Array.from(text.matchAll(WORD), (match) => match[0].toLowerCase());
}

export function sentences(text: string): string[] {
  return text
    .split(SENT_SPLIT)
    .map((part) => (part ?? '').trim())
    .filter((part) => tokenize(part).length > 0);
}

/**
 * 只留用户自己的文字：转发与自动回复整篇丢掉；去掉引用的回信、`>` 开头的行、回信的邮件头，签名分隔以下全删。别人的文字不能进统计、
 * 范文和档案。
 */
export function cleanSample(raw: string): string | undefined {
  // 弯撇号换成直的，缩写的正则才认得；省略号换成三个点。
  const text0 = raw.replaceAll('’', "'").replaceAll('‘', "'").replaceAll('…', '...');
  const low = text0.toLowerCase();
  if (
    FORWARD_MARKERS.some((marker) => low.includes(marker)) ||
    AUTOREPLY_MARKERS.some((marker) => low.slice(0, 300).includes(marker))
  ) {
    return undefined;
  }
  const src = (text0.split(QUOTED_TAIL)[0] ?? '').split('\n');
  const lines: string[] = [];
  for (let i = 0; i < src.length; i += 1) {
    const line = src[i] ?? '';
    const stripped = line.trimStart();
    if (stripped.startsWith('>')) continue;
    if (SIG_DELIM.test(stripped) || OUTLOOK_SEP.test(stripped)) break;
    if (REPLY_HEADER.test(stripped)) {
      // 正文之后连着两行以上的邮件头是 Outlook 式引用的开头（没有 wrote: 也没有 >）：截断。单独一行像邮件头的跳过（“To: 各位”也可能
      // 是正文）；正文之前的邮件头是这封信自己的，也跳过。
      const next = (src[i + 1] ?? '').trimStart();
      if (lines.length > 0 && REPLY_HEADER.test(next)) break;
      continue;
    }
    lines.push(line);
  }
  const cleaned = lines.join('\n').trim();
  return cleaned === '' ? undefined : cleaned;
}

/** 一份样本：一个文件，或聊天里合并的一段对话（`segments` 留着消息的边界，按消息算的比率不会被合并放大）。 */
export interface Sample {
  text: string;
  segments: string[];
  words: string[];
  sents: string[];
  nWords: number;
  /** 文件名开头的受众标签（`<受众>__…`）；没有标签时 `undefined`。 */
  audience?: string;
}

export function sampleOf(text: string, segments: string[] = [text]): Sample {
  const words = tokenize(text);
  return { text, segments, words, sents: sentences(text), nWords: words.length };
}

function rate(count: number, denom: number, per = 1000): number {
  return denom === 0 ? 0 : Math.round((count / denom) * per * 100) / 100;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function count(text: string, pattern: RegExp | string): number {
  if (typeof pattern === 'string') return text.split(pattern).length - 1;
  return Array.from(text.matchAll(pattern)).length;
}

function topCounts(values: Iterable<string>, limit: number): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  // 次数相同按第一次出现的先后（同 Python 的 Counter.most_common）。
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

export interface RegisterStats {
  n_samples: number;
  n_messages: number;
  n_words: number;
  words_per_sample_median: number;
  /** 合并过的聊天样本按段算，是每条消息的真实长度。 */
  words_per_message_median: number;
  sentence_len_mean: number;
  sentence_len_median: number;
  sentence_len_stdev: number;
  contractions_per_100_words: number;
  punct_per_1000_chars: Record<string, number>;
  exclam_per_100_sentences: number;
  emoji_per_message: number;
  pct_sentences_start_lowercase: number;
  pct_sentences_start_conjunction: number;
  pct_messages_with_bullets: number;
  common_greetings: string[];
  common_closings: string[];
  function_word_rates_per_1000: Record<string, number>;
  cjk_marker_rates_per_1000_chars: Record<string, number>;
  ai_tell_baseline: {
    tell_words_per_1000: Record<string, number>;
    cjk_tells_per_1000_chars: Record<string, number>;
    not_x_but_y_per_100_sentences: number;
    em_dash_per_1000_chars: number;
  };
  frequent_phrases: string[];
}

/** 一个落点的统计。 */
export function registerStats(samples: readonly Sample[]): RegisterStats {
  const allText = samples.map((sample) => sample.text).join('\n\n');
  const allWords = samples.flatMap((sample) => sample.words);
  const allSents = samples.flatMap((sample) => sample.sents);
  const nChars = allText.length;
  const nWords = allWords.length;
  const sentLens = allSents.length === 0 ? [0] : allSents.map((sent) => tokenize(sent).length);
  const sentMean = sentLens.reduce((sum, value) => sum + value, 0) / sentLens.length;
  const sentStdev = Math.sqrt(
    sentLens.reduce((sum, value) => sum + (value - sentMean) ** 2, 0) / sentLens.length,
  );

  // 按消息算的比率按段数，不按样本数：一份合并的样本是很多条消息。
  const segs = samples.flatMap((sample) => sample.segments);
  const firstLines: string[] = [];
  const lastLines: string[] = [];
  for (const seg of segs) {
    const lines = seg
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (lines.length === 0) continue;
    firstLines.push(lines[0] as string);
    // 落款常是“谢谢，”下一行署名，看最后两行。
    lastLines.push(...lines.slice(-2));
  }

  const punct = (...marks: string[]) =>
    rate(
      marks.reduce((sum, mark) => sum + count(allText, mark), 0),
      nChars,
    );
  const emDashes = count(allText, /——|—| - /g);
  const lowerStarts = allSents.filter((sent) => /^\p{Ll}/u.test(sent)).length;
  const conjStarts = allSents.filter((sent) =>
    /^(?:(?:and|but|so|also)\b|但是|不过|所以|然后|而且)/i.test(sent),
  ).length;

  const grams = new Map<string, number>();
  for (const sample of samples) {
    const toks = sample.words;
    for (const n of [2, 3]) {
      for (let i = 0; i + n <= toks.length; i += 1) {
        const gram = toks.slice(i, i + n);
        if (!STOPWORDS.has(gram[0] as string) || !STOPWORDS.has(gram[n - 1] as string)) {
          // 汉字逐字成词，连起来时不加空格。
          const key = gram.every((tok) => CJK.test(tok)) ? gram.join('') : gram.join(' ');
          grams.set(key, (grams.get(key) ?? 0) + 1);
        }
      }
    }
  }
  const commonGrams = [...grams.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200)
    .filter(([, c]) => c >= 3)
    .slice(0, 15)
    .map(([gram]) => gram);

  const ratesOf = (entries: [string, number][], denom: number) =>
    Object.fromEntries(entries.map(([word, c]) => [word, rate(c, denom)]));
  const substringRates = (list: readonly string[]) =>
    Object.fromEntries(
      list
        .map((word) => [word, count(allText, word)] as const)
        .filter(([, c]) => c > 0)
        .map(([word, c]) => [word, rate(c, nChars)]),
    );

  return {
    n_samples: samples.length,
    n_messages: segs.length,
    n_words: nWords,
    words_per_sample_median: median(samples.map((sample) => sample.nWords)),
    words_per_message_median: median(segs.map((seg) => tokenize(seg).length)),
    sentence_len_mean: round1(sentMean),
    sentence_len_median: median(sentLens),
    sentence_len_stdev: round1(sentStdev),
    contractions_per_100_words: rate(count(allText, CONTRACTION), nWords, 100),
    punct_per_1000_chars: {
      '!': punct('!', '！'),
      '?': punct('?', '？'),
      ';': punct(';', '；'),
      ':': punct(':', '：'),
      ',': punct(',', '，'),
      em_dash: rate(emDashes, nChars),
      ellipsis: punct('...'),
      parens: punct('(', '（'),
    },
    exclam_per_100_sentences: rate(count(allText, /[!！]/g), allSents.length, 100),
    emoji_per_message: rate(count(allText, EMOJI), segs.length, 1),
    pct_sentences_start_lowercase: rate(lowerStarts, allSents.length, 100),
    pct_sentences_start_conjunction: rate(conjStarts, allSents.length, 100),
    pct_messages_with_bullets: rate(
      segs.filter((seg) => BULLET.test(seg)).length,
      segs.length,
      100,
    ),
    common_greetings: topCounts(
      firstLines.flatMap((line) => {
        const match = GREETING.exec(line);
        return match === null ? [] : [match[0].toLowerCase()];
      }),
      3,
    ).map(([greeting]) => greeting),
    common_closings: topCounts(
      lastLines.flatMap((line) => {
        const match = CLOSING.exec(line);
        return match === null ? [] : [match[0].toLowerCase()];
      }),
      3,
    ).map(([closing]) => closing),
    function_word_rates_per_1000: ratesOf(
      topCounts(
        allWords.filter((word) => FUNCTION_WORDS.has(word)),
        15,
      ),
      nWords,
    ),
    cjk_marker_rates_per_1000_chars: substringRates(CJK_MARKERS),
    ai_tell_baseline: {
      tell_words_per_1000: ratesOf(
        topCounts(
          allWords.filter((word) => AI_TELL_WORDS.has(word)),
          AI_TELL_WORDS.size,
        ),
        nWords,
      ),
      cjk_tells_per_1000_chars: substringRates(CJK_AI_TELLS),
      not_x_but_y_per_100_sentences: rate(count(allText, NOT_X_BUT_Y), allSents.length, 100),
      em_dash_per_1000_chars: rate(emDashes, nChars),
    },
    frequent_phrases: commonGrams,
  };
}

type Vector = Map<string, number>;

function tfidfVectors(samples: readonly Sample[]): Vector[] {
  const docs = samples.map((sample) => sample.words.filter((word) => !STOPWORDS.has(word)));
  const df = new Map<string, number>();
  for (const doc of docs) for (const word of new Set(doc)) df.set(word, (df.get(word) ?? 0) + 1);
  const n = docs.length;
  return docs.map((doc) => {
    const tf = new Map<string, number>();
    for (const word of doc) tf.set(word, (tf.get(word) ?? 0) + 1);
    const vector: Vector = new Map();
    for (const [word, c] of tf) {
      const d = df.get(word) ?? 0;
      if (d < n) vector.set(word, (1 + Math.log(c)) * Math.log(n / d));
    }
    const norm = Math.sqrt([...vector.values()].reduce((sum, x) => sum + x * x, 0)) || 1;
    for (const [word, x] of vector) vector.set(word, x / norm);
    return vector;
  });
}

function cosine(a: Vector, b: Vector): number {
  const [small, large] = b.size < a.size ? [b, a] : [a, b];
  let sum = 0;
  for (const [word, x] of small) sum += x * (large.get(word) ?? 0);
  return sum;
}

function meanSimilarity(vectors: readonly Vector[]): number[] {
  return vectors.map((v) => vectors.reduce((sum, u) => sum + cosine(v, u), 0) / vectors.length);
}

/** 最远点采样：与已选的范文中最像的那篇都最不像的一篇（相同时偏向居中的）。 */
function fillFarthest(
  vectors: readonly Vector[],
  mean: readonly number[],
  chosen: number[],
  k: number,
) {
  while (chosen.length < k) {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < vectors.length; i += 1) {
      if (chosen.includes(i)) continue;
      const nearest = Math.max(
        ...chosen.map((j) => cosine(vectors[i] as Vector, vectors[j] as Vector)),
      );
      const score = -nearest + 1e-9 * (mean[i] ?? 0);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    chosen.push(best);
  }
  return chosen;
}

/** 先挑最居中的一篇，再一篇篇挑最不一样的：既有代表性又看得出用户的范围。 */
export function pickExemplars(samples: readonly Sample[], k: number): number[] {
  if (samples.length <= k) return samples.map((_, index) => index);
  const vectors = tfidfVectors(samples);
  const mean = meanSimilarity(vectors);
  let first = 0;
  for (let i = 1; i < mean.length; i += 1) if ((mean[i] ?? 0) > (mean[first] ?? 0)) first = i;
  return fillFarthest(vectors, mean, [first], k);
}

/**
 * 同 `pickExemplars`，但一个落点有两种以上受众时，每种先留一个名额（各组最居中的一篇）：语气的证据要成对对照，单看用词的多样性
 * 可能让少数受众一篇都选不上。不到两种受众时与 `pickExemplars` 完全一样。
 */
export function pickExemplarsStratified(samples: readonly Sample[], k: number): number[] {
  const groups = new Map<string, number[]>();
  samples.forEach((sample, index) => {
    if (sample.audience === undefined) return;
    const members = groups.get(sample.audience) ?? [];
    members.push(index);
    groups.set(sample.audience, members);
  });
  if (groups.size < 2 || samples.length <= k) return pickExemplars(samples, k);
  const vectors = tfidfVectors(samples);
  const chosen: number[] = [];
  // 人多的受众在前；k 可能比受众种数少。
  const tags = [...groups.keys()].sort(
    (a, b) =>
      (groups.get(b)?.length ?? 0) - (groups.get(a)?.length ?? 0) || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const tag of tags.slice(0, k)) {
    const members = groups.get(tag) ?? [];
    let central = members[0] as number;
    let centralScore = -Infinity;
    for (const i of members) {
      const score =
        members.reduce((sum, j) => sum + cosine(vectors[i] as Vector, vectors[j] as Vector), 0) /
        members.length;
      if (score > centralScore) {
        centralScore = score;
        central = i;
      }
    }
    chosen.push(central);
  }
  return fillFarthest(vectors, meanSimilarity(vectors), chosen, k);
}

/** 英文停用词的占比：廉价的语言探针，英文远高于 0.15；低于它时缩写、问候、虚词这些英文统计不可靠。 */
export function englishFraction(words: readonly string[]): number {
  if (words.length === 0) return 0;
  return (
    Math.round((words.filter((word) => ENGLISH_STOPWORDS.has(word)).length / words.length) * 1000) /
    1000
  );
}

/** 汉字与假名占全部词的比例：高时句长与长度门槛按字算。 */
export function cjkFraction(words: readonly string[]): number {
  if (words.length === 0) return 0;
  return Math.round((words.filter((word) => CJK.test(word)).length / words.length) * 1000) / 1000;
}

export interface SampleFile {
  /** 不带 `.txt` 的文件名：`<受众>__<来源>__<日期>__<序号>`。 */
  stem: string;
  text: string;
}

/**
 * 读一个落点的样本。聊天类的落点里，文件名去掉最后一段 `__<序号>` 相同的合并成一份（一天里同一段对话的短消息合起来算），长度门槛
 * 作用在合并后的样本上。`dropped` 记下丢了多少、为什么。
 */
export function loadRegister(
  register: string,
  files: readonly SampleFile[],
  minWords: number,
  dropped: Map<string, number>,
): Sample[] {
  const isChat = CHAT_REGISTERS.test(register);
  const groups = new Map<string, string[]>();
  for (const file of [...files].sort((a, b) => (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0))) {
    const cleaned = cleanSample(file.text);
    if (cleaned === undefined) {
      const key = `${register}:forward/autoreply`;
      dropped.set(key, (dropped.get(key) ?? 0) + 1);
      continue;
    }
    const cut = file.stem.lastIndexOf('__');
    const key = isChat && cut >= 0 ? file.stem.slice(0, cut) : file.stem;
    const parts = groups.get(key) ?? [];
    parts.push(cleaned);
    groups.set(key, parts);
  }
  const samples: Sample[] = [];
  for (const [key, parts] of groups) {
    const sample = sampleOf(parts.join('\n\n'), parts);
    if (sample.nWords < minWords) {
      const dropKey = `${register}:too_short`;
      dropped.set(dropKey, (dropped.get(dropKey) ?? 0) + parts.length);
      continue;
    }
    // 文件名的第一段是受众标签：<受众>__<来源>__<日期>__<序号>.txt；没有 `__` 的文件没有标签。
    const cut = key.indexOf('__');
    if (cut >= 0) sample.audience = key.slice(0, cut);
    samples.push(sample);
  }
  return samples;
}

export interface AnalyzeOptions {
  /** 邮件与文档的长度门槛（词，汉字一个字算一个）。 */
  minWords?: number;
  /** 聊天类落点的长度门槛。 */
  chatMinWords?: number;
  /** 每个落点挑几篇范文。 */
  perRegister?: number;
}

export interface RegisterAnalysis extends RegisterStats {
  english_stopword_fraction: number;
  cjk_fraction: number;
  /** 英文的统计（缩写、问候、虚词）不可靠：中文等别的语言。 */
  non_english_suspected: boolean;
  audiences: Record<string, number>;
}

export interface StyleAnalysis {
  registers: Record<string, RegisterAnalysis>;
  dropped: Record<string, number>;
  /** 每个落点用上了几条消息。 */
  provenance: Record<string, number>;
}

/** 范文正文最多多少个字符。 */
const EXEMPLAR_MAX_CHARS = 1800;

/**
 * 分析全部落点：`registers` 是落点名 → 那个落点的样本文件。没有一份能用的样本时 `undefined`。门槛是方法的一部分：样本不够时去多找
 * 真实的文字，不要调低门槛。
 */
export function analyzeSamples(
  registers: ReadonlyMap<string, readonly SampleFile[]>,
  options: AnalyzeOptions = {},
): { analysis: StyleAnalysis; exemplars: string } | undefined {
  const minWords = options.minWords ?? 30;
  const chatMinWords = options.chatMinWords ?? 10;
  const perRegister = options.perRegister ?? 5;
  const analysis: Record<string, RegisterAnalysis> = {};
  const exLines: string[] = [];
  const dropped = new Map<string, number>();
  for (const register of [...registers.keys()].sort()) {
    const isChat = CHAT_REGISTERS.test(register);
    const samples = loadRegister(
      register,
      registers.get(register) ?? [],
      isChat ? chatMinWords : minWords,
      dropped,
    );
    if (samples.length === 0) continue;
    const words = samples.flatMap((sample) => sample.words);
    const ef = englishFraction(words);
    const audiences: Record<string, number> = {};
    for (const sample of samples) {
      if (sample.audience !== undefined) {
        audiences[sample.audience] = (audiences[sample.audience] ?? 0) + 1;
      }
    }
    analysis[register] = {
      ...registerStats(samples),
      english_stopword_fraction: ef,
      cjk_fraction: cjkFraction(words),
      non_english_suspected: ef < 0.15,
      audiences,
    };
    exLines.push(`\n## Register: ${register}\n`);
    pickExemplarsStratified(samples, perRegister).forEach((index, rank) => {
      const sample = samples[index] as Sample;
      // 合并的样本逐条列出，写档案时不会把它当成一篇连续的文字。
      let body = sample.segments.join('\n\n---\n\n');
      if (body.length > EXEMPLAR_MAX_CHARS) body = `${body.slice(0, EXEMPLAR_MAX_CHARS)} […]`;
      let tag = sample.audience === undefined ? '' : ` — ${sample.audience}`;
      if (sample.segments.length > 1) tag += ` — bundle of ${sample.segments.length} messages`;
      exLines.push(`### Exemplar ${rank + 1}${tag}\n\n${body}\n`);
    });
  }
  if (Object.keys(analysis).length === 0) return undefined;
  return {
    analysis: {
      registers: analysis,
      dropped: Object.fromEntries(dropped),
      provenance: Object.fromEntries(
        Object.entries(analysis).map(([register, stats]) => [register, stats.n_messages]),
      ),
    },
    exemplars: `# Selected exemplars\n${exLines.join('\n')}`,
  };
}
