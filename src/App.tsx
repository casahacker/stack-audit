/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  PlusCircle,
  Loader2,
  FileText,
  History,
  AlertCircle,
  ChevronRight,
  Upload,
  Download,
  Trash2,
  LogOut,
  X,
  Search,
  FileDown,
  BookOpen,
  Building2,
  ExternalLink,
  Link2,
} from 'lucide-react';
import { cn, formatCurrency, truncateFileName } from './lib/utils';
import Papa from 'papaparse';
import { AuditResult, FileData, AuditItem, AuthUser, BudgetLine, CNPJData } from './types';
import { processAudit } from './services/auditService';

type Section = 'nova' | 'processando' | 'resultado' | 'historico' | 'documentacao';

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidDate(d: string): boolean {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(d)) return false;
  const [day, month, year] = d.split('/').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function parseBrDate(d: string): Date {
  const [day, month, year] = d.split('/').map(Number);
  return new Date(year, month - 1, day);
}

function arrayToCsv(data: any[]): string {
  if (!data.length) return '';
  const headers = Object.keys(data[0]);
  const rows = data.map(row => headers.map(h => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(','));
  return [headers.join(','), ...rows].join('\n');
}

function base64ToBlob(b64: string, type: string): Blob {
  const binary = atob(b64.includes(',') ? b64.split(',')[1] : b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

function normalizeStr(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function computeBudgetLines(budgetCsv: any[], items: AuditItem[]): BudgetLine[] {
  const sampleRow = budgetCsv[0];
  if (!sampleRow) return [];
  const budgetCols = Object.keys(sampleRow);

  // ── Budget CSV: find DESCRIPTION column (col A — "DESCRIÇÃO") ──
  // Priority: 'descri' matches DESCRIÇÃO before activity columns
  const budgetDescKeys = ['descri', 'item', 'rubrica', 'atividade', 'linha'];
  let budgetDescCol: string | undefined;
  for (const key of budgetDescKeys) {
    budgetDescCol = budgetCols.find(c => normalizeStr(c).includes(key));
    if (budgetDescCol) break;
  }
  if (!budgetDescCol) {
    budgetDescCol = budgetCols.find(c => {
      const v = String(sampleRow[c] ?? '');
      return v.length > 3 && isNaN(Number(v.replace(/[R$.,\s]/g, '')));
    });
  }

  // ── Budget CSV: find VALUE column ──
  const valueKeys = ['valor total', 'total', 'valor', 'value', 'montante', 'orcado', 'planejado', 'previsto', 'dotacao', 'aprovado', 'autorizado', 'limite'];
  let valueCol: string | undefined;
  for (const key of valueKeys) {
    valueCol = budgetCols.find(c => normalizeStr(c).includes(normalizeStr(key)));
    if (valueCol) break;
  }
  if (!valueCol) {
    valueCol = budgetCols.find(c => {
      const v = String(sampleRow[c] ?? '');
      return v.length > 0 && !isNaN(Number(v.replace(/[R$.,\s]/g, '')));
    });
  }

  const parseVal = (raw: string | undefined): number => {
    if (!raw) return 0;
    const clean = raw.replace(/[^\d.,]/g, '');
    if (!clean) return 0;
    const lastComma = clean.lastIndexOf(',');
    const lastDot = clean.lastIndexOf('.');
    const normalized =
      lastComma > lastDot
        ? clean.replace(/\./g, '').replace(',', '.')
        : clean.replace(/,/g, '');
    return parseFloat(normalized) || 0;
  };

  // ── Group budget CSV by DESCRIÇÃO (skip summary rows) ──
  const plannedByDesc: Record<string, number> = {};
  for (const row of budgetCsv) {
    const desc = budgetDescCol ? String(row[budgetDescCol] ?? '').trim() : '';
    if (!desc || normalizeStr(desc).includes('custo total') || normalizeStr(desc).includes('total geral')) continue;
    const valRaw = valueCol ? String(row[valueCol] ?? '') : '';
    plannedByDesc[desc] = (plannedByDesc[desc] || 0) + parseVal(valRaw);
  }

  // ── Group executed values by item.activity (rubrica declarada no lançamento) ──
  const executedByActivity: Record<string, number> = {};
  for (const item of items) {
    const key = (item.activity || 'Não Classificado').trim();
    executedByActivity[key] = (executedByActivity[key] || 0) + (item.value || 0);
  }

  // ── Match declared activities to budget rubrics via normalized exact match ──
  const budgetKeyByNorm: Record<string, string> = {};
  for (const key of Object.keys(plannedByDesc)) {
    budgetKeyByNorm[normalizeStr(key)] = key;
  }

  const executedByBudgetKey: Record<string, number> = {};
  let unmatchedTotal = 0;
  for (const [activity, value] of Object.entries(executedByActivity)) {
    const budgetKey = budgetKeyByNorm[normalizeStr(activity)];
    if (budgetKey) {
      executedByBudgetKey[budgetKey] = (executedByBudgetKey[budgetKey] || 0) + value;
    } else {
      unmatchedTotal += value;
    }
  }

  // ── One line per budget rubric + catch-all for unmatched ──
  const lines: BudgetLine[] = Object.keys(plannedByDesc).map(rubric => ({
    activity: rubric,
    plannedValue: plannedByDesc[rubric] || 0,
    executedValue: executedByBudgetKey[rubric] || 0,
  }));

  if (unmatchedTotal > 0) {
    lines.push({ activity: 'Outros / Não Classificado', plannedValue: 0, executedValue: unmatchedTotal });
  }

  return lines.sort((a, b) => b.plannedValue - a.plannedValue || b.executedValue - a.executedValue);
}

// ── Login Screen ──────────────────────────────────────────────────────────────

function LoginScreen({ errorParam }: { errorParam: string | null }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="text-center p-10 border border-line rounded-xl bg-card max-w-sm w-full shadow-2xl">
        <img
          src="https://casahacker.org/wp-content/uploads/2023/07/logo_vertical-branco.svg"
          alt="Casa Hacker"
          className="h-12 mx-auto mb-6 invert opacity-90"
        />
        <h1 className="text-2xl font-extrabold tracking-widest uppercase text-primary mb-2">Stack Audit™</h1>
        <p className="text-text-secondary text-[11px] mb-8 uppercase tracking-widest">
          Plataforma de Auditoria com IA
        </p>

        {errorParam === 'domain' && (
          <div className="mb-6 p-3 bg-error/10 border border-error/30 rounded text-[11px] text-error">
            Acesso negado. Utilize uma conta <strong>@casahacker.org</strong>.
          </div>
        )}

        <a href="/auth/google">
          <button className="w-full flex items-center justify-center gap-3 py-3 px-6 bg-white text-gray-800 font-bold text-sm rounded-lg hover:bg-gray-100 transition-all shadow">
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            Entrar com Google Workspace
          </button>
        </a>

        <p className="mt-6 text-[10px] text-text-secondary">
          Acesso restrito ao domínio <strong>@casahacker.org</strong>
        </p>
      </div>
    </div>
  );
}

// ── Share token detection (module-level, stable across renders) ──────────────
const SHARE_TOKEN = (() => {
  const parts = window.location.pathname.split('/share/');
  return parts.length > 1 ? parts[1].split('?')[0] || null : null;
})();

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [activeSection, setActiveSection] = useState<Section>('nova');
  const [files, setFiles] = useState<Record<string, FileData | null>>({
    budget: null, report: null, invoices: null, payments: null,
  });
  const [metadata, setMetadata] = useState({
    organization: '',
    periodStart: '',
    periodEnd: '',
    contractNumber: '',
  });
  const [periodStartError, setPeriodStartError] = useState('');
  const [periodEndError, setPeriodEndError] = useState('');

  const [processingStep, setProcessingStep] = useState(0);
  const [processingMessage, setProcessingMessage] = useState('');
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [lastAuditResult, setLastAuditResult] = useState<AuditResult | null>(null);

  const [history, setHistory] = useState<AuditResult[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [statusFilter, setStatusFilter] = useState<'Todos' | 'Conciliado' | 'Ressalva' | 'Pendente'>('Todos');
  const [rapcSearch, setRapcSearch] = useState('');
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [termsChecked, setTermsChecked] = useState([false, false, false, false]);
  const [selectedItem, setSelectedItem] = useState<AuditItem | null>(null);
  const [relatedItems, setRelatedItems] = useState<any[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [cnpjCache, setCnpjCache] = useState<Record<string, CNPJData | 'error' | null>>({});
  const [cnpjLoading, setCnpjLoading] = useState<Record<string, boolean>>({});
  const [showCnpjPanel, setShowCnpjPanel] = useState(false);
  const [shareAudit, setShareAudit] = useState<AuditResult | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(!!SHARE_TOKEN);
  const [linkCopied, setLinkCopied] = useState(false);

  // ── Auth check ──────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/me')
      .then(r => r.ok ? r.json() : null)
      .then(data => { setUser(data); setAuthLoading(false); })
      .catch(() => setAuthLoading(false));
  }, []);

  // ── Item deep link: ?item=XXXXXXXX ──────────────────────────────────────────
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('item');
    if (!code || !user) return;
    fetch(`/api/items/${code}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        // Load the full audit then open the item modal
        fetch(`/api/audits/${data.auditId}`)
          .then(r => r.ok ? r.json() : null)
          .then(audit => {
            if (audit) setLastAuditResult(audit);
            setSelectedItem(data.item);
            setActiveSection('resultado');
          });
      })
      .catch(() => {});
  }, [user]);

  // ── History API ─────────────────────────────────────────────────────────────
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const r = await fetch('/api/audits');
      if (r.ok) setHistory(await r.json());
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeSection === 'historico' && user) loadHistory();
  }, [activeSection, user, loadHistory]);

  // ── CNPJ lookup ──────────────────────────────────────────────────────────────
  const fetchCnpj = useCallback(async (taxId: string) => {
    const digits = taxId.replace(/\D/g, '');
    if (digits.length !== 14) return;
    if (cnpjCache[digits] !== undefined) return;
    setCnpjLoading(prev => ({ ...prev, [digits]: true }));
    try {
      const r = await fetch(`/api/cnpj/${digits}`);
      if (r.ok) {
        const data = await r.json();
        setCnpjCache(prev => ({ ...prev, [digits]: data }));
      } else {
        setCnpjCache(prev => ({ ...prev, [digits]: 'error' }));
      }
    } catch {
      setCnpjCache(prev => ({ ...prev, [digits]: 'error' }));
    } finally {
      setCnpjLoading(prev => ({ ...prev, [digits]: false }));
    }
  }, [cnpjCache]);

  const retryFetchCnpj = useCallback((taxId: string) => {
    const digits = taxId.replace(/\D/g, '');
    setCnpjCache(prev => { const next = { ...prev }; delete next[digits]; return next; });
  }, []);

  useEffect(() => {
    setShowCnpjPanel(false);
    setRelatedItems([]);
    if (!selectedItem) return;
    if (selectedItem.taxId) fetchCnpj(selectedItem.taxId);
    // Fetch related items across all audits
    const digits = selectedItem.taxId?.replace(/\D/g, '') || '';
    if (digits.length >= 11) {
      setRelatedLoading(true);
      fetch(`/api/audits/related?taxId=${digits}`)
        .then(r => r.ok ? r.json() : [])
        .then(data => setRelatedItems(data))
        .catch(() => setRelatedItems([]))
        .finally(() => setRelatedLoading(false));
    }
  }, [selectedItem]);

  useEffect(() => {
    if (!SHARE_TOKEN) return;
    fetch(`/api/share/${SHARE_TOKEN}`)
      .then(r => r.ok ? r.json() : r.json().then((e: any) => Promise.reject(e.error)))
      .then((data: AuditResult) => setShareAudit(data))
      .catch((e: any) => setShareError(String(e)))
      .finally(() => setShareLoading(false));
  }, []);

  const saveAuditToServer = async (result: AuditResult, budgetCsv: any[]) => {
    try {
      const budgetLines = budgetCsv.length > 0 ? computeBudgetLines(budgetCsv, result.items) : undefined;
      const sourceFiles: Record<string, string> = {};
      if (files.budget) sourceFiles.budget = files.budget.name;
      if (files.report) sourceFiles.report = files.report.name;
      if (files.invoices) sourceFiles.invoices = files.invoices.name;
      if (files.payments) sourceFiles.payments = files.payments.name;

      const fullResult = { ...result, createdBy: user?.email, budgetLines, sourceFiles };

      const fd = new FormData();
      fd.append('result', JSON.stringify(fullResult));
      if (files.budget) {
        fd.append('budget', new Blob([arrayToCsv(files.budget.content as any[])], { type: 'text/csv' }), files.budget.name);
      }
      if (files.report) {
        fd.append('report', new Blob([arrayToCsv(files.report.content as any[])], { type: 'text/csv' }), files.report.name);
      }
      if (files.invoices) {
        fd.append('invoices', base64ToBlob(files.invoices.content as string, 'application/pdf'), files.invoices.name);
      }
      if (files.payments) {
        fd.append('payments', base64ToBlob(files.payments.content as string, 'application/pdf'), files.payments.name);
      }

      const r = await fetch('/api/audits', { method: 'POST', body: fd });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        console.error('Falha ao salvar auditoria no servidor:', err);
        setSaveError('Falha ao salvar a auditoria no servidor. Tente novamente.');
      } else {
        const resp = await r.json();
        const savedSourceFiles = resp.savedFiles || sourceFiles;
        const saved = { ...fullResult, sourceFiles: savedSourceFiles };
        setLastAuditResult(saved);
        setHistory(prev => [{ ...saved, itemCount: saved.items?.length ?? 0 } as any, ...prev]);
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 4000);
      }
    } catch (e) {
      console.error('Falha ao salvar auditoria no servidor:', e);
      setSaveError('Erro de rede ao salvar a auditoria. Verifique sua conexão.');
    }
  };

  const deleteAudit = async (id: string) => {
    if (!confirm('Excluir esta auditoria e todos os arquivos relacionados?')) return;
    await fetch(`/api/audits/${id}`, { method: 'DELETE' });
    setHistory(h => h.filter(a => a.id !== id));
    if (lastAuditResult?.id === id) setLastAuditResult(null);
  };

  // ── Period validation ────────────────────────────────────────────────────────
  const validatePeriodStart = (v: string) => {
    if (!v) { setPeriodStartError(''); return; }
    if (!isValidDate(v)) { setPeriodStartError('Data inválida'); return; }
    if (metadata.periodEnd && isValidDate(metadata.periodEnd) && parseBrDate(v) > parseBrDate(metadata.periodEnd)) {
      setPeriodStartError('Início após o fim');
    } else {
      setPeriodStartError('');
      setPeriodEndError('');
    }
  };
  const validatePeriodEnd = (v: string) => {
    if (!v) { setPeriodEndError(''); return; }
    if (!isValidDate(v)) { setPeriodEndError('Data inválida'); return; }
    if (metadata.periodStart && isValidDate(metadata.periodStart) && parseBrDate(v) < parseBrDate(metadata.periodStart)) {
      setPeriodEndError('Fim antes do início');
    } else {
      setPeriodEndError('');
      setPeriodStartError('');
    }
  };

  const periodValid =
    isValidDate(metadata.periodStart) &&
    isValidDate(metadata.periodEnd) &&
    parseBrDate(metadata.periodStart) <= parseBrDate(metadata.periodEnd);

  // ── File upload ──────────────────────────────────────────────────────────────
  const handleFileUpload = async (slot: string, file: File) => {
    if (file.type === 'text/csv' || file.name.endsWith('.csv')) {
      Papa.parse(file, {
        header: true, skipEmptyLines: true,
        complete: (results) => {
          setFiles(prev => ({ ...prev, [slot]: { id: slot, name: file.name, size: file.size, type: 'csv', content: results.data } }));
        },
      });
    } else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        setFiles(prev => ({ ...prev, [slot]: { id: slot, name: file.name, size: file.size, type: 'pdf', content: base64, pages: 0 } }));
      };
      reader.readAsDataURL(file);
    }
  };

  // ── CSV download ─────────────────────────────────────────────────────────────
  const handleDownloadCSV = () => {
    if (!lastAuditResult) return;
    const header = ['ID', 'Descrição', 'Atividade', 'Data', 'Razão Social', 'ID Doc Fiscal', 'CNPJ/CPF', 'Valor', 'Status', 'Pág NF', 'Pág PG', 'Observações'].join(',');
    const rows = lastAuditResult.items.map(item => [
      item.id,
      `"${String(item.description || '').replace(/"/g, '""')}"`,
      `"${String(item.activity || '').replace(/"/g, '""')}"`,
      `"${String(item.date || '')}"`,
      `"${String(item.entity || '').replace(/"/g, '""')}"`,
      `"${String(item.docId || '')}"`,
      `"${String(item.taxId || '')}"`,
      item.value,
      item.status,
      item.nfPage || '',
      item.paymentPage || '',
      `"${String(item.observations || '').replace(/"/g, '""')}"`
    ].join(','));
    const csvContent = [header, ...rows].join('\n');
    const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `RAPC_${lastAuditResult.contractNumber}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // ── Start audit ──────────────────────────────────────────────────────────────
  const startAudit = async () => {
    if (!files.budget || !files.report || !files.invoices || !files.payments) return;
    setActiveSection('processando');
    setProcessingStep(1);
    setProcessingError(null);
    const budgetCsv = files.budget.content as any[];
    try {
      const result = await processAudit(
        { organization: metadata.organization, periodStart: metadata.periodStart, periodEnd: metadata.periodEnd, contractNumber: metadata.contractNumber },
        budgetCsv,
        files.report.content as any[],
        files.invoices.content as string,
        files.payments.content as string,
        (step, msg) => { setProcessingStep(step); setProcessingMessage(msg); }
      );
      setLastAuditResult(result);
      await saveAuditToServer(result, budgetCsv);
      setProcessingStep(6);
      setTimeout(() => setActiveSection('resultado'), 500);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Erro na análise. Tente novamente.';
      setProcessingError(msg);
    }
  };

  // ── Render guards ─────────────────────────────────────────────────────────────

  // Share mode — fully public, no auth required
  if (SHARE_TOKEN) {
    const sa = shareAudit;
    const shareDiligenced = sa?.items.filter(i => i.status === 'Pendente' || i.status === 'Ressalva') ?? [];
    const shareFiltered = (sa?.items ?? []).filter(item => {
      const matchesStatus = statusFilter === 'Todos' || item.status === statusFilter;
      if (!matchesStatus) return false;
      if (!rapcSearch) return true;
      const q = rapcSearch.toLowerCase();
      return [item.description, item.activity, item.entity, item.docId, item.taxId, item.date, String(item.value), item.status, item.observations]
        .some(v => String(v || '').toLowerCase().includes(q));
    });
    return (
      <div className="min-h-screen bg-bg text-text">
        {/* Share header */}
        <header className="px-10 py-4 border-b border-line flex items-center justify-between bg-sidebar sticky top-0 z-10">
          <div className="flex items-center gap-4">
            <img src="https://casahacker.org/wp-content/uploads/2023/07/logo_vertical-branco.svg" alt="Casa Hacker" className="h-8 w-auto object-contain invert opacity-90" />
            <div className="text-primary font-extrabold text-[11px] tracking-widest uppercase">Stack Audit™</div>
            <span className="text-text-secondary text-[11px] font-mono hidden sm:inline">· Consulta Pública de Auditoria</span>
          </div>
          {sa && (
            <div className="text-[10px] font-mono text-text-secondary">
              ID: {sa.id.slice(0, 8).toUpperCase()} · {new Date(sa.date).toLocaleDateString('pt-BR')}
            </div>
          )}
        </header>

        <main className="px-6 sm:px-8 py-8 pb-24">
          {shareLoading && (
            <div className="flex items-center justify-center py-24">
              <Loader2 className="animate-spin text-primary" size={32} />
            </div>
          )}
          {shareError && (
            <div className="max-w-lg mx-auto mt-16 p-8 border border-error/30 bg-error/5 rounded-xl text-center">
              <AlertCircle size={32} className="text-error mx-auto mb-4" />
              <h2 className="text-sm font-bold uppercase tracking-widest text-error mb-2">Link inválido ou expirado</h2>
              <p className="text-[11px] text-text-secondary font-mono">{shareError}</p>
            </div>
          )}
          {sa && (
            <>
              <VerdictBanner result={sa} />

              {/* Metrics */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 mb-10">
                <MetricCard label="Itens Auditados" value={sa.metrics?.totalItems ?? 0} sub="Extensão total da lista" />
                <MetricCard label="Itens Conciliados" value={sa.metrics?.conciliatedItems ?? 0} sub="Conformidade absoluta" />
                <MetricCard label="Pendências / Ressalvas" value={shareDiligenced.length} sub="Exige atenção manual" color="amber" />
                <MetricCard label="Valor Auditado" value={formatCurrency(sa.metrics?.totalValue ?? 0)} sub="Volume Executado" />
              </div>

              {/* Budget by line */}
              <div className="bg-card p-6 border border-line rounded mb-10">
                <div className="flex justify-between items-center mb-6 flex-wrap gap-3">
                  <h3 className="text-xs font-bold uppercase tracking-widest text-text-secondary">
                    Execução Orçamentária por Linha (Planejado × Executado)
                  </h3>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-3 text-[10px] text-text-secondary">
                      <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-primary inline-block" /> Executado</span>
                      <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-line inline-block" /> Disponível</span>
                      <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-error inline-block" /> Excedido</span>
                    </div>
                    {(sa.metrics?.totalValue ?? 0) > (sa.metrics?.approvedValue ?? 0) ? (
                      <div className="bg-error/10 text-error border border-error/20 px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded flex items-center gap-1.5">
                        <AlertCircle size={12} /> Orçamento Extrapolado
                      </div>
                    ) : (
                      <div className="bg-success/10 text-success border border-success/20 px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded">
                        ✓ Dentro do Limite Aprovado
                      </div>
                    )}
                  </div>
                </div>
                {sa.budgetLines && sa.budgetLines.length > 0 ? (
                  <BudgetLineChart lines={sa.budgetLines} />
                ) : (
                  <BudgetLineChart lines={
                    Object.entries(
                      sa.items.reduce((acc: Record<string, number>, item) => {
                        const act = item.activity || 'Não Classificado';
                        acc[act] = (acc[act] || 0) + (item.value || 0);
                        return acc;
                      }, {})
                    ).map(([activity, executedValue]) => ({ activity, plannedValue: 0, executedValue }))
                      .sort((a, b) => b.executedValue - a.executedValue)
                  } />
                )}
                <div className="mt-6 pt-4 border-t border-line">
                  <div className="flex justify-between items-center mb-2 flex-wrap gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-widest text-text-secondary">Total Geral</span>
                    <div className="flex gap-6 text-[11px] font-mono flex-wrap">
                      <span className="text-text-secondary">Aprovado: <span className="text-text font-bold">{formatCurrency(sa.metrics?.approvedValue ?? 0)}</span></span>
                      <span className="text-text-secondary">Executado: <span className={cn('font-bold', (sa.metrics?.totalValue ?? 0) > (sa.metrics?.approvedValue ?? 0) ? 'text-error' : 'text-primary')}>{formatCurrency(sa.metrics?.totalValue ?? 0)}</span></span>
                      <span className="text-text-secondary">Saldo: <span className={cn('font-bold', (sa.metrics?.approvedValue ?? 0) - (sa.metrics?.totalValue ?? 0) < 0 ? 'text-error' : 'text-success')}>{formatCurrency((sa.metrics?.approvedValue ?? 0) - (sa.metrics?.totalValue ?? 0))}</span></span>
                    </div>
                  </div>
                  <div className="h-3 w-full bg-line rounded-full overflow-hidden">
                    <div
                      className={cn('h-full transition-all duration-1000 rounded-full', (sa.metrics?.totalValue ?? 0) > (sa.metrics?.approvedValue ?? 0) ? 'bg-error' : 'bg-primary')}
                      style={{ width: `${Math.min(((sa.metrics?.totalValue ?? 0) / (sa.metrics?.approvedValue || 1)) * 100, 100)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[9px] font-mono text-text-secondary mt-1">
                    <span>0%</span>
                    <span className={cn('font-bold', (sa.metrics?.totalValue ?? 0) > (sa.metrics?.approvedValue ?? 0) ? 'text-error' : '')}>
                      {((sa.metrics?.totalValue ?? 0) / (sa.metrics?.approvedValue || 1) * 100).toFixed(1)}% executado
                    </span>
                    <span>100% (Aprovado)</span>
                  </div>
                </div>
              </div>

              {/* RAPC Table */}
              <div className="bg-card border border-line rounded overflow-hidden mb-10">
                <div className="px-6 py-4 border-b border-line flex justify-between items-center bg-bg/50 flex-wrap gap-3">
                  <h3 className="text-xs font-bold uppercase tracking-widest flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary" />Relatório de Conciliação (RAPC)
                  </h3>
                  <div className="flex gap-3 flex-wrap">
                    <div className="relative">
                      <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none" />
                      <input type="text" value={rapcSearch} onChange={e => setRapcSearch(e.target.value)} placeholder="Buscar lançamento..." className="pl-7 pr-3 py-1.5 text-[11px] bg-sidebar border border-line rounded focus:outline-none focus:border-primary transition-colors w-48 text-text placeholder:text-text-secondary/50" />
                      {rapcSearch && <button onClick={() => setRapcSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text"><X size={11} /></button>}
                    </div>
                    <div className="flex gap-1 border border-line rounded p-1 bg-bg/50">
                      {['Todos', 'Conciliado', 'Ressalva', 'Pendente'].map(s => (
                        <button key={s} onClick={() => setStatusFilter(s as any)} className={cn('px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded transition-all', statusFilter === s ? 'bg-primary text-white' : 'text-text-secondary hover:text-text')}>{s}</button>
                      ))}
                    </div>
                  </div>
                </div>
                {rapcSearch && <div className="px-6 py-2 bg-primary/5 border-b border-line text-[10px] text-primary font-mono">{shareFiltered.length} resultado{shareFiltered.length !== 1 ? 's' : ''} para "{rapcSearch}"</div>}
                <div className="overflow-x-auto custom-scrollbar">
                  <table className="w-full text-left text-[11px] border-collapse">
                    <thead className="bg-sidebar text-text-secondary uppercase text-[10px] tracking-tighter">
                      <tr className="border-b border-line">
                        {['#', 'Descrição', 'Atividade', 'Data', 'Razão Social', 'ID Doc Fiscal', 'CNPJ/CPF', 'Valor', 'Status', 'Pág NF', 'Pág PG', 'Observações'].map((h, i) => (
                          <th key={i} className={cn('px-4 py-3 font-semibold border-r border-line', h === 'Valor' && 'text-right', ['Data', 'Status', 'Pág NF', 'Pág PG'].includes(h) && 'text-center')}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line font-mono">
                      {shareFiltered.map((item, idx) => (
                        <tr key={idx} onClick={() => setSelectedItem(item)} className={cn('hover:bg-primary/5 transition-colors cursor-pointer', item.status === 'Ressalva' && 'bg-warning/5', item.status === 'Pendente' && 'bg-error/5')}>
                          <td className="px-4 py-2.5 text-text-secondary border-r border-line uppercase">{item.id || idx + 1}</td>
                          <td className="px-4 py-2.5 border-r border-line max-w-[200px] truncate uppercase">{item.description}</td>
                          <td className="px-4 py-2.5 border-r border-line text-text-secondary uppercase">{item.activity}</td>
                          <td className="px-4 py-2.5 border-r border-line text-center whitespace-nowrap">{item.date}</td>
                          <td className="px-4 py-2.5 border-r border-line uppercase">{item.entity}</td>
                          <td className="px-4 py-2.5 border-r border-line">{item.docId}</td>
                          <td className="px-4 py-2.5 border-r border-line">{item.taxId}</td>
                          <td className="px-4 py-2.5 border-r border-line text-right">{formatCurrency(item.value)}</td>
                          <td className="px-4 py-2.5 border-r border-line text-center">
                            <span className={cn('px-2 py-0.5 text-[9px] font-bold rounded-full uppercase', item.status === 'Conciliado' ? 'bg-success/20 text-success' : item.status === 'Ressalva' ? 'bg-warning/20 text-warning' : 'bg-error/20 text-error')}>{item.status}</span>
                          </td>
                          <td className="px-4 py-2.5 border-r border-line text-center text-text-secondary">{item.nfPage || '—'}</td>
                          <td className="px-4 py-2.5 border-r border-line text-center text-text-secondary">{item.paymentPage || '—'}</td>
                          <td className="px-4 py-2.5 text-text-secondary max-w-[200px] truncate uppercase">{item.observations}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Lançamentos Diligenciados */}
              <div className="bg-card p-6 rounded border border-line mb-10">
                <h3 className="text-xs font-bold uppercase tracking-widest mb-6 flex items-center gap-2">
                  <AlertCircle size={14} className="text-warning" />
                  Lançamentos Diligenciados
                  {shareDiligenced.length > 0 && (
                    <span className="ml-2 bg-warning/20 text-warning text-[10px] font-bold px-2 py-0.5 rounded-full border border-warning/30">{shareDiligenced.length}</span>
                  )}
                </h3>
                {shareDiligenced.length > 0 ? (
                  <div className="space-y-3">
                    {shareDiligenced.map((item, i) => (
                      <div key={i} onClick={() => setSelectedItem(item)} className={cn('p-4 border rounded flex gap-4 cursor-pointer hover:border-primary/40 transition-all', item.status === 'Pendente' ? 'bg-error/5 border-error/20' : 'bg-warning/5 border-warning/20')}>
                        <div className={cn('text-[10px] font-mono font-bold px-2 py-1 h-fit border rounded shrink-0 uppercase', item.status === 'Pendente' ? 'bg-error/10 text-error border-error/30' : 'bg-warning/10 text-warning border-warning/30')}>#{item.id} · {item.status}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-4 mb-1">
                            <p className="text-xs text-text font-semibold truncate uppercase">{item.description}</p>
                            <span className="text-[11px] font-mono font-bold text-text shrink-0">{formatCurrency(item.value)}</span>
                          </div>
                          <div className="flex gap-4 text-[10px] text-text-secondary font-mono mb-2 uppercase">
                            <span>{item.activity}</span><span>&bull;</span><span>{item.date}</span><span>&bull;</span><span>{item.entity}</span>
                          </div>
                          <p className="text-[11px] text-text-secondary leading-relaxed uppercase">{item.observations}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-10 text-text-secondary text-xs uppercase tracking-widest border border-dashed border-line rounded">
                    Integridade de Dados 100% — Nenhum lançamento diligenciado
                  </div>
                )}
              </div>
            </>
          )}

          {/* Footer */}
          <div className="border-t border-line pt-6 text-center text-[10px] text-text-secondary font-mono">
            Auditoria gerada pela plataforma <span className="text-primary font-bold">Stack Audit™</span> · Casa Hacker &bull; Este link é público e foi compartilhado pela equipe auditora.
          </div>
        </main>

        {/* Item detail modal (reused) */}
        {selectedItem && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setSelectedItem(null)}>
            <div className="bg-card border border-line rounded-xl w-full max-w-5xl max-h-[92vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between px-6 py-4 border-b border-line sticky top-0 bg-card z-10">
                <div className="flex items-center gap-3">
                  <h2 className="text-xs font-bold uppercase tracking-widest">Apuração Stack Audit™ — Lançamento #{selectedItem.id}</h2>
                  {selectedItem.itemCode && (
                    <button
                      onClick={() => {
                        const url = `${window.location.origin}/?item=${selectedItem.itemCode}`;
                        navigator.clipboard.writeText(url);
                      }}
                      className="flex items-center gap-1.5 px-2 py-1 bg-sidebar border border-line hover:border-primary text-[10px] font-mono font-bold text-text-secondary hover:text-primary transition-all rounded"
                      title="Copiar link direto deste lançamento"
                    >
                      <Link2 size={10} />
                      {selectedItem.itemCode}
                    </button>
                  )}
                </div>
                <button onClick={() => setSelectedItem(null)} className="p-1 hover:text-primary transition-colors"><X size={16} /></button>
              </div>
              <div className="p-6 text-[11px] font-mono space-y-1">
                {([
                  ['Descrição', selectedItem.description],
                  ['Atividade / Rubrica', selectedItem.activity],
                  ['Data', selectedItem.date],
                  ['Fornecedor', selectedItem.entity],
                  ['ID Doc Fiscal', selectedItem.docId],
                  ['CNPJ / CPF', selectedItem.taxId],
                  ['Valor', formatCurrency(selectedItem.value)],
                  ['Status', selectedItem.status],
                  ['Pág. Nota Fiscal', selectedItem.nfPage],
                  ['Pág. Comprovante', selectedItem.paymentPage],
                  ...(selectedItem.emissionDateTime ? [['Data/Hora Emissão', selectedItem.emissionDateTime]] : []),
                  ...(selectedItem.serviceDescription ? [['Descrição do Serviço/Produto', selectedItem.serviceDescription]] : []),
                  ...(selectedItem.taxInfo ? [['CNAEs / Inf. Tributárias', selectedItem.taxInfo]] : []),
                  ...(selectedItem.paymentDateTime ? [['Data/Hora Pagamento', selectedItem.paymentDateTime]] : []),
                  ...(selectedItem.transactionId ? [['ID da Transação', selectedItem.transactionId]] : []),
                  ...(selectedItem.payerInfo ? [['Pagador', selectedItem.payerInfo]] : []),
                  ...(selectedItem.payeeInfo ? [['Recebedor / Beneficiário', selectedItem.payeeInfo]] : []),
                  ...(selectedItem.paymentMethod ? [['Meio de Pagamento', selectedItem.paymentMethod]] : []),
                ] as [string, any][]).map(([label, value]) => value && (
                  <div key={label} className="grid grid-cols-[180px_1fr] gap-2 py-1.5 border-b border-line/30">
                    <span className="text-text-secondary uppercase">{label}</span>
                    <span className="text-text font-semibold uppercase">{value}</span>
                  </div>
                ))}
                {selectedItem.observations && (
                  <div className="mt-4 p-3 bg-warning/5 border border-warning/20 rounded text-warning text-[11px] uppercase">{selectedItem.observations}</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <Loader2 className="animate-spin text-primary" size={32} />
      </div>
    );
  }

  const errorParam = new URLSearchParams(window.location.search).get('error');
  if (!user) return <LoginScreen errorParam={errorParam} />;

  const canStartAudit = !!files.budget && !!files.report && !!files.invoices && !!files.payments && !!metadata.organization && !!metadata.contractNumber && periodValid;

  // ── Computed data ─────────────────────────────────────────────────────────────
  const diligencedItems = lastAuditResult?.items.filter(i => i.status === 'Pendente' || i.status === 'Ressalva') ?? [];

  const filteredItems = (lastAuditResult?.items ?? []).filter(item => {
    const matchesStatus = statusFilter === 'Todos' || item.status === statusFilter;
    if (!matchesStatus) return false;
    if (!rapcSearch) return true;
    const q = rapcSearch.toLowerCase();
    return [item.description, item.activity, item.entity, item.docId, item.taxId, item.date, String(item.value), item.status, item.nfPage, item.paymentPage, item.observations]
      .some(v => String(v || '').toLowerCase().includes(q));
  });

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="fixed left-0 top-0 h-full w-[180px] bg-sidebar border-r border-line flex flex-col z-50">
        <div className="pt-6 pb-8 px-5 flex flex-col gap-4">
          <img src="https://casahacker.org/wp-content/uploads/2023/07/logo_vertical-branco.svg" alt="Casa Hacker" className="h-10 w-auto object-contain object-left invert opacity-90" />
          <div className="text-primary font-extrabold text-[11px] tracking-widest uppercase">Stack Audit</div>
        </div>

        <nav className="flex-1 px-0 space-y-0">
          {[
            { id: 'nova', label: 'Nova análise', icon: PlusCircle },
            { id: 'processando', label: 'Processando', icon: Loader2 },
            { id: 'resultado', label: 'Resultado', icon: FileText },
            { id: 'historico', label: 'Histórico', icon: History },
            { id: 'documentacao', label: 'Documentação', icon: BookOpen },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => (item.id === 'processando' || item.id === 'resultado') && !lastAuditResult ? null : setActiveSection(item.id as Section)}
              disabled={(item.id === 'processando' || item.id === 'resultado') && !lastAuditResult}
              className={cn(
                'w-full flex items-center gap-3 px-5 py-3 text-[13px] transition-all duration-200 border-l-3 border-transparent',
                activeSection === item.id ? 'bg-sidebar-active text-primary border-l-primary' : 'text-text-secondary hover:text-text hover:bg-white/5',
                (item.id === 'processando' || item.id === 'resultado') && !lastAuditResult && 'opacity-25 cursor-not-allowed'
              )}
            >
              <item.icon size={16} className={cn('shrink-0', activeSection === item.id ? 'text-primary' : 'opacity-70')} />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="px-4 py-4 border-t border-line">
          {user.photo && <img src={user.photo} alt={user.name} className="w-7 h-7 rounded-full mb-2" />}
          <p className="text-[10px] text-text-secondary truncate">{user.email}</p>
          <a href="/auth/logout" className="mt-2 flex items-center gap-1.5 text-[10px] text-text-secondary hover:text-primary transition-colors">
            <LogOut size={11} /> Sair
          </a>
        </div>
      </aside>

      {/* Main Content */}
      <main className="ml-[180px] flex-1 min-w-[844px] flex flex-col">
        {/* Header */}
        <header className="px-10 py-6 border-bottom border-line flex justify-between items-center bg-bg shrink-0">
          <h1 className="text-[20px] font-light">
            Configuração de <span className="font-bold text-primary">Nova Auditoria</span>
          </h1>
          <div className="text-[11px] bg-sidebar-active px-3 py-1.5 rounded border border-primary text-primary font-bold tracking-widest">
            Stack Audit™
          </div>
        </header>

        {/* Metadata strip */}
        <div className="grid grid-cols-4 gap-6 px-10 py-4 bg-card border-b border-line shrink-0">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase text-text-secondary tracking-widest">Organização</label>
            <span className="font-mono text-[13px] text-primary">{metadata.organization || '---'}</span>
          </div>
          <div className="flex flex-col gap-1 col-span-2">
            <label className="text-[10px] uppercase text-text-secondary tracking-widest">Período Auditado</label>
            <span className="font-mono text-[13px] text-primary">
              {metadata.periodStart && metadata.periodEnd ? `${metadata.periodStart} → ${metadata.periodEnd}` : '---'}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase text-text-secondary tracking-widest">Nº Contrato</label>
            <span className="font-mono text-[13px] text-primary">{metadata.contractNumber || '---'}</span>
          </div>
        </div>

        {/* ── NOVA ───────────────────────────────────────────────────────────── */}
        {activeSection === 'nova' && (
          <section className="px-10 py-8 grid grid-cols-[1fr_300px] gap-10 animate-in fade-in slide-in-from-bottom-4 duration-500 overflow-y-auto pb-24">
            <div className="space-y-8">
              <div>
                <h2 className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary mb-4">Grupo A — Planilhas CSV (2 arquivos)</h2>
                <div className="grid grid-cols-2 gap-4">
                  <UploadSlot label="CSV · Orçamento aprovado" description="Rubricas e valores autorizados" file={files.budget} onFileSelect={(f) => handleFileUpload('budget', f)} />
                  <UploadSlot label="CSV · Prestação de contas" description="Lançamentos realizados pelo proponente" file={files.report} onFileSelect={(f) => handleFileUpload('report', f)} />
                </div>
              </div>
              <div>
                <h2 className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary mb-4">Grupo B — Documentos fiscais (2 arquivos)</h2>
                <div className="grid grid-cols-2 gap-4">
                  <UploadSlot label="PDF · Notas Fiscais" description="NFS-e, NF-e, recibos mesclados" file={files.invoices} onFileSelect={(f) => handleFileUpload('invoices', f)} />
                  <UploadSlot label="PDF · Comprovantes" description="Extratos e comprovantes bancários" file={files.payments} onFileSelect={(f) => handleFileUpload('payments', f)} />
                </div>
              </div>

              <div className="bg-sidebar border border-line rounded-xl p-6">
                <div className="text-[10px] uppercase opacity-50 mb-4 tracking-widest">Lógica de Cruzamento de Dados (Quad Check)</div>
                <div className="relative flex justify-between items-center h-4 mx-2">
                  <div className="absolute top-1/2 left-0 right-0 h-[1px] bg-line -translate-y-1/2 z-0" />
                  <div className={cn('absolute top-1/2 left-0 h-[1px] bg-primary -translate-y-1/2 z-0 transition-all duration-500',
                    files.budget && files.report && files.invoices && files.payments ? 'w-full' :
                    files.budget && files.report && files.invoices ? 'w-2/3' :
                    files.budget && files.report ? 'w-1/3' : 'w-0'
                  )} />
                  {(['budget', 'report', 'invoices', 'payments'] as const).map(s => (
                    <div key={s} className={cn('w-4 h-4 rounded-full border-2 bg-bg z-10 transition-colors', files[s] ? 'border-primary' : 'border-line')} />
                  ))}
                </div>
                <div className="flex justify-between mt-3 text-[9px] uppercase text-text-secondary">
                  <span>Rubrica Aprovada</span><span>Lançamento Declarado</span><span>Documento Fiscal</span><span>Pagamento Efetuado</span>
                </div>
                <p className="mt-6 text-[11px] text-text-secondary italic leading-relaxed">
                  * O Stack Audit™ verificará individualmente cada lançamento dos CSVs contra as evidências PDF.
                </p>
              </div>
            </div>

            <div className="space-y-8">
              <div className="bg-card border border-line rounded-xl p-6 h-fit">
                <h3 className="text-[14px] font-bold mb-6">Checklist de Conformidade</h3>
                <div className="space-y-4">
                  <CheckItem label="Rubricas carregadas" checked={!!files.budget} />
                  <CheckItem label="Planilha proponente OK" checked={!!files.report} />
                  <CheckItem label="Evidências fiscais detectadas" checked={!!files.invoices} />
                  <CheckItem label="Comprovantes bancários OK" checked={!!files.payments} />
                  <CheckItem label="Metadados do contrato" checked={!!metadata.organization && !!metadata.contractNumber && periodValid} />
                </div>

                <button
                  onClick={() => { setTermsChecked([false, false, false, false]); setShowTermsModal(true); }}
                  disabled={!canStartAudit}
                  className={cn(
                    'w-full mt-8 py-4 rounded-lg font-bold text-xs uppercase tracking-widest transition-all',
                    canStartAudit ? 'bg-primary text-bg shadow-lg hover:scale-[1.02]' : 'bg-line text-text-secondary opacity-50 cursor-not-allowed'
                  )}
                >
                  Iniciar Stack Audit™ →
                </button>
                <p className="mt-4 text-[10px] text-text-secondary text-center leading-relaxed">
                  Preencha todos os slots e metadados para habilitar o Stack Audit™.
                </p>
              </div>

              <div className="space-y-4">
                <label className="text-[10px] uppercase text-text-secondary tracking-widest px-1">Configurar Metadados</label>
                <div className="space-y-3">
                  <InputGroup label="Organização" value={metadata.organization} onChange={(v) => setMetadata({ ...metadata, organization: v })} placeholder="Nome da organização" />

                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase tracking-widest text-text-secondary px-1">Início do Período</label>
                    <input
                      type="text"
                      maxLength={10}
                      value={metadata.periodStart}
                      onChange={(e) => {
                        let v = e.target.value.replace(/\D/g, '');
                        if (v.length > 2) v = v.slice(0,2) + '/' + v.slice(2);
                        if (v.length > 5) v = v.slice(0,5) + '/' + v.slice(5);
                        setMetadata({ ...metadata, periodStart: v });
                      }}
                      onBlur={(e) => validatePeriodStart(e.target.value)}
                      placeholder="DD/MM/AAAA"
                      className={cn(
                        'w-full bg-sidebar border rounded px-3 py-2 text-[12px] font-mono text-text placeholder:text-text-secondary/40 focus:outline-none focus:border-primary transition-colors',
                        periodStartError ? 'border-error' : 'border-line'
                      )}
                    />
                    {periodStartError && <p className="text-[10px] text-error px-1">{periodStartError}</p>}
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase tracking-widest text-text-secondary px-1">Fim do Período</label>
                    <input
                      type="text"
                      maxLength={10}
                      value={metadata.periodEnd}
                      onChange={(e) => {
                        let v = e.target.value.replace(/\D/g, '');
                        if (v.length > 2) v = v.slice(0,2) + '/' + v.slice(2);
                        if (v.length > 5) v = v.slice(0,5) + '/' + v.slice(5);
                        setMetadata({ ...metadata, periodEnd: v });
                      }}
                      onBlur={(e) => validatePeriodEnd(e.target.value)}
                      placeholder="DD/MM/AAAA"
                      className={cn(
                        'w-full bg-sidebar border rounded px-3 py-2 text-[12px] font-mono text-text placeholder:text-text-secondary/40 focus:outline-none focus:border-primary transition-colors',
                        periodEndError ? 'border-error' : 'border-line'
                      )}
                    />
                    {periodEndError && <p className="text-[10px] text-error px-1">{periodEndError}</p>}
                  </div>

                  <InputGroup label="Nº Contrato" value={metadata.contractNumber} onChange={(v) => setMetadata({ ...metadata, contractNumber: v })} placeholder="#2024.01" />
                </div>
              </div>
            </div>
          </section>
        )}

        {/* ── PROCESSANDO ────────────────────────────────────────────────────── */}
        {activeSection === 'processando' && (
          <section className="px-10 py-20 max-w-4xl mx-auto flex-1 animate-in fade-in zoom-in-95 duration-500">
            <div className="text-center mb-16">
              <h1 className="text-3xl font-bold tracking-tighter mb-4 uppercase">Auditoria em execução</h1>
              <p className="text-text-secondary text-sm">O Stack Audit™ está cruzando 4 camadas de dados para cada lançamento financeiro.</p>
            </div>
            <div className="mb-16">
              <div className="h-1 w-full bg-line rounded-full overflow-hidden mb-4">
                <div className="h-full bg-primary transition-all duration-500 ease-out shadow-[0_0_10px_#7ee8c0]" style={{ width: `${(processingStep / 5) * 100}%` }} />
              </div>
              <div className="flex justify-between text-[10px] text-text-secondary font-mono tracking-widest">
                <span>ESTADO DO PROCESSO</span>
                <span>{Math.round((processingStep / 5) * 100)}% CONCLUÍDO</span>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3">
              <ProcessStep step={1} current={processingStep} label="Leitura e indexação dos arquivos" />
              <ProcessStep step={2} current={processingStep} label="Extração de texto dos documentos PDF" />
              <ProcessStep step={3} current={processingStep} label="Verificação quádrupla por lançamento" />
              <ProcessStep step={4} current={processingStep} label="Geração do RAPC e parecer final" />
              <ProcessStep step={5} current={processingStep} label="Formatando o relatório em tela" />
            </div>
            <div className="mt-12 p-3 bg-sidebar border border-line rounded italic text-center">
              {processingError ? (
                <div className="space-y-4">
                  <span className="text-[10px] font-mono text-error uppercase tracking-widest block">Falha no Processamento</span>
                  <p className="text-xs text-text-secondary mb-4">{processingError}</p>
                  <button onClick={() => setActiveSection('nova')} className="px-4 py-2 bg-primary text-white text-[10px] uppercase tracking-widest rounded hover:bg-blue-700 transition-colors">
                    Voltar e tentar novamente
                  </button>
                </div>
              ) : (
                <span className="text-[10px] font-mono text-primary animate-pulse">{processingMessage || 'Aguardando sistema...'}</span>
              )}
            </div>
          </section>
        )}

        {/* ── RESULTADO ──────────────────────────────────────────────────────── */}
        {activeSection === 'resultado' && lastAuditResult && (
          <section className="px-10 py-8 animate-in fade-in slide-in-from-right-4 duration-500 overflow-y-auto pb-24">
            <VerdictBanner result={lastAuditResult} />

            {/* Share link bar */}
            {lastAuditResult.shareToken && (
              <div className="flex items-center justify-between gap-4 mb-8 px-5 py-3 bg-card border border-line rounded-lg">
                <div className="flex items-center gap-3 min-w-0">
                  <Link2 size={14} className="text-primary shrink-0" />
                  <span className="text-[11px] text-text-secondary font-mono truncate">
                    {`${window.location.origin}/share/${lastAuditResult.shareToken}`}
                  </span>
                </div>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/share/${lastAuditResult.shareToken}`);
                    setLinkCopied(true);
                    setTimeout(() => setLinkCopied(false), 2000);
                  }}
                  className={cn(
                    'shrink-0 flex items-center gap-2 px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded border transition-all',
                    linkCopied
                      ? 'border-success/40 bg-success/10 text-success'
                      : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20'
                  )}
                >
                  <Link2 size={11} />
                  {linkCopied ? 'Copiado!' : 'Copiar link público'}
                </button>
              </div>
            )}

            {/* Metrics */}
            <div className="grid grid-cols-4 gap-6 mb-10">
              <MetricCard label="Itens Auditados" value={lastAuditResult.metrics?.totalItems ?? 0} sub="Extensão total da lista" />
              <MetricCard label="Itens Conciliados" value={lastAuditResult.metrics?.conciliatedItems ?? 0} sub="Conformidade absoluta" />
              <MetricCard label="Pendências / Ressalvas" value={diligencedItems.length} sub="Exige atenção manual" color="amber" />
              <MetricCard label="Valor Auditado" value={formatCurrency(lastAuditResult.metrics?.totalValue ?? 0)} sub="Volume Executado" />
            </div>

            {/* Budget by line */}
            <div className="bg-card p-6 border border-line rounded mb-10">
              <div className="flex justify-between items-center mb-6 flex-wrap gap-3">
                <h3 className="text-xs font-bold uppercase tracking-widest text-text-secondary">
                  Execução Orçamentária por Linha (Planejado × Executado)
                </h3>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-3 text-[10px] text-text-secondary">
                    <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-primary inline-block" /> Executado</span>
                    <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-line inline-block" /> Disponível</span>
                    <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-error inline-block" /> Excedido</span>
                  </div>
                  {(lastAuditResult.metrics?.totalValue ?? 0) > (lastAuditResult.metrics?.approvedValue ?? 0) ? (
                    <div className="bg-error/10 text-error border border-error/20 px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded flex items-center gap-1.5">
                      <AlertCircle size={12} /> Orçamento Extrapolado
                    </div>
                  ) : (
                    <div className="bg-success/10 text-success border border-success/20 px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded">
                      ✓ Dentro do Limite Aprovado
                    </div>
                  )}
                </div>
              </div>

              {lastAuditResult.budgetLines && lastAuditResult.budgetLines.length > 0 ? (
                <BudgetLineChart lines={lastAuditResult.budgetLines} />
              ) : (
                <BudgetLineChart lines={
                  Object.entries(
                    lastAuditResult.items.reduce((acc: Record<string, number>, item) => {
                      const act = item.activity || 'Não Classificado';
                      acc[act] = (acc[act] || 0) + (item.value || 0);
                      return acc;
                    }, {})
                  ).map(([activity, executedValue]) => ({ activity, plannedValue: 0, executedValue }))
                    .sort((a, b) => b.executedValue - a.executedValue)
                } />
              )}

              {/* Total summary */}
              <div className="mt-6 pt-4 border-t border-line">
                <div className="flex justify-between items-center mb-2 flex-wrap gap-2">
                  <span className="text-[11px] font-bold uppercase tracking-widest text-text-secondary">Total Geral</span>
                  <div className="flex gap-6 text-[11px] font-mono flex-wrap">
                    <span className="text-text-secondary">Aprovado: <span className="text-text font-bold">{formatCurrency(lastAuditResult.metrics?.approvedValue ?? 0)}</span></span>
                    <span className="text-text-secondary">Executado: <span className={cn('font-bold', (lastAuditResult.metrics?.totalValue ?? 0) > (lastAuditResult.metrics?.approvedValue ?? 0) ? 'text-error' : 'text-primary')}>{formatCurrency(lastAuditResult.metrics?.totalValue ?? 0)}</span></span>
                    <span className="text-text-secondary">Saldo: <span className={cn('font-bold', (lastAuditResult.metrics?.approvedValue ?? 0) - (lastAuditResult.metrics?.totalValue ?? 0) < 0 ? 'text-error' : 'text-success')}>{formatCurrency((lastAuditResult.metrics?.approvedValue ?? 0) - (lastAuditResult.metrics?.totalValue ?? 0))}</span></span>
                  </div>
                </div>
                <div className="h-3 w-full bg-line rounded-full overflow-hidden">
                  <div
                    className={cn('h-full transition-all duration-1000 rounded-full', (lastAuditResult.metrics?.totalValue ?? 0) > (lastAuditResult.metrics?.approvedValue ?? 0) ? 'bg-error' : 'bg-primary')}
                    style={{ width: `${Math.min(((lastAuditResult.metrics?.totalValue ?? 0) / (lastAuditResult.metrics?.approvedValue || 1)) * 100, 100)}%` }}
                  />
                </div>
                <div className="flex justify-between text-[9px] font-mono text-text-secondary mt-1">
                  <span>0%</span>
                  <span className={cn('font-bold', (lastAuditResult.metrics?.totalValue ?? 0) > (lastAuditResult.metrics?.approvedValue ?? 0) ? 'text-error' : '')}>
                    {((lastAuditResult.metrics?.totalValue ?? 0) / (lastAuditResult.metrics?.approvedValue || 1) * 100).toFixed(1)}% executado
                  </span>
                  <span>100% (Aprovado)</span>
                </div>
              </div>
            </div>

            {/* RAPC Table */}
            <div className="bg-card border border-line rounded overflow-hidden mb-10">
              <div className="px-6 py-4 border-b border-line flex justify-between items-center bg-bg/50 flex-wrap gap-3">
                <h3 className="text-xs font-bold uppercase tracking-widest flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary" />Relatório de Conciliação (RAPC)
                </h3>
                <div className="flex gap-3 flex-wrap">
                  {/* Search */}
                  <div className="relative">
                    <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none" />
                    <input
                      type="text"
                      value={rapcSearch}
                      onChange={e => setRapcSearch(e.target.value)}
                      placeholder="Buscar lançamento..."
                      className="pl-7 pr-3 py-1.5 text-[11px] bg-sidebar border border-line rounded focus:outline-none focus:border-primary transition-colors w-48 text-text placeholder:text-text-secondary/50"
                    />
                    {rapcSearch && (
                      <button onClick={() => setRapcSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text">
                        <X size={11} />
                      </button>
                    )}
                  </div>
                  {/* Status filter */}
                  <div className="flex gap-1 border border-line rounded p-1 bg-bg/50">
                    {['Todos', 'Conciliado', 'Ressalva', 'Pendente'].map(s => (
                      <button key={s} onClick={() => setStatusFilter(s as any)} className={cn('px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded transition-all', statusFilter === s ? 'bg-primary text-white' : 'text-text-secondary hover:text-text')}>
                        {s}
                      </button>
                    ))}
                  </div>
                  <button onClick={handleDownloadCSV} className="flex items-center gap-2 px-3 py-1.5 bg-sidebar border border-line hover:border-primary text-[10px] font-bold uppercase tracking-widest transition-all">
                    <Download size={12} /> CSV
                  </button>
                </div>
              </div>
              {rapcSearch && (
                <div className="px-6 py-2 bg-primary/5 border-b border-line text-[10px] text-primary font-mono">
                  {filteredItems.length} resultado{filteredItems.length !== 1 ? 's' : ''} para "{rapcSearch}"
                </div>
              )}
              <div className="overflow-x-auto custom-scrollbar">
                <table className="w-full text-left text-[11px] border-collapse">
                  <thead className="bg-sidebar text-text-secondary uppercase text-[10px] tracking-tighter">
                    <tr className="border-b border-line">
                      {['#', 'Código', 'Descrição', 'Atividade', 'Data', 'Razão Social', 'ID Doc Fiscal', 'CNPJ/CPF', 'Valor', 'Status', 'Pág NF', 'Pág PG', 'Observações'].map((h, i) => (
                        <th key={i} className={cn('px-4 py-3 font-semibold border-r border-line', h === 'Valor' && 'text-right', ['Data', 'Status', 'Pág NF', 'Pág PG'].includes(h) && 'text-center')}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line font-mono">
                    {filteredItems.map((item, idx) => (
                      <tr key={idx} onClick={() => setSelectedItem(item)} className={cn('hover:bg-primary/5 transition-colors cursor-pointer', item.status === 'Ressalva' && 'bg-warning/5', item.status === 'Pendente' && 'bg-error/5')}>
                        <td className="px-4 py-2.5 text-text-secondary border-r border-line uppercase">{item.id || idx + 1}</td>
                        <td className="px-2 py-2.5 border-r border-line/20" onClick={e => e.stopPropagation()}>
                          {item.itemCode && (
                            <button
                              onClick={() => navigator.clipboard.writeText(`${window.location.origin}/?item=${item.itemCode}`)}
                              className="flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-mono bg-sidebar border border-line hover:border-primary text-text-secondary hover:text-primary transition-all rounded"
                              title="Copiar link deste lançamento"
                            >
                              <Link2 size={9} />{item.itemCode}
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-text border-r border-line/20 font-sans uppercase">{item.description}</td>
                        <td className="px-4 py-2.5 text-text-secondary border-r border-line/20 font-sans uppercase">{item.activity}</td>
                        <td className="px-4 py-2.5 text-center whitespace-nowrap border-r border-line/20 uppercase">{item.date}</td>
                        <td className="px-4 py-2.5 border-r border-line/20 uppercase">{(() => { const d = item.taxId?.replace(/\D/g,''); const cached = d?.length === 14 ? cnpjCache[d] : undefined; return (cached && cached !== 'error' && (cached as CNPJData).razao_social) ? (cached as CNPJData).razao_social : item.entity; })()}</td>
                        <td className="px-4 py-2.5 text-[9px] text-primary border-r border-line/20 uppercase">{item.docId}</td>
                        <td className="px-4 py-2.5 text-[9px] whitespace-nowrap border-r border-line/20 uppercase">{item.taxId}</td>
                        <td className="px-4 py-2.5 text-right font-bold border-r border-line/20">{formatCurrency(item.value)}</td>
                        <td className="px-4 py-2.5 border-r border-line/20">
                          <div className={cn('mx-auto w-fit px-2 py-0.5 rounded-sm text-[9px] font-bold uppercase', item.status === 'Conciliado' && 'bg-success/10 text-success border border-success/30', item.status === 'Ressalva' && 'bg-warning/10 text-warning border border-warning/30', item.status === 'Pendente' && 'bg-error/10 text-error border border-error/30')}>{item.status}</div>
                        </td>
                        <td className="px-4 py-2.5 text-center text-text-secondary border-r border-line/20 uppercase">{item.nfPage || '-'}</td>
                        <td className="px-4 py-2.5 text-center text-text-secondary border-r border-line/20 uppercase">{item.paymentPage || '-'}</td>
                        <td className="px-4 py-2.5 text-text-secondary font-sans leading-tight text-[10px] uppercase">{item.observations}</td>
                      </tr>
                    ))}
                    {filteredItems.length === 0 && (
                      <tr>
                        <td colSpan={13} className="px-6 py-10 text-center text-text-secondary text-xs uppercase tracking-widest">
                          Nenhum lançamento encontrado
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Lançamentos Diligenciados */}
            <div className="bg-card p-6 rounded border border-line mb-10">
              <h3 className="text-xs font-bold uppercase tracking-widest mb-6 flex items-center gap-2">
                <AlertCircle size={14} className="text-warning" />
                Lançamentos Diligenciados
                {diligencedItems.length > 0 && (
                  <span className="ml-2 bg-warning/20 text-warning text-[10px] font-bold px-2 py-0.5 rounded-full border border-warning/30">
                    {diligencedItems.length}
                  </span>
                )}
              </h3>
              {diligencedItems.length > 0 ? (
                <div className="space-y-3">
                  {diligencedItems.map((item, i) => (
                    <div
                      key={i}
                      onClick={() => setSelectedItem(item)}
                      className={cn(
                        'p-4 border rounded flex gap-4 cursor-pointer hover:border-primary/40 transition-all',
                        item.status === 'Pendente' ? 'bg-error/5 border-error/20' : 'bg-warning/5 border-warning/20'
                      )}
                    >
                      <div className={cn(
                        'text-[10px] font-mono font-bold px-2 py-1 h-fit border rounded shrink-0 uppercase',
                        item.status === 'Pendente' ? 'bg-error/10 text-error border-error/30' : 'bg-warning/10 text-warning border-warning/30'
                      )}>
                        #{item.id} · {item.status}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-4 mb-1">
                          <p className="text-xs text-text font-semibold truncate uppercase">{item.description}</p>
                          <span className="text-[11px] font-mono font-bold text-text shrink-0">{formatCurrency(item.value)}</span>
                        </div>
                        <div className="flex gap-4 text-[10px] text-text-secondary font-mono mb-2 uppercase">
                          <span>{item.activity}</span>
                          <span>&bull;</span>
                          <span>{item.date}</span>
                          <span>&bull;</span>
                          <span>{item.entity}</span>
                        </div>
                        <p className="text-[11px] text-text-secondary leading-relaxed uppercase">{item.observations}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-10 text-text-secondary text-xs uppercase tracking-widest border border-dashed border-line rounded">
                  Integridade de Dados 100% — Nenhum lançamento diligenciado
                </div>
              )}
            </div>

            {/* Base de Preparação */}
            <div className="bg-card p-6 rounded border border-line mb-10">
              <h3 className="text-xs font-bold uppercase tracking-widest mb-6 flex items-center gap-2">
                <FileDown size={14} className="text-primary" />
                Base de Preparação
              </h3>
              <p className="text-[11px] text-text-secondary mb-4 uppercase tracking-wide">
                Documentos originais utilizados como base para esta auditoria. Clique para baixar.
              </p>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { field: 'budget', label: 'CSV · Orçamento Aprovado', ext: 'csv' },
                  { field: 'report', label: 'CSV · Prestação de Contas', ext: 'csv' },
                  { field: 'invoices', label: 'PDF · Notas Fiscais', ext: 'pdf' },
                  { field: 'payments', label: 'PDF · Comprovantes de Pagamento', ext: 'pdf' },
                ].map(({ field, label, ext }) => {
                  const savedName = lastAuditResult.sourceFiles?.[field];
                  const filename = savedName || `${field}.${ext}`;
                  const href = `/api/audits/${lastAuditResult.id}/files/${encodeURIComponent(filename)}`;
                  return (
                    <a
                      key={field}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-4 p-4 border border-line rounded hover:border-primary hover:bg-primary/5 transition-all group"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] font-bold uppercase tracking-widest text-text group-hover:text-primary transition-colors">{label}</p>
                        <p className="text-[10px] text-text-secondary font-mono truncate mt-0.5">{savedName || 'Arquivo não disponível'}</p>
                      </div>
                      <Download size={14} className="text-text-secondary group-hover:text-primary transition-colors shrink-0" />
                    </a>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {/* ── HISTÓRICO ──────────────────────────────────────────────────────── */}
        {activeSection === 'historico' && (
          <section className="px-10 py-8 animate-in fade-in slide-in-from-left-4 duration-500 overflow-y-auto pb-24">
            <div className="flex items-end justify-between mb-6">
              <div>
                <h1 className="text-xl font-bold uppercase tracking-widest">Base de Dados de Auditorias</h1>
                <p className="text-[11px] text-text-secondary font-mono mt-1">{history.length} auditoria{history.length !== 1 ? 's' : ''} armazenada{history.length !== 1 ? 's' : ''}</p>
              </div>
            </div>

            {/* Stats bar */}
            {history.length > 0 && (() => {
              const totalValue = history.reduce((s, a) => s + (a.metrics?.totalValue ?? 0), 0);
              const totalItems = history.reduce((s, a) => s + (a.metrics?.totalItems ?? 0), 0);
              const totalConciliated = history.reduce((s, a) => s + (a.metrics?.conciliatedItems ?? 0), 0);
              const avgRate = totalItems > 0 ? (totalConciliated / totalItems * 100).toFixed(0) : '—';
              return (
                <div className="grid grid-cols-4 gap-4 mb-6">
                  {[
                    { label: 'Valor Total Auditado', value: formatCurrency(totalValue) },
                    { label: 'Total de Lançamentos', value: totalItems.toLocaleString('pt-BR') },
                    { label: 'Taxa Média de Conciliação', value: `${avgRate}%` },
                    { label: 'Auditorias Armazenadas', value: history.length },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-card border border-line rounded p-4">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-text-secondary mb-1">{label}</p>
                      <p className="text-lg font-bold font-mono text-primary">{value}</p>
                    </div>
                  ))}
                </div>
              );
            })()}

            <div className="border border-line rounded overflow-hidden">
              <div className="grid grid-cols-[2fr_150px_100px_110px_130px_110px_80px] gap-3 px-6 py-2.5 bg-sidebar text-[10px] font-bold text-text-secondary uppercase tracking-widest border-b border-line">
                <span>Organização / Responsável</span>
                <span>Período Auditado</span>
                <span>Contrato</span>
                <span>Gerado em</span>
                <span>Lançamentos</span>
                <span>Parecer</span>
                <span className="text-right">Ações</span>
              </div>
              {historyLoading ? (
                <div className="text-center py-10 bg-card">
                  <Loader2 className="animate-spin text-primary mx-auto" size={20} />
                </div>
              ) : history.length > 0 ? history.map((item) => {
                const total = item.metrics?.totalItems ?? 0;
                const conciliated = item.metrics?.conciliatedItems ?? 0;
                const pct = total > 0 ? (conciliated / total) : 0;
                const countColor = pct === 1 ? 'text-success' : pct >= 0.8 ? 'text-warning' : 'text-error';
                return (
                  <div key={item.id} className="grid grid-cols-[2fr_150px_100px_110px_130px_110px_80px] gap-3 items-center px-6 py-4 bg-card hover:bg-sidebar-active transition-all border-b border-line/30 group">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className={cn('w-2 h-2 rounded-full shrink-0 mt-1.5', item.verdict === 'APROVADO' ? 'bg-success' : item.verdict === 'DILIGÊNCIA' ? 'bg-error' : 'bg-warning')} />
                      <div className="min-w-0">
                        <h3 className="text-[13px] font-bold group-hover:text-primary transition-colors truncate">{item.organization}</h3>
                        {item.createdBy && (
                          <p className="text-[10px] text-text-secondary font-mono truncate mt-0.5">
                            {item.createdBy}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <p className="text-[10px] text-primary font-mono font-bold">{formatCurrency(item.metrics?.totalValue ?? 0)}</p>
                          {(item as any).sourceFiles && (
                            <p className="text-[9px] text-text-secondary/60 font-mono truncate">
                              {Object.values((item as any).sourceFiles).join(' · ')}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="text-[10px] font-mono text-text-secondary whitespace-nowrap">
                      {item.periodStart}<br /><span className="text-text-secondary/60">→</span> {item.periodEnd}
                    </div>
                    <div className="text-[11px] font-mono text-text-secondary">#{item.contractNumber}</div>
                    <div className="text-[11px] font-mono text-text-secondary whitespace-nowrap">{new Date(item.date).toLocaleDateString('pt-BR')}<br /><span className="text-[9px]">{new Date(item.date).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'})}</span></div>
                    <div className={cn('text-[11px] font-mono font-bold', countColor)}>
                      <span>{conciliated}/{total}</span>
                      <div className="text-[9px] font-normal text-text-secondary/70 mt-0.5">{(pct * 100).toFixed(0)}% conciliado</div>
                      {((item.metrics as any)?.findingsCount ?? 0) > 0 && (
                        <div className="text-[9px] text-warning font-normal mt-0.5">{(item.metrics as any).findingsCount} divergência{(item.metrics as any).findingsCount !== 1 ? 's' : ''}</div>
                      )}
                      {(total - conciliated - ((item.metrics as any)?.findingsCount ?? 0)) > 0 && (
                        <div className="text-[9px] text-error font-normal">{total - conciliated} pendente{total - conciliated !== 1 ? 's' : ''}</div>
                      )}
                    </div>
                    <div className={cn('text-[9px] font-bold uppercase tracking-widest', item.verdict === 'APROVADO' ? 'text-success' : item.verdict === 'DILIGÊNCIA' ? 'text-error' : 'text-warning')}>
                      {item.verdict}
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      {item.shareToken && (
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(`${window.location.origin}/share/${item.shareToken}`);
                          }}
                          className="p-1.5 hover:bg-primary/20 rounded text-text-secondary hover:text-primary transition-colors"
                          title="Copiar link público"
                        >
                          <Link2 size={13} />
                        </button>
                      )}
                      <button
                        onClick={async () => {
                          try {
                            const r = await fetch(`/api/audits/${item.id}`);
                            if (r.ok) {
                              setLastAuditResult(await r.json());
                              setActiveSection('resultado');
                            }
                          } catch (e) {
                            console.error('Falha ao carregar auditoria:', e);
                          }
                        }}
                        className="p-1.5 hover:bg-primary/20 rounded text-text-secondary hover:text-primary transition-colors"
                        title="Ver resultado"
                      >
                        <ChevronRight size={16} />
                      </button>
                      <button
                        onClick={() => deleteAudit(item.id)}
                        className="p-1.5 hover:bg-error/20 rounded text-text-secondary hover:text-error transition-colors"
                        title="Excluir auditoria"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                );
              }) : (
                <div className="text-center py-20 bg-card">
                  <p className="text-text-secondary text-[11px] font-mono uppercase tracking-widest">Nenhuma auditoria encontrada no servidor.</p>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── DOCUMENTAÇÃO ───────────────────────────────────────────────────── */}
        {activeSection === 'documentacao' && (
          <section className="px-10 py-8 animate-in fade-in slide-in-from-left-4 duration-500 overflow-y-auto pb-24">
            <div className="flex items-center gap-3 mb-8">
              <BookOpen size={22} className="text-primary" />
              <div>
                <h1 className="text-xl font-bold uppercase tracking-widest">Documentação da Plataforma</h1>
                <p className="text-[11px] text-text-secondary font-mono mt-0.5">Stack Audit™ — Casa Hacker &bull; Guia completo de uso e interpretação</p>
              </div>
            </div>

            <div className="space-y-6 max-w-4xl">

              {/* 1. Como usar */}
              <div className="bg-card border border-line rounded p-6">
                <h2 className="text-[11px] font-bold uppercase tracking-widest text-primary mb-4 pb-3 border-b border-line">1. Como usar a plataforma</h2>
                <div className="space-y-4 text-[12px] text-text-secondary leading-relaxed">
                  <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-widest text-text mb-2">Fluxo de trabalho</h3>
                    <ol className="space-y-2 list-none">
                      {[
                        ['Nova análise', 'Faça upload dos 4 arquivos (2 CSVs + 2 PDFs) e preencha os metadados do contrato.'],
                        ['Processando', 'O Stack Audit™ extrai texto dos PDFs e cruza os dados contra o orçamento aprovado usando IA.'],
                        ['Resultado', 'Visualize o RAPC, métricas de conciliação, gráfico de execução orçamentária e itens diligenciados.'],
                        ['Histórico', 'Acesse auditorias anteriores a qualquer momento para consulta ou reprocessamento.'],
                      ].map(([title, desc], i) => (
                        <li key={i} className="flex gap-3">
                          <span className="text-primary font-bold font-mono shrink-0">{i + 1}.</span>
                          <span><strong className="text-text">{title}:</strong> {desc}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-widest text-text mb-2">Requisitos dos arquivos</h3>
                    <ul className="space-y-1.5 list-none">
                      <li className="flex gap-2"><span className="text-primary">▸</span><span><strong className="text-text">PDFs:</strong> apenas documentos com <strong className="text-text">texto selecionável</strong> (gerados digitalmente). PDFs escaneados (imagens) não são processados.</span></li>
                      <li className="flex gap-2"><span className="text-primary">▸</span><span><strong className="text-text">CSVs:</strong> codificação UTF-8, separador vírgula ou ponto-e-vírgula, cabeçalho na primeira linha.</span></li>
                      <li className="flex gap-2"><span className="text-primary">▸</span><span><strong className="text-text">Tamanho máximo:</strong> 50 MB por arquivo.</span></li>
                    </ul>
                  </div>
                </div>
              </div>

              {/* 2. Layout dos CSVs */}
              <div className="bg-card border border-line rounded p-6">
                <h2 className="text-[11px] font-bold uppercase tracking-widest text-primary mb-4 pb-3 border-b border-line">2. Layout dos arquivos CSV esperados</h2>
                <div className="space-y-5 text-[12px]">
                  <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-widest text-text mb-3">CSV A — Orçamento Aprovado</h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[11px] border-collapse">
                        <thead>
                          <tr className="bg-sidebar text-text-secondary">
                            <th className="px-4 py-2 text-left border border-line font-bold uppercase tracking-wider">Coluna</th>
                            <th className="px-4 py-2 text-left border border-line font-bold uppercase tracking-wider">Obrigatória?</th>
                            <th className="px-4 py-2 text-left border border-line font-bold uppercase tracking-wider">Exemplos de nomes aceitos</th>
                          </tr>
                        </thead>
                        <tbody className="font-mono">
                          {[
                            ['Descrição / Rubrica', 'Sim', 'DESCRIÇÃO, RUBRICA, ITEM, ATIVIDADE, LINHA'],
                            ['Valor Total / Aprovado', 'Sim', 'VALOR TOTAL, VALOR, TOTAL, DOTAÇÃO, APROVADO, LIMITE'],
                          ].map(([col, req, ex], i) => (
                            <tr key={i} className="border-b border-line/30">
                              <td className="px-4 py-2 border border-line text-text">{col}</td>
                              <td className="px-4 py-2 border border-line text-success">{req}</td>
                              <td className="px-4 py-2 border border-line text-text-secondary text-[10px]">{ex}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-widest text-text mb-3">CSV B — Prestação de Contas</h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[11px] border-collapse">
                        <thead>
                          <tr className="bg-sidebar text-text-secondary">
                            <th className="px-4 py-2 text-left border border-line font-bold uppercase tracking-wider">Coluna</th>
                            <th className="px-4 py-2 text-left border border-line font-bold uppercase tracking-wider">Obrigatória?</th>
                            <th className="px-4 py-2 text-left border border-line font-bold uppercase tracking-wider">Exemplos de nomes aceitos</th>
                          </tr>
                        </thead>
                        <tbody className="font-mono">
                          {[
                            ['Data do lançamento', 'Sim', 'DATA, DATA PAGAMENTO, DATA EMISSÃO'],
                            ['Fornecedor / Favorecido', 'Sim', 'FORNECEDOR, FAVORECIDO, RAZÃO SOCIAL, NOME'],
                            ['Valor pago', 'Sim', 'VALOR, SAÍDA, TOTAL, MONTANTE, PAGO'],
                            ['CNPJ/CPF', 'Recomendado', 'CNPJ, CPF, CNPJ/CPF'],
                            ['Descrição da despesa', 'Recomendado', 'DESCRIÇÃO, HISTÓRICO, DESPESA, ITEM'],
                            ['Nº Nota Fiscal / Doc', 'Opcional', 'NF, NOTA, DOC, COMPROVANTE, NF-E'],
                            ['Atividade / Rubrica', 'Opcional', 'ATIVIDADE, RUBRICA, CATEGORIA'],
                          ].map(([col, req, ex], i) => (
                            <tr key={i} className="border-b border-line/30">
                              <td className="px-4 py-2 border border-line text-text">{col}</td>
                              <td className={cn('px-4 py-2 border border-line', req === 'Sim' ? 'text-success' : req === 'Recomendado' ? 'text-warning' : 'text-text-secondary')}>{req}</td>
                              <td className="px-4 py-2 border border-line text-text-secondary text-[10px]">{ex}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>

              {/* 3. Como interpretar */}
              <div className="bg-card border border-line rounded p-6">
                <h2 className="text-[11px] font-bold uppercase tracking-widest text-primary mb-4 pb-3 border-b border-line">3. Como interpretar os resultados</h2>
                <div className="space-y-5 text-[12px] text-text-secondary">
                  <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-widest text-text mb-3">Status dos lançamentos</h3>
                    <dl className="space-y-2">
                      {[
                        ['Conciliado', 'success', 'O lançamento foi validado com correspondência exata nas 4 fontes: orçamento, CSV, nota fiscal e comprovante de pagamento.'],
                        ['Ressalva', 'warning', 'Há pequena divergência corrigível ou dado parcialmente verificado. Exige análise humana para confirmar ou corrigir.'],
                        ['Pendente', 'error', 'Falta um ou mais documentos de cruzamento. O lançamento não pôde ser auditado completamente. Ação obrigatória.'],
                      ].map(([status, color, desc]) => (
                        <div key={status as string} className="flex gap-3 items-start">
                          <span className={cn('text-[9px] font-bold uppercase px-2 py-0.5 rounded border shrink-0 mt-0.5',
                            color === 'success' ? 'bg-success/10 text-success border-success/30' :
                            color === 'warning' ? 'bg-warning/10 text-warning border-warning/30' :
                            'bg-error/10 text-error border-error/30'
                          )}>{status as string}</span>
                          <span>{desc as string}</span>
                        </div>
                      ))}
                    </dl>
                  </div>
                  <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-widest text-text mb-3">Parecer final (RAPC)</h3>
                    <dl className="space-y-2">
                      {[
                        ['APROVADO', 'success', 'Nenhum item pendente e nenhuma divergência registrada. Prestação de contas íntegra.'],
                        ['APROVADO COM RESSALVAS', 'warning', '≥80% dos lançamentos foram conciliados. Há itens com ressalvas que exigem verificação pontual.'],
                        ['DILIGÊNCIA', 'error', '<80% dos lançamentos foram conciliados. A prestação de contas exige complementação documental.'],
                      ].map(([status, color, desc]) => (
                        <div key={status as string} className="flex gap-3 items-start">
                          <span className={cn('text-[9px] font-bold uppercase px-2 py-0.5 rounded border shrink-0 mt-0.5 whitespace-nowrap',
                            color === 'success' ? 'bg-success/10 text-success border-success/30' :
                            color === 'warning' ? 'bg-warning/10 text-warning border-warning/30' :
                            'bg-error/10 text-error border-error/30'
                          )}>{status as string}</span>
                          <span>{desc as string}</span>
                        </div>
                      ))}
                    </dl>
                  </div>
                  <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-widest text-text mb-2">Verificação Quádrupla</h3>
                    <p>O algoritmo do Stack Audit™ cruza cada lançamento contra 4 fontes simultaneamente: <strong className="text-text">(1)</strong> CSV de Orçamento Aprovado, <strong className="text-text">(2)</strong> CSV de Prestação de Contas, <strong className="text-text">(3)</strong> PDF de Notas Fiscais e <strong className="text-text">(4)</strong> PDF de Comprovantes de Pagamento. Somente itens com correspondência em todas as camadas recebem status "Conciliado".</p>
                  </div>
                </div>
              </div>

              {/* 4. Glossário */}
              <div className="bg-card border border-line rounded p-6">
                <h2 className="text-[11px] font-bold uppercase tracking-widest text-primary mb-4 pb-3 border-b border-line">4. Glossário de termos</h2>
                <dl className="grid grid-cols-1 gap-3 text-[12px]">
                  {[
                    ['RAPC', 'Relatório de Apuração de Prestação de Contas. Documento gerado pelo Stack Audit™ com o resultado da conciliação de todos os lançamentos.'],
                    ['Lançamento', 'Cada linha do CSV de Prestação de Contas representa um lançamento financeiro — uma despesa declarada pelo proponente.'],
                    ['Conciliado', 'Lançamento auditado com sucesso. Todos os 4 documentos cruzados confirmam o gasto.'],
                    ['Ressalva', 'Lançamento com pequena divergência ou documentação incompleta que pode ser corrigida com justificativa.'],
                    ['Pendente', 'Lançamento sem lastro documental completo. Exige providência do proponente.'],
                    ['Diligência', 'Processo formal de complementação documental solicitado ao proponente quando há muitos itens pendentes.'],
                    ['Verificação Quádrupla', 'Metodologia proprietária do Stack Audit™ que cruza CSV orçamento + CSV despesas + PDF notas fiscais + PDF comprovantes.'],
                    ['Razão Social', 'Nome jurídico registrado de uma pessoa jurídica na Receita Federal. Distinto do nome fantasia.'],
                    ['Rubrica / Atividade', 'Linha orçamentária aprovada à qual o gasto deve ser imputado (ex: "Recursos Humanos", "Material de Consumo").'],
                    ['Dotação Orçamentária', 'Valor aprovado para uma determinada rubrica no orçamento do projeto.'],
                    ['NSU', 'Número Sequencial Único — identificador único de transações financeiras em sistemas bancários.'],
                    ['TXID PIX', 'Transaction ID — identificador único de cada transação PIX, gerado pelo sistema bancário.'],
                    ['Tarifa Bancária', 'Cobrança de serviço bancário. Tarifas de até R$ 150,00 são automaticamente conciliadas pelo Stack Audit™ sem necessidade de nota fiscal.'],
                    ['NF-e / NFS-e', 'Nota Fiscal Eletrônica (produtos) / Nota Fiscal de Serviços Eletrônica. Documentos fiscais obrigatórios para comprovação de despesas.'],
                    ['Prestação de Contas', 'Processo pelo qual o proponente comprova ao financiador que os recursos foram aplicados conforme o plano de trabalho aprovado.'],
                    ['Terceiro Setor', 'Organizações sem fins lucrativos, como OSCs, institutos e fundações, que executam projetos com recursos públicos ou privados.'],
                  ].map(([term, def]) => (
                    <div key={term as string} className="grid grid-cols-[180px_1fr] gap-3 border-b border-line/30 pb-3 last:border-0 last:pb-0">
                      <dt className="text-[11px] font-bold uppercase tracking-wider text-primary pt-0.5">{term as string}</dt>
                      <dd className="text-text-secondary leading-relaxed">{def as string}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              {/* 5. Limitações */}
              <div className="bg-card border border-warning/30 bg-warning/5 rounded p-6">
                <h2 className="text-[11px] font-bold uppercase tracking-widest text-warning mb-4 pb-3 border-b border-warning/20 flex items-center gap-2">
                  <AlertCircle size={14} /> 5. Limitações e informações importantes
                </h2>
                <ul className="space-y-3 text-[12px] text-text-secondary">
                  {[
                    'PDFs escaneados (imagens) não são processados — apenas documentos com texto selecionável são suportados.',
                    'A IA pode cometer erros. Revisão humana por amostragem é obrigatória antes de qualquer encaminhamento oficial.',
                    'Os resultados do Stack Audit™ não constituem parecer jurídico, contábil ou fiscal. São uma ferramenta de apoio operacional.',
                    'A plataforma não armazena dados pessoais além do necessário para autenticação (Google OAuth @casahacker.org).',
                    'Acesso restrito a usuários do domínio @casahacker.org. Não compartilhe credenciais ou resultados com terceiros sem autorização.',
                    'A Verificação Quádrupla depende da qualidade do texto extraído dos PDFs. Documentos mal formatados ou com tabelas complexas podem reduzir a precisão.',
                    'Tarifas bancárias de até R$ 150,00 são automaticamente classificadas como Conciliadas por regra institucional — confirme se este valor é adequado para o seu contrato.',
                  ].map((item, i) => (
                    <li key={i} className="flex gap-3 items-start">
                      <span className="text-warning font-bold shrink-0">▸</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

            </div>
          </section>
        )}

        {/* ── TERMS MODAL ────────────────────────────────────────────────────── */}
        {showTermsModal && (
          <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4">
            <div className="bg-bg border border-line p-8 max-w-2xl w-full animate-in fade-in zoom-in-95 duration-200">
              <h2 className="text-xl font-bold mb-4 uppercase tracking-widest text-primary">Termo de Responsabilidade</h2>
              <p className="text-sm text-text-secondary mb-6 leading-relaxed">
                O Casa Hacker® Stack Audit™ é um auditor auxiliar e não deve substituir processos analíticos e de inteligência, mas sim <b>processos operacionais</b>.
              </p>
              <div className="space-y-4 mb-8">
                {[
                  'Usarei o Stack Audit™ como auxiliar de auditoria.',
                  'Analisarei os resultados por amostragem para confirmação dos dados gerados pelo Stack Audit™.',
                  'Não encaminharei resultados, análises e informações integralmente gerados pelo Stack Audit™ sem verificação por amostragem.',
                  'Compreendo que as informações são de uso confidencial e interno na Associação Casa Hacker.',
                ].map((term, idx) => (
                  <label key={idx} className="flex items-start gap-4 cursor-pointer group">
                    <div className="pt-0.5 relative">
                      <input
                        type="checkbox"
                        className="w-5 h-5 rounded border border-line bg-transparent checked:bg-primary checked:border-primary appearance-none flex items-center justify-center transition-all cursor-pointer peer"
                        checked={termsChecked[idx]}
                        onChange={(e) => { const n = [...termsChecked]; n[idx] = e.target.checked; setTermsChecked(n); }}
                      />
                      <svg className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 text-bg pointer-events-none opacity-0 peer-checked:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <span className="text-sm text-text group-hover:text-primary transition-colors leading-relaxed">{term}</span>
                  </label>
                ))}
              </div>
              <div className="flex gap-4 justify-end">
                <button onClick={() => setShowTermsModal(false)} className="px-6 py-2 border border-line text-xs font-bold uppercase tracking-widest hover:bg-white/5 transition-colors">Cancelar</button>
                <button
                  onClick={() => { setShowTermsModal(false); startAudit(); }}
                  disabled={!termsChecked.every(Boolean)}
                  className={cn('px-6 py-2 text-xs font-bold uppercase tracking-widest transition-all', termsChecked.every(Boolean) ? 'bg-primary text-bg hover:scale-[1.02]' : 'bg-line text-text-secondary cursor-not-allowed opacity-50')}
                >
                  Aceitar e Iniciar Auditoria
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── ITEM DETAIL MODAL (widescreen) ─────────────────────────────────── */}
        {selectedItem && (
          <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4">
            <div className="bg-bg border border-line w-full max-w-6xl max-h-[90vh] flex flex-col animate-in fade-in zoom-in-95 duration-200 shadow-2xl rounded-lg overflow-hidden">
              {/* Modal header */}
              <div className="flex justify-between items-center px-8 py-5 border-b border-line bg-card shrink-0">
                <div className="flex items-center gap-4">
                  <div>
                    <h2 className="text-base font-bold uppercase tracking-widest text-primary">Detalhes do Lançamento</h2>
                    <p className="text-[11px] text-text-secondary font-mono mt-0.5">ID {selectedItem.id} &bull; {selectedItem.date}</p>
                  </div>
                  <div className={cn('px-3 py-1 rounded text-[10px] font-bold uppercase border',
                    selectedItem.status === 'Conciliado' && 'bg-success/10 text-success border-success/30',
                    selectedItem.status === 'Ressalva' && 'bg-warning/10 text-warning border-warning/30',
                    selectedItem.status === 'Pendente' && 'bg-error/10 text-error border-error/30'
                  )}>
                    {selectedItem.status}
                  </div>
                </div>
                <button onClick={() => setSelectedItem(null)} className="text-text-secondary hover:text-text transition-colors p-1.5 hover:bg-white/5 rounded">
                  <X size={20} />
                </button>
              </div>

              {/* Modal scrollable body */}
              <div className="overflow-y-auto flex-1 custom-scrollbar">
                <div className="grid grid-cols-2 gap-0 border-b border-line">
                  {/* Left: Stack Audit™ analysis */}
                  <div className="p-8 border-r border-line">
                    <h3 className="text-[11px] font-bold uppercase tracking-widest pb-3 mb-4 border-b border-line text-primary">
                      Apuração Stack Audit™
                    </h3>
                    <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-3 text-[12px]">
                      {(() => {
                        const taxDigits = selectedItem.taxId?.replace(/\D/g, '');
                        const isCnpj = taxDigits?.length === 14;
                        const cnpjRaw = isCnpj ? cnpjCache[taxDigits!] : undefined;
                        const cnpjData = (cnpjRaw && cnpjRaw !== 'error') ? cnpjRaw as CNPJData : undefined;
                        const isLoadingCnpj = isCnpj ? cnpjLoading[taxDigits!] : false;
                        const displayName = cnpjData?.razao_social || selectedItem.entity;
                        const fields: [string, React.ReactNode][] = [
                          ['Descrição', <span className="text-text font-sans uppercase break-words">{selectedItem.description}</span>],
                          ['Atividade / Rubrica', <span className="text-text uppercase">{selectedItem.activity}</span>],
                          ['Fornecedor', (
                            <span className="flex items-center gap-2">
                              <span className={cn('text-text uppercase break-words', isCnpj && 'cursor-pointer text-primary underline decoration-dotted hover:no-underline')} onClick={isCnpj ? () => setShowCnpjPanel(p => !p) : undefined} title={isCnpj ? 'Clique para ver dados do CNPJ' : undefined}>
                                {isLoadingCnpj ? <span className="opacity-50 text-text-secondary">Consultando Receita Federal...</span> : displayName}
                              </span>
                              {isCnpj && <Building2 size={13} className="text-primary opacity-60 shrink-0" />}
                            </span>
                          )],
                          ['CNPJ / CPF', <span className="font-mono text-text">{selectedItem.taxId}</span>],
                          ['Doc Fiscal (ID)', <span className="text-primary font-mono uppercase">{selectedItem.docId}</span>],
                          ['Valor', <span className="font-bold text-text text-base">{formatCurrency(selectedItem.value)}</span>],
                          ['Pág. Nota Fiscal', <span className="font-mono text-text-secondary uppercase">{selectedItem.nfPage || 'Não localizado'}</span>],
                          ['Pág. Comprovante', <span className="font-mono text-text-secondary uppercase">{selectedItem.paymentPage || 'Não localizado'}</span>],
                          ...(selectedItem.emissionDateTime ? [['Data/Hora Emissão', <span className="font-mono text-text-secondary">{selectedItem.emissionDateTime}</span>] as [string, React.ReactNode]] : []),
                          ...(selectedItem.serviceDescription ? [['Descrição do Serviço', <span className="text-text font-sans uppercase break-words text-[11px]">{selectedItem.serviceDescription}</span>] as [string, React.ReactNode]] : []),
                          ...(selectedItem.taxInfo ? [['CNAEs / Inf. Tributárias', <span className="text-text-secondary font-mono text-[10px] break-words">{selectedItem.taxInfo}</span>] as [string, React.ReactNode]] : []),
                          ...(selectedItem.paymentDateTime ? [['Data/Hora Pagamento', <span className="font-mono text-text-secondary">{selectedItem.paymentDateTime}</span>] as [string, React.ReactNode]] : []),
                          ...(selectedItem.transactionId ? [['ID da Transação', <span className="font-mono text-primary text-[10px] break-all">{selectedItem.transactionId}</span>] as [string, React.ReactNode]] : []),
                          ...(selectedItem.payerInfo ? [['Pagador', <span className="text-text-secondary font-sans text-[10px] break-words">{selectedItem.payerInfo}</span>] as [string, React.ReactNode]] : []),
                          ...(selectedItem.payeeInfo ? [['Recebedor / Beneficiário', <span className="text-text-secondary font-sans text-[10px] break-words">{selectedItem.payeeInfo}</span>] as [string, React.ReactNode]] : []),
                          ...(selectedItem.paymentMethod ? [['Meio de Pagamento', <span className="font-bold text-text uppercase">{selectedItem.paymentMethod}</span>] as [string, React.ReactNode]] : []),
                        ];
                        return fields.map(([label, value], i) => (
                          <div key={i} className="contents">
                            <dt className="text-text-secondary text-[11px] font-semibold uppercase tracking-wider pt-0.5 self-start">{label}</dt>
                            <dd>{value}</dd>
                          </div>
                        ));
                      })()}
                    </dl>

                    {/* CNPJ data panel */}
                    {showCnpjPanel && (() => {
                      const taxDigits = selectedItem.taxId?.replace(/\D/g, '');
                      if (!taxDigits || taxDigits.length !== 14) return null;
                      const isLoading = cnpjLoading[taxDigits];
                      const cacheVal = cnpjCache[taxDigits];

                      if (isLoading) return (
                        <div className="mt-4 border-t border-line pt-4 flex items-center gap-2 text-text-secondary text-[11px]">
                          <Loader2 size={13} className="animate-spin" /> Consultando Receita Federal...
                        </div>
                      );

                      if (cacheVal === 'error') return (
                        <div className="mt-4 border-t border-line pt-4">
                          <p className="text-red-400 text-[11px] flex items-center gap-1.5">
                            <AlertCircle size={13} /> Falha ao consultar dados do CNPJ.
                          </p>
                          <button
                            onClick={() => { retryFetchCnpj(selectedItem.taxId!); fetchCnpj(selectedItem.taxId!); }}
                            className="mt-2 text-[10px] text-primary underline"
                          >
                            Tentar novamente
                          </button>
                        </div>
                      );

                      if (!cacheVal) return null;

                      const cnpjData = cacheVal as CNPJData;
                      const labelMap: Record<string, string> = {
                        razao_social: 'Razão Social', nome_fantasia: 'Nome Fantasia', situacao_cadastral: 'Situação Cadastral',
                        data_situacao_cadastral: 'Data Situação', tipo: 'Tipo', natureza_juridica: 'Natureza Jurídica',
                        abertura: 'Data de Abertura', capital_social: 'Capital Social', porte: 'Porte',
                        logradouro: 'Logradouro', numero: 'Número', complemento: 'Complemento',
                        bairro: 'Bairro', municipio: 'Município', uf: 'UF', cep: 'CEP',
                        telefone: 'Telefone', email: 'E-mail',
                        simples_optante: 'Optante Simples Nacional', simei_optante: 'Optante SIMEI',
                      };
                      const qsa: any[] = cnpjData.qsa || [];
                      return (
                        <div className="mt-4 border-t border-line pt-4">
                          <div className="flex items-center justify-between mb-3">
                            <h4 className="text-[10px] font-bold uppercase tracking-widest text-primary flex items-center gap-1.5">
                              <Building2 size={12} /> Dados Receita Federal — CNPJ {selectedItem.taxId}
                            </h4>
                            <button onClick={() => setShowCnpjPanel(false)} className="text-text-secondary hover:text-text text-[10px]"><X size={13} /></button>
                          </div>
                          <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 text-[11px]">
                            {/* Scalar fields only — skip arrays and objects */}
                            {Object.entries(cnpjData)
                              .filter(([k, v]) => v != null && v !== '' && typeof v !== 'object' && k !== 'cnpj')
                              .map(([k, v]) => (
                                <div key={k} className="contents">
                                  <dt className="text-text-secondary text-[10px] font-semibold uppercase tracking-wider pt-0.5 self-start">{labelMap[k] || k.replace(/_/g,' ')}</dt>
                                  <dd className="text-text font-mono text-[10px] break-words uppercase">{String(v)}</dd>
                                </div>
                              ))}
                            {/* CNAE Principal */}
                            {cnpjData.atividade_principal?.length ? (
                              <div className="contents">
                                <dt className="text-text-secondary text-[10px] font-semibold uppercase tracking-wider pt-0.5 self-start">CNAE Principal</dt>
                                <dd className="text-text font-mono text-[10px] break-words uppercase">{cnpjData.atividade_principal.map((a: any) => `${a.code} — ${a.text}`).join('; ')}</dd>
                              </div>
                            ) : null}
                            {/* CNAEs Secundários */}
                            {cnpjData.atividades_secundarias?.filter((a: any) => a.code && a.code !== '00.00-0-00').length ? (
                              <div className="contents">
                                <dt className="text-text-secondary text-[10px] font-semibold uppercase tracking-wider pt-0.5 self-start">CNAEs Secundários</dt>
                                <dd className="text-text font-mono text-[10px] break-words uppercase">{cnpjData.atividades_secundarias.filter((a: any) => a.code !== '00.00-0-00').map((a: any) => `${a.code} — ${a.text}`).join(' | ')}</dd>
                              </div>
                            ) : null}
                          </div>
                          {/* QSA */}
                          {qsa.length > 0 && (
                            <div className="mt-3 pt-3 border-t border-line/50">
                              <p className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary mb-2">Quadro Societário (QSA)</p>
                              <div className="space-y-1">
                                {qsa.map((s: any, i: number) => (
                                  <div key={i} className="flex gap-2 text-[10px] font-mono">
                                    <span className="text-text uppercase">{s.nome_socio || s.nome || '—'}</span>
                                    {(s.qualificacao_socio || s.qual) && <span className="text-text-secondary">— {s.qualificacao_socio || s.qual}</span>}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Right: CSV original */}
                  <div className="p-8">
                    <h3 className="text-[11px] font-bold uppercase tracking-widest pb-3 mb-4 border-b border-line text-text-secondary">
                      Lançamento — Planilha de Prestação
                    </h3>
                    {selectedItem.originalRow ? (
                      <div className="space-y-2 font-mono text-[11px]">
                        {Object.entries(selectedItem.originalRow).map(([k, v], i) => (
                          <div key={i} className="grid grid-cols-[160px_1fr] gap-2 border-b border-line/30 pb-2 last:border-0">
                            <span className="text-text-secondary text-[10px] uppercase font-bold tracking-wider truncate pt-0.5">{k}</span>
                            <span className="text-text break-words uppercase">{String(v || '—')}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-text-secondary italic">Nenhum dado original pareado.</p>
                    )}
                  </div>
                </div>

                {/* Bottom: observations + mitigation */}
                <div className="grid grid-cols-2 gap-0">
                  <div className="p-8 border-r border-line">
                    <h3 className="text-[11px] font-bold uppercase tracking-widest mb-4 text-primary">
                      Observações Stack Audit™
                      <span className={cn('ml-2 text-[10px] px-2 py-0.5 rounded border font-normal',
                        selectedItem.status === 'Conciliado' && 'bg-success/10 text-success border-success/30',
                        selectedItem.status === 'Ressalva' && 'bg-warning/10 text-warning border-warning/30',
                        selectedItem.status === 'Pendente' && 'bg-error/10 text-error border-error/30'
                      )}>{selectedItem.status}</span>
                    </h3>
                    <div className="bg-sidebar border border-line p-4 rounded text-[13px] font-sans leading-relaxed text-text-secondary min-h-[100px] uppercase">
                      {selectedItem.observations || (
                        selectedItem.status === 'Conciliado'
                          ? 'Item com apuração exata. Documentos e valores atestados sem ressalvas.'
                          : 'Nenhuma observação reportada.'
                      )}
                    </div>
                  </div>
                  <div className="p-8">
                    <h3 className="text-[11px] font-bold uppercase tracking-widest mb-4 text-text-secondary">
                      Instrução de Mitigação
                    </h3>
                    <div className="bg-card border border-line p-4 rounded text-[13px] font-sans leading-relaxed text-text-secondary min-h-[100px] uppercase">
                      {selectedItem.status === 'Conciliado'
                        ? 'Nenhuma ação necessária. Lançamento conciliado com documentos fiscais e comprovantes de pagamento sem divergências.'
                        : 'Verifique o documento na respectiva página nos comprovantes originais. Divergências foram geradas pelo Stack Audit™ validando o conteúdo textual dos PDFs. Itens sem lastro documental exigem conciliação humana.'}
                    </div>
                  </div>
                </div>

                {/* Related items across audits */}
                {(relatedLoading || relatedItems.length > 0) && (
                  <div className="border-t border-line p-8">
                    <h3 className="text-[11px] font-bold uppercase tracking-widest mb-4 text-primary flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary inline-block" />
                      Outros Lançamentos — mesmo {selectedItem.taxId?.replace(/\D/g,'').length === 14 ? 'CNPJ' : 'CPF'} ({selectedItem.taxId})
                    </h3>
                    {relatedLoading ? (
                      <div className="flex items-center gap-2 text-[11px] text-text-secondary"><Loader2 size={12} className="animate-spin" /> Buscando em todas as auditorias...</div>
                    ) : (
                      <div className="space-y-4">
                        {relatedItems.map((audit, ai) => {
                          const otherItems = audit.items.filter((it: any) => !(audit.auditId === lastAuditResult?.id && it.id === selectedItem.id));
                          if (otherItems.length === 0) return null;
                          return (
                            <div key={ai}>
                              <p className="text-[10px] font-bold uppercase tracking-widest text-text-secondary mb-2">
                                {audit.contractNumber} — {audit.organization}
                                <span className="ml-2 font-normal opacity-60">{audit.periodStart} → {audit.periodEnd}</span>
                              </p>
                              <div className="overflow-x-auto">
                                <table className="w-full text-[10px] font-mono border-collapse">
                                  <thead>
                                    <tr className="border-b border-line text-text-secondary">
                                      <th className="text-left py-1 pr-4 font-semibold uppercase">#</th>
                                      <th className="text-left py-1 pr-4 font-semibold uppercase">Descrição</th>
                                      <th className="text-left py-1 pr-4 font-semibold uppercase">Atividade</th>
                                      <th className="text-left py-1 pr-4 font-semibold uppercase">Data</th>
                                      <th className="text-right py-1 pr-4 font-semibold uppercase">Valor</th>
                                      <th className="text-left py-1 font-semibold uppercase">Status</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {otherItems.map((it: any, ii: number) => (
                                      <tr key={ii} className="border-b border-line/20 hover:bg-primary/5">
                                        <td className="py-1.5 pr-4 text-text-secondary">{it.id}</td>
                                        <td className="py-1.5 pr-4 uppercase max-w-[200px] truncate">{it.description}</td>
                                        <td className="py-1.5 pr-4 uppercase text-text-secondary max-w-[150px] truncate">{it.activity}</td>
                                        <td className="py-1.5 pr-4 text-text-secondary">{it.date}</td>
                                        <td className="py-1.5 pr-4 text-right">{formatCurrency(it.value)}</td>
                                        <td className="py-1.5">
                                          <span className={cn('px-1.5 py-0.5 rounded text-[9px] font-bold uppercase',
                                            it.status === 'Conciliado' && 'bg-success/10 text-success',
                                            it.status === 'Ressalva' && 'bg-warning/10 text-warning',
                                            it.status === 'Pendente' && 'bg-error/10 text-error'
                                          )}>{it.status}</span>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

      </main>

      <footer className="fixed bottom-0 left-[180px] right-0 py-3 px-6 bg-sidebar border-t border-line text-[10px] text-text-secondary text-center leading-relaxed z-40">
        <p className="font-bold tracking-widest uppercase">CONFIDENCIAL - USO INTERNO &nbsp;&bull;&nbsp; &copy; 2026 ASSOCIAÇÃO CASA HACKER &nbsp;&bull;&nbsp; CNPJ 36.038.079/0001-97 &nbsp;&bull;&nbsp; R. DR. RENATO PAES DE BARROS, 618 – ITAIM BIBI, SÃO PAULO – SP, 04530-000</p>
      </footer>

      {/* ── Save toasts ────────────────────────────────────────────────────── */}
      {saveError && (
        <div className="fixed bottom-16 right-4 z-50 bg-red-600 text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-2 text-[12px] max-w-sm">
          <AlertCircle size={15} className="shrink-0" />
          <span className="flex-1">{saveError}</span>
          <button onClick={() => setSaveError(null)} className="ml-1 opacity-70 hover:opacity-100"><X size={14} /></button>
        </div>
      )}
      {saveSuccess && (
        <div className="fixed bottom-16 right-4 z-50 bg-green-700 text-white px-4 py-3 rounded-lg shadow-lg text-[12px]">
          Auditoria salva com sucesso.
        </div>
      )}
    </div>
  );
}

// ── Helper Components ─────────────────────────────────────────────────────────

function BudgetLineChart({ lines }: { lines: BudgetLine[] }) {
  if (!lines.length) return null;
  const hasPlanValues = lines.some(l => l.plannedValue > 0);

  return (
    <div className="space-y-3 max-h-[400px] overflow-y-auto custom-scrollbar pr-1">
      {lines.map((line, i) => {
        const pct = line.plannedValue > 0 ? (line.executedValue / line.plannedValue) * 100 : 0;
        const over = hasPlanValues && pct > 100;
        const saldo = line.plannedValue - line.executedValue;
        return (
          <div key={i} className={cn('border rounded p-4', over ? 'border-error/30 bg-error/5' : 'border-line bg-bg/50')}>
            <div className="flex justify-between items-start mb-2 gap-4 flex-wrap">
              <span className="text-[11px] font-semibold text-text uppercase">{line.activity}</span>
              <div className="flex gap-4 text-[10px] font-mono shrink-0 items-center flex-wrap">
                {hasPlanValues && (
                  <span className="text-text-secondary">Planejado: <span className="text-text font-bold">{formatCurrency(line.plannedValue)}</span></span>
                )}
                <span className={cn(over ? 'text-error font-bold' : 'text-primary font-bold')}>
                  Executado: {formatCurrency(line.executedValue)}
                </span>
                {hasPlanValues && (
                  <span className={cn('font-bold', saldo < 0 ? 'text-error' : 'text-success')}>
                    {saldo < 0 ? '▲' : '▼'} {formatCurrency(Math.abs(saldo))}
                  </span>
                )}
                {over && (
                  <span className="bg-error/10 text-error border border-error/30 text-[9px] px-1.5 py-0.5 rounded font-bold">
                    ⚠ EXCEDIDO {(pct - 100).toFixed(1)}%
                  </span>
                )}
              </div>
            </div>
            {hasPlanValues && (
              <>
                <div className="h-2 w-full bg-line rounded-full overflow-hidden">
                  <div
                    className={cn('h-full transition-all duration-700 rounded-full', over ? 'bg-error' : 'bg-primary')}
                    style={{ width: `${Math.min(pct, 100)}%` }}
                  />
                </div>
                <div className="flex justify-between mt-1 text-[9px] font-mono text-text-secondary">
                  <span>0%</span>
                  <span className={over ? 'text-error font-bold' : ''}>{pct.toFixed(1)}%</span>
                  <span>100%</span>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function UploadSlot({ label, description, file, onFileSelect }: { label: string; description: string; file: FileData | null; onFileSelect: (f: File) => void }) {
  return (
    <div className={cn(
      'relative border rounded-xl p-5 flex flex-col gap-3 transition-all duration-200 cursor-pointer group min-h-[120px]',
      file ? 'border-primary bg-primary/5' : 'border-line bg-sidebar hover:border-primary/50 hover:bg-sidebar-active'
    )}>
      <input type="file" accept={label.includes('CSV') ? '.csv' : '.pdf,.PDF'} onChange={(e) => e.target.files?.[0] && onFileSelect(e.target.files[0])} className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
      <div className="flex items-center gap-3">
        {file ? <FileText size={18} className="text-primary shrink-0" /> : <Upload size={18} className="text-text-secondary group-hover:text-primary shrink-0 transition-colors" />}
        <div className="min-w-0">
          <p className="text-[12px] font-bold text-text group-hover:text-primary transition-colors truncate">{label}</p>
          <p className="text-[10px] text-text-secondary">{description}</p>
        </div>
      </div>
      {file && (
        <div className="flex items-center gap-2 mt-1 text-[10px] font-mono text-primary">
          <span className="truncate">{truncateFileName(file.name, 28)}</span>
          <span className="text-text-secondary shrink-0">({(file.size / 1024).toFixed(0)} KB)</span>
        </div>
      )}
      {!file && <p className="text-[10px] text-text-secondary/60 italic mt-auto">Clique ou arraste aqui</p>}
    </div>
  );
}

function InputGroup({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] uppercase tracking-widest text-text-secondary px-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-sidebar border border-line rounded px-3 py-2 text-[12px] font-mono text-text placeholder:text-text-secondary/40 focus:outline-none focus:border-primary transition-colors"
      />
    </div>
  );
}

function CheckItem({ label, checked }: { label: string; checked: boolean }) {
  return (
    <div className={cn('flex items-center gap-3 text-[12px] transition-colors', checked ? 'text-success' : 'text-text-secondary')}>
      <div className={cn('w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-all', checked ? 'border-success bg-success/20' : 'border-line')}>
        {checked && <div className="w-1.5 h-1.5 rounded-full bg-success" />}
      </div>
      {label}
    </div>
  );
}

function ProcessStep({ step, current, label }: { step: number; current: number; label: string }) {
  const done = current > step;
  const active = current === step;
  return (
    <div className={cn('flex items-center gap-4 p-4 border rounded transition-all', done ? 'border-success/30 bg-success/5' : active ? 'border-primary/30 bg-primary/5' : 'border-line bg-sidebar')}>
      <div className={cn('w-8 h-8 rounded-full border-2 flex items-center justify-center text-[10px] font-bold shrink-0 transition-all', done ? 'border-success text-success bg-success/10' : active ? 'border-primary text-primary bg-primary/10 animate-pulse' : 'border-line text-text-secondary')}>
        {done ? '✓' : step}
      </div>
      <span className={cn('text-[12px] font-mono uppercase tracking-wider', done ? 'text-success' : active ? 'text-primary' : 'text-text-secondary')}>
        {done ? label + ' — CONCLUÍDO' : active ? label + ' — PROCESSANDO...' : label + ' — PENDENTE'}
      </span>
    </div>
  );
}

function MetricCard({ label, value, sub, color }: { label: string; value: string | number; sub: string; color?: string }) {
  return (
    <div className="bg-card p-5 border border-line rounded">
      <p className="text-[10px] uppercase tracking-widest text-text-secondary mb-2">{label}</p>
      <p className={cn('text-3xl font-mono font-bold mb-1', color === 'amber' ? 'text-warning' : 'text-text')}>{value}</p>
      <p className="text-[10px] text-text-secondary">{sub}</p>
    </div>
  );
}

function VerdictBanner({ result }: { result: AuditResult }) {
  const color = result.verdict === 'APROVADO' ? 'success' : result.verdict === 'DILIGÊNCIA' ? 'error' : 'warning';
  return (
    <div className={cn('mb-8 p-6 border rounded-xl', `border-${color}/30 bg-${color}/5`)}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-text-secondary mb-2">Parecer Final — Stack Audit™</p>
          <h2 className={cn('text-3xl font-extrabold tracking-widest uppercase', `text-${color}`)}>{result.verdict}</h2>
          <p className="text-text-secondary text-sm mt-2 font-mono">
            {result.organization} &bull; {result.periodStart} → {result.periodEnd} &bull; Contrato {result.contractNumber}
          </p>
        </div>
        <div className="text-right text-[10px] text-text-secondary font-mono">
          <p>ID: {result.id.slice(0, 8).toUpperCase()}</p>
          <p>{new Date(result.date).toLocaleString('pt-BR')}</p>
          {result.createdBy && <p className="mt-1 text-primary">{result.createdBy}</p>}
        </div>
      </div>
    </div>
  );
}
