import { appendFileSync } from 'node:fs';
const file = process.env.JEV_CAPTURE_FILE;
const site = process.env.JEV_CAPTURE_SITE;
const orig = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (file && init && typeof init.body === 'string' && String(url).includes('typesafe')) appendFileSync(file, JSON.stringify({ site, body: init.body }) + '\n');
  return orig(url, init);
};
