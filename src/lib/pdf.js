// Minimal local PDF writer: builds a PDF from JPEG-encoded page images
// (DCTDecode passthrough — the JPEG bytes are embedded as-is, never re-encoded).
// No dependencies, no network; runs in any JS environment with TextEncoder.
//
// pages: [{
//   jpeg: Uint8Array,          // JPEG file bytes
//   widthPx, heightPx,         // pixel dimensions of the JPEG
//   pageWidth, pageHeight,     // page size in PDF points
//   x, y, drawWidth, drawHeight // image placement in points (y from page bottom)
// }]
// info: { title?, subject?, creator? } — optional document metadata.

const encoder = new TextEncoder();

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// PDF text string as UTF-16BE hex — safe for any characters incl. ( ) \ and non-ASCII.
function pdfTextString(str) {
  let hex = 'FEFF';
  for (let i = 0; i < str.length; i++) {
    hex += str.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  }
  return `<${hex}>`;
}

function pdfDate(d) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `(D:${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
    `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())})`;
}

export function createPdf({ pages, info = {} }) {
  const parts = [];
  let offset = 0;
  const offsets = {}; // objNum -> byte offset

  const push = (data) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    parts.push(bytes);
    offset += bytes.length;
  };
  const beginObj = (num) => {
    offsets[num] = offset;
    push(`${num} 0 obj\n`);
  };
  const endObj = () => push('endobj\n');

  const n = pages.length;
  // Object layout: 1 catalog, 2 pages tree, then per page i: page(3+3i), image(4+3i),
  // contents(5+3i); info dict last.
  const pageObj = (i) => 3 + i * 3;
  const imgObj = (i) => 4 + i * 3;
  const contentObj = (i) => 5 + i * 3;
  const infoObj = 3 + n * 3;
  const totalObjs = infoObj; // highest object number

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment

  beginObj(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\n');
  endObj();

  beginObj(2);
  const kids = pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ');
  push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>\n`);
  endObj();

  pages.forEach((p, i) => {
    beginObj(pageObj(i));
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(p.pageWidth)} ${fmt(p.pageHeight)}] ` +
      `/Resources << /XObject << /Im0 ${imgObj(i)} 0 R >> >> /Contents ${contentObj(i)} 0 R >>\n`);
    endObj();

    beginObj(imgObj(i));
    push(`<< /Type /XObject /Subtype /Image /Width ${p.widthPx} /Height ${p.heightPx} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
    push(p.jpeg);
    push('\nendstream\n');
    endObj();

    const content = `q\n${fmt(p.drawWidth)} 0 0 ${fmt(p.drawHeight)} ${fmt(p.x)} ${fmt(p.y)} cm\n/Im0 Do\nQ\n`;
    beginObj(contentObj(i));
    push(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}`);
    push('\nendstream\n');
    endObj();
  });

  beginObj(infoObj);
  let infoDict = '<< /Producer (FullSnap)';
  if (info.title) infoDict += ` /Title ${pdfTextString(info.title)}`;
  if (info.subject) infoDict += ` /Subject ${pdfTextString(info.subject)}`;
  if (info.creator) infoDict += ` /Creator ${pdfTextString(info.creator)}`;
  infoDict += ` /CreationDate ${pdfDate(new Date())} >>\n`;
  push(infoDict);
  endObj();

  const xrefStart = offset;
  push(`xref\n0 ${totalObjs + 1}\n`);
  push('0000000000 65535 f \n');
  for (let num = 1; num <= totalObjs; num++) {
    push(`${String(offsets[num]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  const out = new Uint8Array(offset);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}
