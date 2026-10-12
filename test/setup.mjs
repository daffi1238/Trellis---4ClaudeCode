// Loaded before every test file (npm test): the vault key and the key record never touch the user's own.
// Child processes the tests start inherit these variables.
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TRELLIS_VAULT_KEY ??= randomBytes(32).toString('base64');
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'trellis-config-'));
