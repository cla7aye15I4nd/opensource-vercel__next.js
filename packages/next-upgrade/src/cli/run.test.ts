import { ChildProcess, spawn } from 'child_process'
import * as Log from '../shared/log'
import { findDir, getProjectDir } from '../next/project'
import { prepareUpgrade } from './agent/prepare'
import { prepareUpgradeGuides } from './agent/guides'
import createSpinner from './spinner'
import { spawnNextUpgrade } from './run'
import { loadAgentUpgradeConfig as loadConfig } from '../next/config'
import { getAgentName } from './agent/detect-agent'
import { createTelemetry } from '../next/telemetry'

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
}))
jest.mock('./spinner', () => ({
  __esModule: true,
  default: jest.fn(),
}))
jest.mock('../shared/log', () => ({
  bootstrap: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}))
jest.mock('../next/project', () => ({
  findDir: jest.fn(),
  getProjectDir: jest.fn(),
  warnMissingReactDependencies: jest.fn(),
}))
jest.mock('./package-runner', () => ({
  getNpxCommand: () => 'npx',
}))
jest.mock('./agent/prepare', () => ({
  prepareUpgrade: jest.fn(),
}))
// Guide generation and interactive handoff have their own focused tests.
jest.mock('./agent/guides', () => ({ prepareUpgradeGuides: jest.fn() }))
jest.mock('./agent/handoff', () => ({
  handoffUpgrade: jest.fn(),
}))
jest.mock('../next/config', () => ({ loadAgentUpgradeConfig: jest.fn() }))
jest.mock('./agent/detect-agent', () => ({
  getAgentName: jest.fn(),
}))
jest.mock('../next/telemetry', () => ({
  ...jest.requireActual('../next/telemetry'),
  createTelemetry: jest.fn(),
}))
const cliVersion: string = require('@next/upgrade/package.json').version

describe('upgrade CLI execution', () => {
  const originalNextVersion = process.env.__NEXT_VERSION
  const originalPath = process.env.PATH
  const originalUseCurrentCli = process.env.__NEXT_UPGRADE_USE_CURRENT_CLI
  const originalExpectedCliVersion =
    process.env.__NEXT_UPGRADE_EXPECTED_CLI_VERSION
  const originalFetch = global.fetch
  const originalExitCode = process.exitCode

  beforeEach(() => {
    jest.resetAllMocks()
    jest
      .mocked(prepareUpgradeGuides)
      .mockResolvedValue(() => 'Prepared upgrade prompt.')
    jest.mocked(createTelemetry).mockImplementation(
      () =>
        ({
          record: jest.fn(),
          flush: jest.fn().mockResolvedValue([]),
        }) as never
    )
    process.env.__NEXT_VERSION = cliVersion
    process.env.__NEXT_UPGRADE_USE_CURRENT_CLI = '1'
    process.env.__NEXT_UPGRADE_EXPECTED_CLI_VERSION = cliVersion
    global.fetch = jest.fn()
    process.exitCode = undefined

    jest.mocked(getProjectDir).mockReturnValue('/workspace/app')
    jest.mocked(findDir).mockReturnValue('/workspace/app/app')
    jest.mocked(createSpinner).mockReturnValue({
      stop: jest.fn(),
    } as never)
    jest.mocked(prepareUpgrade).mockResolvedValue({
      status: 'ready',
      installedVersion: '14.1.1',
      targetVersion: '16.3.5',
      references: [
        'https://api.github.com/advisories?affects=next',
        'https://registry.npmjs.org/next',
      ],
      futureDefaults: [],
    })
    jest.mocked(getAgentName).mockResolvedValue('codex')
    jest.mocked(loadConfig).mockResolvedValue({
      experimental: { agentUpgrade: false },
    } as never)
  })

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }

    if (originalUseCurrentCli === undefined) {
      delete process.env.__NEXT_UPGRADE_USE_CURRENT_CLI
    } else {
      process.env.__NEXT_UPGRADE_USE_CURRENT_CLI = originalUseCurrentCli
    }

    if (originalNextVersion === undefined) {
      delete process.env.__NEXT_VERSION
    } else {
      process.env.__NEXT_VERSION = originalNextVersion
    }
    process.exitCode = originalExitCode
    global.fetch = originalFetch
    if (originalExpectedCliVersion === undefined) {
      delete process.env.__NEXT_UPGRADE_EXPECTED_CLI_VERSION
    } else {
      process.env.__NEXT_UPGRADE_EXPECTED_CLI_VERSION =
        originalExpectedCliVersion
    }
  })

  it('uses the pinned CLI without looking up canary again', async () => {
    jest.mocked(prepareUpgrade).mockResolvedValue({
      status: 'unaffected',
      reason: 'Already current.',
    })

    await spawnNextUpgrade(
      '/workspace/app',
      {
        revision: 'latest',
        verbose: false,
        agent: 'security',
      },
      null
    )

    expect(global.fetch).toHaveBeenCalledTimes(0)
    expect(spawn).toHaveBeenCalledTimes(0)
    expect(prepareUpgrade).toHaveBeenCalledTimes(1)
    expect(process.env.__NEXT_UPGRADE_EXPECTED_CLI_VERSION).toBeUndefined()
    expect(process.env.__NEXT_UPGRADE_USE_CURRENT_CLI).toBeUndefined()
  })

  it('rejects a worker running a different CLI version', async () => {
    process.env.__NEXT_UPGRADE_EXPECTED_CLI_VERSION = '0.0.0'

    await spawnNextUpgrade(
      '/workspace/app',
      {
        revision: 'latest',
        verbose: false,
        agent: 'security',
      },
      null
    )

    expect(Log.error).toHaveBeenCalledWith(
      'Could not prepare the upgrade:',
      `Expected @next/upgrade 0.0.0 for the upgrade, but launched ${cliVersion}.`
    )
    expect(process.exitCode).toBe(1)
    expect(global.fetch).toHaveBeenCalledTimes(0)
    expect(prepareUpgrade).toHaveBeenCalledTimes(0)
  })

  it('prepares directly without bootstrapping another Next CLI', async () => {
    delete process.env.__NEXT_UPGRADE_EXPECTED_CLI_VERSION
    jest
      .mocked(prepareUpgrade)
      .mockResolvedValue({ status: 'unaffected', reason: 'Already current.' })
    await spawnNextUpgrade(
      '/workspace/app',
      { revision: 'latest', verbose: false, agent: 'security' },
      null
    )
    expect(global.fetch).toHaveBeenCalledTimes(0)
    expect(spawn).toHaveBeenCalledTimes(0)
    expect(prepareUpgrade).toHaveBeenCalledWith('/workspace/app', 'security')
  })

  it('defaults a bare agent upgrade to security', async () => {
    await spawnNextUpgrade(
      '/workspace/app',
      {
        revision: 'latest',
        verbose: false,
        agent: true,
      },
      null
    )

    expect(loadConfig).toHaveBeenCalledWith('/workspace/app')
    expect(prepareUpgrade).toHaveBeenCalledWith('/workspace/app', 'security')
  })

  it.each(['security', 'latest', 'experimental-future'] as const)(
    'uses the configured %s policy for a bare agent upgrade',
    async (policy) => {
      jest.mocked(loadConfig).mockResolvedValue({
        experimental: { agentUpgrade: policy },
      } as never)

      await spawnNextUpgrade(
        '/workspace/app',
        {
          revision: 'latest',
          verbose: false,
          agent: true,
        },
        null
      )

      expect(prepareUpgrade).toHaveBeenCalledWith('/workspace/app', policy)
      expect(prepareUpgradeGuides).toHaveBeenCalledWith(
        expect.objectContaining({ policy })
      )
    }
  )
  it('delegates manual upgrades to codemod and preserves its exit code', async () => {
    const child = new ChildProcess()
    jest.mocked(spawn).mockReturnValue(child)
    await spawnNextUpgrade(
      '/workspace/app',
      { revision: '16.4.0', verbose: true, agent: undefined },
      null
    )
    expect(spawn).toHaveBeenCalledWith(
      'npx',
      ['@next/codemod@canary', 'upgrade', '16.4.0', '--verbose'],
      { stdio: 'inherit', cwd: '/workspace/app' }
    )
    child.emit('close', 19)
    expect(process.exitCode).toBe(19)
  })
})
