import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { config } from 'dotenv'
import { loadCase, suite } from '../runner/fixture'
import { prepareVerifier, verifyTree, type Verdict } from './verify'

// These controls qualify the evaluator; they never become coding-agent cases.
// Keep each source tree and verdict together so a surprising grade is reviewable.
function sourceFiles(directory: string): Record<string, string> {
  const files: Record<string, string> = {}
  const visit = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        ['node_modules', '.next'].includes(entry.name) ||
        entry.name.endsWith('.tsbuildinfo')
      ) {
        continue
      }
      const key = prefix ? `${prefix}/${entry.name}` : entry.name
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(path, key)
      } else {
        files[key] = readFileSync(path).toString('base64')
      }
    }
  }
  visit(directory, '')
  return files
}

async function qualify(): Promise<void> {
  config({ path: join(suite, '../../.env.local'), override: false })
  const id = `qualification-${new Date().toISOString().replaceAll(':', '-')}`
  const output = join(suite, 'results', id)
  const work = join(suite, '.work', id)
  mkdirSync(output, { recursive: true })
  mkdirSync(work, { recursive: true })
  const snapshot = await prepareVerifier()
  process.env.NEXT_UPGRADE_EVAL_VERIFIER_SNAPSHOT_ID = snapshot.snapshotId
  const reports: {
    case: string
    control: string
    expected: string
    status: string
    matched: boolean
  }[] = []
  try {
    for (const name of ['security-same-major', 'security-cross-major']) {
      const scenario = loadCase(name)
      const controls: {
        name: string
        expected: Verdict['status']
        requiredPass: string[] | undefined
        requiredFail: string[] | undefined
      }[] = JSON.parse(
        readFileSync(
          join(suite, 'cases', name, 'validation/controls.json'),
          'utf8'
        )
      )
      const baseline = join(suite, 'apps', scenario.app)
      const reference = join(work, name, 'reference')
      cpSync(baseline, reference, { recursive: true })
      const manifest = JSON.parse(
        readFileSync(join(reference, 'package.json'), 'utf8')
      )
      manifest.dependencies.next = scenario.targetVersion
      if (scenario.sourceVersion.startsWith('13.')) {
        manifest.dependencies.react = '19.1.0'
        manifest.dependencies['react-dom'] = '19.1.0'
        manifest.devDependencies['@types/react'] = '19.1.2'
        manifest.devDependencies['@types/react-dom'] = '19.1.2'
        delete manifest.devDependencies.eslint
        delete manifest.devDependencies['eslint-config-next']
        delete manifest.scripts.lint
        for (const directory of ['app', 'lib']) {
          rmSync(join(reference, directory), { recursive: true })
          cpSync(
            join(suite, 'apps/member-dashboard/next-15', directory),
            join(reference, directory),
            { recursive: true }
          )
        }
      }
      writeFileSync(
        join(reference, 'package.json'),
        JSON.stringify(manifest, null, 2)
      )
      execFileSync(
        'npm',
        [
          'install',
          '--package-lock-only',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
        ],
        { cwd: reference, stdio: 'pipe' }
      )
      for (const control of controls) {
        const directory = join(work, name, control.name)
        if (control.name !== 'reference') {
          cpSync(
            ['baseline', 'wrong-target', 'manifest-only'].includes(control.name)
              ? baseline
              : reference,
            directory,
            { recursive: true }
          )
        }
        if (control.name === 'manifest-only') {
          const manifest = JSON.parse(
            readFileSync(join(directory, 'package.json'), 'utf8')
          )
          manifest.dependencies.next = scenario.targetVersion
          writeFileSync(
            join(directory, 'package.json'),
            JSON.stringify(manifest, null, 2)
          )
        }
        if (
          control.name === 'alternative' ||
          control.name === 'identity-regression'
        ) {
          const viewer = join(directory, 'lib/viewer.ts')
          const source = readFileSync(viewer, 'utf8')
          writeFileSync(
            viewer,
            control.name === 'alternative'
              ? source.replace(
                  'const [cookieStore, headerStore] = await Promise.all([cookies(), headers()])',
                  'const cookieStore = await cookies()\n  const headerStore = await headers()'
                )
              : source.replace(
                  "cookieStore.get('member')?.value || 'Guest'",
                  "'Alice'"
                )
          )
        }
        if (control.name === 'disabled-typecheck') {
          const configPath = join(directory, 'tsconfig.json')
          const config = JSON.parse(readFileSync(configPath, 'utf8'))
          config.compilerOptions.noCheck = true
          writeFileSync(configPath, JSON.stringify(config, null, 2))
        }
        if (control.name === 'alternative') {
          const manifestPath = join(directory, 'package.json')
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
          manifest.dependencies.next = `^${scenario.targetVersion}`
          writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
          execFileSync(
            'npm',
            [
              'install',
              '--package-lock-only',
              '--ignore-scripts',
              '--no-audit',
              '--no-fund',
            ],
            { cwd: directory, stdio: 'pipe' }
          )
        }
        const artifact = {
          path: `control/${name}/${control.name}`,
          head: 'qualification',
          status: '',
          files: sourceFiles(directory),
        }
        const evidence = join(output, name, control.name)
        mkdirSync(evidence, { recursive: true })
        writeFileSync(
          join(evidence, 'artifact.json'),
          JSON.stringify(artifact, null, 2)
        )
        console.log(`${name}/${control.name}: starting`)
        const verdict = await verifyTree(artifact, name, evidence)
        writeFileSync(
          join(evidence, 'verdict.json'),
          JSON.stringify(verdict, null, 2)
        )
        const checks = verdict.checks as Record<string, { passed: boolean }>
        const matched =
          verdict.status === control.expected &&
          (control.requiredPass ?? []).every(
            (check) => checks[check]?.passed === true
          ) &&
          (control.requiredFail ?? []).every(
            (check) => checks[check]?.passed === false
          )
        reports.push({
          case: name,
          control: control.name,
          expected: control.expected,
          status: verdict.status,
          matched,
        })
        writeFileSync(
          join(output, 'summary.json'),
          JSON.stringify(reports, null, 2)
        )
        console.log(JSON.stringify(reports.at(-1)))
        if (!matched) {
          throw new Error(
            `Qualification failed: ${name}/${control.name}; see ${evidence}`
          )
        }
      }
    }
  } finally {
    delete process.env.NEXT_UPGRADE_EVAL_VERIFIER_SNAPSHOT_ID
    const cleanup = await Promise.allSettled([
      snapshot.delete(),
      Promise.resolve().then(() =>
        rmSync(work, { recursive: true, force: true })
      ),
    ])
    const errors = cleanup
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason)
    if (errors.length > 0) {
      throw new global.AggregateError(errors, 'Qualification cleanup failed')
    }
  }
  console.log(`Qualification passed: ${output}`)
}
if (require.main === module) {
  qualify().catch((error) => {
    const token = process.env.VERCEL_OIDC_TOKEN
    console.error(
      token ? String(error).split(token).join('[REDACTED]') : String(error)
    )
    process.exitCode = 1
  })
}
