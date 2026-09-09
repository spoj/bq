export function accrue(balance: number, target: number, elapsed: number, usage: number): number {
  return Math.min(target * 60_000, balance + target * elapsed - usage);
}

export function canStart(target: number, balance: number, running: number): boolean {
  return target > 0 && balance >= 0 && running < Math.ceil(target);
}

export function nextAdmission(target: number, balance: number, running: number): number | null {
  if (target <= 0 || running >= Math.ceil(target)) return null;
  if (balance >= 0) return 0;
  if (running >= target) return null;
  return Math.ceil(-balance / (target - running)) + 1;
}
