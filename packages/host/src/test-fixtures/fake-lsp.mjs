// 测试用的假语言服务器（lsp-tools.test.ts）：经 stdio 讲 LSP。文档里的 `def NAME` 是定义，其他地方出现的 NAME 是引用；
// 含 `ERROR` 的行推送一条错误诊断（只推送，不支持拉取）；`FAKE_LSP_CRASH=1` 时启动就退出；`FAKE_LSP_LOG` 是记下收到的通知的文件。

import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-languageserver-protocol/node';

if (process.env.FAKE_LSP_CRASH === '1') {
  process.stderr.write('fake-lsp: crashing on purpose\n');
  process.exit(3);
}

const log = (line) => {
  if (process.env.FAKE_LSP_LOG) appendFileSync(process.env.FAKE_LSP_LOG, `${line}\n`);
};
const connection = createProtocolConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
/** uri → 文本 */
const documents = new Map();

const wordAt = (text, position) => {
  const line = text.split('\n')[position.line] ?? '';
  const pattern = /\w+/g;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    if (match.index <= position.character && position.character <= match.index + match[0].length) {
      return match[0];
    }
  }
  return undefined;
};

const occurrences = (name) =>
  [...documents].flatMap(([uri, text]) =>
    text.split('\n').flatMap((line, index) => {
      const result = [];
      const pattern = new RegExp(`\\b${name}\\b`, 'g');
      for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
        const range = {
          start: { line: index, character: match.index },
          end: { line: index, character: match.index + match[0].length },
        };
        result.push({
          uri,
          range,
          isDefinition: line.slice(0, match.index).trimEnd().endsWith('def'),
        });
      }
      return result;
    }),
  );

const publish = (uri, version) => {
  const text = documents.get(uri) ?? '';
  const diagnostics = text.split('\n').flatMap((line, index) => {
    const column = line.indexOf('ERROR');
    return column < 0
      ? []
      : [
          {
            range: {
              start: { line: index, character: column },
              end: { line: index, character: column + 5 },
            },
            severity: 1,
            source: 'fake',
            code: 42,
            message: `bad thing on line ${index + 1}`,
          },
        ];
  });
  setTimeout(
    () =>
      connection.sendNotification('textDocument/publishDiagnostics', { uri, version, diagnostics }),
    20,
  );
};

connection.onRequest('initialize', () => ({
  capabilities: {
    textDocumentSync: { openClose: true, change: 1, save: true },
    definitionProvider: true,
    referencesProvider: true,
    hoverProvider: true,
    documentSymbolProvider: true,
    workspaceSymbolProvider: true,
    callHierarchyProvider: true,
  },
}));
connection.onNotification('initialized', () => log('initialized'));
connection.onNotification('textDocument/didOpen', ({ textDocument }) => {
  log(`open ${fileURLToPath(textDocument.uri)}`);
  documents.set(textDocument.uri, textDocument.text);
  publish(textDocument.uri, textDocument.version);
});
connection.onNotification('textDocument/didChange', ({ textDocument, contentChanges }) => {
  log(`change ${fileURLToPath(textDocument.uri)} ${textDocument.version}`);
  documents.set(textDocument.uri, contentChanges.at(-1).text);
  publish(textDocument.uri, textDocument.version);
});
connection.onNotification('textDocument/didSave', ({ textDocument }) =>
  log(`save ${fileURLToPath(textDocument.uri)}`),
);
connection.onNotification('textDocument/didClose', ({ textDocument }) =>
  documents.delete(textDocument.uri),
);
connection.onNotification('workspace/didChangeWatchedFiles', ({ changes }) =>
  log(
    `watched ${changes.map((change) => `${fileURLToPath(change.uri)}:${change.type}`).join(',')}`,
  ),
);
connection.onRequest('textDocument/definition', ({ textDocument, position }) => {
  const name = wordAt(documents.get(textDocument.uri) ?? '', position);
  return name === undefined
    ? null
    : occurrences(name)
        .filter((item) => item.isDefinition)
        .map(({ uri, range }) => ({ uri, range }));
});
connection.onRequest('textDocument/references', ({ textDocument, position, context }) => {
  const name = wordAt(documents.get(textDocument.uri) ?? '', position);
  return name === undefined
    ? []
    : occurrences(name)
        .filter((item) => context.includeDeclaration || !item.isDefinition)
        .map(({ uri, range }) => ({ uri, range }));
});
connection.onRequest('textDocument/hover', ({ textDocument, position }) => {
  const name = wordAt(documents.get(textDocument.uri) ?? '', position);
  return name === undefined
    ? null
    : { contents: { kind: 'markdown', value: `**${name}**: a fake symbol` } };
});
connection.onRequest('textDocument/documentSymbol', ({ textDocument }) =>
  occurrences('\\w+')
    .filter((item) => item.uri === textDocument.uri && item.isDefinition)
    .map(({ range }) => {
      const text = documents.get(textDocument.uri).split('\n')[range.start.line];
      const name = text.slice(range.start.character, range.end.character);
      return { name, kind: 12, range, selectionRange: range, children: [] };
    }),
);
connection.onRequest('workspace/symbol', ({ query }) =>
  occurrences('\\w+')
    .filter((item) => item.isDefinition)
    .map(({ uri, range }) => {
      const name = documents
        .get(uri)
        .split('\n')
        [range.start.line].slice(range.start.character, range.end.character);
      return { name, kind: 12, location: { uri, range } };
    })
    .filter((symbol) => symbol.name.includes(query)),
);
connection.onRequest('textDocument/prepareCallHierarchy', ({ textDocument, position }) => {
  const name = wordAt(documents.get(textDocument.uri) ?? '', position);
  const definition =
    name === undefined ? undefined : occurrences(name).find((item) => item.isDefinition);
  return definition === undefined
    ? null
    : [
        {
          name,
          kind: 12,
          uri: definition.uri,
          range: definition.range,
          selectionRange: definition.range,
        },
      ];
});
connection.onRequest('callHierarchy/incomingCalls', ({ item }) =>
  occurrences(item.name)
    .filter((occurrence) => !occurrence.isDefinition)
    .map(({ uri, range }) => ({
      from: { name: 'caller', kind: 12, uri, range, selectionRange: range },
      fromRanges: [range],
    })),
);
connection.onRequest('shutdown', () => {
  log('shutdown');
  return null;
});
connection.onNotification('exit', () => process.exit(0));
connection.listen();
