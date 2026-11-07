import type { Marked, MarkedExtension } from 'marked';

let extension: MarkedExtension | undefined;
let loading: Promise<void> | undefined;
const parsers = new Set<Marked<string, string>>();

export function withMath(parser: Marked<string, string>): Marked<string, string> {
  if (extension) parser.use(extension);
  else parsers.add(parser);
  return parser;
}

export function mathReady(): boolean {
  return extension !== undefined;
}

export function loadMath(): Promise<void> {
  loading ??= import('./markdown-math').then(({ markdownMath }) => {
    extension = markdownMath();
    for (const parser of parsers) parser.use(extension);
    parsers.clear();
  });
  return loading;
}
