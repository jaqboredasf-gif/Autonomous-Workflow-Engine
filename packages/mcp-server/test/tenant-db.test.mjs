import assert from 'node:assert/strict';
import test from 'node:test';

import { createTenantDb, requireTenantId } from '../src/tenant-db.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function fakeClient() {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        select(columns) {
          return {
            eq(column, value) {
              calls.push({ operation: 'select', table, columns, column, value });
              return calls.at(-1);
            },
          };
        },
        insert(values) {
          calls.push({ operation: 'insert', table, values });
          return calls.at(-1);
        },
      };
    },
  };
}

test('tenant id is mandatory and syntactically valid', () => {
  assert.throws(() => requireTenantId(), /MCP_ORG_ID/);
  assert.throws(() => requireTenantId('first-org'), /MCP_ORG_ID/);
  assert.equal(requireTenantId(ORG.toUpperCase()), ORG);
});

test('all reads add an org_id equality filter', () => {
  const client = fakeClient();
  createTenantDb(client, ORG).from('time_entries').select('id');
  assert.deepEqual(client.calls, [
    {
      operation: 'select',
      table: 'time_entries',
      columns: 'id',
      column: 'org_id',
      value: ORG,
    },
  ]);
});

test('all inserts force the bound tenant', () => {
  const client = fakeClient();
  createTenantDb(client, ORG).from('leads').insert({ summary: 'fixture' });
  assert.equal(client.calls[0].values.org_id, ORG);
});

test('payloads cannot select a different tenant', () => {
  const client = fakeClient();
  const db = createTenantDb(client, ORG);
  assert.throws(
    () => db.from('leads').insert({ org_id: OTHER, summary: 'fixture' }),
    /cannot override/
  );
  assert.equal(client.calls.length, 0);
});
