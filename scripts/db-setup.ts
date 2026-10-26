// Creates the runtime roles and the database, then applies migrations. Uses DATABASE_URL (an admin role).
import { loadConfig, loadEnvFile } from '../src/config';
import { createDatabase, ensureRoles, migrate } from '../src/db/migrate';

loadEnvFile();
const c = loadConfig();
const name = new URL(c.databaseUrl).pathname.slice(1);
await ensureRoles(c.databaseUrl, c.dbRolePassword);
await createDatabase(c.databaseUrl, name);
const applied = await migrate(c.databaseUrl);
console.log(`database ${name} ready; applied: ${applied.length ? applied.join(', ') : 'nothing new'}`);
