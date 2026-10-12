// The Trellis mod (hooks/prompt-mod.js) with Claude Code's mod test kit: run with `claude plugin test`.
// The helper process is stubbed here; test/mod-prompt.test.js tests the helper itself. Fictional data only.
import { expect, test } from 'claude-code/testing'

function session(on, answer) {
  const runs = []
  on('session.root', () => ({ value: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 's1' }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    runs.push({ argv: e.argv, request: JSON.parse(e.init.stdin) })
    return { value: answer(JSON.parse(e.init.stdin)) }
  })
  return runs
}

test('a prompt is sent with the text the helper rewrote', async ($, on) => {
  const runs = session(on, () => ({ exitCode: 0, stdout: JSON.stringify({ text: 'Mail [EMAIL_1]', summary: 'Email' }), stderr: '' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  const result = await $.prompt.submit({ text: 'Mail laura.martinez@example.com' })
  expect(result.text).toBe('Mail [EMAIL_1]')
  expect(runs[0].request).toMatchObject({ mode: 'submit', text: 'Mail laura.martinez@example.com', root: '/work', sessionId: 's1' })
  expect(runs[0].argv[1]).toMatch(/scripts\/mod-prompt\.js$/)
})

test('when the helper fails, the prompt goes on unchanged (the UserPromptSubmit hook still checks it)', async ($, on) => {
  session(on, () => ({ exitCode: 1, stdout: '', stderr: 'boom' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  const result = await $.prompt.submit({ text: 'Mail laura.martinez@example.com' })
  expect(result.text).toBe('Mail laura.martinez@example.com')
})

test('an attachment with sensitive data is read from the obfuscated copy', async ($, on) => {
  session(on, () => ({ exitCode: 0, stdout: JSON.stringify({ path: '/data/mentions/x/team.yml', summary: 'Email' }), stderr: '' }))
  const read = []
  on('prompt.mention', ($, e) => {
    read.push(e.path)
    return { type: null }
  })
  await $.prompt.mention({ path: '/work/team.yml', mention: '@team.yml' })
  expect(read).toEqual(['/data/mentions/x/team.yml'])
})

test('an attachment that cannot be checked is refused, never attached as it is', async ($, on) => {
  session(on, () => ({ exitCode: 1, stdout: '', stderr: 'boom' }))
  const read = []
  on('prompt.mention', ($, e) => {
    read.push(e.path)
    return { type: null }
  })
  const result = await $.prompt.mention({ path: '/work/team.yml', mention: '@team.yml' })
  expect(result.deny).toMatch(/could not check this file/)
  expect(read).toEqual([])
})
