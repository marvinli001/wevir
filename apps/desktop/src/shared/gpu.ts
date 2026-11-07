export function isLowGpu(status: { gpu_compositing?: string; rasterization?: string }): boolean {
  return (
    !status.gpu_compositing?.startsWith('enabled') || !status.rasterization?.startsWith('enabled')
  );
}
