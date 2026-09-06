export function isJsonString(data: string): object | false {
  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* not JSON */
  }
  return false;
}

export function sleep(sec: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, sec * 1000));
}

export function calc(expr: string): number {
  return new Function(`"use strict"; return (${expr})`)();
}

function timestamp(): string {
  const now = new Date()
  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteOffset = Math.abs(offsetMinutes)
  const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, '0')
  const offsetMins = String(absoluteOffset % 60).padStart(2, '0')

  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .replace('Z', '')

  return `${local}${sign}${offsetHours}:${offsetMins}`
}

export function log(...args: unknown[]): void {
  console.log(timestamp(), ...args)
}

export function logError(...args: unknown[]): void {
  console.error(timestamp(), ...args)
}
