import { bold, red, white, yellow } from './picocolors'

export const prefixes = {
  info: white(bold(' ')),
  error: red(bold('⨯')),
  warn: yellow(bold('⚠')),
  event: '✓',
}
export function bootstrap(message: string) {
  console.log(message)
}
export function info(...message: unknown[]) {
  console.log(prefixes.info, ...message)
}
export function error(...message: unknown[]) {
  console.error(prefixes.error, ...message)
}
export function warn(...message: unknown[]) {
  console.warn(prefixes.warn, ...message)
}
