// Trellis mod (Claude Code 2.1.287+): prompts with sensitive data are sent with placeholders instead of being
// blocked, and @ attachments with sensitive data are read from an obfuscated copy.
//
// Mods have no Node.js APIs, so the work is done by scripts/mod-prompt.js (the same engine, settings and vault as
// the hooks), run with $.process.run. When it cannot run, the prompt goes on unchanged and the UserPromptSubmit
// hook blocks it if it holds sensitive data, as without the mod; an attachment is refused instead.

// Runs the helper with one JSON request on stdin; resolves to its JSON answer, or null when it failed.
async function helper($, request) {
  const [root, cwd, sessionId] = await Promise.all([$.session.root(), $.session.cwd(), $.session.id()])
  const run = await $.process.run(['node', $.plugin.root + '/scripts/mod-prompt.js'], {
    stdin: JSON.stringify({ ...request, root, cwd, sessionId }),
    timeoutMs: 20000
  })
  if (run.exitCode !== 0) return null
  try {
    return JSON.parse(run.stdout)
  } catch {
    return null
  }
}

export function register(on) {
  on('prompt.submit', async ($, e, next) => {
    const answer = await helper($, { mode: 'submit', text: e.text })
    if (!answer || typeof answer.text !== 'string' || answer.text === e.text) return next(e)
    $.ui.log('Trellis: ' + answer.summary + ' replaced by placeholders before sending')
    return next({ ...e, text: answer.text })
  }).catch(async ($, e, next) => {
    // The prompt goes on unchanged: the UserPromptSubmit hook still blocks it if it holds sensitive data.
    return next(e)
  })

  on('prompt.mention', async ($, e, next) => {
    const answer = await helper($, { mode: 'mention', path: e.path })
    if (!answer) return { deny: 'Trellis could not check this file for sensitive data, so it was not attached.' }
    if (answer.deny) return { deny: answer.deny }
    if (typeof answer.path !== 'string') return next(e)
    $.ui.log('Trellis: ' + answer.summary + ' in an attached file replaced by placeholders')
    const result = await next({ ...e, path: answer.path })
    if (result.deny !== undefined) return result
    // The model sees the copy's path: point it to the real file for edits.
    const note = 'Trellis: this attachment is ' + answer.original + ', read from an obfuscated copy. To change the file, use ' + answer.original + '.'
    return { ...result, context: [...(result.context ?? []), note] }
  }).catch(async ($, e, next) => {
    // A failed check never attaches the original file.
    if (next.called) return next(e)
    return { deny: 'Trellis could not check this file for sensitive data (' + next.error.kind + '), so it was not attached.' }
  })
}
