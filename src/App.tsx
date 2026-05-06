/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
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
  RefreshCw,
  NotebookPen,
  CheckCircle2,
  Info,
  Accessibility,
  Sun,
  Moon,
  Contrast,
  Printer,
  Share2,
  Flag,
  ChevronUp,
  ChevronDown,
  Layers,
  Keyboard,
  Clock,
} from 'lucide-react';
import { cn, formatCurrency, truncateFileName } from './lib/utils';
import Papa from 'papaparse';
import { AuditResult, FileData, AuditItem, AuthUser, BudgetLine, CNPJData } from './types';
import { processAudit, reprocessItems } from './services/auditService';

type Section = 'nova' | 'processando' | 'resultado' | 'historico' | 'pesquisa' | 'documentacao';

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

function formatTaxId(taxId: string): string {
  const d = taxId?.replace(/\D/g, '') ?? '';
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  return taxId;
}

function isPageDownloadable(pageRef: string | undefined): boolean {
  if (!pageRef) return false;
  const norm = pageRef.replace(/pág\.?\s*/gi, '').trim();
  if (/^(n\/a|não localizado|dispensado|pendente|não encontrado|-+)$/i.test(norm)) return false;
  return /\d/.test(norm);
}

function computeBudgetLines(budgetCsv: any[], items: AuditItem[], pcCsv?: any[]): BudgetLine[] {
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

  // ── Budget CSV: find VALUE column (col H — "VALOR TOTAL") ──
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

  // ── Build normalized budget key lookup ──
  const budgetKeyByNorm: Record<string, string> = {};
  for (const key of Object.keys(plannedByDesc)) {
    budgetKeyByNorm[normalizeStr(key)] = key;
  }

  const executedByBudgetKey: Record<string, number> = {};
  let unmatchedTotal = 0;

  if (pcCsv && pcCsv.length > 0) {
    // ── Use raw PC CSV: "Descrição da despesa (exatamente como no Orçamento)" + "Saída (-)" ──
    const pcCols = Object.keys(pcCsv[0] ?? {});

    // Col B: "Descrição da despesa (exatamente como no Orçamento)"
    const pcDescKeys = ['descri', 'rubrica', 'atividade', 'objeto', 'linha'];
    let pcDescCol: string | undefined;
    for (const key of pcDescKeys) {
      pcDescCol = pcCols.find(c => normalizeStr(c).includes(key));
      if (pcDescCol) break;
    }

    // Col J: "Saída (-)" — expense/debit column
    const pcSaidaKeys = ['saida', 'debito', 'despesa', 'pagto', 'pagamento'];
    let pcSaidaCol: string | undefined;
    for (const key of pcSaidaKeys) {
      pcSaidaCol = pcCols.find(c => normalizeStr(c).includes(key));
      if (pcSaidaCol) break;
    }

    for (const row of pcCsv) {
      // Only count rows with a positive "Saída" value — skip credits ("Entrada") and zero rows
      const saidaVal = parseVal(pcSaidaCol ? String(row[pcSaidaCol] ?? '') : '');
      if (saidaVal <= 0) continue;

      const desc = pcDescCol ? String(row[pcDescCol] ?? '').trim() : '';
      if (!desc) continue;

      const budgetKey = budgetKeyByNorm[normalizeStr(desc)];
      if (budgetKey) {
        executedByBudgetKey[budgetKey] = (executedByBudgetKey[budgetKey] || 0) + saidaVal;
      } else {
        unmatchedTotal += saidaVal;
      }
    }
  } else {
    // ── Fallback: use AI-extracted item.activity; exclude negative values (credits) ──
    const executedByActivity: Record<string, number> = {};
    for (const item of items) {
      if ((item.value || 0) <= 0) continue;
      const key = (item.activity || 'Não Classificado').trim();
      executedByActivity[key] = (executedByActivity[key] || 0) + (item.value || 0);
    }
    for (const [activity, value] of Object.entries(executedByActivity)) {
      const budgetKey = budgetKeyByNorm[normalizeStr(activity)];
      if (budgetKey) {
        executedByBudgetKey[budgetKey] = (executedByBudgetKey[budgetKey] || 0) + value;
      } else {
        unmatchedTotal += value;
      }
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
  const [redirecting, setRedirecting] = React.useState(false);

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="text-center p-10 border border-line rounded-xl bg-card max-w-sm w-full shadow-2xl">
        <img
          src="https://casahacker.org/wp-content/uploads/2023/07/logo_vertical-branco.svg"
          alt="Casa Hacker"
          className="h-12 mx-auto mb-6 invert opacity-90"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
        <h1 className="text-2xl font-extrabold tracking-widest uppercase text-primary mb-2">Stack Audit™</h1>
        <p className="text-text-secondary text-[11px] mb-8 uppercase tracking-widest">
          Plataforma de Auditoria com IA
        </p>

        {errorParam === 'domain' && (
          <div className="mb-6 p-3 bg-error/5 border-l-4 border-error rounded-r flex items-start gap-3 text-left">
            <AlertCircle size={15} className="text-error shrink-0 mt-0.5" />
            <p className="text-[11px] text-error">
              Acesso negado. Utilize uma conta <strong>@casahacker.org</strong>.
            </p>
          </div>
        )}
        {errorParam && errorParam !== 'domain' && (
          <div className="mb-6 p-3 bg-error/5 border-l-4 border-error rounded-r flex items-start gap-3 text-left">
            <AlertCircle size={15} className="text-error shrink-0 mt-0.5" />
            <p className="text-[11px] text-error">Erro de autenticação. Tente novamente.</p>
          </div>
        )}

        <button
          onClick={() => {
            setRedirecting(true);
            window.location.href = '/auth/google';
          }}
          disabled={redirecting}
          className="w-full flex items-center justify-center gap-3 py-3 px-6 bg-white text-gray-800 font-bold text-sm rounded-lg hover:bg-gray-100 transition-all shadow disabled:opacity-60 disabled:cursor-not-allowed"
          aria-label="Entrar com Google Workspace"
        >
          {redirecting ? (
            <Loader2 className="w-5 h-5 animate-spin text-gray-500" />
          ) : (
            <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
          )}
          {redirecting ? 'Redirecionando...' : 'Entrar com Google Workspace'}
        </button>

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
const SHARE_CODE_FROM_URL = new URLSearchParams(window.location.search).get('code')?.toUpperCase() ?? '';

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [activeSection, setActiveSection] = useState<Section>('nova');

  // ── Pesquisa global ───────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchMeta, setSearchMeta] = useState<{ total: number; detectedType: string } | null>(null);
  const [searchError, setSearchError] = useState('');
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

  // ── UX-01: Unified toast notification system ─────────────────────────────────
  type ToastKind = 'success' | 'error' | 'info';
  interface Toast { id: string; kind: ToastKind; message: string; }
  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = useCallback((kind: ToastKind, message: string) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(prev => [...prev, { id, kind, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4500);
  }, []);

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
  const [shareRequiresCode, setShareRequiresCode] = useState(false);
  const [shareCodeInput, setShareCodeInput] = useState(SHARE_CODE_FROM_URL);
  const [shareCodeError, setShareCodeError] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);

  // ── UX-07: Accessibility bar state ───────────────────────────────────────────
  type A11yTheme = 'light' | 'dark';
  type A11yFontSize = 'small' | 'normal' | 'large';
const [a11yTheme, setA11yTheme] = useState<A11yTheme>(() => {
    const saved = localStorage.getItem('a11y-theme') as A11yTheme | null;
    if (saved) return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const [a11yHighContrast, setA11yHighContrast] = useState<boolean>(() => localStorage.getItem('a11y-contrast') === 'high');
  const [a11yFontSize, setA11yFontSize] = useState<A11yFontSize>(() => (localStorage.getItem('a11y-font-size') as A11yFontSize) || 'normal');

  // Apply a11y preferences to <html> element
  useEffect(() => {
    const html = document.documentElement;
    // Theme (high contrast overrides dark)
    if (a11yHighContrast) {
      html.removeAttribute('data-theme');
      html.classList.add('high-contrast');
    } else {
      html.classList.remove('high-contrast');
      html.setAttribute('data-theme', a11yTheme);
    }
    // Font size
    html.classList.remove('font-small', 'font-normal', 'font-large');
    html.classList.add(`font-${a11yFontSize}`);
    // Persist
    localStorage.setItem('a11y-theme', a11yTheme);
    localStorage.setItem('a11y-contrast', a11yHighContrast ? 'high' : 'normal');
    localStorage.setItem('a11y-font-size', a11yFontSize);
  }, [a11yTheme, a11yHighContrast, a11yFontSize]);

  // ── Reauditoria seletiva (#26) ────────────────────────────────────────────────
  const [reauditLoading, setReauditLoading] = useState(false);
  const [reauditMessage, setReauditMessage] = useState('');

  // ── Reanálise individual + anotações ─────────────────────────────────────────
  const [reanalyzeContext, setReanalyzeContext] = useState('');
  const [reanalyzingItem, setReanalyzingItem] = useState(false);
  const [noteValue, setNoteValue] = useState('');
  const noteSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── #49: Audit-level notes ────────────────────────────────────────────────────
  const [auditNoteValue, setAuditNoteValue] = useState('');
  const [auditNoteExpanded, setAuditNoteExpanded] = useState(false);
  const [auditNoteSaving, setAuditNoteSaving] = useState(false);
  const auditNoteSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── #46: RAPC column sort ─────────────────────────────────────────────────────
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // ── #53: Needs-review flag + group by activity ────────────────────────────────
  const [reviewFilter, setReviewFilter] = useState(false);
  const [groupByActivity, setGroupByActivity] = useState(false);

  // ── #54: Keyboard shortcuts ───────────────────────────────────────────────────
  const [focusedRow, setFocusedRow] = useState(-1);
  const [showShortcutsPanel, setShowShortcutsPanel] = useState(false);

  // ── #55: Share expiration ─────────────────────────────────────────────────────
  const [shareExpiry, setShareExpiry] = useState<'none' | '7' | '30' | '90'>('none');

  // ── #56: Peek panel ──────────────────────────────────────────────────────────
  const [peekItem, setPeekItem] = useState<AuditItem | null>(null);

  // ── #18: apiFetch — wrapper that redirects to login on 401 ──────────────────
  const apiFetch = useCallback(async (url: string, opts?: RequestInit) => {
    const r = await fetch(url, opts);
    if (r.status === 401) { setUser(null); throw new Error('Unauthorized'); }
    return r;
  }, []);

  // ── Load saved files from server into files state ────────────────────────────
  const loadAuditFiles = useCallback(async (auditId: string, sourceFiles: Record<string, string>) => {
    const slots = ['budget', 'report', 'invoices', 'payments'] as const;
    const updates: Record<string, FileData | null> = {};
    await Promise.all(slots.map(async (slot) => {
      const filename = sourceFiles[slot];
      if (!filename) return;
      try {
        const r = await apiFetch(`/api/audits/${auditId}/files/${filename}`);
        if (!r.ok) return;
        const isPdf = filename.endsWith('.pdf');
        if (isPdf) {
          const buf = await r.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const base64 = btoa(binary);
          updates[slot] = { id: slot, name: filename, size: buf.byteLength, type: 'pdf', content: base64, pages: 0 };
        } else {
          const text = await r.text();
          const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
          updates[slot] = { id: slot, name: filename, size: text.length, type: 'csv', content: parsed.data };
        }
      } catch { /* file fetch failed, leave null */ }
    }));
    if (Object.keys(updates).length > 0) {
      setFiles(prev => ({ ...prev, ...updates }));
    }
  }, [apiFetch]);

  // ── Auth check ──────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/me')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        // #19: save pending deep link item code before redirecting to login
        if (!data) {
          const code = new URLSearchParams(window.location.search).get('item');
          if (code) sessionStorage.setItem('pendingItemCode', code);
        }
        setUser(data); setAuthLoading(false);
      })
      .catch(() => setAuthLoading(false));
  }, []);

  // ── Item deep link: ?item=XXXXXXXX ──────────────────────────────────────────
  useEffect(() => {
    // #19: also check sessionStorage for code saved before OAuth redirect
    const code = new URLSearchParams(window.location.search).get('item')
              || sessionStorage.getItem('pendingItemCode');
    if (!code || !user) return;
    sessionStorage.removeItem('pendingItemCode');
    apiFetch(`/api/items/${code}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        // Load the full audit then open the item modal
        apiFetch(`/api/audits/${data.auditId}`)
          .then(r => r.ok ? r.json() : null)
          .then(audit => {
            if (audit) {
              setLastAuditResult(audit);
              if (audit.sourceFiles) loadAuditFiles(audit.id, audit.sourceFiles);
            }
            setSelectedItem(data.item);
            setActiveSection('resultado');
          });
      })
      .catch(() => {});
  }, [user, apiFetch, loadAuditFiles]);

  // ── Internal deep link: ?audit=UUID&item=NUM (#44) ──────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const auditParam = params.get('audit');
    const itemParam = params.get('item');
    if (!auditParam || !itemParam || !user) return;
    // Clear params from URL without reload
    const clean = window.location.pathname + window.location.hash;
    window.history.replaceState({}, '', clean);
    apiFetch(`/api/audits/${auditParam}`)
      .then(r => r.ok ? r.json() : null)
      .then(audit => {
        if (!audit) return;
        setLastAuditResult(audit);
        if (audit.sourceFiles) loadAuditFiles(audit.id, audit.sourceFiles);
        const item = audit.items?.find((it: AuditItem) => String(it.id) === String(itemParam));
        if (item) { setSelectedItem(item); setActiveSection('resultado'); }
      })
      .catch(() => {});
  }, [user, apiFetch, loadAuditFiles]);

  // ── History API ─────────────────────────────────────────────────────────────
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const r = await apiFetch('/api/audits');
      if (r.ok) setHistory(await r.json());
    } catch { /* 401 handled by apiFetch */ }
    finally {
      setHistoryLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    if (activeSection === 'historico' && user) loadHistory();
  }, [activeSection, user, loadHistory]);

  // ── Search (debounced) ───────────────────────────────────────────────────────
  useEffect(() => {
    if (activeSection !== 'pesquisa') return;
    const q = searchQuery.trim();
    if (!q) { setSearchResults([]); setSearchMeta(null); setSearchError(''); return; }
    setSearchLoading(true);
    setSearchError('');
    const timer = setTimeout(async () => {
      try {
        const r = await apiFetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        setSearchResults(data.results ?? []);
        setSearchMeta({ total: data.total ?? 0, detectedType: data.detectedType ?? 'fulltext' });
      } catch (e: any) {
        setSearchError(e.message || 'Erro na pesquisa');
        setSearchResults([]);
        setSearchMeta(null);
      } finally {
        setSearchLoading(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [searchQuery, activeSection, apiFetch]);

  // ── CNPJ lookup ──────────────────────────────────────────────────────────────
  const fetchCnpj = useCallback(async (taxId: string) => {
    const digits = taxId.replace(/\D/g, '');
    if (digits.length !== 14) return;
    if (cnpjCache[digits] !== undefined) return;
    setCnpjLoading(prev => ({ ...prev, [digits]: true }));
    try {
      const r = await apiFetch(`/api/cnpj/${digits}`);
      if (r.ok) {
        const data = await r.json();
        setCnpjCache(prev => ({ ...prev, [digits]: data }));
        // Persist in audit result so it survives sessions
        setLastAuditResult(prev => {
          if (!prev) return prev;
          const updated = { ...prev, cnpjData: { ...(prev.cnpjData || {}), [digits]: data } };
          apiFetch(`/api/audits/${prev.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cnpjData: updated.cnpjData }),
          }).catch(() => {});
          return updated;
        });
      } else {
        setCnpjCache(prev => ({ ...prev, [digits]: 'error' }));
      }
    } catch {
      setCnpjCache(prev => ({ ...prev, [digits]: 'error' }));
    } finally {
      setCnpjLoading(prev => ({ ...prev, [digits]: false }));
    }
  }, [cnpjCache, apiFetch]);

  const retryFetchCnpj = useCallback((taxId: string) => {
    const digits = taxId.replace(/\D/g, '');
    setCnpjCache(prev => { const next = { ...prev }; delete next[digits]; return next; });
  }, []);

  // Sync audit-level note when audit changes
  useEffect(() => {
    setAuditNoteValue((lastAuditResult as any)?.auditNotes ?? '');
  }, [lastAuditResult?.id]);

  useEffect(() => {
    setShowCnpjPanel(false);
    setRelatedItems([]);
    setReanalyzeContext('');
    setNoteValue(selectedItem?.auditorNote ?? '');
    if (!selectedItem) return;
    const tidDigits = selectedItem.taxId?.replace(/\D/g, '') ?? '';
    if (tidDigits.length === 14) fetchCnpj(selectedItem.taxId!);
    // Fetch related items across all audits
    const digits = selectedItem.taxId?.replace(/\D/g, '') || '';
    if (digits.length >= 11) {
      setRelatedLoading(true);
      apiFetch(`/api/audits/related?taxId=${digits}`)
        .then(r => r.ok ? r.json() : [])
        .then(data => setRelatedItems(data))
        .catch(() => setRelatedItems([]))
        .finally(() => setRelatedLoading(false));
    }
  }, [selectedItem, fetchCnpj, apiFetch]);

  const fetchShareAudit = useCallback((code: string) => {
    if (!SHARE_TOKEN) return;
    setShareLoading(true);
    setShareError(null);
    const url = code ? `/api/share/${SHARE_TOKEN}?code=${encodeURIComponent(code)}` : `/api/share/${SHARE_TOKEN}`;
    fetch(url)
      .then(r => r.json().then((body: any) => {
        if (!r.ok) {
          if (body.requiresCode) { setShareRequiresCode(true); if (code) setShareCodeError('Código inválido. Tente novamente.'); }
          else setShareError(body.error ?? 'Erro desconhecido');
          return null;
        }
        return body as AuditResult;
      }))
      .then(data => { if (data) { setShareAudit(data); setShareRequiresCode(false); setShareCodeError(''); } })
      .finally(() => setShareLoading(false));
  }, []);

  useEffect(() => {
    if (!SHARE_TOKEN) return;
    fetchShareAudit(SHARE_CODE_FROM_URL);
  }, [fetchShareAudit]);

  const saveAuditToServer = async (result: AuditResult, budgetCsv: any[]) => {
    try {
      const pcCsv = (files.report?.content as any[] | undefined) ?? [];
      const budgetLines = budgetCsv.length > 0 ? computeBudgetLines(budgetCsv, result.items, pcCsv) : undefined;
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

      const r = await apiFetch('/api/audits', { method: 'POST', body: fd });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        console.error('Falha ao salvar auditoria no servidor:', err);
        addToast('error', 'Falha ao salvar a auditoria no servidor. Tente novamente.');
      } else {
        const resp = await r.json();
        const savedSourceFiles = resp.savedFiles || sourceFiles;
        const saved = { ...fullResult, sourceFiles: savedSourceFiles };
        setLastAuditResult(saved);
        setHistory(prev => [{ ...saved, itemCount: saved.items?.length ?? 0 } as any, ...prev]);
        addToast('success', 'Auditoria salva com sucesso.');
      }
    } catch (e) {
      console.error('Falha ao salvar auditoria no servidor:', e);
      addToast('error', 'Erro de rede ao salvar a auditoria. Verifique sua conexão.');
    }
  };

  const deleteAudit = async (id: string) => {
    if (!confirm('Excluir esta auditoria e todos os arquivos relacionados?')) return;
    await apiFetch(`/api/audits/${id}`, { method: 'DELETE' });
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

  const periodValid = true;

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

  // ── XLSX download (#28) ───────────────────────────────────────────────────────
  const handleDownloadXLSX = () => {
    if (!lastAuditResult) return;
    const wb = XLSX.utils.book_new();

    // Sheet 1 — RAPC
    const rapcRows = lastAuditResult.items.map(i => ({
      ID: i.id, Código: i.itemCode ?? '',
      Descrição: i.description, Atividade: i.activity, Data: i.date,
      'Razão Social': i.entity, 'Doc Fiscal': i.docId, 'CNPJ/CPF': i.taxId,
      'Valor (R$)': i.value, Status: i.status,
      'Pág NF': i.nfPage ?? '', 'Pág Comprovante': i.paymentPage ?? '',
      Observações: i.observations,
      ...(i.auditorNote ? { 'Nota do Auditor': i.auditorNote } : {}),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rapcRows), 'RAPC');

    // Sheet 2 — Resumo
    const resumo = [
      { Campo: 'Organização', Valor: lastAuditResult.organization },
      { Campo: 'Contrato', Valor: lastAuditResult.contractNumber },
      { Campo: 'Período', Valor: `${lastAuditResult.periodStart} → ${lastAuditResult.periodEnd}` },
      { Campo: 'Parecer', Valor: lastAuditResult.verdict },
      { Campo: 'Total Itens', Valor: lastAuditResult.metrics.totalItems },
      { Campo: 'Conciliados', Valor: lastAuditResult.metrics.conciliatedItems },
      { Campo: 'Pendentes/Ressalvas', Valor: lastAuditResult.metrics.totalItems - lastAuditResult.metrics.conciliatedItems },
      { Campo: 'Valor Total Executado', Valor: lastAuditResult.metrics.totalValue },
      { Campo: 'Valor Aprovado', Valor: lastAuditResult.metrics.approvedValue },
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resumo), 'Resumo');

    // Sheet 3 — Execução Orçamentária
    if (lastAuditResult.budgetLines && lastAuditResult.budgetLines.length > 0) {
      const budgetRows = lastAuditResult.budgetLines.map(l => ({
        Rubrica: l.activity,
        'Planejado (R$)': l.plannedValue,
        'Executado (R$)': l.executedValue,
        'Saldo (R$)': l.plannedValue - l.executedValue,
        '% Executado': l.plannedValue > 0 ? +((l.executedValue / l.plannedValue) * 100).toFixed(1) : '',
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(budgetRows), 'Execução Orçamentária');
    }

    XLSX.writeFile(wb, `RAPC_${lastAuditResult.contractNumber}.xlsx`);
  };

  // ── Exportar PDF (#9) ─────────────────────────────────────────────────────────
  const handleExportPDF = () => {
    if (!lastAuditResult) return;
    const r = lastAuditResult;

    const esc = (s: string | undefined | null) =>
      String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const verdictClass = r.verdict === 'APROVADO' ? 'ok' : r.verdict === 'DILIGÊNCIA' ? 'err' : 'res';
    const diligenced = r.items.filter(i => i.status === 'Pendente' || i.status === 'Ressalva');
    const noConciliated = r.items.filter(i => i.status === 'Conciliado').length;

    const bLines = r.budgetLines && r.budgetLines.length > 0
      ? r.budgetLines
      : Object.entries(r.items.reduce((acc: Record<string, number>, item) => {
          const act = item.activity || 'Não Classificado';
          acc[act] = (acc[act] || 0) + (item.value || 0);
          return acc;
        }, {}))
        .map(([activity, executedValue]) => ({ activity, plannedValue: 0, executedValue: executedValue as number }))
        .sort((a: any, b: any) => b.executedValue - a.executedValue);

    const hasBudget = bLines.some((l: any) => l.plannedValue > 0);
    const budgetTotalPlanned = bLines.reduce((s: number, l: any) => s + l.plannedValue, 0);
    const budgetTotalExecuted = bLines.reduce((s: number, l: any) => s + l.executedValue, 0);

    const getEntityName = (item: AuditItem): string => {
      const digits = item.taxId?.replace(/\D/g, '') ?? '';
      if (digits.length === 14 && r.cnpjData?.[digits] && r.cnpjData[digits] !== 'error') {
        return (r.cnpjData[digits] as CNPJData).razao_social || item.entity;
      }
      return item.entity;
    };

    const rapcRows = r.items.map(item => {
      const rowClass = item.status === 'Ressalva' ? 'row-res' : item.status === 'Pendente' ? 'row-pend' : '';
      const badgeClass = item.status === 'Conciliado' ? 'badge-ok' : item.status === 'Ressalva' ? 'badge-res' : 'badge-pend';
      return `<tr class="${rowClass}">
        <td style="text-align:center">${item.id}</td>
        <td>${esc(item.description)}</td>
        <td>${esc(item.activity)}</td>
        <td style="text-align:center;white-space:nowrap">${esc(item.date)}</td>
        <td>${esc(getEntityName(item))}</td>
        <td>${esc(item.docId)}</td>
        <td style="white-space:nowrap;font-family:'IBM Plex Mono',monospace">${esc(formatTaxId(item.taxId))}</td>
        <td style="text-align:right;font-weight:700">${formatCurrency(item.value)}</td>
        <td style="text-align:center"><span class="${badgeClass}">${esc(item.status)}</span></td>
        <td style="text-align:center">${esc(item.nfPage) || '—'}</td>
        <td style="text-align:center">${esc(item.paymentPage) || '—'}</td>
        <td style="font-size:7.5pt">${esc(item.observations)}</td>
      </tr>`;
    }).join('\n');

    const budgetRows = bLines.map((l: any) => {
      const saldo = l.plannedValue - l.executedValue;
      const pct = l.plannedValue > 0 ? ((l.executedValue / l.plannedValue) * 100).toFixed(1) : '—';
      const over = l.plannedValue > 0 && l.executedValue > l.plannedValue;
      return `<tr${over ? ' style="background:#fff1f2"' : ''}>
        <td>${esc(l.activity)}</td>
        ${hasBudget ? `<td style="text-align:right">${formatCurrency(l.plannedValue)}</td>` : ''}
        <td style="text-align:right;font-weight:600">${formatCurrency(l.executedValue)}</td>
        ${hasBudget ? `<td style="text-align:right;color:${saldo < 0 ? '#da1e28' : '#198038'};font-weight:600">${formatCurrency(saldo)}</td>` : ''}
        ${hasBudget ? `<td style="text-align:right">${pct}%</td>` : ''}
      </tr>`;
    }).join('\n');

    const diligencedHtml = diligenced.length === 0
      ? `<div style="text-align:center;padding:24px;border:1px dashed #e0e0e0;border-radius:4px;color:#525252;font-size:9pt;text-transform:uppercase;letter-spacing:0.1em">Integridade de dados 100% — nenhum lançamento diligenciado</div>`
      : diligenced.map(item => `
          <div class="dilig-item ${item.status === 'Pendente' ? 'dilig-pend' : 'dilig-res'}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
              <span style="font-weight:700;font-size:10pt">${esc(item.description)}</span>
              <span style="font-family:'IBM Plex Mono',monospace;font-weight:700;white-space:nowrap;margin-left:16px">${formatCurrency(item.value)}</span>
            </div>
            <div style="font-size:8pt;color:#525252;font-family:'IBM Plex Mono',monospace;margin-bottom:6px">
              #${item.id} &bull; ${esc(item.activity)} &bull; ${esc(item.date)} &bull; ${esc(getEntityName(item))}
              ${item.taxId && item.taxId !== 'N/A' ? `&bull; ${esc(formatTaxId(item.taxId))}` : ''}
            </div>
            ${item.observations ? `<div style="font-size:8.5pt;color:#393939;margin-bottom:6px">${esc(item.observations)}</div>` : ''}
            ${item.auditorNote ? `<div style="font-size:8pt;color:#0f62fe;border-top:1px solid #e0e0e0;padding-top:6px;margin-top:6px"><strong>Anotação do Auditor:</strong> ${esc(item.auditorNote)}</div>` : ''}
          </div>`).join('\n');

    const auditedDate = (() => { try { return new Date(r.date).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }); } catch { return r.date; } })();

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Auditoria ${esc(r.contractNumber)} — ${esc(r.organization)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@300;400;600;700;900&display=swap');
@page { margin: 18mm 15mm 18mm 15mm; size: A4 portrait; }
*,*::before,*::after { box-sizing: border-box; }
body { font-family: 'IBM Plex Sans',system-ui,sans-serif; color: #161616; background: #fff; font-size: 10pt; line-height: 1.4; }
.page-break { page-break-before: always; padding-top: 4mm; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
a { color: inherit; text-decoration: none; }
/* Cover */
.cover { display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 250mm; text-align: center; }
.cover-logo { font-size: 30pt; font-weight: 900; letter-spacing: 0.18em; color: #0f62fe; margin-bottom: 6px; }
.cover-sub { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.18em; color: #6f6f6f; margin-bottom: 40px; }
.cover-box { border: 1px solid #e0e0e0; border-radius: 6px; padding: 32px 48px; text-align: left; min-width: 340px; margin-bottom: 40px; }
.field-label { font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.1em; color: #6f6f6f; display: block; margin-bottom: 2px; }
.field-value { font-size: 12pt; font-weight: 600; display: block; margin-bottom: 16px; }
.field-value:last-child { margin-bottom: 0; }
.verdict-ok  { color: #198038; border-color: #198038; }
.verdict-res { color: #9e6900; border-color: #f1c21b; }
.verdict-err { color: #da1e28; border-color: #da1e28; }
.verdict-badge { font-size: 20pt; font-weight: 900; letter-spacing: 0.15em; border: 3px solid; padding: 12px 32px; border-radius: 6px; }
/* Section heading */
h2.section { font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.14em; color: #525252; border-bottom: 1px solid #e0e0e0; padding-bottom: 5px; margin: 0 0 14px 0; }
/* Metrics */
.metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 22px; }
.metric-card { border: 1px solid #e0e0e0; border-radius: 4px; padding: 12px 14px; }
.metric-label { font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.1em; color: #525252; margin-bottom: 4px; }
.metric-value { font-size: 20pt; font-family: 'IBM Plex Mono',monospace; font-weight: 700; line-height: 1.1; }
.metric-sub { font-size: 7.5pt; color: #525252; margin-top: 2px; }
/* Budget table */
table.budget { width: 100%; border-collapse: collapse; font-size: 9pt; margin-bottom: 8px; }
table.budget th { background: #f4f4f4; padding: 5px 9px; border: 1px solid #e0e0e0; font-size: 8pt; text-align: left; }
table.budget td { padding: 5px 9px; border: 1px solid #e0e0e0; }
table.budget tfoot td { background: #f4f4f4; font-weight: 700; }
/* RAPC table */
table.rapc { width: 100%; border-collapse: collapse; font-family: 'IBM Plex Mono',monospace; font-size: 7.5pt; }
table.rapc th { background: #f4f4f4; font-size: 7pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; border: 1px solid #e0e0e0; padding: 5px 7px; white-space: nowrap; }
table.rapc td { border: 1px solid #e0e0e0; padding: 4px 7px; vertical-align: top; font-size: 7.5pt; }
table.rapc tr.row-res td { background: #fffbeb; }
table.rapc tr.row-pend td { background: #fff1f2; }
.badge-ok   { background: #d9f5e5; color: #198038; border: 1px solid #24a148; padding: 1px 5px; border-radius: 3px; font-weight: 700; font-size: 7pt; white-space: nowrap; }
.badge-res  { background: #fef3c7; color: #9e6900; border: 1px solid #f1c21b; padding: 1px 5px; border-radius: 3px; font-weight: 700; font-size: 7pt; white-space: nowrap; }
.badge-pend { background: #ffe0e0; color: #da1e28; border: 1px solid #fa4d56; padding: 1px 5px; border-radius: 3px; font-weight: 700; font-size: 7pt; white-space: nowrap; }
/* Diligenced items */
.dilig-item { border: 1px solid; border-radius: 4px; padding: 10px 13px; margin-bottom: 9px; }
.dilig-pend { border-color: #fa4d56; background: #fff1f2; }
.dilig-res  { border-color: #f1c21b; background: #fffbeb; }
/* Footer */
.footer { border-top: 1px solid #e0e0e0; padding-top: 8px; margin-top: 30px; text-align: center; font-size: 7.5pt; color: #8d8d8d; }
@media print {
  .no-print { display: none !important; }
  .footer { position: fixed; bottom: 0; left: 0; right: 0; }
}
</style>
</head>
<body>

<!-- ── CAPA ──────────────────────────────────────────────────────────────────── -->
<div class="cover">
  <div class="cover-logo">STACK AUDIT™</div>
  <div class="cover-sub">Plataforma de Auditoria Financeira com IA · Casa Hacker</div>
  <div class="cover-box">
    <span class="field-label">Organização</span><span class="field-value">${esc(r.organization)}</span>
    <span class="field-label">Número do Contrato</span><span class="field-value">#${esc(r.contractNumber)}</span>
    <span class="field-label">Período Auditado</span><span class="field-value">${esc(r.periodStart)} → ${esc(r.periodEnd)}</span>
    <span class="field-label">Data da Auditoria</span><span class="field-value" style="margin-bottom:0">${auditedDate}</span>
  </div>
  <div class="verdict-badge verdict-${verdictClass}">${esc(r.verdict)}</div>
  ${r.createdBy ? `<div style="margin-top:18px;font-size:9pt;color:#525252">Auditor responsável: ${esc(r.createdBy)}</div>` : ''}
  <div style="margin-top:8px;font-size:7.5pt;color:#a8a8a8;font-family:'IBM Plex Mono',monospace">ID ${r.id.slice(0, 8).toUpperCase()}</div>
</div>

<!-- ── RESUMO EXECUTIVO ──────────────────────────────────────────────────────── -->
<div class="page-break">
  <h2 class="section">Resumo Executivo</h2>
  <div class="metrics">
    <div class="metric-card">
      <div class="metric-label">Itens Auditados</div>
      <div class="metric-value">${r.metrics.totalItems}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Itens Conciliados</div>
      <div class="metric-value" style="color:#198038">${noConciliated}</div>
      <div class="metric-sub">${r.metrics.totalItems > 0 ? ((noConciliated / r.metrics.totalItems) * 100).toFixed(1) : 0}% do total</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Pendências / Ressalvas</div>
      <div class="metric-value" style="color:${diligenced.length > 0 ? '#da1e28' : '#198038'}">${diligenced.length}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Valor Total Auditado</div>
      <div class="metric-value" style="font-size:14pt">${formatCurrency(r.metrics.totalValue)}</div>
    </div>
  </div>

  <h2 class="section" style="margin-top:8px">Execução Orçamentária por Rubrica</h2>
  <table class="budget">
    <thead>
      <tr>
        <th style="width:45%">Rubrica / Atividade</th>
        ${hasBudget ? `<th style="text-align:right">Planejado (R$)</th>` : ''}
        <th style="text-align:right">Executado (R$)</th>
        ${hasBudget ? `<th style="text-align:right">Saldo (R$)</th><th style="text-align:right">% Exec.</th>` : ''}
      </tr>
    </thead>
    <tbody>${budgetRows}</tbody>
    <tfoot>
      <tr>
        <td><strong>TOTAL</strong></td>
        ${hasBudget ? `<td style="text-align:right">${formatCurrency(budgetTotalPlanned)}</td>` : ''}
        <td style="text-align:right">${formatCurrency(budgetTotalExecuted)}</td>
        ${hasBudget ? `<td style="text-align:right;color:${budgetTotalExecuted > budgetTotalPlanned ? '#da1e28' : '#198038'}">${formatCurrency(budgetTotalPlanned - budgetTotalExecuted)}</td>
        <td style="text-align:right">${budgetTotalPlanned > 0 ? ((budgetTotalExecuted / budgetTotalPlanned) * 100).toFixed(1) : '—'}%</td>` : ''}
      </tr>
    </tfoot>
  </table>
</div>

<!-- ── RAPC ──────────────────────────────────────────────────────────────────── -->
<div class="page-break">
  <h2 class="section">Relatório de Conciliação — RAPC (${r.items.length} lançamentos)</h2>
  <table class="rapc">
    <thead>
      <tr>
        <th>#</th><th>Descrição</th><th>Atividade</th><th>Data</th>
        <th>Razão Social</th><th>Doc Fiscal</th><th>CNPJ / CPF</th>
        <th style="text-align:right">Valor</th><th>Status</th>
        <th>Pág NF</th><th>Pág PG</th><th>Observações</th>
      </tr>
    </thead>
    <tbody>${rapcRows}</tbody>
  </table>
</div>

<!-- ── DILIGENCIADOS ─────────────────────────────────────────────────────────── -->
<div class="page-break">
  <h2 class="section">Lançamentos Diligenciados (${diligenced.length})</h2>
  ${diligencedHtml}
</div>

<div class="footer">
  Stack Audit™ &nbsp;·&nbsp; casahacker.org &nbsp;·&nbsp; Contrato #${esc(r.contractNumber)} &nbsp;·&nbsp; ${esc(r.organization)} &nbsp;·&nbsp; ID ${r.id.slice(0, 8).toUpperCase()}
</div>

<script>window.onload = function() { setTimeout(function() { window.focus(); window.print(); }, 150); };</script>
</body>
</html>`;

    const win = window.open('', '_blank', 'width=960,height=760');
    if (!win) { alert('Permita pop-ups para exportar o PDF.'); return; }
    win.document.write(html);
    win.document.close();
  };

  // ── Reauditoria seletiva (#26) ────────────────────────────────────────────────
  const handleReauditSelectiva = async () => {
    if (!lastAuditResult) return;
    const targets = lastAuditResult.items.filter(i => i.status === 'Pendente' || i.status === 'Ressalva');
    if (targets.length === 0) return;
    setReauditLoading(true);
    setReauditMessage('Reanalisando no servidor...');
    try {
      const r = await apiFetch(`/api/audits/${lastAuditResult.id}/reprocess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds: targets.map(i => i.id), additionalContext: '' }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { items: updated } = await r.json();
      const merged = lastAuditResult.items.map(i => {
        const u = (updated as AuditItem[]).find(u => u.id === i.id);
        return u ?? i;
      });
      const newResult = { ...lastAuditResult, items: merged };
      setLastAuditResult(newResult);
      setSelectedItem(null);
      await apiFetch(`/api/audits/${lastAuditResult.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: updated }),
      });
      setReauditMessage('');
    } catch (e) {
      setReauditMessage(`Erro: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setReauditLoading(false);
    }
  };

  // ── Imprimir / exportar lançamento (#45) ────────────────────────────────────
  const handlePrintItem = () => {
    if (!selectedItem || !lastAuditResult) return;
    const item = selectedItem;
    const audit = lastAuditResult;
    const statusColor = item.status === 'Conciliado' ? '#24a148' : item.status === 'Ressalva' ? '#f1c21b' : '#da1e28';
    const row = (label: string, value: string | number | undefined) =>
      value && value !== 'N/A' ? `<tr><td class="label">${label}</td><td class="value">${value}</td></tr>` : '';
    // Casa Hacker logo — SVG inline so it works in the print popup (no CORS/path issues)
    const logoSvg = `<svg width="120" height="32" viewBox="0 0 120 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="32" height="32" rx="4" fill="#0f62fe"/>
      <text x="6" y="22" font-family="monospace" font-size="18" font-weight="800" fill="#fff">CH</text>
      <text x="40" y="14" font-family="'IBM Plex Mono',monospace" font-size="9" font-weight="700" fill="#0f62fe" text-anchor="start" letter-spacing="1">CASA HACKER</text>
      <text x="40" y="26" font-family="'IBM Plex Mono',monospace" font-size="7" fill="#525252" text-anchor="start" letter-spacing="0.5">Stack Audit™</text>
    </svg>`;
    const originalRowHtml = item.originalRow
      ? Object.entries(item.originalRow).map(([k, v]) => row(k, String(v ?? ''))).join('')
      : row('Dados originais', 'Não disponível');
    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<title>Lançamento #${item.id} — ${audit.organization}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'IBM Plex Mono',Consolas,monospace;font-size:11px;color:#161616;background:#fff;padding:28px 32px}
  header{border-bottom:2px solid #0f62fe;padding-bottom:14px;margin-bottom:18px;display:flex;justify-content:space-between;align-items:center}
  header .title{display:flex;flex-direction:column;gap:4px}
  header h1{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#0f62fe}
  header .subtitle{font-size:9px;color:#525252}
  header .meta{text-align:right;font-size:9px;color:#525252;line-height:1.7}
  .badge{display:inline-block;padding:3px 10px;border:1px solid ${statusColor};color:${statusColor};font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;border-radius:2px;margin-bottom:14px}
  .section{margin-bottom:18px}
  .section h2{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.15em;color:#0f62fe;border-bottom:1px solid #e0e0e0;padding-bottom:5px;margin-bottom:8px}
  table{width:100%;border-collapse:collapse}
  td{padding:4px 0;border-bottom:1px solid #f4f4f4;vertical-align:top}
  .label{width:160px;color:#525252;text-transform:uppercase;font-size:9px;padding-right:8px}
  .value{font-weight:600;text-transform:uppercase;font-size:9px;word-break:break-word}
  .grid{display:table;width:100%;table-layout:fixed}
  .col{display:table-cell;width:50%;vertical-align:top;padding-right:20px}
  .col:last-child{padding-right:0;padding-left:20px;border-left:1px solid #e0e0e0}
  .obs{background:#f4f4f4;padding:10px;font-size:10px;color:#393939;line-height:1.5;text-transform:uppercase;min-height:50px}
  footer{margin-top:28px;border-top:1px solid #e0e0e0;padding-top:10px;font-size:8px;color:#8d8d8d;text-align:center;text-transform:uppercase;letter-spacing:.08em}
  @media print{
    @page{margin:16mm}
    body{padding:0}
    footer{position:fixed;bottom:0;left:0;right:0;background:#fff}
  }
</style></head><body>
<header>
  <div style="display:flex;align-items:center;gap:16px">
    ${logoSvg}
    <div class="title">
      <h1>Detalhes do Lançamento</h1>
      <span class="subtitle">${audit.organization} &bull; Contrato ${audit.contractNumber} &bull; ${audit.periodStart} → ${audit.periodEnd}</span>
    </div>
  </div>
  <div class="meta">
    Gerado em ${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'})}<br>
    Lançamento #${item.id}${item.itemCode ? ` &bull; Cód. ${item.itemCode}` : ''}
  </div>
</header>
<div><span class="badge">${item.status}</span></div>
<div class="grid">
  <div class="col section">
    <h2>Apuração Stack Audit™</h2>
    <table>
      ${row('Descrição', item.description)}
      ${row('Atividade / Rubrica', item.activity)}
      ${row('Data', item.date)}
      ${row('Fornecedor', item.entity)}
      ${row('CNPJ / CPF', item.taxId)}
      ${row('Doc Fiscal (ID)', item.docId)}
      ${row('Valor', formatCurrency(item.value))}
      ${row('Pág. Nota Fiscal', item.nfPage)}
      ${row('Pág. Comprovante', item.paymentPage)}
      ${item.emissionDateTime ? row('Data/Hora Emissão', item.emissionDateTime) : ''}
      ${item.transactionId ? row('ID Transação', item.transactionId) : ''}
      ${item.paymentMethod ? row('Meio de Pagamento', item.paymentMethod) : ''}
      ${item.payerInfo ? row('Pagador', item.payerInfo) : ''}
      ${item.payeeInfo ? row('Recebedor', item.payeeInfo) : ''}
    </table>
  </div>
  <div class="col section">
    <h2>Lançamento — Planilha de Prestação</h2>
    <table>${originalRowHtml}</table>
  </div>
</div>
<div class="section">
  <h2>Observações Stack Audit™</h2>
  <div class="obs">${item.observations || (item.status === 'Conciliado' ? 'Lançamento conciliado com documentos fiscais e comprovantes de pagamento sem divergências.' : 'Nenhuma observação registrada.')}</div>
</div>
${item.auditorNote ? `<div class="section"><h2>Anotação do Auditor</h2><div class="obs" style="border-left:3px solid #0f62fe">${item.auditorNote}</div></div>` : ''}
<footer>CONFIDENCIAL — USO INTERNO &nbsp;&bull;&nbsp; Stack Audit™ — Associação Casa Hacker &nbsp;&bull;&nbsp; CNPJ 36.038.079/0001-97</footer>
<script>window.onload=()=>{window.print();}</script>
</body></html>`;
    const win = window.open('', '_blank', 'width=900,height=700');
    if (win) { win.document.write(html); win.document.close(); }
  };

  // ── Reanálise de item individual ──────────────────────────────────────────────
  const handleReanalyzeItem = async () => {
    if (!selectedItem || !lastAuditResult) return;
    setReanalyzingItem(true);
    try {
      const r = await apiFetch(`/api/audits/${lastAuditResult.id}/reprocess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds: [selectedItem.id], additionalContext: reanalyzeContext }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { items } = await r.json();
      const updated = items[0] as AuditItem;
      const newItems = lastAuditResult.items.map(i => i.id === updated.id ? updated : i);
      setLastAuditResult({ ...lastAuditResult, items: newItems });
      setSelectedItem(updated);
      await apiFetch(`/api/audits/${lastAuditResult.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [updated] }),
      });
      setReanalyzeContext('');
    } catch (e) {
      console.error('Reanálise falhou:', e);
    } finally {
      setReanalyzingItem(false);
    }
  };

  // ── Salvar nota do auditor (debounced) ────────────────────────────────────────
  const handleNoteChange = (value: string) => {
    setNoteValue(value);
    if (noteSaveTimer.current) clearTimeout(noteSaveTimer.current);
    noteSaveTimer.current = setTimeout(async () => {
      if (!selectedItem || !lastAuditResult) return;
      const updatedItem = { ...selectedItem, auditorNote: value };
      const newItems = lastAuditResult.items.map(i => i.id === updatedItem.id ? updatedItem : i);
      setLastAuditResult({ ...lastAuditResult, items: newItems });
      setSelectedItem(updatedItem);
      await apiFetch(`/api/audits/${lastAuditResult.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ id: selectedItem.id, auditorNote: value }] }),
      }).catch(() => {});
    }, 800);
  };

  // ── #49: Audit-level notes (debounced) ────────────────────────────────────────
  const handleAuditNoteChange = (value: string) => {
    setAuditNoteValue(value);
    setAuditNoteSaving(true);
    if (auditNoteSaveTimer.current) clearTimeout(auditNoteSaveTimer.current);
    auditNoteSaveTimer.current = setTimeout(async () => {
      if (!lastAuditResult) return;
      await apiFetch(`/api/audits/${lastAuditResult.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auditNotes: value, auditNotesUpdatedAt: new Date().toISOString(), auditNotesUpdatedBy: user?.email }),
      }).catch(() => {});
      setAuditNoteSaving(false);
    }, 1000);
  };

  // ── #53: Toggle needs-review flag ────────────────────────────────────────────
  const handleToggleReviewFlag = async (item: AuditItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!lastAuditResult) return;
    const updated = { ...item, needsReview: !item.needsReview };
    const newItems = lastAuditResult.items.map(i => i.id === updated.id ? updated : i);
    setLastAuditResult({ ...lastAuditResult, items: newItems });
    if (selectedItem?.id === item.id) setSelectedItem(updated);
    if (peekItem?.id === item.id) setPeekItem(updated);
    await apiFetch(`/api/audits/${lastAuditResult.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: item.id, needsReview: !item.needsReview }] }),
    }).catch(() => {});
  };

  // ── #54: Keyboard shortcuts ───────────────────────────────────────────────────
  const rapcSearchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (activeSection !== 'resultado') return;
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === '?') { e.preventDefault(); setShowShortcutsPanel(p => !p); return; }
      if (e.key === '/') { e.preventDefault(); rapcSearchRef.current?.focus(); return; }
      if (e.key === 'Escape') {
        if (showShortcutsPanel) { setShowShortcutsPanel(false); return; }
        if (peekItem) { setPeekItem(null); return; }
        if (selectedItem) { setSelectedItem(null); return; }
        return;
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedRow(r => Math.min(r + 1, filteredItems.length - 1));
        return;
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedRow(r => Math.max(r - 1, 0));
        return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && focusedRow >= 0 && focusedRow < filteredItems.length) {
        e.preventDefault();
        setSelectedItem(filteredItems[focusedRow]);
        return;
      }
      if (e.key === 'p' && focusedRow >= 0 && focusedRow < filteredItems.length) {
        e.preventDefault();
        setPeekItem(filteredItems[focusedRow]);
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeSection, filteredItems, focusedRow, selectedItem, peekItem, showShortcutsPanel]);

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
          {!shareLoading && shareRequiresCode && !shareAudit && (
            <div className="max-w-sm mx-auto mt-20 p-8 border border-line bg-card rounded-xl text-center">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              </div>
              <h2 className="text-sm font-bold uppercase tracking-widest mb-1">Acesso Protegido</h2>
              <p className="text-[11px] text-text-secondary mb-6">Informe o código de acesso enviado pelo auditor para visualizar esta auditoria.</p>
              <form onSubmit={e => { e.preventDefault(); setShareCodeError(''); fetchShareAudit(shareCodeInput.trim().toUpperCase()); }} className="space-y-3">
                <input
                  type="text"
                  value={shareCodeInput}
                  onChange={e => setShareCodeInput(e.target.value.toUpperCase())}
                  placeholder="EX: AB3K9Z"
                  maxLength={8}
                  autoFocus
                  className="w-full bg-bg border border-line rounded px-4 py-3 text-center text-xl font-mono font-bold tracking-[0.4em] text-primary focus:outline-none focus:border-primary transition-colors uppercase"
                />
                {shareCodeError && <p className="text-[11px] text-error">{shareCodeError}</p>}
                <button type="submit" disabled={shareCodeInput.length < 4} className="w-full py-3 bg-primary text-bg font-bold text-xs uppercase tracking-widest rounded hover:opacity-90 transition-all disabled:opacity-40">
                  Acessar Auditoria
                </button>
              </form>
            </div>
          )}
          {shareError && !shareRequiresCode && (
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
                {/* #23 — warn if budget columns unrecognized or budget CSV absent */}
                {sa.budgetLines && sa.budgetLines.length > 0 &&
                 sa.budgetLines.every(l => l.plannedValue === 0) && (
                  <div className="mb-3 flex items-start gap-2 text-[11px] text-amber-400 bg-amber-400/10 rounded p-2.5 border border-amber-400/20">
                    <AlertCircle size={13} className="mt-0.5 shrink-0" />
                    <span>Colunas de rubrica/valor não foram reconhecidas no CSV de orçamento. Valores planejados indisponíveis — exibindo apenas o executado.</span>
                  </div>
                )}
                {!sa.budgetLines && (
                  <p className="mb-2 text-[10px] text-text-secondary italic">Orçamento aprovado não enviado — exibindo execução por atividade sem comparativo de limite.</p>
                )}
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
                          <td className="px-4 py-2.5 border-r border-line uppercase">{(() => { const d = item.taxId?.replace(/\D/g,'') ?? ''; return (d.length === 14 && shareAudit?.cnpjData?.[d] && shareAudit.cnpjData[d] !== 'error') ? (shareAudit.cnpjData[d] as CNPJData).razao_social || item.entity : item.entity; })()}</td>
                          <td className="px-4 py-2.5 border-r border-line">{item.docId}</td>
                          <td className="px-4 py-2.5 border-r border-line">{formatTaxId(item.taxId)}</td>
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
        {selectedItem && (() => {
          const auditId = lastAuditResult?.id;
          const canDownloadNf = isPageDownloadable(selectedItem.nfPage);
          const canDownloadPay = isPageDownloadable(selectedItem.paymentPage);
          const docUrl = (type: 'nf' | 'payment') =>
            `/api/audits/${auditId}/items/${selectedItem.id}/doc?type=${type}`;
          return (
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

                {/* ── Download doc PDFs ──────────────────────────────────── */}
                {auditId && (canDownloadNf || canDownloadPay) && (
                  <div className="mt-5 pt-4 border-t border-line">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-text-secondary mb-3">Exportar Documentos</p>
                    <div className="flex gap-3 flex-wrap">
                      <a
                        href={canDownloadNf ? docUrl('nf') : undefined}
                        download
                        aria-disabled={!canDownloadNf}
                        className={cn(
                          'flex items-center gap-2 px-3 py-2 rounded border text-[11px] font-bold uppercase tracking-widest transition-all',
                          canDownloadNf
                            ? 'bg-sidebar border-line hover:border-primary hover:text-primary text-text-secondary cursor-pointer'
                            : 'border-line/40 text-text-secondary/30 cursor-not-allowed pointer-events-none'
                        )}
                        title={canDownloadNf ? `Baixar PDF — Pág(s): ${selectedItem.nfPage}` : `Página não identificada (${selectedItem.nfPage || 'N/A'})`}
                      >
                        <FileDown size={13} />
                        Doc Fiscal (NF)
                        {selectedItem.nfPage && selectedItem.nfPage !== 'N/A' && (
                          <span className="font-mono text-[9px] text-text-secondary/60 ml-1">{selectedItem.nfPage}</span>
                        )}
                      </a>
                      <a
                        href={canDownloadPay ? docUrl('payment') : undefined}
                        download
                        aria-disabled={!canDownloadPay}
                        className={cn(
                          'flex items-center gap-2 px-3 py-2 rounded border text-[11px] font-bold uppercase tracking-widest transition-all',
                          canDownloadPay
                            ? 'bg-sidebar border-line hover:border-primary hover:text-primary text-text-secondary cursor-pointer'
                            : 'border-line/40 text-text-secondary/30 cursor-not-allowed pointer-events-none'
                        )}
                        title={canDownloadPay ? `Baixar PDF — Pág(s): ${selectedItem.paymentPage}` : `Página não identificada (${selectedItem.paymentPage || 'N/A'})`}
                      >
                        <FileDown size={13} />
                        Comprovante de Pagamento
                        {selectedItem.paymentPage && selectedItem.paymentPage !== 'N/A' && (
                          <span className="font-mono text-[9px] text-text-secondary/60 ml-1">{selectedItem.paymentPage}</span>
                        )}
                      </a>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          );
        })()}
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

  const filteredItems = (() => {
    let items = (lastAuditResult?.items ?? []).filter(item => {
      const matchesStatus = statusFilter === 'Todos' || item.status === statusFilter;
      if (!matchesStatus) return false;
      if (reviewFilter && !item.needsReview) return false;
      if (!rapcSearch) return true;
      const q = rapcSearch.toLowerCase();
      return [item.description, item.activity, item.entity, item.docId, item.taxId, item.date, String(item.value), item.status, item.nfPage, item.paymentPage, item.observations]
        .some(v => String(v || '').toLowerCase().includes(q));
    });
    if (sortBy) {
      items = [...items].sort((a: any, b: any) => {
        let va = a[sortBy], vb = b[sortBy];
        if (sortBy === 'value') { va = Number(va) || 0; vb = Number(vb) || 0; }
        else if (sortBy === 'date') { va = new Date(va?.split('/').reverse().join('-') || 0).getTime(); vb = new Date(vb?.split('/').reverse().join('-') || 0).getTime(); }
        else { va = String(va || '').toLowerCase(); vb = String(vb || '').toLowerCase(); }
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return items;
  })();

  return (
    <>
    {/* ── UX-07: Accessibility bar — fixed top strip ───────────────────────── */}
    <div
      role="navigation"
      aria-label="Barra de acessibilidade"
      className="fixed top-0 left-0 right-0 h-8 z-[110] flex items-center px-4 gap-4 bg-[#21272a] text-white border-b border-white/10 text-[11px] select-none"
    >
      <span className="flex items-center gap-1.5 font-bold uppercase tracking-widest text-white/60 shrink-0">
        <Accessibility size={12} />
        Acessibilidade
      </span>
      <span className="w-px h-4 bg-white/20 shrink-0" />
      {/* Theme */}
      <span className="text-white/40 uppercase tracking-wider shrink-0">Tema</span>
      <button
        onClick={() => { setA11yHighContrast(false); setA11yTheme('light'); }}
        className={cn('flex items-center gap-1 px-2 py-0.5 rounded transition-all', !a11yHighContrast && a11yTheme === 'light' ? 'bg-primary text-white' : 'text-white/60 hover:text-white hover:bg-white/10')}
        aria-pressed={!a11yHighContrast && a11yTheme === 'light'}
        aria-label="Tema claro"
      >
        <Sun size={11} /> Claro
      </button>
      <button
        onClick={() => { setA11yHighContrast(false); setA11yTheme('dark'); }}
        className={cn('flex items-center gap-1 px-2 py-0.5 rounded transition-all', !a11yHighContrast && a11yTheme === 'dark' ? 'bg-primary text-white' : 'text-white/60 hover:text-white hover:bg-white/10')}
        aria-pressed={!a11yHighContrast && a11yTheme === 'dark'}
        aria-label="Tema escuro"
      >
        <Moon size={11} /> Escuro
      </button>
      <span className="w-px h-4 bg-white/20 shrink-0" />
      {/* High contrast */}
      <button
        onClick={() => setA11yHighContrast(p => !p)}
        className={cn('flex items-center gap-1 px-2 py-0.5 rounded transition-all', a11yHighContrast ? 'bg-primary text-white' : 'text-white/60 hover:text-white hover:bg-white/10')}
        aria-pressed={a11yHighContrast}
        aria-label="Alto contraste WCAG AA"
      >
        <Contrast size={11} /> Alto Contraste
      </button>
      <span className="w-px h-4 bg-white/20 shrink-0" />
      {/* Font size */}
      <span className="text-white/40 uppercase tracking-wider shrink-0">Fonte</span>
      {([['small', 'A−'], ['normal', 'A'], ['large', 'A+']] as const).map(([size, label]) => (
        <button
          key={size}
          onClick={() => setA11yFontSize(size)}
          className={cn('px-2 py-0.5 rounded font-bold transition-all', a11yFontSize === size ? 'bg-primary text-white' : 'text-white/60 hover:text-white hover:bg-white/10', size === 'small' ? 'text-[10px]' : size === 'large' ? 'text-[13px]' : 'text-[11px]')}
          aria-pressed={a11yFontSize === size}
          aria-label={`Fonte ${size === 'small' ? 'pequena' : size === 'normal' ? 'normal' : 'grande'}`}
        >
          {label}
        </button>
      ))}
    </div>

    <div className="flex min-h-screen pt-8">
      {/* UX-02: Skip to main content link */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-10 focus:left-2 focus:z-[200] focus:bg-primary focus:text-white focus:px-4 focus:py-2 focus:rounded focus:text-xs focus:font-bold focus:uppercase focus:tracking-widest focus:outline-none"
      >
        Ir para conteúdo principal
      </a>

      {/* Sidebar */}
      <aside className="fixed left-0 top-8 h-[calc(100vh-2rem)] w-[180px] bg-sidebar border-r border-line flex flex-col z-50">
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
            { id: 'pesquisa', label: 'Pesquisa', icon: Search },
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
      <main id="main-content" className="ml-[180px] flex-1 min-w-[844px] flex flex-col">
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
                  <CheckItem label="Metadados do contrato" checked={!!metadata.organization && !!metadata.contractNumber} />
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
              <div className="mb-8 px-5 py-4 bg-card border border-line rounded-lg space-y-3">
                {/* URL row */}
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <Link2 size={14} className="text-primary shrink-0" />
                    <span className="text-[11px] text-text-secondary font-mono truncate">
                      {`${window.location.origin}/share/${lastAuditResult.shareToken}`}
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      const base = `${window.location.origin}/share/${lastAuditResult.shareToken}`;
                      const url = lastAuditResult.shareAccessCode ? `${base}?code=${lastAuditResult.shareAccessCode}` : base;
                      navigator.clipboard.writeText(url);
                      setLinkCopied(true);
                      setTimeout(() => setLinkCopied(false), 2000);
                    }}
                    className={cn(
                      'shrink-0 flex items-center gap-2 px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded border transition-all',
                      linkCopied ? 'border-success/40 bg-success/10 text-success' : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20'
                    )}
                  >
                    <Link2 size={11} />
                    {linkCopied ? 'Copiado!' : 'Copiar link'}
                  </button>
                </div>
                {/* Access code row */}
                {lastAuditResult.shareAccessCode && (
                  <div className="flex items-center gap-3 pt-2 border-t border-line">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary shrink-0"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    <div className="flex items-center gap-3 flex-1">
                      <span className="text-[10px] text-text-secondary uppercase tracking-widest">Código de acesso:</span>
                      <span className="font-mono font-bold text-primary text-base tracking-[0.3em]">{lastAuditResult.shareAccessCode}</span>
                      <span className="text-[9px] text-text-secondary/60">· Envie separadamente do link por segurança</span>
                    </div>
                    <button
                      onClick={() => navigator.clipboard.writeText(lastAuditResult.shareAccessCode!)}
                      className="text-[10px] text-text-secondary hover:text-primary transition-colors px-2 py-1 border border-line rounded"
                    >
                      Copiar código
                    </button>
                  </div>
                )}
                {/* #55 Expiry controls */}
                <div className="flex items-center gap-3 pt-2 border-t border-line flex-wrap">
                  <Clock size={12} className="text-text-secondary shrink-0" />
                  <span className="text-[10px] text-text-secondary uppercase tracking-widest">Validade do link:</span>
                  <div className="flex gap-1">
                    {([['none', 'Sem expiração'], ['7', '7 dias'], ['30', '30 dias'], ['90', '90 dias']] as const).map(([val, lbl]) => (
                      <button
                        key={val}
                        onClick={() => {
                          setShareExpiry(val);
                          if (val !== 'none' && lastAuditResult?.id) {
                            apiFetch(`/api/audits/${lastAuditResult.id}`, {
                              method: 'PATCH',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ shareExpiresAt: val === 'none' ? null : new Date(Date.now() + Number(val) * 86400000).toISOString() }),
                            }).catch(() => {});
                          }
                        }}
                        className={cn('px-2 py-0.5 text-[9px] font-bold uppercase rounded border transition-all', shareExpiry === val ? 'border-primary/50 bg-primary/10 text-primary' : 'border-line text-text-secondary hover:text-text')}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={async () => {
                      if (!lastAuditResult?.id) return;
                      if (!confirm('Revogar o link de compartilhamento? Isso tornará o link atual inválido.')) return;
                      await apiFetch(`/api/audits/${lastAuditResult.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ shareToken: null, shareAccessCode: null }),
                      }).catch(() => {});
                      setLastAuditResult({ ...lastAuditResult, shareToken: undefined, shareAccessCode: undefined });
                      addToast('success', 'Link de compartilhamento revogado');
                    }}
                    className="ml-auto text-[9px] text-error/70 hover:text-error border border-error/20 hover:border-error/40 px-2 py-0.5 rounded transition-all"
                  >
                    Revogar link
                  </button>
                </div>
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

              {/* #23 — warn if budget columns unrecognized or budget CSV absent */}
              {lastAuditResult.budgetLines && lastAuditResult.budgetLines.length > 0 &&
               lastAuditResult.budgetLines.every(l => l.plannedValue === 0) && (
                <div className="mb-3 flex items-start gap-2 text-[11px] text-amber-400 bg-amber-400/10 rounded p-2.5 border border-amber-400/20">
                  <AlertCircle size={13} className="mt-0.5 shrink-0" />
                  <span>Colunas de rubrica/valor não foram reconhecidas no CSV de orçamento. Valores planejados indisponíveis — exibindo apenas o executado.</span>
                </div>
              )}
              {!lastAuditResult.budgetLines && (
                <p className="mb-2 text-[10px] text-text-secondary italic">Orçamento aprovado não enviado — exibindo execução por atividade sem comparativo de limite.</p>
              )}
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

            {/* #49 Audit notes */}
            <div className="bg-card border border-line rounded mb-10">
              <button
                onClick={() => setAuditNoteExpanded(p => !p)}
                className="w-full px-5 py-3.5 flex items-center justify-between text-[11px] font-bold uppercase tracking-widest text-text-secondary hover:text-text transition-colors"
              >
                <span className="flex items-center gap-2">
                  <NotebookPen size={13} className="text-primary" />
                  Notas do Auditor
                  {auditNoteValue && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
                </span>
                <span className="flex items-center gap-2">
                  {auditNoteSaving && <Loader2 size={11} className="animate-spin text-primary" />}
                  {auditNoteExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </span>
              </button>
              {auditNoteExpanded && (
                <div className="px-5 pb-4 border-t border-line">
                  <textarea
                    value={auditNoteValue}
                    onChange={e => handleAuditNoteChange(e.target.value)}
                    placeholder="Adicione observações gerais sobre esta auditoria (visível apenas para usuários autenticados)..."
                    className="w-full mt-3 bg-bg border border-line rounded p-3 text-[12px] text-text placeholder:text-text-secondary/50 resize-y min-h-[80px] focus:outline-none focus:border-primary transition-colors font-mono"
                    rows={4}
                  />
                  <p className="text-[9px] text-text-secondary mt-1">Salvo automaticamente · Vinculado ao auditor: {user?.email}</p>
                </div>
              )}
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
                      ref={rapcSearchRef}
                      type="text"
                      value={rapcSearch}
                      onChange={e => setRapcSearch(e.target.value)}
                      placeholder="Buscar lançamento... (/)"
                      aria-label="Buscar lançamento na tabela RAPC"
                      className="pl-7 pr-3 py-1.5 text-[11px] bg-sidebar border border-line rounded focus:outline-none focus:border-primary transition-colors w-52 text-text placeholder:text-text-secondary/50"
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
                  {/* #53 Review filter */}
                  <button
                    onClick={() => setReviewFilter(p => !p)}
                    className={cn('flex items-center gap-1.5 px-3 py-1.5 border text-[10px] font-bold uppercase tracking-widest transition-all rounded', reviewFilter ? 'border-amber-500/50 bg-amber-500/10 text-amber-400' : 'border-line bg-sidebar text-text-secondary hover:text-text')}
                    title="Filtrar itens marcados para revisão"
                  >
                    <Flag size={11} /> Revisão
                  </button>
                  {/* #47 Group by activity */}
                  <button
                    onClick={() => setGroupByActivity(p => !p)}
                    className={cn('flex items-center gap-1.5 px-3 py-1.5 border text-[10px] font-bold uppercase tracking-widest transition-all rounded', groupByActivity ? 'border-primary/50 bg-primary/10 text-primary' : 'border-line bg-sidebar text-text-secondary hover:text-text')}
                    title="Agrupar por atividade/rubrica"
                  >
                    <Layers size={11} /> Agrupar
                  </button>
                  <button onClick={handleDownloadCSV} className="flex items-center gap-2 px-3 py-1.5 bg-sidebar border border-line hover:border-primary text-[10px] font-bold uppercase tracking-widest transition-all">
                    <Download size={12} /> CSV
                  </button>
                  <button onClick={handleDownloadXLSX} className="flex items-center gap-2 px-3 py-1.5 bg-sidebar border border-line hover:border-primary text-[10px] font-bold uppercase tracking-widest transition-all">
                    <Download size={12} /> XLSX
                  </button>
                  <button onClick={handleExportPDF} className="flex items-center gap-2 px-3 py-1.5 bg-sidebar border border-line hover:border-primary text-[10px] font-bold uppercase tracking-widest transition-all">
                    <FileDown size={12} /> PDF
                  </button>
                  {/* #26 — Reauditoria seletiva */}
                  {diligencedItems.length > 0 && (
                    <button
                      onClick={handleReauditSelectiva}
                      disabled={reauditLoading}
                      className="flex items-center gap-2 px-3 py-1.5 border border-warning/50 text-warning bg-warning/5 hover:bg-warning/10 text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-50"
                    >
                      {reauditLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                      Reanalisar Pendentes/Ressalvas ({diligencedItems.length})
                    </button>
                  )}
                  {/* #54 Keyboard shortcuts hint */}
                  <button
                    onClick={() => setShowShortcutsPanel(p => !p)}
                    title="Atalhos de teclado (?)"
                    className={cn('p-1.5 border rounded transition-all', showShortcutsPanel ? 'border-primary/50 text-primary bg-primary/10' : 'border-line text-text-secondary hover:text-text')}
                  >
                    <Keyboard size={12} />
                  </button>
                </div>
              </div>
              {showShortcutsPanel && (
                <div className="px-6 py-3 bg-sidebar border-b border-line text-[10px] text-text-secondary">
                  <div className="flex flex-wrap gap-x-6 gap-y-1.5">
                    {[
                      ['j / ↓', 'Próxima linha'],
                      ['k / ↑', 'Linha anterior'],
                      ['Enter', 'Abrir detalhe'],
                      ['p', 'Prévia rápida'],
                      ['/', 'Buscar'],
                      ['Esc', 'Fechar / Voltar'],
                      ['?', 'Mostrar atalhos'],
                    ].map(([key, desc]) => (
                      <span key={key} className="flex items-center gap-1.5">
                        <kbd className="px-1.5 py-0.5 bg-bg border border-line rounded text-[9px] font-mono font-bold text-primary">{key}</kbd>
                        <span>{desc}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {reauditLoading && reauditMessage && (
                <div className="px-6 py-2 bg-warning/5 border-b border-warning/20 text-[11px] text-warning flex items-center gap-2">
                  <Loader2 size={11} className="animate-spin shrink-0" /> {reauditMessage}
                </div>
              )}
              {rapcSearch && (
                <div className="px-6 py-2 bg-primary/5 border-b border-line text-[10px] text-primary font-mono">
                  {filteredItems.length} resultado{filteredItems.length !== 1 ? 's' : ''} para "{rapcSearch}"
                </div>
              )}
              <div className="overflow-x-auto custom-scrollbar">
                <table className="w-full text-left text-[11px] border-collapse" role="grid" aria-label="Relatório de Conciliação">
                  <thead className="bg-sidebar text-text-secondary uppercase text-[10px] tracking-tighter">
                    <tr className="border-b border-line">
                      {([
                        { label: '#', field: null },
                        { label: 'Código', field: null },
                        { label: 'Descrição', field: 'description' },
                        { label: 'Atividade', field: 'activity' },
                        { label: 'Data', field: 'date' },
                        { label: 'Razão Social', field: 'entity' },
                        { label: 'ID Doc Fiscal', field: null },
                        { label: 'CNPJ/CPF', field: null },
                        { label: 'Valor', field: 'value' },
                        { label: 'Status', field: 'status' },
                        { label: 'Pág NF', field: null },
                        { label: 'Pág PG', field: null },
                        { label: 'Observações', field: null },
                        { label: '', field: null },
                      ] as { label: string; field: string | null }[]).map(({ label, field }, i) => (
                        <th
                          key={i}
                          onClick={field ? () => { if (sortBy === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortBy(field); setSortDir('asc'); } } : undefined}
                          className={cn(
                            'px-4 py-3 font-semibold border-r border-line select-none',
                            label === 'Valor' && 'text-right',
                            ['Data', 'Status', 'Pág NF', 'Pág PG'].includes(label) && 'text-center',
                            field && 'cursor-pointer hover:text-text hover:bg-bg/30 transition-colors',
                          )}
                          aria-sort={field && sortBy === field ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                        >
                          <span className="inline-flex items-center gap-1">
                            {label}
                            {field && sortBy === field && (sortDir === 'asc' ? <ChevronUp size={10} className="text-primary" /> : <ChevronDown size={10} className="text-primary" />)}
                            {field && sortBy !== field && <ChevronUp size={10} className="opacity-0 group-hover:opacity-30" />}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line font-mono">
                    {filteredItems.length === 0 ? (
                      <tr>
                        <td colSpan={14}>
                          <EmptyState
                            icon={rapcSearch ? Search : reviewFilter ? Flag : FileText}
                            title={rapcSearch ? `Nenhum resultado para "${rapcSearch}"` : reviewFilter ? 'Nenhum item marcado para revisão' : `Nenhum item com status "${statusFilter}"`}
                            description={rapcSearch ? 'Tente outros termos de busca.' : reviewFilter ? 'Use o ícone de bandeira nas linhas para marcar itens.' : 'Mude o filtro de status para ver outros itens.'}
                          />
                        </td>
                      </tr>
                    ) : groupByActivity ? (
                      /* #47 Grouped by activity */
                      Object.entries(
                        filteredItems.reduce((acc: Record<string, AuditItem[]>, item) => {
                          const key = item.activity || 'Não Classificado';
                          (acc[key] = acc[key] || []).push(item);
                          return acc;
                        }, {})
                      ).sort(([a], [b]) => a.localeCompare(b)).map(([activity, groupItems]) => (
                        <React.Fragment key={activity}>
                          <tr className="bg-sidebar/70">
                            <td colSpan={14} className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-primary border-r border-line">
                              <span className="flex items-center gap-2">
                                <Layers size={10} />
                                {activity}
                                <span className="text-text-secondary font-normal">({groupItems.length} lançamento{groupItems.length !== 1 ? 's' : ''} · {formatCurrency(groupItems.reduce((s, i) => s + (i.value || 0), 0))})</span>
                              </span>
                            </td>
                          </tr>
                          {groupItems.map((item, idx) => (
                            <RapcTableRow key={item.id ?? idx} item={item} idx={idx} focusedRow={focusedRow} filteredItems={filteredItems} onSelect={setSelectedItem} onPeek={setPeekItem} onFlag={handleToggleReviewFlag} cnpjCache={cnpjCache} auditResult={lastAuditResult!} />
                          ))}
                        </React.Fragment>
                      ))
                    ) : (
                      filteredItems.map((item, idx) => (
                        <RapcTableRow key={item.id ?? idx} item={item} idx={idx} focusedRow={focusedRow} filteredItems={filteredItems} onSelect={setSelectedItem} onPeek={setPeekItem} onFlag={handleToggleReviewFlag} cnpjCache={cnpjCache} auditResult={lastAuditResult!} />
                      ))
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

            <div className="border border-line rounded overflow-hidden" role="grid" aria-label="Lista de auditorias">
              <div role="row" className="grid grid-cols-[2fr_150px_100px_110px_130px_110px_80px] gap-3 px-6 py-2.5 bg-sidebar text-[10px] font-bold text-text-secondary uppercase tracking-widest border-b border-line">
                <span role="columnheader">Organização / Responsável</span>
                <span role="columnheader">Período Auditado</span>
                <span role="columnheader">Contrato</span>
                <span role="columnheader">Gerado em</span>
                <span role="columnheader">Lançamentos</span>
                <span role="columnheader">Parecer</span>
                <span role="columnheader" className="text-right">Ações</span>
              </div>
              {historyLoading ? (
                <>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <SkeletonRow key={i} cols={[2, 1.5, 1, 1.1, 1.3, 1.1, 0.8]} />
                  ))}
                </>
              ) : history.length > 0 ? history.map((item) => {
                const total = item.metrics?.totalItems ?? 0;
                const conciliated = item.metrics?.conciliatedItems ?? 0;
                const pct = total > 0 ? (conciliated / total) : 0;
                const countColor = pct === 1 ? 'text-success' : pct >= 0.8 ? 'text-warning' : 'text-error';
                return (
                  <div
                    key={item.id}
                    role="row"
                    tabIndex={0}
                    onKeyDown={async (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        try {
                          const r = await apiFetch(`/api/audits/${item.id}`);
                          if (r.ok) {
                            const audit = await r.json();
                            setLastAuditResult(audit);
                            if (audit.sourceFiles) loadAuditFiles(audit.id, audit.sourceFiles);
                            setActiveSection('resultado');
                          }
                        } catch { /* handled by apiFetch */ }
                      }
                    }}
                    aria-label={`Auditoria: ${item.organization}, ${item.verdict}`}
                    className="grid grid-cols-[2fr_150px_100px_110px_130px_110px_80px] gap-3 items-center px-6 py-4 bg-card hover:bg-sidebar-active transition-all border-b border-line/30 group focus:outline-none focus:ring-1 focus:ring-primary focus:ring-inset"
                  >
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
                            const base = `${window.location.origin}/share/${item.shareToken}`;
                            const url = (item as any).shareAccessCode ? `${base}?code=${(item as any).shareAccessCode}` : base;
                            navigator.clipboard.writeText(url);
                          }}
                          className="p-1.5 hover:bg-primary/20 rounded text-text-secondary hover:text-primary transition-colors"
                          title={(item as any).shareAccessCode ? `Copiar link + código (${(item as any).shareAccessCode})` : 'Copiar link público'}
                        >
                          <Link2 size={13} />
                        </button>
                      )}
                      <button
                        onClick={async () => {
                          try {
                            const r = await apiFetch(`/api/audits/${item.id}`);
                            if (r.ok) {
                              const audit = await r.json();
                              setLastAuditResult(audit);
                              if (audit.sourceFiles) loadAuditFiles(audit.id, audit.sourceFiles);
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
                <div className="bg-card">
                  <EmptyState icon={History} title="Nenhuma auditoria encontrada" description="Inicie uma nova análise para que ela apareça aqui." />
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── PESQUISA ───────────────────────────────────────────────────────── */}
        {activeSection === 'pesquisa' && (
          <section className="px-10 py-8 animate-in fade-in slide-in-from-left-4 duration-500 overflow-y-auto pb-24">
            <div className="flex items-center gap-3 mb-8">
              <Search size={22} className="text-primary" />
              <div>
                <h1 className="text-xl font-bold uppercase tracking-widest">Pesquisa</h1>
                <p className="text-[11px] text-text-secondary font-mono mt-0.5">Busca global em todas as auditorias — fornecedores, lançamentos, notas fiscais</p>
              </div>
            </div>

            {/* Search input */}
            <div className="relative mb-6 max-w-2xl">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none" />
              <input
                type="search"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="CNPJ, CPF, nome do fornecedor, nº NF, código do item, descrição…"
                autoFocus
                className="w-full pl-9 pr-4 py-3 bg-card border border-line rounded text-[13px] font-mono text-text placeholder:text-text-secondary/40 focus:outline-none focus:border-primary transition-colors"
                aria-label="Pesquisar em todas as auditorias"
              />
              {searchLoading && (
                <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-primary animate-spin" />
              )}
            </div>

            {/* Detected type badge */}
            {searchMeta && searchQuery.trim() && (
              <div className="flex items-center gap-3 mb-4">
                <span className="text-[10px] font-mono text-text-secondary uppercase">
                  {searchMeta.total} resultado{searchMeta.total !== 1 ? 's' : ''} &bull;&nbsp;
                  tipo detectado:&nbsp;
                  <span className="text-primary font-bold">
                    {searchMeta.detectedType === 'itemCode' ? 'Código de item' :
                     searchMeta.detectedType === 'taxId' ? 'CNPJ / CPF' : 'Texto livre'}
                  </span>
                </span>
              </div>
            )}

            {/* Error */}
            {searchError && (
              <div className="flex items-center gap-2 text-error text-[12px] font-mono mb-4">
                <AlertCircle size={14} /> {searchError}
              </div>
            )}

            {/* Results */}
            {!searchLoading && searchMeta && searchResults.length === 0 && searchQuery.trim() && (
              <EmptyState icon={Search} title="Nenhum resultado encontrado" description={`Nenhum lançamento, fornecedor ou NF corresponde a "${searchQuery}"`} />
            )}

            {searchResults.length > 0 && (() => {
              // Group by auditId
              const groups: Record<string, { meta: any; items: any[] }> = {};
              for (const r of searchResults) {
                if (!groups[r.auditId]) groups[r.auditId] = { meta: r, items: [] };
                groups[r.auditId].items.push(r);
              }
              return (
                <div className="space-y-6">
                  {Object.entries(groups).map(([auditId, group]) => (
                    <div key={auditId} className="bg-card border border-line rounded overflow-hidden">
                      {/* Group header */}
                      <div className="px-5 py-3 border-b border-line bg-sidebar flex items-center gap-3">
                        <FileText size={14} className="text-primary shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="text-[11px] font-bold uppercase tracking-widest text-text">{group.meta.organization}</span>
                          <span className="text-[10px] font-mono text-text-secondary ml-3">{group.meta.contractNumber}</span>
                          <span className="text-[10px] text-text-secondary ml-2 opacity-60">{group.meta.periodStart} → {group.meta.periodEnd}</span>
                        </div>
                        <span className={cn('text-[9px] font-bold uppercase px-2 py-0.5 rounded border',
                          group.meta.verdict === 'APROVADO' && 'bg-success/10 text-success border-success/30',
                          group.meta.verdict === 'APROVADO COM RESSALVAS' && 'bg-warning/10 text-warning border-warning/30',
                          group.meta.verdict === 'DILIGÊNCIA' && 'bg-error/10 text-error border-error/30',
                        )}>{group.meta.verdict}</span>
                        <span className="text-[9px] text-text-secondary/40 font-mono">{group.items.length} item{group.items.length !== 1 ? 's' : ''}</span>
                      </div>

                      {/* Items */}
                      <table className="w-full text-[11px] font-mono border-collapse">
                        <tbody>
                          {group.items.map((r: any, i: number) => (
                            <tr
                              key={i}
                              className="border-b border-line/30 hover:bg-primary/5 cursor-pointer transition-colors"
                              onClick={() => {
                                // Load this audit into context then open modal
                                if (lastAuditResult?.id === r.auditId) {
                                  setSelectedItem(r.item);
                                } else {
                                  // Navigate to audit from history
                                  apiFetch(`/api/audits/${r.auditId}`).then(async res => {
                                    if (res.ok) {
                                      const data = await res.json();
                                      setLastAuditResult(data);
                                      setActiveSection('resultado');
                                      setTimeout(() => setSelectedItem(r.item), 100);
                                    }
                                  });
                                }
                              }}
                            >
                              <td className="py-3 pl-5 pr-2 w-10 text-text-secondary">{r.item.id}</td>
                              <td className="py-3 pr-3">
                                <span className={cn('inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase',
                                  r.item.status === 'Conciliado' && 'bg-success/10 text-success',
                                  r.item.status === 'Ressalva' && 'bg-warning/10 text-warning',
                                  r.item.status === 'Pendente' && 'bg-error/10 text-error',
                                )}>{r.item.status}</span>
                              </td>
                              <td className="py-3 pr-4 uppercase max-w-[240px] truncate text-text">{r.item.entity}</td>
                              <td className="py-3 pr-4 text-text-secondary uppercase max-w-[200px] truncate">{r.item.description}</td>
                              <td className="py-3 pr-4 text-text-secondary">{r.item.date}</td>
                              <td className="py-3 pr-4 text-right font-bold text-text">{formatCurrency(r.item.value)}</td>
                              <td className="py-3 pr-5 text-text-secondary/50 text-[9px] capitalize">{r.matchField}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Empty state with tips — shown when no query */}
            {!searchQuery.trim() && !searchLoading && (
              <div className="max-w-xl">
                <div className="bg-card border border-line rounded p-6 space-y-4">
                  <h3 className="text-[10px] font-bold uppercase tracking-widest text-text-secondary">O que você pode pesquisar</h3>
                  <div className="space-y-3">
                    {[
                      ['CNPJ / CPF', '43.283.811/0001-75 ou 12345678000195', 'Todos os lançamentos deste fornecedor em qualquer auditoria'],
                      ['Nome do fornecedor', 'KALUNGA ou SEBRAE', 'Busca por razão social ou nome fantasia'],
                      ['Nº documento fiscal', 'NF 42 ou NFSE 1234', 'Encontra a nota fiscal específica'],
                      ['Código de item', 'AB3K7F', 'Localiza o lançamento exato pelo código único'],
                      ['Descrição', 'GESTÃO DE PROJETOS', 'Busca livre na descrição e atividade'],
                    ].map(([type, example, desc], i) => (
                      <div key={i} className="grid grid-cols-[120px_1fr] gap-x-4 text-[11px]">
                        <span className="text-primary font-bold uppercase">{type}</span>
                        <span className="text-text-secondary">
                          <code className="font-mono bg-sidebar px-1 rounded text-[10px]">{example}</code>
                          <span className="ml-2 opacity-60">{desc}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
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
          <ItemDetailModal onClose={() => setSelectedItem(null)}>
            <div className="flex justify-between items-center px-8 py-5 border-b border-line bg-card shrink-0">
              <div className="flex items-center gap-4">
                <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 shrink-0">
                  <span className="text-primary font-bold font-mono text-sm">#{selectedItem.id}</span>
                </div>
                <div>
                  <h2 id="item-modal-title" className="text-base font-bold uppercase tracking-widest text-primary">Detalhes do Lançamento</h2>
                  <p className="text-[11px] text-text-secondary font-mono mt-0.5">{selectedItem.date}</p>
                </div>
                <div className={cn('px-3 py-1 rounded text-[10px] font-bold uppercase border',
                  selectedItem.status === 'Conciliado' && 'bg-success/10 text-success border-success/30',
                  selectedItem.status === 'Ressalva' && 'bg-warning/10 text-warning border-warning/30',
                  selectedItem.status === 'Pendente' && 'bg-error/10 text-error border-error/30'
                )}>
                  {selectedItem.status}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* Share internal link (#44) */}
                {lastAuditResult?.id && (
                  <button
                    onClick={() => {
                      const url = `${window.location.origin}/?audit=${lastAuditResult.id}&item=${selectedItem.id}`;
                      navigator.clipboard.writeText(url).then(() =>
                        addToast('success', 'Link copiado — apenas usuários autenticados podem acessar')
                      );
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-sidebar border border-line hover:border-primary text-[10px] font-bold uppercase tracking-widest text-text-secondary hover:text-primary transition-all rounded"
                    title="Copiar link interno deste lançamento (requer autenticação)"
                  >
                    <Share2 size={12} /> Compartilhar
                  </button>
                )}
                {/* Print (#45) */}
                {lastAuditResult && (
                  <button
                    onClick={handlePrintItem}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-sidebar border border-line hover:border-primary text-[10px] font-bold uppercase tracking-widest text-text-secondary hover:text-primary transition-all rounded"
                    title="Imprimir / exportar este lançamento como PDF"
                  >
                    <Printer size={12} /> Imprimir
                  </button>
                )}
                <button onClick={() => setSelectedItem(null)} className="text-text-secondary hover:text-text transition-colors p-1.5 hover:bg-white/5 rounded" aria-label="Fechar">
                  <X size={20} />
                </button>
              </div>
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
                        const taxDigits = selectedItem.taxId?.replace(/\D/g, '') ?? '';
                        const isCnpj = taxDigits.length === 14 && selectedItem.taxId !== 'N/A';
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
                    {selectedItem.auditorNote && (
                      <div className="mt-3 p-3 bg-primary/5 border border-primary/20 rounded text-[11px] font-sans text-primary/80 flex items-start gap-2">
                        <NotebookPen size={12} className="shrink-0 mt-0.5" />
                        <span>{selectedItem.auditorNote}</span>
                      </div>
                    )}
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

                {/* ── Download doc PDFs ──────────────────────────────────── */}
                {(() => {
                  const auditId = lastAuditResult?.id;
                  const canDownloadNf = isPageDownloadable(selectedItem.nfPage);
                  const canDownloadPay = isPageDownloadable(selectedItem.paymentPage);
                  const docUrl = (type: 'nf' | 'payment') =>
                    `/api/audits/${auditId}/items/${selectedItem.id}/doc?type=${type}`;
                  if (!auditId || (!canDownloadNf && !canDownloadPay)) return null;
                  return (
                    <div className="border-t border-line p-8">
                      <h3 className="text-[11px] font-bold uppercase tracking-widest mb-4 text-primary flex items-center gap-2">
                        <FileDown size={13} /> Exportar Documentos
                      </h3>
                      <div className="flex gap-3 flex-wrap">
                        <a
                          href={canDownloadNf ? docUrl('nf') : undefined}
                          download
                          aria-disabled={!canDownloadNf}
                          className={cn(
                            'flex items-center gap-2 px-4 py-2.5 rounded border text-[11px] font-bold uppercase tracking-widest transition-all',
                            canDownloadNf
                              ? 'bg-sidebar border-line hover:border-primary hover:text-primary text-text-secondary cursor-pointer'
                              : 'border-line/40 text-text-secondary/30 cursor-not-allowed pointer-events-none'
                          )}
                          title={canDownloadNf ? `Baixar PDF — Pág(s): ${selectedItem.nfPage}` : `Página não identificada (${selectedItem.nfPage || 'N/A'})`}
                        >
                          <FileDown size={13} />
                          Doc Fiscal (NF)
                          {selectedItem.nfPage && selectedItem.nfPage !== 'N/A' && (
                            <span className="font-mono text-[9px] text-text-secondary/60 ml-1">pág. {selectedItem.nfPage}</span>
                          )}
                        </a>
                        <a
                          href={canDownloadPay ? docUrl('payment') : undefined}
                          download
                          aria-disabled={!canDownloadPay}
                          className={cn(
                            'flex items-center gap-2 px-4 py-2.5 rounded border text-[11px] font-bold uppercase tracking-widest transition-all',
                            canDownloadPay
                              ? 'bg-sidebar border-line hover:border-primary hover:text-primary text-text-secondary cursor-pointer'
                              : 'border-line/40 text-text-secondary/30 cursor-not-allowed pointer-events-none'
                          )}
                          title={canDownloadPay ? `Baixar PDF — Pág(s): ${selectedItem.paymentPage}` : `Página não identificada (${selectedItem.paymentPage || 'N/A'})`}
                        >
                          <FileDown size={13} />
                          Comprovante de Pagamento
                          {selectedItem.paymentPage && selectedItem.paymentPage !== 'N/A' && (
                            <span className="font-mono text-[9px] text-text-secondary/60 ml-1">pág. {selectedItem.paymentPage}</span>
                          )}
                        </a>
                      </div>
                    </div>
                  );
                })()}

                {/* Reanálise individual + Anotação do auditor */}
                <div className="grid grid-cols-2 gap-0 border-t border-line">
                  {/* Reanálise individual */}
                  <div className="p-8 border-r border-line">
                    <h3 className="text-[11px] font-bold uppercase tracking-widest mb-3 text-primary flex items-center gap-2">
                      <RefreshCw size={13} /> Reanálise Individual pela IA
                    </h3>
                    <div className="space-y-3">
                      <textarea
                        value={reanalyzeContext}
                        onChange={e => setReanalyzeContext(e.target.value)}
                        placeholder="(Opcional) Contexto adicional para a IA: ex. 'A nota fiscal está na pág. 5 e o pagamento foi via PIX em 03/10/2025.'"
                        rows={3}
                        className="w-full bg-sidebar border border-line rounded px-3 py-2 text-[11px] font-sans text-text placeholder:text-text-secondary/40 focus:outline-none focus:border-primary transition-colors resize-none"
                      />
                      <button
                        onClick={handleReanalyzeItem}
                        disabled={reanalyzingItem}
                        className="flex items-center gap-2 px-4 py-2 bg-primary/10 border border-primary/30 hover:bg-primary/20 text-primary text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-50 rounded"
                      >
                        {reanalyzingItem ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                        {reanalyzingItem ? 'Reanalisando...' : 'Reanalisar este lançamento'}
                      </button>
                    </div>
                  </div>

                  {/* Anotação do auditor */}
                  <div className="p-8">
                    <h3 className="text-[11px] font-bold uppercase tracking-widest mb-3 text-text-secondary flex items-center gap-2">
                      <NotebookPen size={13} /> Anotação do Auditor
                    </h3>
                    <textarea
                      value={noteValue}
                      onChange={e => handleNoteChange(e.target.value)}
                      placeholder="Registre observações manuais, documentos adicionais apresentados, decisões de auditoria ou qualquer nota relevante para este lançamento..."
                      rows={4}
                      className="w-full bg-sidebar border border-line rounded px-3 py-2 text-[12px] font-sans text-text placeholder:text-text-secondary/40 focus:outline-none focus:border-primary transition-colors resize-none"
                    />
                    <p className="text-[9px] text-text-secondary mt-1 opacity-60">Salvo automaticamente · Visível apenas para auditores autenticados</p>
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
          </ItemDetailModal>
        )}

        {/* #56 Peek panel — lightweight side panel */}
        {peekItem && !selectedItem && (
          <div className="fixed right-0 top-8 bottom-0 w-[380px] bg-card border-l border-line z-40 flex flex-col shadow-2xl animate-in slide-in-from-right-4 duration-300">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-line shrink-0 bg-sidebar">
              <div className="flex items-center gap-3">
                <span className={cn('px-2 py-0.5 rounded text-[9px] font-bold uppercase border',
                  peekItem.status === 'Conciliado' && 'bg-success/10 text-success border-success/30',
                  peekItem.status === 'Ressalva' && 'bg-warning/10 text-warning border-warning/30',
                  peekItem.status === 'Pendente' && 'bg-error/10 text-error border-error/30',
                )}>{peekItem.status}</span>
                <span className="text-[11px] font-bold font-mono text-text-secondary">#{peekItem.id}</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => { setSelectedItem(peekItem); setPeekItem(null); }}
                  className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest bg-primary/10 text-primary border border-primary/30 rounded hover:bg-primary/20 transition-colors"
                >
                  Abrir completo
                </button>
                <button onClick={() => setPeekItem(null)} className="p-1.5 text-text-secondary hover:text-text transition-colors">
                  <X size={14} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-4 text-[11px]">
              <div>
                <p className="text-text-secondary uppercase tracking-widest text-[9px] mb-1">Descrição</p>
                <p className="font-bold text-text uppercase">{peekItem.description}</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><p className="text-text-secondary uppercase tracking-widest text-[9px] mb-1">Data</p><p className="font-mono">{peekItem.date}</p></div>
                <div><p className="text-text-secondary uppercase tracking-widest text-[9px] mb-1">Valor</p><p className="font-mono font-bold text-primary">{formatCurrency(peekItem.value)}</p></div>
                <div><p className="text-text-secondary uppercase tracking-widest text-[9px] mb-1">Atividade</p><p className="uppercase">{peekItem.activity}</p></div>
                <div><p className="text-text-secondary uppercase tracking-widest text-[9px] mb-1">CNPJ/CPF</p><p className="font-mono">{formatTaxId(peekItem.taxId)}</p></div>
                <div><p className="text-text-secondary uppercase tracking-widest text-[9px] mb-1">Pág NF</p><p className="font-mono">{peekItem.nfPage || '-'}</p></div>
                <div><p className="text-text-secondary uppercase tracking-widest text-[9px] mb-1">Pág Pgto</p><p className="font-mono">{peekItem.paymentPage || '-'}</p></div>
              </div>
              {peekItem.observations && (
                <div>
                  <p className="text-text-secondary uppercase tracking-widest text-[9px] mb-1">Observações</p>
                  <p className="text-text-secondary leading-relaxed uppercase">{peekItem.observations}</p>
                </div>
              )}
              {peekItem.auditorNote && (
                <div className="p-3 bg-primary/5 border border-primary/20 rounded">
                  <p className="text-text-secondary uppercase tracking-widest text-[9px] mb-1 flex items-center gap-1"><NotebookPen size={9} /> Nota do auditor</p>
                  <p className="text-text">{peekItem.auditorNote}</p>
                </div>
              )}
              <div className="pt-2 flex items-center gap-2">
                <button
                  onClick={e => handleToggleReviewFlag(peekItem, e)}
                  className={cn('flex items-center gap-1.5 px-3 py-1.5 border rounded text-[10px] font-bold uppercase tracking-widest transition-all', peekItem.needsReview ? 'border-amber-500/50 bg-amber-500/10 text-amber-400' : 'border-line text-text-secondary hover:text-text')}
                >
                  <Flag size={11} fill={peekItem.needsReview ? 'currentColor' : 'none'} />
                  {peekItem.needsReview ? 'Remover revisão' : 'Marcar para revisão'}
                </button>
              </div>
            </div>
          </div>
        )}

      </main>

      <footer className="fixed bottom-0 left-[180px] right-0 py-3 px-6 bg-sidebar border-t border-line text-[10px] text-text-secondary text-center leading-relaxed z-40">
        <p className="font-bold tracking-widest uppercase">CONFIDENCIAL - USO INTERNO &nbsp;&bull;&nbsp; &copy; 2026 ASSOCIAÇÃO CASA HACKER &nbsp;&bull;&nbsp; CNPJ 36.038.079/0001-97 &nbsp;&bull;&nbsp; R. DR. RENATO PAES DE BARROS, 618 – ITAIM BIBI, SÃO PAULO – SP, 04530-000</p>
      </footer>

      {/* ── UX-01: Toast notification region ──────────────────────────────── */}
      <div role="status" aria-live="polite" aria-label="Notificações" className="fixed bottom-16 right-4 z-[60] flex flex-col gap-2 pointer-events-none">
        {toasts.map(toast => (
          <InlineNotification
            key={toast.id}
            kind={toast.kind}
            message={toast.message}
            onClose={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}
          />
        ))}
      </div>

    </div>
    </>
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
        <div className="mt-1 space-y-1">
          <div className="flex items-center gap-2 text-[10px] font-mono text-primary">
            <span className="truncate">{truncateFileName(file.name, 28)}</span>
            <span className="text-text-secondary shrink-0">{file.size > 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${(file.size / 1024).toFixed(0)} KB`}</span>
          </div>
          {/* #52: CSV row count + size warning */}
          {file.type === 'csv' && Array.isArray(file.content) && (
            <div className="flex items-center gap-2 text-[9px] font-mono text-text-secondary">
              <span>{(file.content as any[]).length} linhas</span>
              {Object.keys((file.content as any[])[0] ?? {}).length > 0 && (
                <span>· {Object.keys((file.content as any[])[0]).length} colunas</span>
              )}
            </div>
          )}
          {file.size > 20 * 1024 * 1024 && (
            <div className="flex items-center gap-1 text-[9px] text-amber-400">
              <AlertCircle size={9} />
              Arquivo grande — pode aumentar o tempo de processamento
            </div>
          )}
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

// ── UX-03: ItemDetailModal — focus trap modal wrapper ─────────────────────────
function ItemDetailModal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const previousFocusRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement;
    const focusable = overlayRef.current?.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])'
    );
    if (focusable && focusable.length > 0) focusable[0].focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab' || !focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={overlayRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="item-modal-title"
        className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto custom-scrollbar"
      >
        {children}
      </div>
    </div>
  );
}

// ── UX-01: InlineNotification — Carbon-aligned toast ─────────────────────────
function InlineNotification({ kind, message, onClose }: { kind: 'success' | 'error' | 'info'; message: string; onClose: () => void }) {
  const config = {
    success: { border: 'border-l-success', icon: CheckCircle2, iconClass: 'text-success', bg: 'bg-success/5' },
    error:   { border: 'border-l-error',   icon: AlertCircle,  iconClass: 'text-error',   bg: 'bg-error/5'   },
    info:    { border: 'border-l-primary',  icon: Info,         iconClass: 'text-primary',  bg: 'bg-primary/5' },
  }[kind];
  const Icon = config.icon;
  return (
    <div
      className={cn('pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-lg border border-l-4 shadow-lg min-w-[280px] max-w-sm toast-slide-in', config.border, config.bg, 'border-line')}
      role="alert"
    >
      <Icon size={16} className={cn('mt-0.5 shrink-0', config.iconClass)} />
      <p className="flex-1 text-sm text-text-primary leading-snug">{message}</p>
      <button onClick={onClose} className="shrink-0 text-text-secondary hover:text-text-primary transition-colors" aria-label="Fechar notificação">
        <X size={14} />
      </button>
    </div>
  );
}

// ── UX-05: SkeletonRow — animated skeleton for table rows ─────────────────────
function SkeletonRow({ cols }: { cols: number[] }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-line">
      {cols.map((flex, i) => (
        <div key={i} className="skeleton h-4 rounded" style={{ flex }} />
      ))}
    </div>
  );
}

// ── #46/#53/#56: RAPC table row (extracted for reuse with group-by) ────────────
function RapcTableRow({
  item, idx, focusedRow, filteredItems, onSelect, onPeek, onFlag, cnpjCache, auditResult
}: {
  item: AuditItem; idx: number; focusedRow: number; filteredItems: AuditItem[];
  onSelect: (i: AuditItem) => void; onPeek: (i: AuditItem) => void;
  onFlag: (i: AuditItem, e: React.MouseEvent) => void;
  cnpjCache: Record<string, CNPJData | 'error' | null>; auditResult: AuditResult;
}) {
  const isFocused = filteredItems[focusedRow]?.id === item.id;
  const d = item.taxId?.replace(/\D/g, '') ?? '';
  const cached = d.length === 14 ? cnpjCache[d] : undefined;
  const persisted = d.length === 14 ? auditResult?.cnpjData?.[d] : undefined;
  const src = (cached && cached !== 'error') ? cached as CNPJData : (persisted && persisted !== 'error') ? persisted as CNPJData : undefined;
  return (
    <tr
      onClick={() => onSelect(item)}
      className={cn(
        'hover:bg-primary/5 transition-colors cursor-pointer',
        item.status === 'Ressalva' && 'bg-warning/5',
        item.status === 'Pendente' && 'bg-error/5',
        isFocused && 'ring-1 ring-inset ring-primary',
      )}
      role="row"
      aria-selected={isFocused}
    >
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
      <td className="px-4 py-2.5 border-r border-line/20 uppercase">{src?.razao_social || item.entity}</td>
      <td className="px-4 py-2.5 text-[9px] text-primary border-r border-line/20 uppercase">{item.docId}</td>
      <td className="px-4 py-2.5 text-[9px] whitespace-nowrap border-r border-line/20 uppercase">{formatTaxId(item.taxId)}</td>
      <td className="px-4 py-2.5 text-right font-bold border-r border-line/20">{formatCurrency(item.value)}</td>
      <td className="px-4 py-2.5 border-r border-line/20">
        <div className={cn('mx-auto w-fit px-2 py-0.5 rounded-sm text-[9px] font-bold uppercase', item.status === 'Conciliado' && 'bg-success/10 text-success border border-success/30', item.status === 'Ressalva' && 'bg-warning/10 text-warning border border-warning/30', item.status === 'Pendente' && 'bg-error/10 text-error border border-error/30')}>{item.status}</div>
      </td>
      <td className="px-4 py-2.5 text-center text-text-secondary border-r border-line/20 uppercase">{item.nfPage || '-'}</td>
      <td className="px-4 py-2.5 text-center text-text-secondary border-r border-line/20 uppercase">{item.paymentPage || '-'}</td>
      <td className="px-4 py-2.5 text-text-secondary font-sans leading-tight text-[10px] uppercase border-r border-line/20">{item.observations}</td>
      <td className="px-2 py-2.5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-1">
          <button
            onClick={e => onFlag(item, e)}
            title={item.needsReview ? 'Remover marcação de revisão' : 'Marcar para revisão'}
            className={cn('p-1 rounded transition-colors', item.needsReview ? 'text-amber-400 hover:text-amber-300' : 'text-text-secondary/30 hover:text-amber-400')}
          >
            <Flag size={11} fill={item.needsReview ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onPeek(item); }}
            title="Prévia rápida (peek)"
            className="p-1 rounded text-text-secondary/30 hover:text-primary transition-colors"
          >
            <ChevronRight size={11} />
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── UX-06: EmptyState — centered icon + title + description ───────────────────
function EmptyState({ icon: Icon, title, description }: { icon: React.ElementType; title: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="w-12 h-12 rounded-full bg-surface-hover flex items-center justify-center mb-4">
        <Icon size={22} className="text-text-secondary" />
      </div>
      <p className="text-sm font-semibold text-text-primary mb-1">{title}</p>
      <p className="text-xs text-text-secondary max-w-xs">{description}</p>
    </div>
  );
}
