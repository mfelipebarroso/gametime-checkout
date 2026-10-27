import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { openDb } from './db';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH ?? resolve(here, '../data/dev.db');
mkdirSync(dirname(dbPath), { recursive: true });

const mockMode = process.env.MOCK_MODE === '1';
const port = Number(process.env.PORT ?? 4000);
const { app } = createApp({ db: openDb(dbPath), mockMode });

app.listen(port, () => {
  process.stdout.write(`server listening on :${port} (MOCK_MODE=${mockMode ? '1' : '0'}, db=${dbPath})\n`);
});
