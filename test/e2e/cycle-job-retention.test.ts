/** The same production purge behavior on real PostgreSQL; missing DB refuses. */
import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../cycle-job-retention.serial.test.ts'));
