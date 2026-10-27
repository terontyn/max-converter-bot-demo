import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { convertToJpeg, convertImageToPdf } from '../lib/conversion.mjs';
const root = new URL('./', import.meta.url);
const fixture = await fs.readFile(new URL('fixture.svg', root));
await fs.mkdir(new URL('generated/', root), {recursive:true});
await fs.writeFile(new URL('generated/demo.jpg', root), await convertToJpeg(fixture));
await fs.writeFile(new URL('generated/demo.pdf', root), await convertImageToPdf(fixture));
console.log('Generated synthetic JPEG and PDF with the production conversion functions.');
