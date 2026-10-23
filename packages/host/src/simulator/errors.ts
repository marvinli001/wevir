import { HostError } from '../errors.js';

/** 模拟器操作的失败：`code` 是 `SIMULATOR_ERROR_CODES` 之一（开放字符串，helper 给的原样保留）。 */
export class SimulatorError extends Error {
  override readonly name = 'SimulatorError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 给 `simulator.*` 方法：换成 `SIMULATOR_FAILED`，别的错误原样抛出。 */
export function toHostError(error: unknown): unknown {
  if (error instanceof SimulatorError) {
    return new HostError('SIMULATOR_FAILED', error.message, { code: error.code });
  }
  return error;
}
