import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

export async function convertToJpeg(inputBuffer) {
  return sharp(inputBuffer)
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
}

export async function convertImageToPdf(inputBuffer) {
  const jpgBuffer = await convertToJpeg(inputBuffer);
  const meta = await sharp(jpgBuffer).metadata();

  const pdf = await PDFDocument.create();
  const jpgImage = await pdf.embedJpg(jpgBuffer);

  const pageWidth = meta.width || 1000;
  const pageHeight = meta.height || 1000;

  const page = pdf.addPage([pageWidth, pageHeight]);
  page.drawImage(jpgImage, {
    x: 0,
    y: 0,
    width: pageWidth,
    height: pageHeight
  });

  return Buffer.from(await pdf.save());
}
