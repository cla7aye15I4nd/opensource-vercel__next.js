import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { SandboxManager } from '@vercel/agent-eval'
import type { EvalRunData } from '@vercel/agent-eval'
import { installPlaywright } from '../../lib/setup'
import type { Artifact, DeliveredTree } from '../runner/artifact'
import { suite, type Scenario } from '../runner/fixture'

export type Verdict = {
  status: 'passed' | 'failed' | 'invalid'
  checks: Record<string, unknown>
  reason: string
}

// Prepare only trusted tools. Forking this credential-free snapshot saves browser
// setup time while each delivered app still gets its own clean verifier VM.
export async function prepareVerifier() {
  const sandbox = await SandboxManager.create({
    backend: 'vercel',
    runtime: 'node24',
    timeout: 600000,
  })
  try {
    sandbox.setWorkingDirectory('/vercel/sandbox/verify')
    await sandbox.writeFiles({
      'package.json': JSON.stringify({
        private: true,
        type: 'module',
        dependencies: { vitest: '3.1.3', '@playwright/test': '1.51.1' },
      }),
    })
    const install = await sandbox.runCommand('npm', [
      'install',
      '--no-audit',
      '--no-fund',
    ])
    if (install.exitCode !== 0) {
      throw new Error(`Verifier tooling install failed: ${install.stderr}`)
    }
    await installPlaywright(sandbox)
    return await sandbox.snapshot({ expiration: 86400000 })
  } finally {
    await sandbox.stop()
  }
}

// The verifier receives only exported source and trusted tests. No Gateway key,
// agent state, cached build, node_modules, or mutable app test code is transferred.
export async function verifyTree(
  tree: DeliveredTree,
  name: string,
  directory: string
): Promise<Verdict> {
  const trusted = process.env.NEXT_UPGRADE_EVAL_TRUSTED_ROOT ?? suite
  const sandbox = await SandboxManager.create({
    backend: 'vercel',
    runtime: 'node24',
    timeout: 1200000,
    snapshotId: process.env.NEXT_UPGRADE_EVAL_VERIFIER_SNAPSHOT_ID,
  })
  try {
    const files = Object.entries(tree.files).map(([path, data]) => {
      if (
        path.startsWith('/') ||
        path.split('/').some((part) => part === '..')
      ) {
        throw new Error(`Unsafe artifact path ${path}`)
      }
      return {
        path: `/vercel/sandbox/app/${path}`,
        content: Buffer.from(data, 'base64'),
      }
    })
    await sandbox.uploadFiles(files)
    sandbox.setWorkingDirectory('/vercel/sandbox/verify')
    await sandbox.writeFiles({
      'package.json': JSON.stringify({
        private: true,
        type: 'module',
        dependencies: { vitest: '3.1.3', '@playwright/test': '1.51.1' },
      }),
      'EVAL.ts': readFileSync(join(trusted, 'cases', name, 'EVAL.ts'), 'utf8'),
      'validation/EVAL.ts': readFileSync(
        join(trusted, 'verifier/upgrade.ts'),
        'utf8'
      ),
      'apps/member-dashboard/behavior.spec.ts': readFileSync(
        join(trusted, 'apps/member-dashboard/behavior.spec.ts'),
        'utf8'
      ),
      'vitest.config.mjs':
        "export default { test: { include: ['EVAL.ts'], fileParallelism: false, maxWorkers: 1, minWorkers: 1 } }\n",
    })
    if (!process.env.NEXT_UPGRADE_EVAL_VERIFIER_SNAPSHOT_ID) {
      const install = await sandbox.runCommand('npm', [
        'install',
        '--no-audit',
        '--no-fund',
      ])
      if (install.exitCode !== 0) {
        throw new Error(`Verifier tooling install failed: ${install.stderr}`)
      }
      await installPlaywright(sandbox)
    }
    const result = await sandbox.runCommand(
      'node',
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'vitest.config.mjs',
      ],
      {
        env: {
          NEXT_UPGRADE_VERIFY_APP: '/vercel/sandbox/app',
          NEXT_UPGRADE_VERIFY_REPORT: '/tmp/verification.json',
          NEXT_TELEMETRY_DISABLED: '1',
        },
      }
    )
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'vitest.txt'),
      result.stdout + '\n' + result.stderr
    )
    if (!(await sandbox.fileExists('/tmp/verification.json'))) {
      throw new Error('Verifier did not produce required check evidence')
    }
    const report = JSON.parse(await sandbox.readFile('/tmp/verification.json'))
    writeFileSync(
      join(directory, 'checks.json'),
      JSON.stringify(report, null, 2)
    )
    const required: string[] = JSON.parse(
      readFileSync(
        join(trusted, 'cases', name, 'validation/checks.json'),
        'utf8'
      )
    )
    const infra =
      report.installError &&
      /EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT|E503|E429/.test(
        report.installError
      )
    const passed =
      result.exitCode === 0 &&
      required.every((check) => report.checks[check]?.passed === true)
    return {
      status: infra ? 'invalid' : passed ? 'passed' : 'failed',
      checks: report.checks,
      reason: infra
        ? 'Registry infrastructure error'
        : passed
          ? 'All required app checks passed'
          : 'Delivered app failed required checks',
    }
  } finally {
    await sandbox.stop()
  }
}

export async function verifyRun(
  name: string,
  scenario: Scenario,
  artifact: Artifact | null,
  native: EvalRunData,
  directory: string
): Promise<Verdict> {
  const nativeError = native.result.error ?? ''
  if (
    /HTTP (?:401|403|429)|unauthorized|invalid (?:auth|bearer|api)[ -]?(?:token|key)|authentication failed|rate_limit_error/i.test(
      nativeError
    )
  ) {
    return {
      status: 'invalid',
      checks: {},
      reason: `Native agent authentication/service error: ${nativeError}`,
    }
  }
  if (!artifact) {
    const failurePath = join(directory, 'capture-failure.json')
    if (existsSync(failurePath)) {
      const failure = JSON.parse(readFileSync(failurePath, 'utf8'))
      return {
        status: failure.kind === 'delivery' ? 'failed' : 'invalid',
        checks: { delivery: failure },
        reason: failure.reason,
      }
    }
    return {
      status: /Eval timed out/.test(native.result.error ?? '')
        ? 'failed'
        : 'invalid',
      checks: {},
      reason:
        native.result.error ??
        'Agent runner did not capture a delivered artifact',
    }
  }
  if (scenario.kind === 'nudge') {
    const file = join(directory, 'nudge-verdict.json')
    if (!existsSync(file)) {
      return {
        status: 'invalid',
        checks: {},
        reason: 'Native nudge grader produced no evidence',
      }
    }
    const report = JSON.parse(readFileSync(file, 'utf8'))
    if (process.env.NEXT_UPGRADE_EVAL_QUALIFY_JUDGE === '1') {
      const qualification = join(directory, 'judge-qualification.json')
      if (
        !existsSync(qualification) ||
        !JSON.parse(readFileSync(qualification, 'utf8')).complete
      ) {
        return {
          status: 'invalid',
          checks: report.checks,
          reason: 'Fixed-judge qualification did not complete',
        }
      }
    }
    const required = ['notice-emitted', 'notice-mentioned']
    if (
      !required.every(
        (check) => typeof report.checks[check]?.passed === 'boolean'
      )
    ) {
      return {
        status: 'invalid',
        checks: report.checks,
        reason: 'Missing required nudge check',
      }
    }
    if (report.checks['notice-mentioned'].judgeCompleted !== true) {
      return {
        status: 'invalid',
        checks: report.checks,
        reason:
          'Judge execution did not produce a completed structured verdict',
      }
    }
    return {
      status: required.every((check) => report.checks[check].passed)
        ? 'passed'
        : 'failed',
      checks: report.checks,
      reason: 'Two nudge criteria evaluated separately',
    }
  }
  // Inspect all actual worktrees. Agent-corrupted manifests are evaluated as
  // app failures instead of causing host parsing errors classified as invalid.
  const trees = artifact.trees
  const invocations = (artifact.evidence['invocations.jsonl'] ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const commands = (artifact.evidence['commands.jsonl'] ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const requested = invocations.filter((invocation) => {
    const args: string[] = invocation.args
    let selected: string | null = null
    for (let index = 1; index < args.length; index++) {
      if (args[index] === '--') {
        break
      }
      if (args[index].startsWith('--agent=')) {
        selected = args[index].slice('--agent='.length)
      } else if (args[index] === '--agent') {
        const value = args[index + 1]
        selected = value && !value.startsWith('-') ? value : 'security'
      }
    }
    return (
      args[0] === 'upgrade' &&
      invocation.executable.startsWith('/tmp/next-upgrade-eval/next/') &&
      selected === scenario.policy &&
      !args.some((arg) => ['--help', '-h', '--version', '-v'].includes(arg))
    )
  })
  const candidateInvoked =
    requested.length > 0 &&
    requested.every((invocation) => {
      const completions = commands.filter(
        (command) =>
          'exitCode' in command &&
          command.version === invocation.version &&
          (invocation.id
            ? command.id === invocation.id
            : JSON.stringify(command.args) === JSON.stringify(invocation.args))
      )
      return (
        completions.length > 0 &&
        completions.every((command) => command.exitCode === 0)
      )
    })
  const reports = []
  for (const [index, tree] of trees.entries()) {
    reports.push({
      path: tree.path,
      ...(await verifyTree(
        tree,
        name,
        join(directory, `verification-${index + 1}`)
      )),
    })
  }
  const passed = reports.find((report) => report.status === 'passed')
  return {
    status:
      passed && candidateInvoked && !native.result.error
        ? 'passed'
        : reports.some((report) => report.status === 'invalid')
          ? 'invalid'
          : 'failed',
    checks: {
      'candidate-cli': {
        passed: candidateInvoked,
        evidence:
          'Actual candidate invocation with requested policy and successful exit; no relevant command failure hidden',
      },
      deliveredWorktrees: reports,
    },
    reason: native.result.error
      ? `Native agent execution failed: ${native.result.error}`
      : !candidateInvoked
        ? 'Candidate upgrade invocation was missing, incomplete, or failed for the requested policy'
        : passed
          ? `Verified delivered app at ${passed.path}`
          : 'No delivered worktree satisfied the upgrade contract',
  }
}

// Reverify a retained direct trial without rerunning the coding agent. Keep the
// original verdict intact and append a fresh verification record.
async function reverify(): Promise<void> {
  const directory = process.argv[2]
  if (!directory) {
    throw new Error('Pass the retained native run-1 directory')
  }
  const { config } = await import('dotenv')
  config({ path: join(suite, '../../.env.local'), override: false })
  const inputs = JSON.parse(
    readFileSync(join(directory, 'inputs.json'), 'utf8')
  )
  const scenario: Scenario = inputs.scenario
  const artifact: Artifact = JSON.parse(
    readFileSync(join(directory, 'artifact.json'), 'utf8')
  )
  const output = join(
    directory,
    `reverification-${new Date().toISOString().replaceAll(':', '-')}`
  )
  const trusted = join(output, 'trusted-inputs')
  mkdirSync(output)
  cpSync(join(suite, 'verifier'), join(trusted, 'verifier'), {
    recursive: true,
  })
  cpSync(
    join(suite, 'apps/member-dashboard/behavior.spec.ts'),
    join(trusted, 'apps/member-dashboard/behavior.spec.ts')
  )
  const caseRoot = join(trusted, 'cases', inputs.case)
  mkdirSync(join(caseRoot, 'validation'), { recursive: true })
  writeFileSync(
    join(caseRoot, 'EVAL.ts'),
    scenario.kind === 'direct'
      ? `import { upgradeChecks } from './validation/EVAL'\nupgradeChecks(${JSON.stringify(scenario.targetVersion)})\n`
      : `import { nudgeChecks } from './validation/EVAL'\nnudgeChecks(${JSON.stringify(scenario.policy)}, ${JSON.stringify(scenario.sourceVersion)}, ${JSON.stringify(scenario.targetVersion)})\n`
  )
  const required =
    inputs.requiredChecks ??
    (scenario.kind === 'direct'
      ? [
          'manifest',
          'lockfile',
          'installed-version',
          'typecheck',
          'build',
          'http',
          'browser',
        ]
      : ['notice-emitted', 'notice-mentioned'])
  writeFileSync(
    join(caseRoot, 'validation/checks.json'),
    JSON.stringify(required)
  )
  const sha = (file: string) =>
    createHash('sha256').update(readFileSync(file)).digest('hex')
  writeFileSync(
    join(output, 'inputs.json'),
    JSON.stringify(
      {
        originalRunDirectory: directory,
        scenario,
        requiredChecks: required,
        sourceRevision: inputs.sourceRevision,
        artifactSha256: sha(join(directory, 'artifact.json')),
        graderSha256: sha(
          join(
            trusted,
            'verifier',
            scenario.kind === 'direct' ? 'upgrade.ts' : 'nudge.ts'
          )
        ),
        behaviorSha256: sha(
          join(trusted, 'apps/member-dashboard/behavior.spec.ts')
        ),
        originalInputs: inputs,
        correction:
          'Current corrected grader; recorded original policy/source/target and delivered artifact remain fixed',
      },
      null,
      2
    )
  )
  const previousTrusted = process.env.NEXT_UPGRADE_EVAL_TRUSTED_ROOT
  const previousSnapshot = process.env.NEXT_UPGRADE_EVAL_VERIFIER_SNAPSHOT_ID
  process.env.NEXT_UPGRADE_EVAL_TRUSTED_ROOT = trusted
  let snapshot: Awaited<ReturnType<typeof prepareVerifier>> | null = null
  try {
    let verdict: Verdict
    if (scenario.kind === 'direct') {
      if (!previousSnapshot) {
        snapshot = await prepareVerifier()
        process.env.NEXT_UPGRADE_EVAL_VERIFIER_SNAPSHOT_ID = snapshot.snapshotId
      }
      const nativePath = join(directory, 'native-result.json')
      const nativeResult = JSON.parse(
        readFileSync(
          existsSync(nativePath) ? nativePath : join(directory, 'result.json'),
          'utf8'
        )
      )
      // Early saved trials predate native-result retention. Their successful-only
      // capture proves native completion; strip only the host-added eval error.
      if (
        !existsSync(nativePath) &&
        nativeResult.analysis?.upgradeEval &&
        /^(failed|invalid): /.test(nativeResult.error ?? '')
      ) {
        delete nativeResult.error
      }
      verdict = await verifyRun(
        inputs.case,
        scenario,
        artifact,
        { result: nativeResult },
        output
      )
    } else {
      await rejudgeNudge(directory, output, inputs.case, artifact, trusted)
      verdict = await verifyRun(
        inputs.case,
        scenario,
        artifact,
        { result: {} } as EvalRunData,
        output
      )
    }
    writeFileSync(
      join(output, 'verdict.json'),
      JSON.stringify(verdict, null, 2)
    )
    console.log(`${verdict.status}: ${output}`)
  } finally {
    if (previousTrusted) {
      process.env.NEXT_UPGRADE_EVAL_TRUSTED_ROOT = previousTrusted
    } else {
      delete process.env.NEXT_UPGRADE_EVAL_TRUSTED_ROOT
    }
    if (previousSnapshot) {
      process.env.NEXT_UPGRADE_EVAL_VERIFIER_SNAPSHOT_ID = previousSnapshot
    } else {
      delete process.env.NEXT_UPGRADE_EVAL_VERIFIER_SNAPSHOT_ID
    }
    if (snapshot) {
      await snapshot.delete()
    }
  }
}

// Regrade only the retained transcript and raw command evidence through the same
// native fixed-judge runner. No coding agent or app upgrade is run a second time.
async function rejudgeNudge(
  directory: string,
  output: string,
  name: string,
  artifact: Artifact,
  trusted: string
): Promise<void> {
  const nativeRoot = dirname(require.resolve('@vercel/agent-eval/package.json'))
  const shared = await import(
    pathToFileURL(join(nativeRoot, 'dist/lib/agents/shared.js')).href
  )
  const { getAgent } = await import('@vercel/agent-eval')
  const definition = getAgent('vercel-ai-gateway/claude-code').definition
  const sandbox = await SandboxManager.create({
    backend: 'vercel',
    runtime: 'node24',
    timeout: 1200000,
    snapshotId: process.env.AGENT_EVAL_SANDBOX_SNAPSHOT_ID,
  })
  const scrub = (text: string) => {
    const token = process.env.VERCEL_OIDC_TOKEN
    return token ? text.split(token).join('[REDACTED]') : text
  }
  try {
    sandbox.setWorkingDirectory('/vercel/sandbox/judge')
    await sandbox.writeFiles({
      'package.json': JSON.stringify({
        private: true,
        type: 'module',
        dependencies: { vitest: '3.1.3' },
      }),
      'EVAL.ts': readFileSync(join(trusted, 'cases', name, 'EVAL.ts'), 'utf8'),
      'validation/EVAL.ts': readFileSync(
        join(trusted, 'verifier/nudge.ts'),
        'utf8'
      ),
      'validation/judge/EVAL.ts': readFileSync(
        join(trusted, 'verifier/judge/EVAL.ts'),
        'utf8'
      ),
      [shared.EVAL_HELPER_PATH]: readFileSync(
        join(nativeRoot, 'dist/lib/agents/eval-helper.mjs'),
        'utf8'
      ),
      [shared.JUDGE_TRANSCRIPT_FILE]: readFileSync(
        join(directory, 'transcript-raw.jsonl'),
        'utf8'
      ),
      [shared.JUDGE_RUNNER_PATH]: readFileSync(definition.runnerPath, 'utf8'),
      [shared.JUDGE_CONFIG_PATH]: JSON.stringify({
        runnerPath: shared.JUDGE_RUNNER_PATH,
        model: 'claude-haiku-4-5',
      }),
      '/tmp/next-upgrade-eval/commands.jsonl':
        artifact.evidence['commands.jsonl'] ?? '',
    })
    if (!process.env.AGENT_EVAL_SANDBOX_SNAPSHOT_ID) {
      const install = await sandbox.runCommand('npm', [
        'install',
        '--global',
        '--no-audit',
        '--no-fund',
        '@anthropic-ai/claude-code@2.1.293',
      ])
      if (install.exitCode !== 0) {
        throw new Error('Fixed judge CLI install failed')
      }
    }
    const install = await sandbox.runCommand('npm', [
      'install',
      '--no-audit',
      '--no-fund',
    ])
    if (install.exitCode !== 0) {
      throw new Error('Fixed judge Vitest install failed')
    }
    await shared.createVitestConfig(sandbox)
    const env = definition.authEnv({
      apiKey: process.env.VERCEL_OIDC_TOKEN ?? '',
      model: 'claude-haiku-4-5',
      prompt: '',
      timeout: 1200000,
    })
    if (process.env.NEXT_UPGRADE_EVAL_QUALIFY_JUDGE === '1') {
      env.NEXT_UPGRADE_EVAL_QUALIFY_JUDGE = '1'
    }
    const validation = await shared.runValidation(sandbox, [], 'vitest', env)
    writeFileSync(
      join(output, 'vitest.txt'),
      scrub(validation.test?.output ?? '')
    )
    for (const file of ['nudge-verdict.json', 'judge-qualification.json']) {
      if (await sandbox.fileExists(`/tmp/next-upgrade-eval/${file}`)) {
        writeFileSync(
          join(output, file),
          scrub(await sandbox.readFile(`/tmp/next-upgrade-eval/${file}`))
        )
      }
    }
    const judges = await sandbox.runCommand('sh', [
      '-c',
      'find __agent_eval__/judge -maxdepth 1 -type f -name "*.json" -exec cat {} \\;',
    ])
    writeFileSync(
      join(output, 'judge.txt'),
      scrub(judges.stdout + judges.stderr)
    )
  } finally {
    await sandbox.stop()
  }
}

if (require.main === module) {
  reverify().catch((error) => {
    const token = process.env.VERCEL_OIDC_TOKEN
    console.error(
      token ? String(error).split(token).join('[REDACTED]') : String(error)
    )
    process.exitCode = 1
  })
}
