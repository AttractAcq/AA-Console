import type { NavTab } from "../config/navigation";
import type { Database } from "../types/database";
import { supabase } from "./supabase";

export type ExportModule = "intelligence" | "strategy";
type Section = { title: string; body?: string | null; description?: string | null };
type ExportDocument = { title: string; subtitle?: string; sections: Section[] };

const RECORD_DOMAINS: Record<string, Database["public"]["Enums"]["record_domain"]> = {
  market: "market",
  icp: "icp",
  competitors: "competitor",
  "branding-associations": "association",
  "campaign-intelligence": "campaign_intel",
  "proof-intelligence": "proof",
  "branding-strategy": "brand_strategy",
  "offer-strategy": "offer_strategy",
  "money-model-strategy": "money_model",
};

const CONTEXT_FIELDS = [
  ["business_overview", "Business Overview"],
  ["current_revenue", "Current Revenue"],
  ["target_revenue", "Target Revenue"],
  ["current_marketing", "Current Marketing"],
  ["ideal_customer", "Ideal Customer"],
  ["main_offer", "Main Offer"],
  ["competitors", "Competitors"],
  ["proof_testimonials", "Proof / Testimonials"],
  ["brand_voice", "Brand Voice"],
  ["sales_process", "Sales Process"],
] as const;

function checkResult(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

export async function loadExportDocument(clientId: string, tab: NavTab): Promise<ExportDocument> {
  if (tab.id === "business-context") {
    const { data, error } = await supabase.from("client_business_context").select("*").eq("client_id", clientId).maybeSingle();
    checkResult(error);
    const row = data as Record<string, string | null> | null;
    return {
      title: tab.label,
      sections: CONTEXT_FIELDS.map(([key, title]) => ({ title, body: row?.[key] })),
    };
  }

  if (tab.id === "content-pillars") {
    const { data, error } = await supabase.from("client_content_pillars")
      .select("name, premise, belongs, does_not_belong, target_share, active")
      .eq("client_id", clientId)
      .order("active", { ascending: false })
      .order("target_share", { ascending: false });
    checkResult(error);
    const pillars = data ?? [];
    return {
      title: tab.label,
      sections: pillars.map((pillar) => ({
        title: `${pillar.name}${pillar.active ? `  ·  ${pillar.target_share}% share` : "  ·  Retired"}`,
        body: pillar.active
          ? `What it argues\n${pillar.premise}\n\nWhat belongs\n${pillar.belongs}\n\nWhat does not\n${pillar.does_not_belong}`
          : null,
      })),
    };
  }

  const domain = RECORD_DOMAINS[tab.id];
  if (!domain) throw new Error(`No PDF export is configured for ${tab.label}.`);
  const [templatesResult, recordsResult] = await Promise.all([
    supabase.from("record_templates")
      .select("item_key, item_type, title, description, display_order")
      .eq("domain", domain)
      .order("display_order"),
    supabase.from("client_agent_records")
      .select("item_key, title, body, period, display_order")
      .eq("client_id", clientId)
      .eq("domain", domain)
      .order("display_order"),
  ]);
  checkResult(templatesResult.error);
  checkResult(recordsResult.error);
  const records = recordsResult.data ?? [];
  const periods = records.map((record) => record.period).filter((period): period is string => Boolean(period));
  const activePeriod = periods.length ? periods.sort().at(-1) : undefined;
  const shown = activePeriod
    ? records.filter((record) => record.period === activePeriod || record.period === null)
    : records;
  const byKey = new Map(shown.map((record) => [record.item_key, record]));
  const templates = templatesResult.data ?? [];
  const templateKeys = new Set(templates.map((template) => template.item_key));
  const sections = [
    ...templates.map((template) => ({
      key: template.item_key,
      title: template.title,
      description: template.description,
      display_order: template.display_order,
    })),
    ...shown.filter((record) => !templateKeys.has(record.item_key)).map((record) => ({
      key: record.item_key,
      title: record.title,
      description: null,
      display_order: record.display_order,
    })),
  ].sort((a, b) => a.display_order - b.display_order);
  return {
    title: tab.label,
    subtitle: activePeriod ? `Period ${activePeriod}` : undefined,
    sections: sections.map((section) => ({
      title: section.title,
      description: section.description,
      body: byKey.get(section.key)?.body,
    })),
  };
}

function safeName(name: string) {
  return name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
}

/** A text PDF with page breaks, titles and selectable content. */
export async function renderExportPdf(doc: ExportDocument, clientName: string, module: ExportModule): Promise<ArrayBuffer> {
  const [{ jsPDF }, { default: regularFont }, { default: boldFont }] = await Promise.all([
    import("jspdf"),
    import("dejavu-fonts-ttf/ttf/DejaVuSans.ttf?inline"),
    import("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf?inline"),
  ]);
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  pdf.addFileToVFS("DejaVuSans.ttf", regularFont.split(",")[1]);
  pdf.addFileToVFS("DejaVuSans-Bold.ttf", boldFont.split(",")[1]);
  pdf.addFont("DejaVuSans.ttf", "DejaVu", "normal");
  pdf.addFont("DejaVuSans-Bold.ttf", "DejaVu", "bold");
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const left = 19;
  const right = pageWidth - 19;
  const bottom = pageHeight - 20;
  let y = 0;

  function startPage() {
    if (pdf.getNumberOfPages() > 0 && y > 0) pdf.addPage();
    pdf.setFillColor(22, 35, 48);
    pdf.rect(0, 0, pageWidth, 9, "F");
    pdf.setFont("DejaVu", "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(105, 115, 125);
    pdf.text(`${clientName}  /  ${module === "intelligence" ? "Intelligence" : "Strategy"}`, left, 18);
    y = 29;
  }

  function ensureSpace(height: number) {
    if (y + height > bottom) startPage();
  }

  function writeText(value: string, fontSize: number, color: [number, number, number], lineHeight: number) {
    pdf.setFont("DejaVu", "normal");
    pdf.setFontSize(fontSize);
    pdf.setTextColor(...color);
    for (const paragraph of value.split("\n")) {
      if (!paragraph.trim()) {
        y += lineHeight * 0.65;
        continue;
      }
      const lines = pdf.splitTextToSize(paragraph, right - left) as string[];
      for (const line of lines) {
        ensureSpace(lineHeight);
        pdf.text(line, left, y);
        y += lineHeight;
      }
    }
  }

  startPage();
  pdf.setFont("DejaVu", "bold");
  pdf.setFontSize(22);
  pdf.setTextColor(22, 35, 48);
  pdf.text(doc.title, left, y);
  y += 9;
  if (doc.subtitle) writeText(doc.subtitle, 9, [105, 115, 125], 5);
  y += 4;

  if (!doc.sections.length) writeText("No content has been saved for this tab yet.", 10, [105, 115, 125], 5.5);
  for (const section of doc.sections) {
    ensureSpace(21);
    pdf.setDrawColor(222, 227, 232);
    pdf.line(left, y, right, y);
    y += 7;
    pdf.setFont("DejaVu", "bold");
    pdf.setFontSize(12);
    pdf.setTextColor(22, 35, 48);
    const headingLines = pdf.splitTextToSize(section.title, right - left) as string[];
    for (const line of headingLines) {
      ensureSpace(6);
      pdf.text(line, left, y);
      y += 6;
    }
    y += 1;
    if (section.description) {
      writeText(section.description, 9, [105, 115, 125], 5);
      y += 2;
    }
    writeText(section.body?.trim() || "Not yet saved.", 10, [49, 58, 68], 5.5);
    y += 6;
  }

  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    pdf.setPage(page);
    pdf.setFont("DejaVu", "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(130, 138, 146);
    pdf.text(`${page} / ${pages}`, right, pageHeight - 10, { align: "right" });
  }
  return pdf.output("arraybuffer");
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function clientNameFor(clientId: string) {
  const { data, error } = await supabase.from("clients").select("name").eq("id", clientId).maybeSingle();
  checkResult(error);
  return data?.name?.trim() || "Client";
}

export async function downloadTabPdf(clientId: string, module: ExportModule, tab: NavTab) {
  const clientName = await clientNameFor(clientId);
  const doc = await loadExportDocument(clientId, tab);
  const bytes = await renderExportPdf(doc, clientName, module);
  saveBlob(new Blob([bytes], { type: "application/pdf" }), `${safeName(clientName)}-${tab.id}.pdf`);
}

export async function downloadModuleZip(clientId: string, module: ExportModule, tabs: NavTab[]) {
  const { default: JSZip } = await import("jszip");
  const clientName = await clientNameFor(clientId);
  const zip = new JSZip();
  for (const tab of tabs) {
    const doc = await loadExportDocument(clientId, tab);
    zip.file(`${safeName(clientName)}-${tab.id}.pdf`, await renderExportPdf(doc, clientName, module));
  }
  const blob = await zip.generateAsync({ type: "blob" });
  saveBlob(blob, `${safeName(clientName)}-${module}.zip`);
}
