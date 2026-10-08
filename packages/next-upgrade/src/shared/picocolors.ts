import { createColors } from 'picocolors'

// Keep Next's terminal color policy when using the standalone dependency.
const { env, stdout } = process
const enabled =
  !env.NO_COLOR &&
  (env.FORCE_COLOR || (stdout.isTTY && !env.CI && env.TERM !== 'dumb'))

// Explicit signatures keep vendored declarations independent of picocolors types.
export const {
  bold,
  cyan,
  dim,
  red,
  white,
  yellow,
}: Record<
  'bold' | 'cyan' | 'dim' | 'red' | 'white' | 'yellow',
  (value: string) => string
> = createColors(Boolean(enabled))
