import { describe, expect, it } from 'vitest';
import { alongside } from './start-session-model';

describe('alongside', () => {
  it('side 先开始、与 main 同时进行，main 成功后等 side 做完', async () => {
    const log: string[] = [];
    let finishSide: () => void = () => {};
    const side = () =>
      new Promise<void>((resolve) => {
        log.push('side started');
        finishSide = () => {
          log.push('side done');
          resolve();
        };
      });
    const main = async () => {
      log.push('main');
      finishSide();
    };
    await alongside(main, side);
    expect(log).toEqual(['side started', 'main', 'side done']);
  });

  it('main 失败时直接抛出，不等 side', async () => {
    const side = () => new Promise<void>(() => {});
    await expect(
      alongside(async () => {
        throw new Error('send failed');
      }, side),
    ).rejects.toThrow('send failed');
    await expect(alongside(async () => {}, undefined)).resolves.toBeUndefined();
  });
});
