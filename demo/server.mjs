import http from 'node:http';
import fs from 'node:fs/promises';
import { convertToJpeg, convertImageToPdf } from '../lib/conversion.mjs';
const root = new URL('./', import.meta.url);
const fixture = await fs.readFile(new URL('fixture.svg', root));
const server = http.createServer(async (request,response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/') {
      response.setHeader('Content-Type','text/html; charset=utf-8');
      return response.end(await fs.readFile(new URL('index.html',root)));
    }
    if (request.method === 'GET' && url.pathname === '/fixture.svg') {
      response.setHeader('Content-Type','image/svg+xml');return response.end(fixture);
    }
    if (request.method === 'GET' && ['/demo.jpg','/demo.pdf'].includes(url.pathname)) {
      const pdf=url.pathname.endsWith('.pdf');
      response.setHeader('Content-Type',pdf?'application/pdf':'image/jpeg');
      return response.end(await (pdf?convertImageToPdf:convertToJpeg)(fixture));
    }
    response.writeHead(404);response.end('Not found');
  } catch { response.writeHead(500);response.end('Conversion failed'); }
});
server.listen(8792,'127.0.0.1',()=>console.log('Offline converter demo: http://127.0.0.1:8792'));
