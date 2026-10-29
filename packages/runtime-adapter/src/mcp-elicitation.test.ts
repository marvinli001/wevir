import { describe, expect, it } from 'vitest';
import { elicitationQuestions, elicitationResult, elicitationUrl } from './mcp-elicitation.js';

const SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string', title: 'Repository', description: 'owner/name' },
    count: { type: 'integer', title: 'Count' },
    ratio: { type: 'number' },
    private: { type: 'boolean', title: 'Private', default: false },
    visibility: {
      type: 'string',
      title: 'Visibility',
      oneOf: [
        { const: 'pub', title: 'Public' },
        { const: 'int', title: 'Internal' },
      ],
      default: 'int',
    },
    color: { type: 'string', enum: ['r', 'g'], enumNames: ['Red', 'Green'] },
    labels: {
      type: 'array',
      items: {
        anyOf: [
          { const: 'bug', title: 'Bug' },
          { const: 'doc', title: 'Docs' },
        ],
      },
    },
  },
  required: ['repo', 'count'],
};

describe('表单 elicitation', () => {
  it('每个字段一个问题，服务的说明在第一个问题前面', () => {
    const questions = elicitationQuestions('Create a repository', SCHEMA);
    expect(questions).toEqual([
      {
        id: 'repo',
        header: 'Repository',
        question: 'Create a repository\n\nowner/name',
        options: [],
        allowOther: true,
      },
      { id: 'count', header: 'Count', question: 'Count', options: [], allowOther: true },
      { id: 'ratio', question: 'ratio', options: [], allowOther: true },
      {
        id: 'private',
        header: 'Private',
        question: 'Private',
        options: [{ label: 'Yes' }, { label: 'No' }],
        defaultOption: 'No',
      },
      {
        id: 'visibility',
        header: 'Visibility',
        question: 'Visibility',
        options: [{ label: 'Public' }, { label: 'Internal' }],
        defaultOption: 'Internal',
      },
      { id: 'color', question: 'color', options: [{ label: 'Red' }, { label: 'Green' }] },
      {
        id: 'labels',
        question: 'labels',
        options: [{ label: 'Bug' }, { label: 'Docs' }],
        multiSelect: true,
      },
    ]);
  });

  it('回答按字段类型换回去', () => {
    expect(
      elicitationResult('Create a repository', SCHEMA, {
        repo: ['  me/app '],
        count: ['3'],
        ratio: ['0.5'],
        private: ['Yes'],
        visibility: ['Public'],
        color: ['Green'],
        labels: ['Bug', 'Docs'],
      }),
    ).toEqual({
      action: 'accept',
      content: {
        repo: 'me/app',
        count: 3,
        ratio: 0.5,
        private: true,
        visibility: 'pub',
        color: 'g',
        labels: ['bug', 'doc'],
      },
    });
  });

  it('全部跳过、必填的没答或答得不对是 decline；选填的不对就不带', () => {
    expect(elicitationResult('', SCHEMA, {})).toEqual({ action: 'decline' });
    expect(elicitationResult('', SCHEMA, { repo: ['me/app'] })).toEqual({ action: 'decline' });
    expect(elicitationResult('', SCHEMA, { repo: ['me/app'], count: ['1.5'] })).toEqual({
      action: 'decline',
    });
    expect(elicitationResult('', SCHEMA, { repo: ['me/app'], count: ['2'], ratio: ['x'] })).toEqual(
      { action: 'accept', content: { repo: 'me/app', count: 2 } },
    );
  });

  it('没有字段的表单是一个是 / 否的确认', () => {
    const empty = { type: 'object', properties: {} };
    expect(elicitationQuestions('Proceed with the deploy?', empty)).toEqual([
      {
        id: 'confirm',
        question: 'Proceed with the deploy?',
        options: [{ label: 'Yes' }, { label: 'No' }],
      },
    ]);
    expect(elicitationResult('Proceed?', empty, { confirm: ['Yes'] })).toEqual({
      action: 'accept',
      content: {},
    });
    expect(elicitationResult('Proceed?', empty, { confirm: ['No'] })).toEqual({
      action: 'decline',
    });
  });

  it('不认识的字段类型不出问题', () => {
    const nested = { type: 'object', properties: { owner: { type: 'object', properties: {} } } };
    expect(elicitationQuestions('x', nested)).toBeUndefined();
    expect(elicitationResult('x', nested, { owner: ['a'] })).toEqual({ action: 'decline' });
    expect(elicitationQuestions('x', undefined)).toBeUndefined();
  });
});

describe('链接 elicitation 的地址', () => {
  it('只认 http 与 https', () => {
    expect(elicitationUrl('https://example.com/auth?x=1')).toBe('https://example.com/auth?x=1');
    expect(elicitationUrl('http://localhost:3000/')).toBe('http://localhost:3000/');
    expect(elicitationUrl('javascript:alert(1)')).toBeUndefined();
    expect(elicitationUrl('file:///etc/passwd')).toBeUndefined();
    expect(elicitationUrl('not a url')).toBeUndefined();
    expect(elicitationUrl(3)).toBeUndefined();
  });
});
