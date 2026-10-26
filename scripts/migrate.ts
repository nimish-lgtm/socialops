import { loadConfig, loadEnvFile } from '../src/config';
import { migrate } from '../src/db/migrate';

loadEnvFile();
console.log('applied:', (await migrate(loadConfig().databaseUrl)).join(', ') || 'nothing new');
