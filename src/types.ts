export type AuditVerdict = 'APROVADO' | 'APROVADO COM RESSALVAS' | 'DILIGÊNCIA';

export interface CNPJData {
  razao_social?: string;
  nome_fantasia?: string;
  situacao_cadastral?: string;
  data_situacao_cadastral?: string;
  tipo?: string;
  natureza_juridica?: string;
  abertura?: string;
  capital_social?: string;
  atividade_principal?: Array<{ code: string; text: string }>;
  atividades_secundarias?: Array<{ code: string; text: string }>;
  logradouro?: string;
  numero?: string;
  complemento?: string;
  bairro?: string;
  municipio?: string;
  uf?: string;
  cep?: string;
  telefone?: string;
  email?: string;
  [key: string]: any;
}

export interface AuditItem {
  id: number;
  itemCode?: string;
  description: string;
  activity: string;
  date: string;
  entity: string;
  docId: string;
  taxId: string;
  value: number;
  status: 'Conciliado' | 'Ressalva' | 'Pendente';
  nfPage?: string;
  paymentPage?: string;
  observations: string;
  originalRow?: Record<string, any>;
  emissionDateTime?: string;
  serviceDescription?: string;
  taxInfo?: string;
  paymentDateTime?: string;
  transactionId?: string;
  payerInfo?: string;
  payeeInfo?: string;
  paymentMethod?: string;
}

export interface AuditFinding {
  itemId: string | number;
  type: string;
  involvedDocs: string[];
}

export interface BudgetLine {
  activity: string;
  plannedValue: number;
  executedValue: number;
}

export interface AuditResult {
  id: string;
  organization: string;
  periodStart: string;
  periodEnd: string;
  contractNumber: string;
  date: string;
  createdBy?: string;
  shareToken?: string;
  verdict: AuditVerdict;
  metrics: {
    totalItems: number;
    conciliatedItems: number;
    findingsCount: number;
    totalValue: number;
    approvedValue: number;
  };
  items: AuditItem[];
  findings: AuditFinding[];
  emailTemplate: {
    subject: string;
    body: string;
  };
  budgetLines?: BudgetLine[];
  sourceFiles?: Record<string, string>;
  cnpjData?: Record<string, CNPJData>;
}

export interface FileData {
  id: string;
  name: string;
  size: number;
  type: string;
  content: string | any[];
  pages?: number;
}

export interface AuthUser {
  email: string;
  name: string;
  photo?: string;
}
