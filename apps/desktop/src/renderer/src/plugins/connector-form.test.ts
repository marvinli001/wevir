import type { Connector } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildConfig,
  buildPatch,
  type ConnectorForm,
  emptyForm,
  formErrors,
  formFromConnector,
  hasErrors,
  nameError,
  newRow,
  parseArgs,
  removeRow,
  updateRow,
} from './connector-form';

const stdioConnector: Connector = {
  id: 'con_1',
  name: 'files',
  config: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'pkg'],
    cwd: '/work',
    env: { TOKEN: true, REGION: true },
  },
  enabled: true,
};
const httpConnector: Connector = {
  id: 'con_2',
  name: 'remote',
  config: { transport: 'http', url: 'https://x.test/mcp', headers: { Authorization: true } },
  enabled: true,
};

const stdioForm = (patch: Partial<ConnectorForm> = {}): ConnectorForm => ({
  ...emptyForm('stdio'),
  name: 'files',
  command: 'npx',
  ...patch,
});

describe('参数文本', () => {
  it('一行一个，空行与空白行丢掉，行内的空白保留', () => {
    expect(parseArgs('-y\n  \n@scope/pkg\r\n/path with space\n')).toEqual([
      '-y',
      '@scope/pkg',
      '/path with space',
    ]);
    expect(parseArgs('')).toEqual([]);
  });
});

describe('名字', () => {
  const existing = new Set(['files', 'remote']);

  it('必填、只许小写字母数字与 - _、不以 wevir 开头、不能与已有的重名', () => {
    expect(nameError('', existing)).toBe('required');
    expect(nameError('  ', existing)).toBe('required');
    expect(nameError('My Server', existing)).toBe('invalid');
    expect(nameError('文件', existing)).toBe('invalid');
    expect(nameError('wevir_x', existing)).toBe('reserved');
    expect(nameError('Wevir', existing)).toBe('reserved');
    expect(nameError('files', existing)).toBe('exists');
    expect(nameError('ok_name-1', existing)).toBeUndefined();
  });

  it('编辑时它自己现在的名字不算重名', () => {
    expect(nameError('files', existing, 'files')).toBeUndefined();
    expect(nameError('remote', existing, 'files')).toBe('exists');
  });
});

describe('表单校验', () => {
  const existing = new Set<string>();

  it('命令模式：命令必填；环境变量的键不能空着带值、不能重复，空白行不算', () => {
    expect(formErrors(stdioForm(), existing)).toEqual({});
    expect(formErrors(stdioForm({ command: ' ' }), existing)).toEqual({ command: 'required' });
    const rows = (...pairs: [string, string][]) =>
      pairs.map(([key, value]) => ({ ...newRow(key), value }));
    expect(formErrors(stdioForm({ env: rows(['', ''], ['A', '1']) }), existing)).toEqual({});
    expect(formErrors(stdioForm({ env: rows(['', 'v']) }), existing)).toEqual({ env: 'emptyKey' });
    expect(formErrors(stdioForm({ env: rows(['A', '1'], [' A ', '2']) }), existing)).toEqual({
      env: 'duplicateKey',
    });
  });

  it('地址模式：地址必填且是 http(s)、不带用户名密码；请求头同样检查键', () => {
    const http = (patch: Partial<ConnectorForm>) => ({ ...emptyForm('http'), name: 'r', ...patch });
    expect(formErrors(http({ url: 'https://x.test/mcp' }), existing)).toEqual({});
    expect(formErrors(http({ url: '' }), existing)).toEqual({ url: 'required' });
    expect(formErrors(http({ url: 'not a url' }), existing)).toEqual({ url: 'invalid' });
    expect(formErrors(http({ url: 'ftp://x.test' }), existing)).toEqual({ url: 'invalid' });
    expect(formErrors(http({ url: 'https://u:p@x.test' }), existing)).toEqual({ url: 'invalid' });
    expect(
      formErrors(
        http({ url: 'https://x.test', headers: [{ ...newRow('A'), value: '1' }, newRow('A')] }),
        existing,
      ),
    ).toEqual({ headers: 'duplicateKey' });
  });

  it('名字的问题一起报，hasErrors 说有没有', () => {
    const errors = formErrors(stdioForm({ name: 'wevir', command: '' }), existing);
    expect(errors).toEqual({ name: 'reserved', command: 'required' });
    expect(hasErrors(errors)).toBe(true);
    expect(hasErrors({})).toBe(false);
  });
});

describe('添加：连接器的配置', () => {
  it('命令模式：参数、工作目录、环境变量，空的不带', () => {
    expect(buildConfig(stdioForm())).toEqual({ transport: 'stdio', command: 'npx' });
    expect(
      buildConfig(
        stdioForm({
          command: ' node ',
          args: '-y\n\npkg',
          cwd: ' /work ',
          env: [{ ...newRow('A'), value: '1' }, { ...newRow(' B '), value: '' }, newRow('')],
        }),
      ),
    ).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['-y', 'pkg'],
      cwd: '/work',
      env: { A: '1', B: '' },
    });
  });

  it('地址模式：地址与请求头', () => {
    const form = {
      ...emptyForm('http'),
      url: ' https://x.test/mcp ',
      headers: [{ ...newRow('Authorization'), value: 'Bearer t' }],
    };
    expect(buildConfig(form)).toEqual({
      transport: 'http',
      url: 'https://x.test/mcp',
      headers: { Authorization: 'Bearer t' },
    });
    expect(buildConfig({ ...emptyForm('http'), url: 'https://x.test' })).toEqual({
      transport: 'http',
      url: 'https://x.test',
    });
  });
});

describe('编辑', () => {
  it('从连接器的视图填表单：传输方式固定，已有的键只有键、值是空的', () => {
    const form = formFromConnector(stdioConnector);
    expect(form).toMatchObject({
      name: 'files',
      mode: 'stdio',
      command: 'npx',
      args: '-y\npkg',
      cwd: '/work',
    });
    expect(form.env).toMatchObject([
      { key: 'TOKEN', value: '', existing: true, removed: false },
      { key: 'REGION', value: '', existing: true, removed: false },
    ]);
    const remote = formFromConnector(httpConnector);
    expect(remote).toMatchObject({ mode: 'http', url: 'https://x.test/mcp' });
    expect(remote.headers).toMatchObject([{ key: 'Authorization', existing: true }]);
  });

  it('散装连接器待填的键标成 missing，插件的输入项不算', () => {
    const form = formFromConnector({ ...stdioConnector, missingInputs: ['TOKEN'] });
    expect(form.env.map((row) => [row.key, row.missing === true])).toEqual([
      ['TOKEN', true],
      ['REGION', false],
    ]);
    const owned = formFromConnector({ ...stdioConnector, pluginId: 'p', missingInputs: ['TOKEN'] });
    expect(owned.env.some((row) => row.missing)).toBe(false);
  });

  it('没改动时补丁只有命令、参数，密钥一个都不送（留空表示不变）', () => {
    expect(buildPatch(formFromConnector(stdioConnector), stdioConnector)).toEqual({
      config: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'pkg'],
        cwd: '/work',
      },
    });
    expect(buildPatch(formFromConnector(httpConnector), httpConnector)).toEqual({
      config: { transport: 'http', url: 'https://x.test/mcp' },
    });
  });

  it('改名带 name；已有的键写了值是新值、移除是 null、新加的是值', () => {
    const form = formFromConnector(stdioConnector);
    const [token, region] = form.env;
    if (!token || !region) throw new Error('rows');
    const edited: ConnectorForm = {
      ...form,
      name: 'files2',
      args: '',
      env: [
        { ...token, value: 'new-secret' },
        ...removeRow([region], region.id),
        { ...newRow('EXTRA'), value: 'x' },
      ],
    };
    expect(buildPatch(edited, stdioConnector)).toEqual({
      name: 'files2',
      config: {
        transport: 'stdio',
        command: 'npx',
        args: [],
        cwd: '/work',
        env: { TOKEN: 'new-secret', REGION: null, EXTRA: 'x' },
      },
    });
  });

  it('工作目录清空不带（协议的补丁没有清除它的写法）', () => {
    const form = { ...formFromConnector(stdioConnector), cwd: '' };
    expect(buildPatch(form, stdioConnector).config).not.toHaveProperty('cwd');
  });

  it('请求头同样按键处理', () => {
    const form = formFromConnector(httpConnector);
    const [header] = form.headers;
    if (!header) throw new Error('row');
    expect(
      buildPatch(
        {
          ...form,
          headers: [
            { ...header, removed: true },
            { ...newRow('X'), value: '1' },
          ],
        },
        httpConnector,
      ).config,
    ).toEqual({
      transport: 'http',
      url: 'https://x.test/mcp',
      headers: { Authorization: null, X: '1' },
    });
  });
});

describe('键值行的操作', () => {
  it('新加的行删掉，已有的键标成移除、再点一次恢复，值清空', () => {
    const fresh = newRow('A');
    const existing = { ...newRow('B', true), value: 'typed' };
    const rows = [fresh, existing];
    expect(removeRow(rows, fresh.id)).toEqual([existing]);
    const removed = removeRow(rows, existing.id);
    expect(removed[1]).toMatchObject({ key: 'B', removed: true, value: '' });
    expect(removeRow(removed, existing.id)[1]).toMatchObject({ removed: false });
  });

  it('改键与值只动那一行', () => {
    const [a, b] = [newRow('A'), newRow('B')];
    expect(updateRow([a, b], b.id, { value: 'v' })).toEqual([a, { ...b, value: 'v' }]);
  });
});
