// A temporary workspace with fake_lucidos.py on PATH as `lucidos`, for the
// JS suites that need the price table the engine serves before and after the
// 0.4.x price migration. fake_lucidos.py merges like llm/model_prices.rs.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const MIGRATE = path.resolve(HERE, '../../../scripts/token-cost/migrate_prices.py');
export const LEGACY_TEXT = fs.readFileSync(path.join(HERE, 'fixtures/legacy-pricing-0.4.json'), 'utf8');

/** A workspace holding the sanitized 0.4.4 pricing.json (or none). */
export function fakeWorkspace(withLegacy) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-engine-'));
  fs.mkdirSync(path.join(root, 'data/artifacts/token-cost'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'));
  if (withLegacy) fs.writeFileSync(path.join(root, 'data/artifacts/token-cost/pricing.json'), LEGACY_TEXT);
  fs.writeFileSync(path.join(root, 'bin/lucidos'),
    `#!/bin/sh\nexec python3 -I "${path.join(HERE, 'fake_lucidos.py')}" "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, LUCIDOS_WORKSPACE: root,
                FAKE_SHIPPED: path.join(HERE, 'fixtures/shipped-prices.json') };
  delete env.FAKE_FAIL;
  delete env.FAKE_REJECT;
  return {
    /** Run the migration once, as the rollup does. */
    migrate: () => execFileSync('python3', ['-I', MIGRATE], { env, encoding: 'utf8' }),
    /** The merged price table, as lucidos.priceTable.get() returns it. */
    table: () => JSON.parse(execFileSync('lucidos', ['model-prices'], { env, encoding: 'utf8' })),
    /** A file under data/, or null. */
    read: (rel) => { try { return fs.readFileSync(path.join(root, 'data', rel), 'utf8'); } catch (e) { return null; } },
  };
}
