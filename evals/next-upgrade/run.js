#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const { config: loadEnvironment } = require('dotenv')
const { packPackage } = require('../lib/pack')
require('tsx/cjs')
const { loadCase, materialize } = require('./runner/fixture.ts')
const root = path.resolve(__dirname, '../..')
const hash = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function redact(value) {
  let text = value
  for (const name of [
    'VERCEL_OIDC_TOKEN',
    'AI_GATEWAY_API_KEY',
    'VERCEL_TOKEN',
  ]) {
    const secret = process.env[name]
    if (secret) {
      text = text.split(secret).join('[REDACTED]')
    }
  }
  return text
}

// Reject mismatched prepared inputs before allocating any remote resources.
function validatePreparedCandidate(provenance, expected) {
  for (const field of ['sourceRevision', 'originalVersion', 'nextSha256']) {
    if (provenance[field] !== expected[field]) {
      throw new Error(`Prepared stable candidate has mismatched ${field}`)
    }
  }
  if (
    provenance.declaredVersion !== '16.5.0' ||
    provenance.compiledVersion !== 'Next.js v16.5.0'
  ) {
    throw new Error('Prepared stable candidate has the wrong build identity')
  }
}

// Independent cleanup must continue after a failed deletion, and every failure
// must reach the caller instead of silently leaving owned resources behind.
async function cleanupOwned(tasks) {
  const results = await Promise.allSettled(
    tasks.map((task) => Promise.resolve().then(task))
  )
  const errors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
  if (errors.length > 0) {
    throw new global.AggregateError(errors, 'Owned eval cleanup failed')
  }
}

// A stable test identity must be supplied before normal compilation. Build the
// same revision in an isolated checkout and remove only this invocation's tree.
function buildStableCandidate(runRoot, destination) {
  const checkout = path.join(runRoot, 'stable-build')
  const dirty = execFileSync('git', ['diff', 'HEAD', '--', 'packages/next'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (dirty) {
    throw new Error(
      'Commit or explicitly prepare the candidate runtime source before a stable-identity build'
    )
  }
  execFileSync('git', ['worktree', 'add', '--detach', checkout, 'HEAD'], {
    cwd: root,
    stdio: 'ignore',
  })
  try {
    fs.symlinkSync(
      path.join(root, 'node_modules'),
      path.join(checkout, 'node_modules'),
      'dir'
    )
    for (const name of fs.readdirSync(path.join(root, 'packages'))) {
      const modules = path.join(root, 'packages', name, 'node_modules')
      const directory = path.join(checkout, 'packages', name)
      if (fs.existsSync(modules) && fs.existsSync(directory)) {
        fs.symlinkSync(modules, path.join(directory, 'node_modules'), 'dir')
      }
    }
    const manifestPath = path.join(checkout, 'packages/next/package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const originalVersion = manifest.version
    manifest.version = '16.5.0'
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    const log = fs.openSync(path.join(runRoot, 'stable-build.log'), 'w')
    try {
      execFileSync('pnpm', ['--filter=next', 'build'], {
        cwd: checkout,
        stdio: ['ignore', log, log],
      })
    } finally {
      fs.closeSync(log)
    }
    const compiledVersion = execFileSync(
      process.execPath,
      [path.join(checkout, 'packages/next/dist/bin/next'), '--version'],
      { encoding: 'utf8' }
    ).trim()
    if (compiledVersion !== 'Next.js v16.5.0') {
      throw new Error('Stable candidate compilation has the wrong identity')
    }
    packPackage(path.join(checkout, 'packages/next'), destination)
    return {
      sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      nextSha256: hash(destination),
      originalVersion,
      declaredVersion: '16.5.0',
      compiledVersion,
      method: 'normal build in isolated checkout',
    }
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', checkout], {
      cwd: root,
      stdio: 'ignore',
    })
  }
}

async function main() {
  const args = process.argv.slice(2)
  const cases = fs.readdirSync(path.join(__dirname, 'cases')).sort()
  if (args.includes('--list')) {
    if (args.length !== 1) {
      throw new Error('Use --list alone')
    }
    console.log(cases.join('\n'))
    return
  }
  const names = args.filter((arg) => !arg.startsWith('--'))
  if (names.length !== 1 || !cases.includes(names[0])) {
    throw new Error(`Select one case: ${cases.join(', ')}`)
  }
  if (args.some((arg) => arg.startsWith('--') && arg !== '--dry')) {
    throw new Error('Supported flags: --list, --dry')
  }
  const name = names[0]
  const scenario = loadCase(name)
  const harness = process.env.NEXT_UPGRADE_EVAL_EXPERIMENT
  if (harness && !['codex', 'claude'].includes(harness)) {
    throw new Error('Select codex or claude')
  }
  if (args.includes('--dry')) {
    console.log(name)
    return
  }

  // Fail before paid execution when dependency installation omitted the pinned hooks.
  const nativeRoot = path.dirname(
    require.resolve('@vercel/agent-eval/package.json')
  )
  const nativeSource = fs.readFileSync(
    path.join(nativeRoot, 'dist/lib/agents/plugin/orchestrator.js'),
    'utf8'
  )
  if (
    !nativeSource.includes('options.agentOptions?.afterAgent') ||
    !nativeSource.includes('options.agentOptions?.beforeValidation')
  ) {
    throw new Error(
      'The pinned agent-eval lifecycle patch is missing; run pnpm install'
    )
  }

  // Inherited environment wins. Credentials are host-only, never fixture files.
  loadEnvironment({ path: path.join(root, '.env.local'), override: false })
  loadEnvironment({ path: path.join(root, '.env'), override: false })
  if (!process.env.VERCEL_OIDC_TOKEN) {
    throw new Error(
      'Pull a local VERCEL_OIDC_TOKEN from vercel-labs/next-agentic-upgrade first'
    )
  }
  if (process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_TOKEN) {
    throw new Error(
      'Unset AI_GATEWAY_API_KEY and VERCEL_TOKEN to use this suite’s explicit OIDC mode'
    )
  }
  for (const file of [
    'packages/next/dist/bin/next',
    'packages/next-codemod/bin/next-codemod.js',
  ]) {
    if (!fs.existsSync(path.join(root, file))) {
      throw new Error(`Missing build: ${file}`)
    }
  }
  const id =
    new Date().toISOString().replaceAll(':', '-') +
    '-' +
    crypto.randomBytes(3).toString('hex')
  const runRoot = path.join(__dirname, '.work', id)
  const retained = path.join(__dirname, 'results', id)
  fs.mkdirSync(runRoot, { recursive: true })
  fs.mkdirSync(path.join(runRoot, 'results'))
  fs.mkdirSync(retained, { recursive: true })
  const nextTarball = path.join(runRoot, 'tarballs/next.tgz')
  const codemodTarball = path.join(runRoot, 'tarballs/codemod.tgz')
  fs.writeFileSync(
    path.join(retained, 'inputs.json'),
    JSON.stringify(
      {
        runId: id,
        case: name,
        scenario,
        sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: root,
          encoding: 'utf8',
        }).trim(),
        experiments: harness ? [harness] : ['codex', 'claude'],
      },
      null,
      2
    )
  )
  let snapshot
  let verifierSnapshot
  let candidateBuild = null
  let childStatus = 1
  try {
    if (scenario.kind === 'nudge') {
      const stable = process.env.NEXT_UPGRADE_EVAL_STABLE_TARBALL
      if (stable) {
        if (!fs.existsSync(stable)) {
          throw new Error('Stable candidate tarball is missing')
        }
        fs.mkdirSync(path.dirname(nextTarball), { recursive: true })
        fs.copyFileSync(stable, nextTarball)
        candidateBuild = JSON.parse(
          fs.readFileSync(
            path.join(path.dirname(stable), 'stable-provenance.json'),
            'utf8'
          )
        )
        validatePreparedCandidate(candidateBuild, {
          sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: root,
            encoding: 'utf8',
          }).trim(),
          originalVersion: JSON.parse(
            fs.readFileSync(
              path.join(root, 'packages/next/package.json'),
              'utf8'
            )
          ).version,
          nextSha256: hash(nextTarball),
        })
      } else {
        candidateBuild = buildStableCandidate(runRoot, nextTarball)
      }
    } else {
      packPackage(path.join(root, 'packages/next'), nextTarball)
    }
    packPackage(path.join(root, 'packages/next-codemod'), codemodTarball)
    materialize(name, runRoot)
    const trusted = path.join(runRoot, 'trusted')
    for (const folder of ['runner', 'verifier']) {
      fs.cpSync(path.join(__dirname, folder), path.join(trusted, folder), {
        recursive: true,
      })
    }
    fs.cpSync(
      path.join(__dirname, 'cases', name),
      path.join(trusted, 'cases', name),
      { recursive: true }
    )
    fs.mkdirSync(path.join(trusted, 'apps/member-dashboard'), {
      recursive: true,
    })
    fs.copyFileSync(
      path.join(__dirname, 'apps/member-dashboard/behavior.spec.ts'),
      path.join(trusted, 'apps/member-dashboard/behavior.spec.ts')
    )
    fs.copyFileSync(__filename, path.join(trusted, 'run.js'))
    fs.cpSync(trusted, path.join(retained, 'trusted-inputs'), {
      recursive: true,
    })
    fs.cpSync(
      path.join(runRoot, 'evals', name),
      path.join(retained, 'fixture-inputs'),
      { recursive: true }
    )

    const { discoverFixtures, loadFixture } = await import('@vercel/agent-eval')
    if (discoverFixtures(path.join(runRoot, 'evals')).length !== 1) {
      throw new Error('Materialized fixture is invalid')
    }
    loadFixture(path.join(runRoot, 'evals'), name)
    const experiments = harness ? [harness] : ['codex', 'claude']
    fs.mkdirSync(path.join(runRoot, 'experiments'))
    for (const experiment of experiments) {
      fs.writeFileSync(
        path.join(runRoot, 'experiments', `${experiment}.ts`),
        `import { upgradeExperiment } from ${JSON.stringify(path.join(__dirname, 'runner/experiment.ts'))}\nexport default upgradeExperiment('${experiment === 'codex' ? 'codex' : 'claude-code'}')\n`
      )
    }
    // Prepare credential-free CLI tooling once. Native credential files are
    // written only to per-agent forks after snapshots are created.
    const { Sandbox } = require('@vercel/sandbox')
    if (!process.env.AGENT_EVAL_SANDBOX_SNAPSHOT_ID) {
      const vm = await Sandbox.create({ runtime: 'node24', timeout: 600000 })
      try {
        const install = await vm.runCommand({
          cmd: 'npm',
          args: [
            'install',
            '--global',
            '--no-audit',
            '--no-fund',
            '@openai/codex@0.161.0',
            '@anthropic-ai/claude-code@2.1.293',
          ],
        })
        if (install.exitCode !== 0) {
          throw new Error(`Toolchain install failed: ${await install.stderr()}`)
        }
        const versions = await vm.runCommand({
          cmd: 'sh',
          args: ['-c', 'codex --version && claude --version && node --version'],
        })
        if (versions.exitCode !== 0) {
          throw new Error('Toolchain version preflight failed')
        }
        fs.writeFileSync(
          path.join(retained, 'toolchain.txt'),
          await versions.stdout()
        )
        snapshot = await vm.snapshot({ expiration: 86400000 })
      } finally {
        await vm.stop()
      }
    } else {
      fs.writeFileSync(
        path.join(retained, 'toolchain.txt'),
        'Externally supplied credential-free toolchain snapshot; see batch infrastructure provenance.\n'
      )
    }
    if (
      scenario.kind === 'direct' &&
      !process.env.NEXT_UPGRADE_EVAL_VERIFIER_SNAPSHOT_ID
    ) {
      const { prepareVerifier } = require('./verifier/verify.ts')
      verifierSnapshot = await prepareVerifier()
    }
    const inputs = {
      runId: id,
      case: name,
      scenario,
      requiredChecks: JSON.parse(
        fs.readFileSync(
          path.join(__dirname, 'cases', name, 'validation/checks.json'),
          'utf8'
        )
      ),
      sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      candidateBuild,
      graderSha256: hash(
        path.join(
          trusted,
          'verifier',
          scenario.kind === 'direct' ? 'upgrade.ts' : 'nudge.ts'
        )
      ),
      behaviorSha256: hash(
        path.join(trusted, 'apps/member-dashboard/behavior.spec.ts')
      ),
      promptSha256: hash(path.join(trusted, 'cases', name, 'PROMPT.md')),
      agentEvalPatchSha256: hash(
        path.join(root, 'patches/@vercel__agent-eval@2.2.1.patch')
      ),
      toolchainSnapshotExternallyProvided: Boolean(
        process.env.AGENT_EVAL_SANDBOX_SNAPSHOT_ID
      ),
      verifierSnapshotExternallyProvided: Boolean(
        process.env.NEXT_UPGRADE_EVAL_VERIFIER_SNAPSHOT_ID
      ),
      nativeBindingVersion: JSON.parse(
        fs.readFileSync(path.join(root, 'packages/next/package.json'))
      ).version,
      candidateVersion:
        scenario.kind === 'nudge'
          ? scenario.sourceVersion
          : JSON.parse(
              fs.readFileSync(path.join(root, 'packages/next/package.json'))
            ).version,
      nextSha256: hash(nextTarball),
      codemodSha256: hash(codemodTarball),
      upstreamSha256: hash(
        path.join(__dirname, 'cases', name, 'upstream.json')
      ),
      agentEval: '2.2.1',
      sandbox: '1.8.0',
      experiments,
    }
    fs.writeFileSync(
      path.join(retained, 'inputs.json'),
      JSON.stringify(inputs, null, 2)
    )
    fs.cpSync(path.join(runRoot, 'tarballs'), path.join(retained, 'tarballs'), {
      recursive: true,
    })
    const result = spawnSync(
      path.join(root, 'node_modules/.bin/agent-eval'),
      ['run', ...experiments, '--force', '--ack-failures'],
      {
        cwd: runRoot,
        env: {
          ...process.env,
          NEXT_UPGRADE_EVAL_CASE: name,
          NEXT_UPGRADE_EVAL_RUN_ROOT: runRoot,
          NEXT_UPGRADE_EVAL_TRUSTED_ROOT: trusted,
          NEXT_UPGRADE_EVAL_NEXT_TARBALL: nextTarball,
          NEXT_UPGRADE_EVAL_CODEMOD_TARBALL: codemodTarball,
          NEXT_UPGRADE_EVAL_NATIVE_BINDING_VERSION: JSON.parse(
            fs.readFileSync(path.join(root, 'packages/next/package.json'))
          ).version,
          ...(experiments.length > 1
            ? {
                AGENT_EVAL_PREPARE_FIXTURE_ONCE: '1',
                AGENT_EVAL_PREPARED_FIXTURE_CONSUMERS: String(
                  experiments.length
                ),
              }
            : {}),
          AGENT_EVAL_SANDBOX_SNAPSHOT_ID:
            snapshot?.snapshotId ?? process.env.AGENT_EVAL_SANDBOX_SNAPSHOT_ID,
          ...(verifierSnapshot
            ? {
                NEXT_UPGRADE_EVAL_VERIFIER_SNAPSHOT_ID:
                  verifierSnapshot.snapshotId,
              }
            : {}),
        },
        stdio: 'inherit',
      }
    )
    if (result.error) {
      throw result.error
    }
    childStatus = result.status ?? 1
    if (fs.readdirSync(path.join(runRoot, 'results')).length === 0) {
      throw new Error(
        `Native runner exited ${childStatus} before producing trial evidence`
      )
    }
  } catch (error) {
    fs.writeFileSync(
      path.join(retained, 'setup-error.json'),
      redact(
        JSON.stringify(
          {
            status: 'invalid',
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2
        )
      )
    )
    throw error
  } finally {
    let retentionComplete = false
    try {
      // Retain complete native output and custom evidence before temporary cleanup.
      for (const folder of ['results', 'evidence']) {
        if (fs.existsSync(path.join(runRoot, folder))) {
          fs.cpSync(path.join(runRoot, folder), path.join(retained, folder), {
            recursive: true,
          })
        }
      }
      if (fs.existsSync(path.join(runRoot, 'stable-build.log'))) {
        fs.copyFileSync(
          path.join(runRoot, 'stable-build.log'),
          path.join(retained, 'stable-build.log')
        )
      }
      const nativeResults = path.join(retained, 'results')
      if (fs.existsSync(nativeResults)) {
        const attach = (directory) => {
          for (const entry of fs.readdirSync(directory, {
            withFileTypes: true,
          })) {
            if (entry.isDirectory()) {
              attach(path.join(directory, entry.name))
            } else if (entry.name === 'result.json') {
              const label = path
                .relative(nativeResults, directory)
                .split(path.sep)[0]
              const evidence = path.join(retained, 'evidence', label)
              if (fs.existsSync(evidence)) {
                fs.cpSync(evidence, directory, { recursive: true })
              }
              if (fs.existsSync(path.join(retained, 'inputs.json'))) {
                fs.copyFileSync(
                  path.join(retained, 'inputs.json'),
                  path.join(directory, 'inputs.json')
                )
              }
            }
          }
        }
        attach(nativeResults)
      }
      retentionComplete = true
    } finally {
      try {
        await cleanupOwned([
          ...(snapshot ? [() => snapshot.delete()] : []),
          ...(verifierSnapshot ? [() => verifierSnapshot.delete()] : []),
          ...(retentionComplete
            ? [async () => fs.rmSync(runRoot, { recursive: true, force: true })]
            : []),
        ])
        fs.writeFileSync(
          path.join(retained, 'cleanup.json'),
          JSON.stringify(
            {
              ownedResourcesDeleted: true,
              temporaryWorkRemoved: retentionComplete,
            },
            null,
            2
          )
        )
      } catch (error) {
        fs.writeFileSync(
          path.join(retained, 'cleanup.json'),
          redact(
            JSON.stringify(
              {
                ownedResourcesDeleted: false,
                temporaryWorkRemoved: !fs.existsSync(runRoot),
                error: String(error),
                errors:
                  error instanceof global.AggregateError
                    ? error.errors.map(String)
                    : [],
              },
              null,
              2
            )
          )
        )
        throw error
      }
    }
    console.log(`Retained results: ${retained}`)
  }
  process.exitCode = childStatus
}
if (require.main === module) {
  main().catch((error) => {
    const token = process.env.VERCEL_OIDC_TOKEN
    const message = error instanceof Error ? error.message : String(error)
    console.error(token ? message.split(token).join('[REDACTED]') : message)
    process.exitCode = 1
  })
}
module.exports = { main, validatePreparedCandidate, cleanupOwned }
