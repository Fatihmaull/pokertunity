import 'dotenv/config';
import { applyMigrations } from './apply-migrations';

applyMigrations()
  .then(() => console.log('migrations applied'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
