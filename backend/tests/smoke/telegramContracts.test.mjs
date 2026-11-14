// Dependency-light smoke test: compiles the actual pure TypeScript module with TypeScript.
// Uses local TypeScript from npm ci; TS_COMPILER_PATH is an optional override for offline environments.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ts = require(process.env.TS_COMPILER_PATH || 'typescript');
const source = fs.readFileSync(fileURLToPath(new URL('../../src/modules/integrations/telegram.contract.ts', import.meta.url)), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
new Function('module', 'exports', compiled)(module, module.exports);
const { BOT_COMMANDS, parseBotAction } = module.exports;

test('all six commands are parsed without application dependencies', () => {
  assert.equal(BOT_COMMANDS.length, 6);
  for (const command of BOT_COMMANDS) {
    assert.deepEqual(parseBotAction(`/${command}`), { command, argument: '' });
  }
});
test('deep link parsing and ignoring unknown/password text', () => {
  assert.deepEqual(parseBotAction('/start@RestaurantTestBot g_1234'), {command:'start', argument:'g_1234'});
  assert.equal(parseBotAction('password: 1234'), null);
  assert.equal(parseBotAction('/invalid-command'), null);
});
