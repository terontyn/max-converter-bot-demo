import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import {PDFDocument} from 'pdf-lib';
import {convertToJpeg,convertImageToPdf} from '../lib/conversion.mjs';
const fixture=await fs.readFile(new URL('../demo/fixture.svg',import.meta.url));
test('JPEG dimensions match input and format is jpeg',async()=>{
 const metadata=await sharp(await convertToJpeg(fixture)).metadata();
 assert.equal(metadata.format,'jpeg');assert.equal(metadata.width,800);assert.equal(metadata.height,540);
});
test('PDF contains one page with preserved dimensions',async()=>{
 const pdf=await PDFDocument.load(await convertImageToPdf(fixture));
 assert.equal(pdf.getPageCount(),1);assert.equal(pdf.getPage(0).getWidth(),800);assert.equal(pdf.getPage(0).getHeight(),540);
});
test('invalid input rejects instead of returning a success artifact',async()=>{
 await assert.rejects(()=>convertImageToPdf(Buffer.from('not an image')));
});
