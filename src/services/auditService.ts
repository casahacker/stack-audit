import OpenAI from "openai";
import { AuditResult, AuditVerdict } from "../types";
import { jsonrepair } from "jsonrepair";

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || "",
  baseURL: "https://api.deepseek.com",
  dangerouslyAllowBrowser: true,
});

async function extractPdfText(b64: string): Promise<string> {
  try {
    const clean = b64.includes(",") ? b64.split(",")[1] : b64;
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: "application/pdf" });
    const fd = new FormData();
    fd.append("file", blob, "document.pdf");
    const r = await fetch("/api/extract-pdf", { method: "POST", body: fd });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { text } = await r.json();
    return text as string;
  } catch (e) {
    console.warn("Falha na extração de PDF server-side:", e);
    return "";
  }
}

function parseJsonSafe(text: string): any {
  const startIdx = text.indexOf('{');
  if (startIdx === -1) return null;
  let jsonText = text.substring(startIdx);
  const endIdx = jsonText.lastIndexOf('}');
  if (endIdx !== -1) jsonText = jsonText.substring(0, endIdx + 1);
  try { return JSON.parse(jsonText); } catch { /* */ }
  try { return JSON.parse(jsonrepair(jsonText)); } catch { /* */ }
  try { return JSON.parse(jsonrepair(text.substring(startIdx))); } catch { /* */ }
  return null;
}

function normalizeItem(item: any, idx: number, globalOffset: number) {
  return {
    id: globalOffset + idx + 1,
    itemCode: crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase(),
    description: item.description || "Sem descrição informada",
    activity: item.activity || "Não Informado",
    date: item.date || "N/A",
    entity: item.entity || "N/A",
    docId: item.docId || "N/A",
    taxId: item.taxId || "N/A",
    value: Number(item.value) || 0,
    status: (["Conciliado", "Ressalva", "Pendente"].includes(item.status) ? item.status : "Pendente") as "Conciliado" | "Ressalva" | "Pendente",
    nfPage: item.nfPage || "N/A",
    paymentPage: item.paymentPage || "N/A",
    observations: item.observations || (item.status === "Conciliado" ? "Item apurado e validado sem ressalvas." : "Análise pendente ou ressalvada."),
    ...(item.emissionDateTime ? { emissionDateTime: item.emissionDateTime } : {}),
    ...(item.serviceDescription ? { serviceDescription: item.serviceDescription } : {}),
    ...(item.taxInfo ? { taxInfo: item.taxInfo } : {}),
    ...(item.paymentDateTime ? { paymentDateTime: item.paymentDateTime } : {}),
    ...(item.transactionId ? { transactionId: item.transactionId } : {}),
    ...(item.payerInfo ? { payerInfo: item.payerInfo } : {}),
    ...(item.payeeInfo ? { payeeInfo: item.payeeInfo } : {}),
    ...(item.paymentMethod ? { paymentMethod: item.paymentMethod } : {}),
  };
}

function fallbackFromCsvRow(row: any, globalIdx: number) {
  const getVal = (keys: string[]) => {
    const rowKeys = Object.keys(row);
    const match = rowKeys.find(rk => {
      const clean = rk.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
      return keys.some(k => clean.includes(k.toLowerCase()));
    });
    return match ? (row[match] ?? "") : "";
  };
  const valRaw = getVal(["saida", "saída", "valor", "total", "montante", "pago"]);
  let valStr = String(valRaw || 0).replace(/[^\d.,-]/g, "").replace(",", ".");
  const lastSep = Math.max(valStr.lastIndexOf(","), valStr.lastIndexOf("."));
  if (lastSep > -1) valStr = valStr.substring(0, lastSep).replace(/[.,]/g, "") + "." + valStr.substring(lastSep + 1);
  return {
    id: globalIdx + 1,
    itemCode: crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase(),
    description: String(getVal(["despesa", "descri", "historico", "item", "lancamento"]) || Object.values(row).find((x: any) => x && isNaN(Number(x)) && String(x).length > 5) || "Sem descrição"),
    activity: String(getVal(["atividade", "rubrica", "categoria"]) || "Não Informado"),
    date: String(getVal(["data", "emissao", "pagamento"]) || "N/A"),
    entity: String(getVal(["razao", "fornecedor", "favorecido", "nome"]) || "N/A"),
    docId: String(getVal(["doc", "nota", "nf", "comprovante"]) || "Pendente"),
    taxId: String(getVal(["cnpj", "cpf"]) || "N/A"),
    value: Number(valStr) || 0,
    status: "Pendente" as const,
    nfPage: "N/A",
    paymentPage: "N/A",
    observations: "Item recuperado por fallback — auditoria automatizada falhou.",
  };
}

const BATCH_SIZE = 25;

export async function processAudit(
  metadata: { organization: string; periodStart: string; periodEnd: string; contractNumber: string },
  csv1: any[],
  csv2: any[],
  pdfNfB64: string,
  pdfPayB64: string,
  onProgress: (step: number, message: string) => void
): Promise<AuditResult> {
  onProgress(1, "Lendo e indexando arquivos recebidos...");
  await new Promise(r => setTimeout(r, 300));

  onProgress(2, "Extraindo texto dos documentos PDF (processamento server-side)...");
  const [pdfNfText, pdfPayText] = await Promise.all([
    extractPdfText(pdfNfB64),
    extractPdfText(pdfPayB64),
  ]);

  // Split csv2 into batches of BATCH_SIZE rows
  const batches: any[][] = [];
  for (let i = 0; i < csv2.length; i += BATCH_SIZE) {
    batches.push(csv2.slice(i, i + BATCH_SIZE));
  }
  const totalBatches = batches.length;

  const baseSystemInstruction = `Você é um Auditor Financeiro Sênior e Especialista em Compliance atuando com rigor militar em projetos sociais do terceiro setor.

### INSTRUÇÃO MÁXIMA E OBRIGATÓRIA (CRÍTICO):
1. **EXAUSTIVIDADE TOTAL**: Você receberá um lote de registros de prestação de contas. Você DEVE processar e retornar **TODOS** os registros do lote sem exceção. O array "items" DEVE ter EXATAMENTE O MESMO NÚMERO DE ELEMENTOS que os registros recebidos no lote.
2. NUNCA resuma, agrupe ou omita itens. Cada objeto em "items" corresponde a UM registro do lote.

### REGRAS DE AUDITORIA:
- **Verificação Quádrupla**: Valide se o mesmo gasto bate com o CSV de Orçamento, se o texto extraído da Nota Fiscal está compatível, e se o texto do Comprovante confirma o pagamento real com a data/valor da Nota e CSV.
- **Tarifas Bancárias**: Tarifas bancárias de até 150 reais devem ser sempre consideradas como status "Conciliado" e dispensadas de comprovação fiscal. Nesses casos, preencha OBRIGATORIAMENTE: "docId": "Dispensado", "nfPage": "Dispensado", "paymentPage": "Dispensado".
- **Mobilidade (Uber/99/Táxi)**: Recibos de aplicativos de transporte (Uber, Táxi, 99) são considerados Comprovantes Aprovados válidos por si mesmos, sem necessidade de outro documento fiscal. Devem ser classificados como "Conciliado" se os valores/data baterem com o lançamento.
- **Documentos Fiscais Aceitos**: São documentos fiscais válidos para comprovação: Nota Fiscal Eletrônica (NF-e), Nota Fiscal de Serviços Eletrônica (NFS-e), Nota de Débito, Recibo de Uber/Táxi/99 (conforme regra Mobilidade acima) e Recibo de Aluguel com identificação do locador e locatário. NÃO são documentos fiscais suficientes por si só: comprovantes de pagamento (PIX, TED, DOC, boleto bancário, extrato de cartão de crédito/débito). Se o único documento disponível para um lançamento for um comprovante de pagamento sem o correspondente documento fiscal (NF-e, NFS-e, Nota de Débito ou equivalente), o status DEVE ser 'Pendente' e a observação DEVE conter: "Comprovante de pagamento apresentado sem documento fiscal correspondente (NF-e/NFS-e/Nota de Débito). Necessária apresentação do documento fiscal para conciliação."
- **Identificação**:
  - Status pode ser apenas: 'Conciliado', 'Ressalva' ou 'Pendente'.
  - Se faltar documento cruzado: status 'Pendente'.
  - Se houver pequena divergência corrigível ou dúvida: status 'Ressalva'.
  - Se houver matching exato: status 'Conciliado'.
- **Rastreabilidade de Páginas**: Procure identificar em que página do documento fiscal/comprovante você achou a comprovação e preencha "nfPage" e "paymentPage". Se não achar, preencha "Não localizado".
- **Razão Social (entity)**: No campo "entity", utilize SEMPRE a razão social completa conforme consta no documento fiscal (NFS-e, NF-e ou recibo). Prefira a razão social registrada à denominação fantasia. Utilize a versão mais completa disponível nos documentos fiscais fornecidos.
- **Campos Adicionais**: Quando disponíveis nos documentos, extraia os campos opcionais abaixo. Se não houver informação, omita o campo (não retorne null ou string vazia).
- **Linguagem Financeira**: Todos os achados/divergências ("findings") e observações devem ser escritos em **Português do Brasil**, utilizando terminologia formal, técnica e linguagem estritamente financeira/contábil.

### DADOS DO CONTRATO:
- **Organização:** ${metadata.organization}
- **Período Auditado:** ${metadata.periodStart} a ${metadata.periodEnd}
- **Contrato:** ${metadata.contractNumber}

### REFERÊNCIA ORÇAMENTÁRIA (Aprovado previamente):
${JSON.stringify(csv1, null, 2)}`;

  const allItems: any[] = [];
  const allFindings: any[] = [];
  let firstParsedMeta: any = {};

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batch = batches[batchIdx];
    const globalOffset = batchIdx * BATCH_SIZE;
    const batchStart = globalOffset + 1;
    const batchEnd = globalOffset + batch.length;

    onProgress(
      3,
      totalBatches === 1
        ? "Stack Audit™ está cruzando 4 camadas de dados para cada lançamento financeiro..."
        : `Processando lote ${batchIdx + 1}/${totalBatches} — lançamentos ${batchStart} a ${batchEnd} de ${csv2.length}...`
    );

    const batchSystemInstruction = `${baseSystemInstruction}

### LOTE DE REGISTROS A AUDITAR (${batch.length} registros — lote ${batchIdx + 1} de ${totalBatches}):
${JSON.stringify(batch, null, 2)}`;

    const batchUserPrompt = `INSTRUÇÃO FINAL: Analise os textos dos PDFs abaixo e correlacione com os ${batch.length} registros do lote acima.
Retorne EXCLUSIVAMENTE JSON válido. O array "items" DEVE ter EXATAMENTE ${batch.length} elementos na mesma ordem dos registros recebidos.

=== TEXTO EXTRAÍDO — NOTAS FISCAIS ===
${pdfNfText}

=== TEXTO EXTRAÍDO — COMPROVANTES DE PAGAMENTO ===
${pdfPayText}

ESTRUTURA JSON ESPERADA (items deve ter ${batch.length} elementos). Campos opcionais: omita se não encontrado nos documentos.
{
  "items": [
    {
      "id": ${batchStart},
      "description": "Descrição do item",
      "activity": "Atividade/Rubrica",
      "date": "Data",
      "entity": "Fornecedor / Razão Social completa conforme doc fiscal",
      "docId": "Número da NF ou Comprovante",
      "taxId": "CNPJ/CPF",
      "value": 100.0,
      "status": "Conciliado, Ressalva ou Pendente",
      "nfPage": "Pág X ou Não localizado ou Dispensado",
      "paymentPage": "Pág X ou Não localizado ou Dispensado",
      "observations": "Justificativa detalhada",
      "emissionDateTime": "(opcional) Data/hora da emissão do documento fiscal (DD/MM/AAAA HH:mm)",
      "serviceDescription": "(opcional) Descrição completa dos produtos/serviços conforme doc fiscal",
      "taxInfo": "(opcional) CNAEs e informações tributárias relevantes (ISS, alíquota, etc.)",
      "paymentDateTime": "(opcional) Data/hora do pagamento conforme comprovante",
      "transactionId": "(opcional) Identificador único da operação (NSU, TXID PIX, código de autenticação, etc.)",
      "payerInfo": "(opcional) Pagador: nome, CNPJ/CPF, banco, agência, conta",
      "payeeInfo": "(opcional) Recebedor/Beneficiário: nome, CNPJ/CPF, banco, chave PIX",
      "paymentMethod": "(opcional) Meio de pagamento: PIX, TED, DOC, boleto, cartão"
    }
  ],
  "findings": [
    {
      "itemId": ${batchStart},
      "type": "Tipo da divergência",
      "involvedDocs": ["documentos envolvidos"]
    }
  ]
}`;

    let batchText = "";
    try {
      const response = await client.chat.completions.create({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: batchSystemInstruction },
          { role: "user", content: batchUserPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 8192,
      });
      batchText = response.choices[0]?.message?.content || "";
    } catch (error: any) {
      console.error(`DeepSeek API Error (batch ${batchIdx + 1}):`, error);
      // Fallback: use CSV rows directly for this batch
      for (let j = 0; j < batch.length; j++) {
        allItems.push({ ...fallbackFromCsvRow(batch[j], globalOffset + j), originalRow: batch[j] });
      }
      continue;
    }

    const parsed = parseJsonSafe(batchText);

    if (batchIdx === 0 && parsed) firstParsedMeta = parsed;

    let batchItems: any[] = parsed && Array.isArray(parsed.items) ? parsed.items : [];
    const batchFindings: any[] = parsed && Array.isArray(parsed.findings) ? parsed.findings : [];

    // Normalize items
    batchItems = batchItems.map((item: any, j: number) => normalizeItem(item, j, globalOffset));

    // If AI returned fewer items than the batch, fill remaining with fallback
    if (batchItems.length < batch.length) {
      console.warn(`Batch ${batchIdx + 1}: AI returned ${batchItems.length}/${batch.length} items — filling remainder with fallback`);
      for (let j = batchItems.length; j < batch.length; j++) {
        batchItems.push(fallbackFromCsvRow(batch[j], globalOffset + j));
      }
    }

    // Attach originalRow: direct 1:1 mapping — batchItems[j] → batch[j]
    for (let j = 0; j < batchItems.length; j++) {
      batchItems[j] = { ...batchItems[j], originalRow: batch[Math.min(j, batch.length - 1)] };
    }

    allItems.push(...batchItems);
    allFindings.push(...batchFindings);
  }

  onProgress(4, "Calculando período, métricas e gerando parecer final...");

  // ── #17: Compute actual period from item dates ────────────────────────────
  const parseDateTs = (d: string): number => {
    if (!d || d === "N/A") return 0;
    const br = d.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (br) return new Date(+br[3], +br[2] - 1, +br[1]).getTime();
    const ts = Date.parse(d);
    return isNaN(ts) ? 0 : ts;
  };
  const formatBrDate = (ts: number): string => {
    const d = new Date(ts);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  };
  const validTs = allItems.map((i: any) => parseDateTs(i.date)).filter(t => t > 0);
  const actualPeriodStart = validTs.length ? formatBrDate(Math.min(...validTs)) : metadata.periodStart || "N/A";
  const actualPeriodEnd   = validTs.length ? formatBrDate(Math.max(...validTs)) : metadata.periodEnd   || "N/A";

  // ── Verdict & metrics ────────────────────────────────────────────────────
  const totalItemsCount = allItems.length;
  const conciliatedCount = allItems.filter((i: any) => i.status === "Conciliado").length;
  const pendingCount = allItems.filter((i: any) => i.status === "Pendente").length;
  const findingsCount = allFindings.length;

  let verdict: AuditVerdict;
  if (pendingCount === 0 && findingsCount === 0) {
    verdict = "APROVADO";
  } else if (conciliatedCount / Math.max(totalItemsCount, 1) >= 0.8) {
    verdict = "APROVADO COM RESSALVAS";
  } else {
    verdict = "DILIGÊNCIA";
  }

  const computedTotalValue = allItems.reduce((acc: number, i: any) => acc + (Number(i.value) || 0), 0);

  const approvedValue = csv1.reduce((sum: number, row: any) => {
    const valStr = row.Valor || row.valor || row.value || row["Valor Total"] || 0;
    let clean = String(valStr).replace(/[^\d.,-]/g, "").replace(",", ".");
    const sep = Math.max(clean.lastIndexOf(","), clean.lastIndexOf("."));
    if (sep > -1) clean = clean.substring(0, sep).replace(/[.,]/g, "") + "." + clean.substring(sep + 1);
    const val = Number(clean);
    return sum + (isNaN(val) ? 0 : val);
  }, 0);

  onProgress(5, "Formatando o relatório de parecer (RAPC) em tela...");

  const emailSubject = firstParsedMeta?.emailTemplate?.subject
    || `Auditoria de Prestação de Contas — ${metadata.contractNumber}`;
  const emailBody = firstParsedMeta?.emailTemplate?.body
    || `Auditoria finalizada. Total de lançamentos: ${totalItemsCount}. Conciliados: ${conciliatedCount}. Pendentes: ${pendingCount}. Parecer: ${verdict}.`;

  return {
    id: crypto.randomUUID(),
    shareToken: crypto.randomUUID(),
    organization: metadata.organization || "Não informado",
    periodStart: actualPeriodStart,
    periodEnd: actualPeriodEnd,
    contractNumber: metadata.contractNumber || "Não informado",
    date: new Date().toISOString(),
    verdict,
    metrics: {
      totalItems: totalItemsCount,
      conciliatedItems: conciliatedCount,
      findingsCount,
      totalValue: computedTotalValue,
      approvedValue,
    },
    items: allItems,
    findings: allFindings,
    emailTemplate: {
      subject: emailSubject,
      body: emailBody,
    },
  };
}
