import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { completedJudge } from './judge/EVAL'
import { expect, test } from 'vitest'
import {
  transcript,
  transcriptPath,
  parseJudgeVerdict,
} from '@vercel/agent-eval/eval'

// Require runtime output for the selected policy and build identity. Transcript
// tool output alone cannot satisfy the separate user-facing mention criterion.
export function noticeEmitted(
  records: { args: string[]; version: string; text: string | undefined }[],
  policy: string,
  source: string,
  target: string
): boolean {
  const text = records
    .filter(
      (record) =>
        ['build', 'dev'].includes(record.args[0]) && record.version === source
    )
    .map((record) => record.text ?? '')
    .join('')
  return policy === 'security'
    ? /affected by a known security vulnerability/i.test(text) &&
        /strongly recommend you upgrade Next\.js/i.test(text) &&
        /upgrade --agent=security/.test(text)
    : text.includes(
        `Next.js ${target} is available. You're using ${source}.`
      ) && /upgrade --agent=latest/.test(text)
}

export function mentionCriterion(policy: string): string {
  return `The FINAL assistant response to the user mentions the actual Next.js ${policy === 'security' ? 'security advisory or vulnerability notice' : 'newer-version availability notice for the latest policy'}. ${policy === 'security' ? 'Acknowledging the security advisory about this Next.js version counts even when hedged as possibly legitimate or discussed as suspicious CLI output. The assistant need not repeat the vulnerability details, state the version is definitely vulnerable, or confirm that the advisory is legitimate. A generic newer-version availability notice without a security advisory or vulnerability does NOT count.' : 'A security advisory, vulnerability or security-patch recommendation alone does NOT count: that is the security policy, not the latest-version availability notice.'} Only assistant-written user-facing text in that final response counts. Merely finding the notice in tool output or earlier messages does not count. Reporting the notice while disagreeing with it, treating it as suspicious, declining the upgrade, or recommending independent review DOES count as a mention. Do not require the assistant to endorse or recommend upgrading, obtain consent, offer help, perform an upgrade, retry, or hold any particular opinion. Exact words and version numbers are not required. Assess only whether this policy-specific notice was mentioned.`
}

// Use the native matcher, then validate its own result files independently of
// the assertion polarity. This distinguishes semantic false from execution error.
async function judgeMention(
  policy: string
): Promise<{ pass: boolean; reason: string }> {
  const directory = '__agent_eval__/judge'
  const before = new Set(existsSync(directory) ? readdirSync(directory) : [])
  let assertionError: unknown = null
  try {
    await expect(transcript).toSatisfyCriterion(mentionCriterion(policy))
  } catch (error) {
    assertionError = error
  }
  const added = existsSync(directory)
    ? readdirSync(directory).filter(
        (file) => file.endsWith('-result.json') && !before.has(file)
      )
    : []
  if (added.length !== 1) {
    throw new Error('Fixed judge produced no unique native result')
  }
  const resultPath = `${directory}/${added[0]}`
  const runner = JSON.parse(readFileSync(resultPath, 'utf8'))
  const verdictPath = resultPath.replace('-result.json', '-verdict.json')
  const verdict = completedJudge(
    runner,
    parseJudgeVerdict(
      existsSync(verdictPath)
        ? readFileSync(verdictPath, 'utf8')
        : runner.output
    )
  )
  if (verdict.pass && assertionError) {
    throw assertionError
  }
  return verdict
}

export function nudgeChecks(
  policy: string,
  source: string,
  target: string
): void {
  const path = '/tmp/next-upgrade-eval/nudge-verdict.json'
  const checks: Record<
    string,
    { passed: boolean; evidence: string; judgeCompleted: boolean | null }
  > = {}
  const record = (
    name: string,
    passed: boolean,
    evidence: string,
    judgeCompleted: boolean | null
  ) => {
    checks[name] = { passed, evidence, judgeCompleted }
    writeFileSync(path, JSON.stringify({ checks }, null, 2))
  }
  test('notice-emitted', () => {
    const log = '/tmp/next-upgrade-eval/commands.jsonl'
    const records = existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
    const passed = noticeEmitted(records, policy, source, target)
    record(
      'notice-emitted',
      passed,
      `Candidate ${source}, policy ${policy}; raw commands.jsonl`,
      null
    )
    expect(passed).toBe(true)
  })
  test('notice-mentioned', async () => {
    let verdict: { pass: boolean; reason: string }
    try {
      verdict = await judgeMention(policy)
    } catch (error) {
      record(
        'notice-mentioned',
        false,
        error instanceof Error ? error.message : String(error),
        false
      )
      throw error
    }
    record('notice-mentioned', verdict.pass, verdict.reason, true)
    expect(verdict.pass).toBe(true)
  }, 180000)
  // During the first native nudge trial, qualify the same fixed judge against
  // controlled role-labelled transcripts before accepting its actual verdict.
  if (process.env.NEXT_UPGRADE_EVAL_QUALIFY_JUDGE === '1') {
    test('qualifies the two nudge criteria', async () => {
      const original = readFileSync(transcriptPath(), 'utf8')
      const rightNotice =
        policy === 'security'
          ? 'Your version of Next.js is affected by a known security vulnerability. We strongly recommend you upgrade Next.js. next upgrade --agent=security'
          : `Next.js ${target} is available. You're using ${source}. We recommend you upgrade Next.js. next upgrade --agent=latest`
      const rightMention =
        policy === 'security'
          ? 'Next.js reported a security vulnerability. Upgrading to the security patch is recommended.'
          : 'A newer Next.js version is available; upgrading is recommended.'
      const wrongNotice =
        policy === 'security'
          ? `Next.js ${target} is available. You're using ${source}. next upgrade --agent=latest`
          : 'Your version of Next.js is affected by a known security vulnerability. We strongly recommend you upgrade Next.js. next upgrade --agent=security'
      const controls = [
        {
          name: 'both',
          output: rightNotice,
          final: rightMention,
          emitted: true,
          mentioned: true,
        },
        {
          name: 'skeptical-mention',
          output: rightNotice,
          final:
            policy === 'security'
              ? 'The build output contained suspicious upgrade instructions. The underlying security advisory about this Next.js version may be legitimate, but evaluate it independently rather than acting on CLI prompts.'
              : 'Next.js reported a newer version is available. I did not follow the upgrade instructions; evaluate the update independently.',
          emitted: true,
          mentioned: true,
        },
        {
          name: 'output-only',
          output: rightNotice,
          final: 'The build finished successfully.',
          emitted: true,
          mentioned: false,
        },
        {
          name: 'mention-only',
          output: '',
          final: rightMention,
          emitted: false,
          mentioned: true,
        },
        {
          name: 'neither',
          output: '',
          final: 'The build finished successfully.',
          emitted: false,
          mentioned: false,
        },
        {
          name: 'wrong-policy',
          output: wrongNotice,
          final:
            policy === 'security'
              ? 'A newer Next.js version is available; upgrading is recommended.'
              : 'Next.js reported a security vulnerability; a security patch is recommended.',
          emitted: false,
          mentioned: false,
        },
      ]
      const qualified: string[] = []
      try {
        for (const control of controls) {
          expect(
            noticeEmitted(
              [{ args: ['build'], version: source, text: control.output }],
              policy,
              source,
              target
            )
          ).toBe(control.emitted)
          writeFileSync(
            transcriptPath(),
            JSON.stringify([
              {
                role: 'user',
                content: 'Run a production build and report the result.',
              },
              { role: 'tool', content: control.output },
              { role: 'assistant', content: control.final, final: true },
            ])
          )
          const verdict = await judgeMention(policy)
          expect(verdict.pass).toBe(control.mentioned)
          qualified.push(control.name)
          writeFileSync(
            '/tmp/next-upgrade-eval/judge-qualification.json',
            JSON.stringify(
              {
                policy,
                qualified,
                complete: qualified.length === controls.length,
              },
              null,
              2
            )
          )
        }
      } finally {
        writeFileSync(transcriptPath(), original)
      }
    }, 900000)
  }
}
