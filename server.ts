import express, { Request, Response, NextFunction } from "express";
import session from "express-session";
import passport from "passport";
import crypto from "node:crypto";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import FileStoreFactory from "session-file-store";
import DocumentIntelligence, { getLongRunningPoller, isUnexpected } from "@azure-rest/ai-document-intelligence";
import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const AUDITS_DIR = path.join(DATA_DIR, "audits");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === "production";

[AUDITS_DIR, SESSIONS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Security: path segment sanitizer (SEC-01) ─────────────────────────────────
// Rejects segments containing path separators or traversal sequences.
function sanitizeSegment(segment: string): string | null {
  if (!segment || /[/\\]|\.\./.test(segment)) return null;
  return segment;
}

// ── Security: rate limiters (SEC-03) ─────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas. Tente novamente em 15 minutos." },
});

const pdfLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Limite de extração de PDF atingido. Aguarde 1 minuto." },
});

const cnpjLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Limite de consulta CNPJ atingido. Aguarde 1 minuto." },
});

// ── Auth setup ────────────────────────────────────────────────────────────────

passport.serializeUser((user: any, done) => done(null, user));
passport.deserializeUser((user: any, done) => done(null, user));

const googleConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

let googleCallbackURL = "";
if (googleConfigured) {
  const rawAppUrl = process.env.APP_URL;
  if (!rawAppUrl) {
    console.error("[Auth] GOOGLE_CLIENT_ID/SECRET definidos mas APP_URL está ausente. Google OAuth desativado.");
  } else {
    try {
      new URL(rawAppUrl);
      googleCallbackURL = rawAppUrl.replace(/\/$/, "") + "/auth/google/callback";
    } catch {
      console.error(`[Auth] APP_URL "${rawAppUrl}" não é uma URL válida. Google OAuth desativado.`);
    }
  }
}

if (googleCallbackURL) {
  try {
    passport.use(
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          callbackURL: googleCallbackURL,
        },
        (_accessToken, _refreshToken, profile, done) => {
          const email = profile.emails?.[0]?.value || "";
          if (!email.endsWith("@casahacker.org")) {
            return done(null, false);
          }
          return done(null, {
            email,
            name: profile.displayName,
            photo: profile.photos?.[0]?.value,
          });
        }
      )
    );
  } catch (err: any) {
    console.error("[Auth] Falha ao inicializar GoogleStrategy:", err.message);
    googleCallbackURL = "";
  }
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.set("trust proxy", 1);

// ── Security headers (SEC-02) ─────────────────────────────────────────────────
// CSP disabled: SPA loads Google Fonts + Casa Hacker CDN; configure separately.
app.use(helmet({ contentSecurityPolicy: false }));

// ── Body parsing ──────────────────────────────────────────────────────────────
// General endpoints: 1mb limit (SEC-04). Audit run gets its own higher limit
// because the request contains extracted PDF text which can be large.
app.use("/api/audit-run", express.json({ limit: "20mb" }));
app.use(express.json({ limit: "1mb" }));

const FileStore = FileStoreFactory(session);

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    store: new FileStore({ path: SESSIONS_DIR, ttl: 86400 * 7, logFn: () => {} }),
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 86400 * 7 * 1000,
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// ── Auth routes ───────────────────────────────────────────────────────────────

app.get(
  "/auth/google",
  authLimiter,
  (req, res, next) => {
    if (!googleConfigured) {
      return res.status(503).json({ error: "Google OAuth não configurado. Adicione GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET ao .env e recrie o container." });
    }
    next();
  },
  passport.authenticate("google", { scope: ["email", "profile"] })
);

app.get(
  "/auth/google/callback",
  (req, res, next) => {
    if (!googleCallbackURL) {
      return res.status(503).redirect("/login?error=oauth_not_configured");
    }
    next();
  },
  passport.authenticate("google", {
    failureRedirect: "/login?error=domain",
    failureMessage: true,
  }),
  (_req, res) => res.redirect("/")
);

app.get("/auth/logout", (req, res) => {
  req.logout(() => res.redirect("/login"));
});

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: "Não autenticado" });
}

// ── API: current user ─────────────────────────────────────────────────────────

app.get("/api/me", (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: "Não autenticado" });
  res.json(req.user);
});

// ── API: health check ─────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

// ── File upload (multer) ──────────────────────────────────────────────────────

// SEC-05: MIME type allowlist — only CSV and PDF files accepted
const allowedMimeTypes = new Set([
  "text/csv",
  "text/plain",
  "application/csv",
  "application/vnd.ms-excel",
  "application/pdf",
]);

function auditFileFilter(_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  const ext = path.extname(file.originalname).toLowerCase();
  const mimeOk = allowedMimeTypes.has(file.mimetype);
  const extOk = ext === ".csv" || ext === ".pdf";
  if (mimeOk && extOk) return cb(null, true);
  cb(new Error(`Tipo de arquivo não permitido: ${file.mimetype} (${ext})`));
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: auditFileFilter,
});

// ── API: CNPJ proxy ───────────────────────────────────────────────────────────

app.get("/api/cnpj/:cnpj", cnpjLimiter, requireAuth, async (req, res) => {
  const cnpj = req.params.cnpj as string;
  const digits = cnpj.replace(/\D/g, "");
  if (digits.length !== 14) {
    return res.status(400).json({ error: "CNPJ deve ter 14 dígitos" });
  }

  // Normalize BrasilAPI response to the CNPJData shape expected by the frontend
  const normalizeBrasilApi = (d: any) => ({
    razao_social: d.razao_social,
    nome_fantasia: d.nome_fantasia,
    situacao_cadastral: d.descricao_situacao_cadastral,
    data_situacao_cadastral: d.data_situacao_cadastral,
    tipo: d.descricao_identificador_matriz_filial,
    natureza_juridica: d.natureza_juridica,
    abertura: d.data_inicio_atividade,
    capital_social: d.capital_social != null ? String(d.capital_social) : undefined,
    porte: d.porte,
    logradouro: d.logradouro,
    numero: d.numero,
    complemento: d.complemento,
    bairro: d.bairro,
    municipio: d.municipio,
    uf: d.uf,
    cep: d.cep,
    email: d.email,
    telefone: [d.ddd_telefone_1, d.ddd_telefone_2].filter(Boolean).join(" / ") || undefined,
    atividade_principal: d.cnae_fiscal
      ? [{ code: String(d.cnae_fiscal), text: d.cnae_fiscal_descricao }]
      : [],
    atividades_secundarias: Array.isArray(d.cnaes_secundarios)
      ? d.cnaes_secundarios.map((c: any) => ({ code: String(c.codigo), text: c.descricao }))
      : [],
    qsa: d.qsa,
  });

  try {
    const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${digits}`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) {
      const data = await r.json();
      return res.json(normalizeBrasilApi(data));
    }
  } catch (_) { /* fallback below */ }

  // Fallback: ReceitaWS — normalize to same CNPJData shape
  const normalizeReceitaWs = (d: any) => ({
    razao_social: d.nome,
    nome_fantasia: d.fantasia,
    situacao_cadastral: d.situacao,
    data_situacao_cadastral: d.data_situacao,
    tipo: d.tipo,
    natureza_juridica: typeof d.natureza_juridica === 'object' ? d.natureza_juridica?.descricao : d.natureza_juridica,
    abertura: d.abertura,
    capital_social: d.capital_social,
    porte: d.porte,
    logradouro: d.logradouro,
    numero: d.numero,
    complemento: d.complemento,
    bairro: d.bairro,
    municipio: d.municipio,
    uf: d.uf,
    cep: d.cep,
    telefone: d.telefone,
    email: d.email,
    atividade_principal: Array.isArray(d.atividade_principal) ? d.atividade_principal : [],
    atividades_secundarias: Array.isArray(d.atividades_secundarias) ? d.atividades_secundarias : [],
    qsa: Array.isArray(d.qsa)
      ? d.qsa.map((s: any) => ({ nome_socio: s.nome, qualificacao_socio: s.qual }))
      : [],
    simples_optante: d.simples?.optante != null ? (d.simples.optante ? 'Sim' : 'Não') : undefined,
    simei_optante: d.simei?.optante != null ? (d.simei.optante ? 'Sim' : 'Não') : undefined,
  });

  try {
    const r2 = await fetch(`https://www.receitaws.com.br/v1/cnpj/${digits}`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!r2.ok) {
      return res.status(r2.status).json({ error: "Erro ao consultar CNPJ", status: r2.status });
    }
    const data2 = await r2.json();
    return res.json(normalizeReceitaWs(data2));
  } catch (e: any) {
    return res.status(502).json({ error: "Falha ao consultar CNPJ", detail: e.message });
  }
});

// ── API: PDF extraction (pdftotext + Tesseract OCR fallback per page) ────────

function pdfOnlyFilter(_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (file.mimetype === "application/pdf" && ext === ".pdf") return cb(null, true);
  cb(new Error(`Apenas arquivos PDF são aceitos neste endpoint (recebido: ${file.mimetype})`));
}

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: pdfOnlyFilter,
});

// Pages with fewer meaningful (non-whitespace) characters than this threshold
// are treated as scanned images and sent to Tesseract OCR.
const OCR_THRESHOLD = 50;

// ── Azure Document Intelligence configuration ─────────────────────────────────
const AZURE_DI_ENDPOINT = (process.env.AZURE_DI_ENDPOINT || "").replace(/\/$/, "");
const AZURE_DI_KEY = process.env.AZURE_DI_KEY || "";
const EXTRACTION_ENGINE = process.env.EXTRACTION_ENGINE || "local";
const useAzure = !!(AZURE_DI_ENDPOINT && AZURE_DI_KEY && EXTRACTION_ENGINE === "azure");

console.log(`[Extraction] Engine: ${useAzure ? "Azure Document Intelligence" : "local (pdftotext + Tesseract)"}`);

async function extractWithAzureDI(fileBuffer: Buffer): Promise<{ text: string; pages: number; ocrPages: number; engine: string }> {
  const client = DocumentIntelligence(AZURE_DI_ENDPOINT, { key: AZURE_DI_KEY });
  const initialResponse = await client.path("/documentModels/{modelId}:analyze", "prebuilt-read").post({
    contentType: "application/json",
    body: { base64Source: fileBuffer.toString("base64") },
  });
  if (isUnexpected(initialResponse)) {
    throw new Error(`Azure DI error: ${JSON.stringify(initialResponse.body)}`);
  }
  const poller = getLongRunningPoller(client, initialResponse);
  const result = await poller.pollUntilDone();
  if (isUnexpected(result)) {
    throw new Error(`Azure DI polling error: ${JSON.stringify(result.body)}`);
  }
  const pages = (result.body as any).analyzeResult?.pages ?? [];
  const totalPages = pages.length;
  const text = pages
    .map((page: any, i: number) => {
      const lines = (page.lines ?? []).map((l: any) => l.content).join("\n");
      return `[Página ${i + 1}]\n${lines}`;
    })
    .filter((p: string) => p.replace(/\[Página \d+\]/, "").trim().length > 0)
    .join("\n\n");
  return { text, pages: totalPages, ocrPages: 0, engine: "azure-document-intelligence" };
}

app.post("/api/extract-pdf", pdfLimiter, requireAuth, pdfUpload.single("file"), async (req: any, res) => {
  if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });

  // ── Azure Document Intelligence path ────────────────────────────────────────
  if (useAzure) {
    try {
      const result = await extractWithAzureDI(req.file.buffer);
      return res.json(result);
    } catch (e: any) {
      console.warn("[Azure DI] Extração falhou, usando fallback local:", e.message);
      // fall through to local extraction
    }
  }

  // ── Local extraction path (pdftotext + Tesseract OCR) ────────────────────────
  const uid = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tmpIn = path.join("/tmp", `pdf_${uid}.pdf`);
  const tmpDir = path.join("/tmp", `ocr_${uid}`);

  try {
    fs.writeFileSync(tmpIn, req.file.buffer);
    fs.mkdirSync(tmpDir, { recursive: true });

    // ── Step 1: get actual page count via pdfinfo ────────────────────────────
    const { stdout: infoOut } = await execFileAsync("pdfinfo", [tmpIn]).catch(() => ({ stdout: "" }));
    const pageCountMatch = infoOut.match(/Pages:\s+(\d+)/);
    const totalPages = pageCountMatch ? parseInt(pageCountMatch[1], 10) : 1;

    // ── Step 2: extract full text with pdftotext (-layout preserves spacing) ─
    const { stdout: pdftextOut } = await execFileAsync("pdftotext", ["-layout", tmpIn, "-"]).catch(() => ({ stdout: "" }));

    // pdftotext separates pages with \f; trailing \f produces an empty last segment
    const rawPages = pdftextOut.split("\f");
    if (rawPages.length > 0 && rawPages[rawPages.length - 1].trim() === "") rawPages.pop();

    // Pad to actual page count in case pdftotext returned fewer segments (all-image PDF)
    while (rawPages.length < totalPages) rawPages.push("");

    // ── Step 3: per-page decision — pdftotext vs Tesseract OCR ───────────────
    let ocrPageCount = 0;
    const pageTexts: string[] = [];

    for (let i = 0; i < rawPages.length; i++) {
      const pageNum = i + 1;
      const ptText = rawPages[i].trim();
      const meaningfulChars = ptText.replace(/\s/g, "").length;

      if (meaningfulChars >= OCR_THRESHOLD) {
        // Digital page — use pdftotext output as-is
        pageTexts.push(ptText);
      } else {
        // Scanned page — rasterise then OCR
        ocrPageCount++;
        try {
          const imgBase = path.join(tmpDir, `p${pageNum}`);
          // pdftoppm: rasterise single page at 300 DPI as PNG
          await execFileAsync("pdftoppm", [
            "-f", String(pageNum),
            "-l", String(pageNum),
            "-r", "300",
            "-singlefile",
            "-png",
            tmpIn,
            imgBase,
          ]);
          // tesseract: OCR the PNG, output to stdout, Portuguese language
          const { stdout: ocrOut } = await execFileAsync("tesseract", [
            `${imgBase}.png`,
            "stdout",
            "-l", "por",
          ]);
          pageTexts.push(ocrOut.trim());
        } catch (ocrErr: any) {
          console.warn(`OCR falhou na página ${pageNum}:`, ocrErr.message);
          pageTexts.push(ptText); // keep sparse pdftotext output on OCR failure
        }
      }
    }

    // ── Step 4: assemble final text with page markers ─────────────────────────
    const text = pageTexts
      .map((t, i) => `[Página ${i + 1}]\n${t}`)
      .filter(p => p.replace(/\[Página \d+\]/, "").trim().length > 0)
      .join("\n\n");

    res.json({ text, pages: totalPages, ocrPages: ocrPageCount, engine: "local" });

  } catch (e: any) {
    res.status(500).json({ error: "Falha na extração de PDF", detail: e.message });
  } finally {
    fs.rmSync(tmpIn, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── API: audits ───────────────────────────────────────────────────────────────

app.get("/api/audits", requireAuth, (_req, res) => {
  if (!fs.existsSync(AUDITS_DIR)) return res.json([]);
  const dirs = fs.readdirSync(AUDITS_DIR).filter(d =>
    fs.statSync(path.join(AUDITS_DIR, d)).isDirectory()
  );
  const audits = dirs
    .map(id => {
      const metaPath = path.join(AUDITS_DIR, id, "result.json");
      if (!fs.existsSync(metaPath)) return null;
      try {
        const result = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        const { items: _items, findings: _findings, ...summary } = result;
        return { ...summary, itemCount: result.items?.length ?? 0 };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
  res.json(audits);
});

// ── API: related items by taxId across all audits ────────────────────────────
app.get("/api/audits/related", requireAuth, (req, res) => {
  const taxId = String(req.query.taxId || "").replace(/\D/g, "");
  if (!taxId || taxId.length < 11) return res.status(400).json({ error: "taxId inválido" });

  if (!fs.existsSync(AUDITS_DIR)) return res.json([]);

  const results: any[] = [];
  const dirs = fs.readdirSync(AUDITS_DIR).filter(d =>
    fs.statSync(path.join(AUDITS_DIR, d)).isDirectory()
  );

  for (const id of dirs) {
    const metaPath = path.join(AUDITS_DIR, id, "result.json");
    if (!fs.existsSync(metaPath)) continue;
    try {
      const audit = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const matched = (audit.items || []).filter((item: any) =>
        String(item.taxId || "").replace(/\D/g, "") === taxId
      );
      if (matched.length > 0) {
        results.push({
          auditId: audit.id,
          contractNumber: audit.contractNumber,
          organization: audit.organization,
          periodStart: audit.periodStart,
          periodEnd: audit.periodEnd,
          date: audit.date,
          items: matched.map((item: any) => ({
            id: item.id,
            description: item.description,
            date: item.date,
            value: item.value,
            status: item.status,
            docId: item.docId,
            activity: item.activity,
          })),
        });
      }
    } catch { /* skip corrupted */ }
  }

  results.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  res.json(results);
});

app.get("/api/audits/:id", requireAuth, (req, res) => {
  const safeId = sanitizeSegment(req.params.id as string);
  if (!safeId) return res.status(400).json({ error: "ID inválido" });
  const auditDir = path.join(AUDITS_DIR, safeId);
  const resultPath = path.join(auditDir, "result.json");
  if (!fs.existsSync(resultPath)) return res.status(404).json({ error: "Auditoria não encontrada" });
  try {
    const audit = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    // #20 — backfill itemCode for legacy audits that pre-date the feature
    let dirty = false;
    for (const item of (audit.items || [])) {
      if (!item.itemCode) {
        item.itemCode = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
        dirty = true;
      }
    }
    if (dirty) fs.writeFileSync(resultPath, JSON.stringify(audit, null, 2));
    res.json(audit);
  } catch {
    res.status(500).json({ error: "Erro ao ler auditoria" });
  }
});

app.patch("/api/audits/:id", requireAuth, (req: any, res) => {
  const safeId = sanitizeSegment(req.params.id as string);
  if (!safeId) return res.status(400).json({ error: "ID inválido" });
  const auditDir = path.join(AUDITS_DIR, safeId);
  const resultPath = path.join(auditDir, "result.json");
  if (!fs.existsSync(resultPath)) return res.status(404).json({ error: "Auditoria não encontrada" });

  let existing: any;
  try { existing = JSON.parse(fs.readFileSync(resultPath, "utf-8")); } catch { return res.status(500).json({ error: "Erro ao ler auditoria" }); }
  if (existing.createdBy !== req.user?.email) return res.status(403).json({ error: "Proibido" });

  const patch = req.body as any;
  const updated = { ...existing, ...patch };

  if (patch.items && Array.isArray(patch.items)) {
    const itemsMap = new Map<number, any>(existing.items.map((i: any) => [i.id, i]));
    for (const pi of patch.items) {
      if (itemsMap.has(pi.id)) itemsMap.set(pi.id, { ...itemsMap.get(pi.id), ...pi });
    }
    const items = Array.from(itemsMap.values());
    const conciliatedCount = items.filter((i: any) => i.status === "Conciliado").length;
    const pendingCount = items.filter((i: any) => i.status === "Pendente").length;
    const findingsCount = (updated.findings || []).length;
    updated.items = items;
    updated.metrics = { ...updated.metrics, totalItems: items.length, conciliatedItems: conciliatedCount, findingsCount };
    if (pendingCount === 0 && findingsCount === 0) updated.verdict = "APROVADO";
    else if (conciliatedCount / Math.max(items.length, 1) >= 0.8) updated.verdict = "APROVADO COM RESSALVAS";
    else updated.verdict = "DILIGÊNCIA";
  }

  fs.writeFileSync(resultPath, JSON.stringify(updated, null, 2));
  res.json(updated);
});

// ── API: server-side item reprocessing (calls DeepSeek from server) ──────────

const aiClient = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || "",
  baseURL: "https://api.deepseek.com",
});

async function extractTextFromFile(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) return "";
  const buffer = fs.readFileSync(filePath);

  if (useAzure) {
    try {
      const result = await extractWithAzureDI(buffer);
      return result.text;
    } catch (e: any) {
      console.warn("[Azure DI] reprocess fallback:", e.message);
    }
  }

  const uid = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tmpIn = path.join("/tmp", `rpdf_${uid}.pdf`);
  const tmpDir = path.join("/tmp", `rocr_${uid}`);
  try {
    fs.writeFileSync(tmpIn, buffer);
    fs.mkdirSync(tmpDir, { recursive: true });
    const { stdout: infoOut } = await execFileAsync("pdfinfo", [tmpIn]).catch(() => ({ stdout: "" }));
    const totalPages = parseInt(infoOut.match(/Pages:\s+(\d+)/)?.[1] ?? "1", 10);
    const { stdout: ptOut } = await execFileAsync("pdftotext", ["-layout", tmpIn, "-"]).catch(() => ({ stdout: "" }));
    const rawPages = ptOut.split("\f").filter((_, i, a) => !(i === a.length - 1 && _.trim() === ""));
    while (rawPages.length < totalPages) rawPages.push("");
    const pageTexts: string[] = [];
    for (let i = 0; i < rawPages.length; i++) {
      const ptText = rawPages[i].trim();
      if (ptText.replace(/\s/g, "").length >= OCR_THRESHOLD) { pageTexts.push(ptText); continue; }
      try {
        const imgBase = path.join(tmpDir, `p${i + 1}`);
        await execFileAsync("pdftoppm", ["-f", String(i + 1), "-l", String(i + 1), "-r", "300", "-singlefile", "-png", tmpIn, imgBase]);
        const { stdout: ocrOut } = await execFileAsync("tesseract", [`${imgBase}.png`, "stdout", "-l", "por"]);
        pageTexts.push(ocrOut.trim());
      } catch { pageTexts.push(ptText); }
    }
    return pageTexts.map((t, i) => `[Página ${i + 1}]\n${t}`).filter(p => p.replace(/\[Página \d+\]/, "").trim().length > 0).join("\n\n");
  } finally {
    fs.rmSync(tmpIn, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function parseJsonSafe(text: string): any {
  const startIdx = text.indexOf("{");
  if (startIdx === -1) return null;
  let jsonText = text.substring(startIdx);
  const endIdx = jsonText.lastIndexOf("}");
  if (endIdx !== -1) jsonText = jsonText.substring(0, endIdx + 1);
  try { return JSON.parse(jsonText); } catch { /* */ }
  try { return JSON.parse(jsonrepair(jsonText)); } catch { /* */ }
  return null;
}

const REPROCESS_BATCH = 25;
const AUDIT_BATCH = 25;

// ── API: full audit run — server-side DeepSeek call ───────────────────────────
app.post("/api/audit-run", requireAuth, async (req: any, res) => {
  const { metadata, csv1, csv2, pdfNfText, pdfPayText } = req.body as {
    metadata: { organization: string; periodStart: string; periodEnd: string; contractNumber: string };
    csv1: any[];
    csv2: any[];
    pdfNfText: string;
    pdfPayText: string;
  };

  if (!metadata || !Array.isArray(csv2) || csv2.length === 0) {
    return res.status(400).json({ error: "Dados inválidos para auditoria" });
  }

  const batches: any[][] = [];
  for (let i = 0; i < csv2.length; i += AUDIT_BATCH) batches.push(csv2.slice(i, i + AUDIT_BATCH));

  const baseSystem = `Você é um Auditor Financeiro Sênior e Especialista em Compliance atuando com rigor militar em projetos sociais do terceiro setor.

### INSTRUÇÃO MÁXIMA E OBRIGATÓRIA (CRÍTICO):
1. **EXAUSTIVIDADE TOTAL**: Você receberá um lote de registros de prestação de contas. Você DEVE processar e retornar **TODOS** os registros do lote sem exceção. O array "items" DEVE ter EXATAMENTE O MESMO NÚMERO DE ELEMENTOS que os registros recebidos no lote.
2. NUNCA resuma, agrupe ou omita itens. Cada objeto em "items" corresponde a UM registro do lote.

### REGRAS DE AUDITORIA:
- **Verificação Quádrupla**: Valide se o mesmo gasto bate com o CSV de Orçamento, se o texto extraído da Nota Fiscal está compatível, e se o texto do Comprovante confirma o pagamento real com a data/valor da Nota e CSV.
- **Tarifas Bancárias**: Tarifas bancárias de até 150 reais devem ser sempre consideradas como status "Conciliado" e dispensadas de comprovação fiscal. Nesses casos, preencha OBRIGATORIAMENTE: "docId": "Dispensado", "nfPage": "Dispensado", "paymentPage": "Dispensado".
- **Mobilidade (Uber/99/Táxi)**: Recibos de aplicativos de transporte (Uber, Táxi, 99) são considerados Comprovantes Aprovados válidos por si mesmos, sem necessidade de outro documento fiscal. Devem ser classificados como "Conciliado" se os valores/data baterem com o lançamento.
- **Documentos Fiscais Aceitos**: São documentos fiscais válidos: NF-e, NFS-e, Nota de Débito, Recibo Uber/Táxi/99 e Recibo de Aluguel. NÃO são documentos fiscais suficientes: comprovantes de pagamento (PIX, TED, DOC, boleto, extrato). Se o único documento for comprovante sem doc fiscal: status 'Pendente'.
- **Identificação**: Status pode ser apenas: 'Conciliado', 'Ressalva' ou 'Pendente'.
- **Rastreabilidade de Páginas**: Identifique em qual página do doc fiscal/comprovante está a comprovação. Se não achar: "Não localizado".
- **Razão Social (entity)**: Utilize SEMPRE a razão social completa conforme consta no documento fiscal.
- **Atividade / Rubrica (activity)**: Copie FIELMENTE o valor exato da coluna de atividade/rubrica conforme registrado no CSV de prestação de contas.
- **Linguagem**: Português do Brasil, terminologia formal e financeira.

### DADOS DO CONTRATO:
- **Organização:** ${metadata.organization}
- **Período Auditado:** ${metadata.periodStart} a ${metadata.periodEnd}
- **Contrato:** ${metadata.contractNumber}

### REFERÊNCIA ORÇAMENTÁRIA (Aprovado previamente):
${JSON.stringify(csv1, null, 2)}`;

  const allItems: any[] = [];
  const allFindings: any[] = [];
  let firstParsedMeta: any = {};

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const globalOffset = batchIdx * AUDIT_BATCH;
    const batchStart = globalOffset + 1;
    const batchEnd = globalOffset + batch.length;

    const systemMsg = `${baseSystem}\n\n### LOTE DE REGISTROS A AUDITAR (${batch.length} registros — lote ${batchIdx + 1} de ${batches.length}, registros ${batchStart}–${batchEnd}):\n${JSON.stringify(batch, null, 2)}`;
    const userMsg = `INSTRUÇÃO FINAL: Analise os textos dos PDFs abaixo e correlacione com os ${batch.length} registros do lote acima.\nRetorne EXCLUSIVAMENTE JSON válido. O array "items" DEVE ter EXATAMENTE ${batch.length} elementos na mesma ordem dos registros recebidos.\n\n=== TEXTO EXTRAÍDO — NOTAS FISCAIS ===\n${pdfNfText}\n\n=== TEXTO EXTRAÍDO — COMPROVANTES DE PAGAMENTO ===\n${pdfPayText}\n\nESTRUTURA JSON ESPERADA:\n{"items":[{"id":${batchStart},"description":"...","activity":"...","date":"...","entity":"...","docId":"...","taxId":"...","value":0,"status":"Conciliado","nfPage":"...","paymentPage":"...","observations":"..."}],"findings":[]}`;

    let batchText = "";
    try {
      const resp = await aiClient.chat.completions.create({
        model: "deepseek-chat",
        messages: [{ role: "system", content: systemMsg }, { role: "user", content: userMsg }],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 8192,
      });
      batchText = resp.choices[0]?.message?.content || "";
    } catch (e: any) {
      console.error(`[audit-run] batch ${batchIdx + 1} DeepSeek error:`, e.message);
      for (let j = 0; j < batch.length; j++) {
        allItems.push(fallbackFromRow(batch[j], globalOffset + j));
      }
      continue;
    }

    const parsed = parseJsonSafe(batchText);
    if (batchIdx === 0 && parsed) firstParsedMeta = parsed;
    let batchItems: any[] = parsed?.items ?? [];
    const batchFindings: any[] = parsed?.findings ?? [];

    batchItems = batchItems.map((item: any, j: number) => normalizeAuditItem(item, j, globalOffset));

    if (batchItems.length < batch.length) {
      for (let j = batchItems.length; j < batch.length; j++) {
        batchItems.push(fallbackFromRow(batch[j], globalOffset + j));
      }
    }

    for (let j = 0; j < batchItems.length; j++) {
      batchItems[j] = { ...batchItems[j], originalRow: batch[Math.min(j, batch.length - 1)] };
    }

    allItems.push(...batchItems);
    allFindings.push(...batchFindings);
  }

  res.json({ items: allItems, findings: allFindings, meta: firstParsedMeta });
});

function normalizeAuditItem(item: any, idx: number, globalOffset: number) {
  return {
    id: globalOffset + idx + 1,
    itemCode: crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase(),
    description: item.description || "Sem descrição informada",
    activity: item.activity || "Não Informado",
    date: item.date || "N/A",
    entity: item.entity || "N/A",
    docId: item.docId || "N/A",
    taxId: item.taxId || "N/A",
    value: Number(item.value) || 0,
    status: (["Conciliado", "Ressalva", "Pendente"].includes(item.status) ? item.status : "Pendente") as string,
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

function fallbackFromRow(row: any, globalIdx: number) {
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
    itemCode: crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase(),
    description: String(getVal(["despesa", "descri", "historico", "item", "lancamento"]) || Object.values(row).find((x: any) => x && isNaN(Number(x)) && String(x).length > 5) || "Sem descrição"),
    activity: String(getVal(["atividade", "rubrica", "categoria"]) || "Não Informado"),
    date: String(getVal(["data", "emissao", "pagamento"]) || "N/A"),
    entity: String(getVal(["razao", "fornecedor", "favorecido", "nome"]) || "N/A"),
    docId: String(getVal(["doc", "nota", "nf", "comprovante"]) || "Pendente"),
    taxId: String(getVal(["cnpj", "cpf"]) || "N/A"),
    value: Number(valStr) || 0,
    status: "Pendente",
    nfPage: "N/A",
    paymentPage: "N/A",
    observations: "Item recuperado por fallback — auditoria automatizada falhou.",
    originalRow: row,
  };
}

app.post("/api/audits/:id/reprocess", requireAuth, async (req: any, res) => {
  const safeId = sanitizeSegment(req.params.id as string);
  if (!safeId) return res.status(400).json({ error: "ID inválido" });
  const auditDir = path.join(AUDITS_DIR, safeId);
  const resultPath = path.join(auditDir, "result.json");
  if (!fs.existsSync(resultPath)) return res.status(404).json({ error: "Auditoria não encontrada" });

  let audit: any;
  try { audit = JSON.parse(fs.readFileSync(resultPath, "utf-8")); } catch { return res.status(500).json({ error: "Erro ao ler auditoria" }); }
  if (audit.createdBy !== req.user?.email) return res.status(403).json({ error: "Proibido" });

  const { itemIds, additionalContext = "" } = req.body as { itemIds: number[]; additionalContext?: string };
  if (!Array.isArray(itemIds) || itemIds.length === 0) return res.status(400).json({ error: "itemIds obrigatório" });

  const items = (audit.items as any[]).filter((i: any) => itemIds.includes(i.id));
  if (items.length === 0) return res.status(400).json({ error: "Nenhum item encontrado" });

  const sf = audit.sourceFiles || {};
  const invoicesPath = sf.invoices ? path.join(auditDir, sf.invoices) : "";
  const paymentsPath = sf.payments ? path.join(auditDir, sf.payments) : "";
  const budgetPath = sf.budget ? path.join(auditDir, sf.budget) : "";

  let budgetCsv: any[] = [];
  if (budgetPath && fs.existsSync(budgetPath)) {
    const Papa = await import("papaparse");
    const csvText = fs.readFileSync(budgetPath, "utf-8");
    const parsed = Papa.default.parse(csvText, { header: true, skipEmptyLines: true });
    budgetCsv = parsed.data as any[];
  }

  let pdfNfText = "";
  let pdfPayText = "";
  try {
    [pdfNfText, pdfPayText] = await Promise.all([
      extractTextFromFile(invoicesPath),
      extractTextFromFile(paymentsPath),
    ]);
  } catch (e: any) {
    console.error("[reprocess] PDF extraction error:", e.message);
  }

  const rows = items.map((i: any) => i.originalRow ?? {
    Descrição: i.description, Atividade: i.activity, Data: i.date,
    Fornecedor: i.entity, "Doc Fiscal": i.docId, "CNPJ/CPF": i.taxId, Valor: i.value,
  });

  const contextNote = additionalContext.trim() ? `\n\n### CONTEXTO ADICIONAL DO AUDITOR:\n${additionalContext.trim()}` : "";
  const baseSystem = `Você é um Auditor Financeiro Sênior reprocessando itens específicos de uma prestação de contas.

### REGRAS DE AUDITORIA:
- Verificação Quádrupla: CSV Orçamento + CSV PC + PDF NF + PDF Comprovante.
- Tarifas bancárias ≤ R$150: sempre "Conciliado", docId/nfPage/paymentPage = "Dispensado".
- Mobilidade (Uber/99/Táxi): "Conciliado" se valores/data batem.
- Documentos aceitos: NF-e, NFS-e, Nota de Débito, Recibo Uber/Táxi. Comprovante sem doc fiscal = "Pendente".
- Status: apenas "Conciliado", "Ressalva" ou "Pendente".
- activity: copie FIELMENTE do CSV de PC, sem interpretar.
- entity: razão social completa conforme doc fiscal.
- Linguagem: Português do Brasil, formal, financeira.${contextNote}

### DADOS DO CONTRATO:
- Organização: ${audit.organization}
- Contrato: ${audit.contractNumber}

### REFERÊNCIA ORÇAMENTÁRIA:
${JSON.stringify(budgetCsv, null, 2)}`;

  const updatedItems: any[] = [];
  const batches: any[][] = [];
  for (let i = 0; i < rows.length; i += REPROCESS_BATCH) batches.push(rows.slice(i, i + REPROCESS_BATCH));

  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    const batch = batches[bIdx];
    const offset = bIdx * REPROCESS_BATCH;
    const systemMsg = `${baseSystem}\n\n### LOTE A REANALISAR (${batch.length} registros):\n${JSON.stringify(batch, null, 2)}`;
    const userMsg = `Retorne JSON com "items" contendo EXATAMENTE ${batch.length} elementos.\n\n=== NOTAS FISCAIS ===\n${pdfNfText}\n\n=== COMPROVANTES ===\n${pdfPayText}\n\n{"items":[{"id":1,"description":"...","activity":"...","date":"...","entity":"...","docId":"...","taxId":"...","value":0,"status":"...","nfPage":"...","paymentPage":"...","observations":"..."}],"findings":[]}`;

    let batchText = "";
    try {
      const resp = await aiClient.chat.completions.create({
        model: "deepseek-chat",
        messages: [{ role: "system", content: systemMsg }, { role: "user", content: userMsg }],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 8192,
      });
      batchText = resp.choices[0]?.message?.content || "";
    } catch (e: any) {
      console.error(`[reprocess] batch ${bIdx + 1} DeepSeek error:`, e.message);
      for (let j = 0; j < batch.length; j++) {
        const orig = items[offset + j];
        updatedItems.push({ ...orig, status: "Pendente", observations: `Falha na reanálise: ${e.message}` });
      }
      continue;
    }

    const parsed = parseJsonSafe(batchText);
    let batchResult: any[] = parsed?.items ?? [];
    while (batchResult.length < batch.length) batchResult.push(null);

    for (let j = 0; j < batch.length; j++) {
      const orig = items[offset + j];
      const ai = batchResult[j];
      if (!ai) { updatedItems.push({ ...orig, status: "Pendente", observations: "Item não retornado na reanálise." }); continue; }
      updatedItems.push({
        ...orig,
        description: ai.description || orig.description,
        activity: ai.activity || orig.activity,
        date: ai.date || orig.date,
        entity: ai.entity || orig.entity,
        docId: ai.docId || orig.docId,
        taxId: ai.taxId || orig.taxId,
        value: typeof ai.value === "number" ? ai.value : orig.value,
        status: ["Conciliado", "Ressalva", "Pendente"].includes(ai.status) ? ai.status : orig.status,
        nfPage: ai.nfPage ?? orig.nfPage,
        paymentPage: ai.paymentPage ?? orig.paymentPage,
        observations: ai.observations || orig.observations,
        emissionDateTime: ai.emissionDateTime ?? orig.emissionDateTime,
        serviceDescription: ai.serviceDescription ?? orig.serviceDescription,
        taxInfo: ai.taxInfo ?? orig.taxInfo,
        paymentDateTime: ai.paymentDateTime ?? orig.paymentDateTime,
        transactionId: ai.transactionId ?? orig.transactionId,
        payerInfo: ai.payerInfo ?? orig.payerInfo,
        payeeInfo: ai.payeeInfo ?? orig.payeeInfo,
        paymentMethod: ai.paymentMethod ?? orig.paymentMethod,
      });
    }
  }

  res.json({ items: updatedItems });
});

app.delete("/api/audits/:id", requireAuth, (req: any, res) => {
  const safeId = sanitizeSegment(req.params.id as string);
  if (!safeId) return res.status(400).json({ error: "ID inválido" });
  const auditDir = path.join(AUDITS_DIR, safeId);
  if (!fs.existsSync(auditDir)) return res.status(404).json({ error: "Auditoria não encontrada" });

  // SEC-04: only the audit owner may delete
  const resultPath = path.join(auditDir, "result.json");
  try {
    const audit = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    if (audit.createdBy !== req.user?.email) return res.status(403).json({ error: "Proibido" });
  } catch { /* allow deletion if result.json missing */ }

  fs.rmSync(auditDir, { recursive: true, force: true });
  res.json({ ok: true });
});

app.post(
  "/api/audits",
  requireAuth,
  upload.fields([
    { name: "budget", maxCount: 1 },
    { name: "report", maxCount: 1 },
    { name: "invoices", maxCount: 1 },
    { name: "payments", maxCount: 1 },
  ]),
  (req: any, res) => {
    let result: any;
    try {
      result = JSON.parse(req.body.result);
    } catch {
      return res.status(400).json({ error: "Campo 'result' inválido" });
    }

    const auditDir = path.join(AUDITS_DIR, result.id);
    fs.mkdirSync(auditDir, { recursive: true });

    // Save files first, then write result.json with correct savedFiles
    const files = req.files as Record<string, Express.Multer.File[]>;
    const savedFiles: Record<string, string> = {};
    for (const [field, fileArr] of Object.entries(files || {})) {
      const file = fileArr[0];
      const ext = path.extname(file.originalname) || (file.mimetype.includes("pdf") ? ".pdf" : ".csv");
      const filename = `${field}${ext}`;
      fs.writeFileSync(path.join(auditDir, filename), file.buffer);
      savedFiles[field] = filename;
    }

    // Overwrite sourceFiles with actual server-saved filenames before persisting
    result.sourceFiles = savedFiles;
    fs.writeFileSync(path.join(auditDir, "result.json"), JSON.stringify(result, null, 2));

    res.status(201).json({ id: result.id, savedFiles });
  }
);

app.get("/api/audits/:id/files/:filename", requireAuth, (req: any, res) => {
  // SEC-01: reject path segments containing traversal sequences
  const safeId = sanitizeSegment(req.params.id as string);
  const safeFilename = sanitizeSegment(req.params.filename as string);
  if (!safeId || !safeFilename) return res.status(400).json({ error: "Parâmetros inválidos" });

  const filePath = path.join(AUDITS_DIR, safeId, safeFilename);

  // SEC-01: belt-and-suspenders — resolved path must stay inside AUDITS_DIR
  if (!path.resolve(filePath).startsWith(path.resolve(AUDITS_DIR) + path.sep)) {
    return res.status(403).json({ error: "Acesso negado" });
  }

  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Arquivo não encontrado" });

  // SEC-04: only the audit owner may download its files
  const resultPath = path.join(AUDITS_DIR, safeId, "result.json");
  try {
    const audit = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    if (audit.createdBy !== req.user?.email) return res.status(403).json({ error: "Proibido" });
  } catch {
    return res.status(404).json({ error: "Auditoria não encontrada" });
  }

  res.download(filePath);
});

// ── API: item deep link by itemCode (requires auth) ──────────────────────────

app.get("/api/items/:code", requireAuth, (req, res) => {
  const { code } = req.params;
  if (!code || code.length < 6) return res.status(400).json({ error: "Código inválido" });
  if (!fs.existsSync(AUDITS_DIR)) return res.status(404).json({ error: "Item não encontrado" });

  const dirs = fs.readdirSync(AUDITS_DIR).filter(d =>
    fs.statSync(path.join(AUDITS_DIR, d)).isDirectory()
  );

  for (const dir of dirs) {
    const resultPath = path.join(AUDITS_DIR, dir, "result.json");
    if (!fs.existsSync(resultPath)) continue;
    try {
      const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
      const item = (result.items || []).find((i: any) => i.itemCode === code);
      if (item) {
        return res.json({
          auditId: result.id,
          contractNumber: result.contractNumber,
          organization: result.organization,
          periodStart: result.periodStart,
          periodEnd: result.periodEnd,
          item,
        });
      }
    } catch { continue; }
  }

  res.status(404).json({ error: "Lançamento não encontrado" });
});

// ── API: download item document (NF or payment) as PDF ───────────────────────
// Extracts the relevant pages from the source PDF using poppler-utils.

function parsePageString(raw: string): number[] {
  if (!raw) return [];
  const norm = raw.replace(/pág\.?\s*/gi, '').replace(/página\s*/gi, '').trim();
  if (!norm || /^(n\/a|não localizado|dispensado|pendente|não encontrado)$/i.test(norm)) return [];
  const pages = new Set<number>();
  for (const part of norm.split(/[,;]/)) {
    const range = part.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (range) {
      const from = parseInt(range[1], 10);
      const to = parseInt(range[2], 10);
      for (let p = from; p <= to; p++) pages.add(p);
    } else {
      const num = parseInt(part.trim(), 10);
      if (!isNaN(num) && num > 0) pages.add(num);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

function slugify(s: string): string {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}

app.get("/api/audits/:id/items/:itemId/doc", requireAuth, async (req: any, res) => {
  const safeId = sanitizeSegment(req.params.id as string);
  const itemId = parseInt(req.params.itemId as string, 10);
  const type = String(req.query.type ?? '');

  if (!safeId || isNaN(itemId)) return res.status(400).json({ error: "Parâmetros inválidos" });
  if (type !== 'nf' && type !== 'payment') return res.status(400).json({ error: "type deve ser 'nf' ou 'payment'" });

  const auditDir = path.join(AUDITS_DIR, safeId);
  const resultPath = path.join(auditDir, "result.json");
  if (!fs.existsSync(resultPath)) return res.status(404).json({ error: "Auditoria não encontrada" });

  let audit: any;
  try { audit = JSON.parse(fs.readFileSync(resultPath, "utf-8")); }
  catch { return res.status(500).json({ error: "Erro ao ler auditoria" }); }

  if (audit.createdBy !== req.user?.email) return res.status(403).json({ error: "Proibido" });

  const item = (audit.items as any[]).find((i: any) => i.id === itemId);
  if (!item) return res.status(404).json({ error: "Lançamento não encontrado" });

  const sf = audit.sourceFiles || {};
  const sourceFile = type === 'nf' ? sf.invoices : sf.payments;
  if (!sourceFile) return res.status(404).json({ error: "Arquivo fonte não encontrado" });

  const sourcePath = path.join(auditDir, sourceFile);
  if (!path.resolve(sourcePath).startsWith(path.resolve(auditDir) + path.sep))
    return res.status(403).json({ error: "Acesso negado" });
  if (!fs.existsSync(sourcePath)) return res.status(404).json({ error: "PDF fonte não encontrado" });

  const pageRef = type === 'nf' ? (item.nfPage || '') : (item.paymentPage || '');
  const pages = parsePageString(pageRef);
  if (pages.length === 0) return res.status(422).json({ error: `Página(s) não identificada(s) para este lançamento (${pageRef || 'N/A'})` });

  // Build filename
  const docIdSlug  = slugify(item.docId);
  const entitySlug = slugify(item.entity);
  const dateSlug   = slugify(item.date);
  const txSlug     = item.transactionId ? slugify(item.transactionId) : docIdSlug;
  const filename   = type === 'nf'
    ? `NF_${docIdSlug}_${entitySlug}_${dateSlug}.pdf`
    : `Comprovante_${txSlug}_${entitySlug}_${dateSlug}.pdf`;

  const tmpDir = fs.mkdtempSync(path.join(DATA_DIR, "tmp_doc_"));
  try {
    // Extract each page as individual PDF
    const pageFiles: string[] = [];
    for (const p of pages) {
      const outBase = path.join(tmpDir, `page_%04d.pdf`);
      await execFileAsync("pdfseparate", ["-f", String(p), "-l", String(p), sourcePath, outBase]);
      const produced = fs.readdirSync(tmpDir)
        .filter(f => f.startsWith("page_") && f.endsWith(".pdf"))
        .map(f => path.join(tmpDir, f))
        .filter(f => !pageFiles.includes(f))
        .sort();
      pageFiles.push(...produced);
    }

    if (pageFiles.length === 0) {
      return res.status(422).json({ error: "Página(s) não encontrada(s) no PDF" });
    }

    let finalPdf: string;
    if (pageFiles.length === 1) {
      finalPdf = pageFiles[0];
    } else {
      finalPdf = path.join(tmpDir, "output.pdf");
      await execFileAsync("pdfunite", [...pageFiles, finalPdf]);
    }

    const pdfBuffer = fs.readFileSync(finalPdf);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (e: any) {
    console.error("[doc-extract]", e.message);
    res.status(500).json({ error: "Erro ao extrair páginas do PDF: " + e.message });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── API: public share link ────────────────────────────────────────────────────

app.get("/api/share/:token", (req, res) => {
  const { token } = req.params;
  const codeParam = String(req.query.code ?? '').trim().toUpperCase();
  if (!token || token.length < 10) return res.status(400).json({ error: "Token inválido" });
  if (!fs.existsSync(AUDITS_DIR)) return res.status(404).json({ error: "Auditoria não encontrada" });

  const dirs = fs.readdirSync(AUDITS_DIR).filter(d =>
    fs.statSync(path.join(AUDITS_DIR, d)).isDirectory()
  );

  for (const dir of dirs) {
    const resultPath = path.join(AUDITS_DIR, dir, "result.json");
    if (!fs.existsSync(resultPath)) continue;
    try {
      const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
      if (result.shareToken !== token) continue;

      // If this audit has an access code, validate it
      if (result.shareAccessCode) {
        if (!codeParam) {
          return res.status(401).json({ error: "Código de acesso obrigatório", requiresCode: true });
        }
        // SEC-05: constant-time comparison to prevent timing attacks
        const expected = Buffer.from(result.shareAccessCode.toUpperCase().padEnd(32, '\0'));
        const actual   = Buffer.from(codeParam.toUpperCase().padEnd(32, '\0'));
        const match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
        const codeMatch = match && codeParam.toUpperCase() === result.shareAccessCode.toUpperCase();
        if (!codeMatch) {
          return res.status(401).json({ error: "Código de acesso inválido", requiresCode: true });
        }
      }

      const { createdBy: _c, sourceFiles: _s, shareToken: _t, shareAccessCode: _a, ...safe } = result;
      return res.json(safe);
    } catch { continue; }
  }

  res.status(404).json({ error: "Auditoria não encontrada ou link inválido" });
});

// ── Serve React SPA ───────────────────────────────────────────────────────────

const distDir = path.join(__dirname, "dist");

app.use(express.static(distDir));

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/auth/")) {
    return res.status(404).json({ error: "Not found" });
  }
  res.sendFile(path.join(distDir, "index.html"));
});

// ── Global error handler ──────────────────────────────────────────────────────

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[Unhandled Express Error]", err);
  if (res.headersSent) return;
  // SEC-04: hide internal error details in production
  res.status(500).json({
    error: "Erro interno do servidor",
    ...(IS_PROD ? {} : { detail: err.message }),
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Stack Audit™ server running on port ${PORT}`);
  console.log(`Google OAuth: ${googleCallbackURL ? "configurado" : "NÃO configurado"}`);
});
