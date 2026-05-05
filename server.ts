import express, { Request, Response, NextFunction } from "express";
import session from "express-session";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import FileStoreFactory from "session-file-store";
import DocumentIntelligence, { getLongRunningPoller, isUnexpected } from "@azure-rest/ai-document-intelligence";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const AUDITS_DIR = path.join(DATA_DIR, "audits");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const PORT = Number(process.env.PORT) || 3000;

[AUDITS_DIR, SESSIONS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

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
app.use(express.json({ limit: "50mb" }));

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ── API: CNPJ proxy ───────────────────────────────────────────────────────────

app.get("/api/cnpj/:cnpj", requireAuth, async (req, res) => {
  const { cnpj } = req.params;
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

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
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
  const pages = result.body.analyzeResult?.pages ?? [];
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

app.post("/api/extract-pdf", requireAuth, pdfUpload.single("file"), async (req: any, res) => {
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

app.get("/api/audits/:id", requireAuth, (req, res) => {
  const auditDir = path.join(AUDITS_DIR, req.params.id);
  const resultPath = path.join(auditDir, "result.json");
  if (!fs.existsSync(resultPath)) return res.status(404).json({ error: "Auditoria não encontrada" });
  try {
    res.json(JSON.parse(fs.readFileSync(resultPath, "utf-8")));
  } catch {
    res.status(500).json({ error: "Erro ao ler auditoria" });
  }
});

app.delete("/api/audits/:id", requireAuth, (req, res) => {
  const auditDir = path.join(AUDITS_DIR, req.params.id);
  if (!fs.existsSync(auditDir)) return res.status(404).json({ error: "Auditoria não encontrada" });
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

app.get("/api/audits/:id/files/:filename", requireAuth, (req, res) => {
  const filePath = path.join(AUDITS_DIR, req.params.id, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Arquivo não encontrado" });
  res.download(filePath);
});

// ── API: public share link ────────────────────────────────────────────────────

app.get("/api/share/:token", (req, res) => {
  const { token } = req.params;
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
      if (result.shareToken === token) {
        const { createdBy: _c, sourceFiles: _s, shareToken: _t, ...safe } = result;
        return res.json(safe);
      }
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
  res.status(500).json({ error: "Erro interno do servidor", detail: err.message });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Stack Audit™ server running on port ${PORT}`);
  console.log(`Google OAuth: ${googleCallbackURL ? "configurado" : "NÃO configurado"}`);
});
