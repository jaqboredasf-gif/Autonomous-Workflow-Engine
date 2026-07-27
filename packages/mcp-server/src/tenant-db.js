const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireTenantId(value) {
  if (!value || !UUID.test(value)) {
    throw new Error('MCP_ORG_ID must be a valid UUID');
  }
  return value.toLowerCase();
}

function bindInsert(values, orgId) {
  const rows = Array.isArray(values) ? values : [values];
  const bound = rows.map((row) => {
    if (row.org_id != null && row.org_id.toLowerCase() !== orgId) {
      throw new Error('MCP payload cannot override the bound tenant');
    }
    return { ...row, org_id: orgId };
  });
  return Array.isArray(values) ? bound : bound[0];
}

export function createTenantDb(client, orgIdValue) {
  const orgId = requireTenantId(orgIdValue);
  return {
    orgId,
    from(table) {
      return {
        select(columns) {
          return client.from(table).select(columns).eq('org_id', orgId);
        },
        insert(values) {
          return client.from(table).insert(bindInsert(values, orgId));
        },
      };
    },
  };
}
