import { existsSync, realpathSync } from 'fs'
import * as nodeModule from 'module'
import { join, resolve } from 'path'
import { warn } from '../shared/log'

export function requireFromProject(directory: string) {
  // NCC treats direct createRequire calls as build-time module resolution.
  // Keep the app's require at runtime, after choosing its installed Next graph.
  return Reflect.apply(Reflect.get(nodeModule, 'createRequire'), null, [
    join(directory, 'package.json'),
  ]) as NodeRequire
}

export function getProjectDir(directory: string | undefined) {
  const resolved = resolve(directory || '.')
  const real = realpathSync(resolved)
  if (resolved !== real && resolved.toLowerCase() === real.toLowerCase()) {
    warn(
      `Invalid casing detected for project dir, received ${resolved} actual path ${real}`
    )
  }
  return real
}

export function findDir(directory: string, name: 'app' | 'pages') {
  for (const candidate of [
    join(directory, name),
    join(directory, 'src', name),
  ]) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

export function warnMissingReactDependencies(directory: string) {
  for (const dependency of ['react', 'react-dom']) {
    try {
      requireFromProject(directory).resolve(dependency)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') {
        throw error
      }
      console.warn(
        `The module '${dependency}' was not found. Next.js requires that you include it in 'dependencies' of your 'package.json'. To add it, run 'npm install ${dependency}'`
      )
    }
  }
}
