import express from 'express';

const app = express();
const port = Number(process.env.PORT ?? 4000);

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  process.stdout.write(`server listening on :${port} (MOCK_MODE=${process.env.MOCK_MODE ?? '0'})\n`);
});
