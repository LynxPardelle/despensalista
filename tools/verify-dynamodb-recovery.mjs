// Read-only: compare a rehearsal restore with unchanged production tables.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const prefix = process.argv[2];
assert.match(prefix ?? '', /^despensalista-tst-recovery-\d{8}$/);
const aws = (args) => JSON.parse(execFileSync('aws', [
  'dynamodb', ...args, '--region', 'us-east-1', '--output', 'json',
], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }));
const stable = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item);
const digest = (items) => createHash('sha256')
  .update(items.map(stable).sort().join('\n')).digest('hex');

for (const suffix of ['users', 'products', 'product-types', 'inventory-lots']) {
  const names = [`despensalista-prod-${suffix}`, `${prefix}-${suffix}`];
  const results = names.map(name => {
    const table = aws(['describe-table', '--table-name', name]).Table;
    assert.equal(table.TableStatus, 'ACTIVE', name);
    const items = [];
    let key;
    do {
      const page = aws(['scan', '--table-name', name, '--consistent-read', '--no-paginate',
        ...(key ? ['--exclusive-start-key', JSON.stringify(key)] : [])]);
      items.push(...page.Items);
      key = page.LastEvaluatedKey;
    } while (key);
    return { count: items.length, hash: digest(items),
      keys: stable(table.KeySchema),
      indexes: stable((table.GlobalSecondaryIndexes ?? []).map(index => ({
        name: index.IndexName, keys: index.KeySchema, projection: index.Projection,
      })).sort((a, b) => a.name.localeCompare(b.name))),
    };
  });
  assert.deepEqual(results[1], results[0], `Recovery mismatch: ${suffix}`);
  process.stdout.write(JSON.stringify({ table: suffix, result: 'identical', ...results[0] }) + '\n');
}
