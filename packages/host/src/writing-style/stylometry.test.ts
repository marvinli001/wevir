import { describe, expect, it } from 'vitest';
import {
  analyzeSamples,
  cjkFraction,
  cleanSample,
  englishFraction,
  loadRegister,
  pickExemplars,
  pickExemplarsStratified,
  registerStats,
  type SampleFile,
  sampleOf,
  sentences,
  tokenize,
} from './stylometry.js';

describe('cleanSample', () => {
  it('转发整篇丢掉', () => {
    expect(cleanSample('---------- Forwarded message ----------\nnot the user')).toBeUndefined();
    expect(cleanSample('---------- 转发的邮件 ----------\n别人写的')).toBeUndefined();
  });

  it('去掉引用的回信与里面的名字', () => {
    const cleaned = cleanSample(
      "Sounds good, let's do Tuesday! I'll bring the notes.\n\n" +
        'On Mon, Jun 1, 2026 at 9:00 AM Alice <a@x.com> wrote:\n> how about tuesday?\n',
    );
    expect(cleaned).toBeDefined();
    expect(cleaned).not.toContain('tuesday?');
    expect(cleaned).not.toContain('Alice');
    const zh = cleanSample(
      '好的，周二见。\n\n于2026年6月1日周一 09:00，张三写道：\n周二可以吗？\n',
    );
    expect(zh).toBe('好的，周二见。');
  });

  it('签名分隔以下全删', () => {
    expect(
      cleanSample('Quick note.\nMore text here.\n-- \nBob Builder\nbob@x.com\n'),
    ).not.toContain('Builder');
    expect(cleanSample('马上发。\n发自我的iPhone')).toBe('马上发。');
  });

  it('Outlook 式引用：有分隔线、只有邮件头都截断', () => {
    const outlook =
      "Sounds good, I'll send the deck tonight.\n\n" +
      '________________________________\n' +
      'From: Alice <a@x.com>\nSent: Mon, Jun 1, 2026 9:00 AM\n' +
      'To: Bob <b@x.com>\nSubject: Re: deck\n\n' +
      'Can you send the deck by EOD?\n';
    for (const text of [outlook, outlook.replace('________________________________\n', '')]) {
      const cleaned = cleanSample(text);
      expect(cleaned).toContain('deck tonight');
      expect(cleaned).not.toContain('EOD');
      expect(cleaned).not.toContain('Alice');
    }
    const zh = cleanSample(
      '今晚发。\n\n发件人: 张三\n发送时间: 2026年6月1日\n主题: 回复\n\n能今天发吗？',
    );
    expect(zh).toBe('今晚发。');
  });

  it('正文里单独一行像邮件头的不截断，开头的邮件头跳过', () => {
    expect(
      cleanSample('Two things.\nTo: everyone — thanks for the push.\nShip it Friday.\n'),
    ).toContain('Ship it Friday');
    expect(cleanSample('From: me\nTo: you\nSubject: hi\n\nActual body here.\n')).toBe(
      'Actual body here.',
    );
  });

  it('弯撇号算缩写', () => {
    const sample = sampleOf(cleanSample('I can’t make it… maybe later.') as string);
    expect(sample.nWords).toBe(6);
    expect(sample.words).toContain("can't");
  });
});

describe('分词与断句', () => {
  it('英文按词，缩写是一个词', () => {
    expect(tokenize("I can't make it today. Maybe tomorrow works?")).toHaveLength(8);
  });

  it('汉字与假名一个字一个词，英文夹在中间照样按词', () => {
    expect(tokenize('今天把 deploy 推了')).toEqual(['今', '天', '把', 'deploy', '推', '了']);
    expect(tokenize('ありがとう')).toHaveLength(5);
    expect(tokenize('안녕하세요 여러분')).toEqual(['안녕하세요', '여러분']);
  });

  it('中文句末标点也断句', () => {
    expect(sentences('先合进去。测试明天补！可以吗？')).toEqual([
      '先合进去。',
      '测试明天补！',
      '可以吗？',
    ]);
  });
});

describe('registerStats', () => {
  it('问候按问候语聚合，不带名字', () => {
    const stats = registerStats(
      ['Hi Alice,\nsee you there.', 'Hi Bob —\nworks for me.'].map((text) =>
        sampleOf(cleanSample(text) as string),
      ),
    );
    expect(stats.common_greetings).toEqual(['hi']);
  });

  it('缩写与语言探针', () => {
    const sample = sampleOf("I can't make it today. Maybe tomorrow works?");
    expect(registerStats([sample]).contractions_per_100_words).toBeGreaterThan(0);
    expect(englishFraction(sample.words)).toBeGreaterThan(0.15);
  });

  it('中文：全角标点、语气词、AI 腔与“不是……而是”', () => {
    const sample = sampleOf(
      '你好，这个其实不难吧。不是代码的问题，而是配置没改！此外，我们要赋能团队……',
    );
    const stats = registerStats([sample]);
    expect(stats.punct_per_1000_chars['!']).toBeGreaterThan(0);
    expect(stats.punct_per_1000_chars[',']).toBeGreaterThan(0);
    expect(stats.cjk_marker_rates_per_1000_chars).toHaveProperty('其实');
    expect(stats.cjk_marker_rates_per_1000_chars).toHaveProperty('吧');
    expect(stats.ai_tell_baseline.cjk_tells_per_1000_chars).toHaveProperty('赋能');
    expect(stats.ai_tell_baseline.not_x_but_y_per_100_sentences).toBeGreaterThan(0);
    expect(stats.common_greetings).toEqual(['你好']);
    expect(cjkFraction(sample.words)).toBeGreaterThan(0.9);
    expect(englishFraction(sample.words)).toBeLessThan(0.15);
  });
});

describe('范文', () => {
  const teamTopics = [
    'the quick brown fox jumps over the lazy dog near the river bank',
    'quarterly revenue projections need a careful review before the board meeting',
    'deployment pipeline flaked again so the release train slips to thursday',
  ];

  it('既要居中又要不一样', () => {
    const docs = [teamTopics[0], teamTopics[0], teamTopics[1]].map((text) =>
      sampleOf(text as string),
    );
    const picked = pickExemplars(docs, 2);
    expect(new Set(picked).size).toBe(2);
    expect(picked).toContain(2);
  });

  it('少数受众也留一个名额', () => {
    const strat = teamTopics.map((text) => ({ ...sampleOf(text), audience: 'team' }));
    strat.push({
      ...sampleOf('thanks so much for flagging this, the quick brown fox team will follow up'),
      audience: 'customer',
    });
    const picked = pickExemplarsStratified(strat, 2);
    expect(picked.some((index) => strat[index]?.audience === 'customer')).toBe(true);
    expect(picked.some((index) => strat[index]?.audience === 'team')).toBe(true);
  });

  it('只有一种受众或没有标签时与不分层的一样', () => {
    const mono = teamTopics.map((text) => ({ ...sampleOf(text), audience: 'team' }));
    expect(pickExemplarsStratified(mono, 2)).toEqual(pickExemplars(mono, 2));
    const untagged = teamTopics.map((text) => sampleOf(text));
    expect(pickExemplarsStratified(untagged, 2)).toEqual(pickExemplars(untagged, 2));
  });
});

describe('loadRegister', () => {
  it('聊天按对话合并，门槛作用在合并后的样本上', () => {
    const files: SampleFile[] = [
      { stem: 'alice__2026-06-01__001', text: 'ship it please :)' },
      { stem: 'alice__2026-06-01__002', text: 'lgtm, merging now' },
      { stem: 'alice__2026-06-01__003', text: 'can you rerun ci' },
      { stem: 'solo', text: 'too short' },
    ];
    const dropped = new Map<string, number>();
    const pooled = loadRegister('dm', files, 10, dropped);
    expect(pooled).toHaveLength(1);
    expect(pooled[0]?.segments).toHaveLength(3);
    expect(pooled[0]?.audience).toBe('alice');
    expect(dropped.get('dm:too_short')).toBe(1);
    const stats = registerStats(pooled);
    expect(stats.n_samples).toBe(1);
    expect(stats.n_messages).toBe(3);
    expect(stats.emoji_per_message).toBeGreaterThan(0);
    expect(stats.emoji_per_message).toBeLessThan(1);
    expect(stats.words_per_sample_median).toBe(10);
    expect(stats.words_per_message_median).toBe(3);
  });

  it('邮件与文档不合并，没有 `__` 的文件没有受众', () => {
    const files: SampleFile[] = [
      { stem: 'a__b__001', text: 'word '.repeat(40) },
      { stem: 'solo', text: 'word '.repeat(40) },
    ];
    const samples = loadRegister('email', files, 30, new Map());
    expect(samples).toHaveLength(2);
    expect(samples.every((sample) => sample.segments.length === 1)).toBe(true);
    expect(samples.map((sample) => sample.audience)).toEqual(['a', undefined]);
  });
});

describe('analyzeSamples', () => {
  it('每个落点出统计与范文，合并的范文逐条列出', () => {
    const chat: SampleFile[] = [
      { stem: 'agent__s1__2026-10-01__001', text: '先别动配置文件，跑一下测试看看。' },
      { stem: 'agent__s1__2026-10-01__002', text: '好，那就按你说的改，改完提交。' },
    ];
    const result = analyzeSamples(new Map([['chat', chat]]));
    expect(result?.analysis.provenance).toEqual({ chat: 2 });
    expect(result?.analysis.registers.chat?.non_english_suspected).toBe(true);
    expect(result?.exemplars).toContain('## Register: chat');
    expect(result?.exemplars).toContain('bundle of 2 messages');
    expect(result?.exemplars).toContain('\n\n---\n\n');
  });

  it('没有能用的样本时 undefined', () => {
    expect(analyzeSamples(new Map([['email', [{ stem: 'x', text: 'short' }]]]))).toBeUndefined();
  });
});
