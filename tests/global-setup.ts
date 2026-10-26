import { createDatabase, dropDatabase, ensureRoles, migrate, withDbName } from '../src/db/migrate';

export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://socialops_owner:dev@localhost:5432/postgres';
export const TEMPLATE = 'socialops_test_tpl';

/** One migrated template database; each test file clones it so files run in parallel and in isolation. */
export default async function setup(): Promise<void> {
  await ensureRoles(ADMIN_URL, 'dev');
  await dropDatabase(ADMIN_URL, TEMPLATE);
  await createDatabase(ADMIN_URL, TEMPLATE);
  await migrate(withDbName(ADMIN_URL, TEMPLATE));
}
