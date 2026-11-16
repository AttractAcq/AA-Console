// Small, dependency-free text PDF writer for internal campaign drafts. The
// submitted guide is plain English; reject unsupported glyphs rather than
// silently dropping a client's copy from the exported file.
type Guide = { title: string; intro: string; sections: { title: string; body: string }[]; closing: string };

function pdfText(value: string): string {
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(value)) {
    throw new Error("The guide contains characters this PDF renderer cannot preserve.");
  }
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrap(value: string, limit: number): string[] {
  const out: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    if (!paragraph.trim()) { out.push(""); continue; }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (word.length > limit) throw new Error("The guide contains a word too long to fit in the PDF.");
      if (line && `${line} ${word}`.length > limit) { out.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    if (line) out.push(line);
  }
  return out;
}

export function renderGuidePdf(guide: Guide): Buffer {
  const pages: string[][] = [[]];
  let y = 748;
  const line = (value: string, size: number, bold = false): void => {
    if (y < 65) { pages.push([]); y = 748; }
    pages.at(-1)!.push(`BT /${bold ? "F2" : "F1"} ${size} Tf 50 ${y} Td (${pdfText(value)}) Tj ET`);
    y -= size + 6;
  };
  const block = (value: string, size = 11): void => {
    for (const item of wrap(value, size >= 15 ? 52 : 86)) line(item, size);
    y -= 9;
  };
  block(guide.title, 18);
  block(guide.intro);
  for (const section of guide.sections) {
    for (const heading of wrap(section.title, 60)) line(heading, 14, true);
    y -= 5;
    block(section.body);
  }
  line("Next step", 14, true);
  block(guide.closing);

  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"];
  const kids: string[] = [];
  for (const commands of pages) {
    const pageId = objects.length + 1;
    const contentId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`);
    const stream = commands.join("\n") + "\n";
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, "ascii"));
  }
  const xref = Buffer.concat(chunks).length;
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "ascii"));
  return Buffer.concat(chunks);
}
