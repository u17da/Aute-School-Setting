import { RiskClass, ActionPrimitive } from './plan';

export interface GuardedPageInterface {
  readonly isWriteBlocked: boolean;
  navigate(url: string, timeoutMs?: number): Promise<void>;
  waitForSelector(selector: string, timeoutMs?: number): Promise<boolean>;
  click(selector: string, timeoutMs?: number): Promise<void>;
  clickNav(selector: string, timeoutMs?: number): Promise<void>;
  fill(selector: string, value: string, timeoutMs?: number): Promise<void>;
  selectOption(selector: string, value: string, timeoutMs?: number): Promise<void>;
  getText(selector: string, timeoutMs?: number): Promise<string>;
  getValue(selector: string, timeoutMs?: number): Promise<string>;
  isVisible(selector: string, timeoutMs?: number): Promise<boolean>;
  dragAndDrop(sourceSelector: string, targetSelector: string): Promise<void>;
  reload(timeoutMs?: number): Promise<void>;
  takeScreenshot(tag?: string): Promise<string | undefined>;
}

export interface AuthenticatedSchoolContext {
  schoolCode: string;
  schoolName: string;
  organizationId?: string;
  authenticatedAt: string;
}

export interface CapabilityExecutionContext {
  page: GuardedPageInterface;
  jobId?: string;
  schoolCode: string;
  schoolName: string;
  expectedOrgId?: string;
  authenticatedSchoolContext?: AuthenticatedSchoolContext;
  credentialRef: string;
  isDryRun: boolean;
  logger: {
    info(msg: string, meta?: any): void;
    warn(msg: string, meta?: any): void;
    error(msg: string, meta?: any): void;
  };
}

export interface CapabilityObservationResult {
  currentState: Record<string, any>;
  eligible: boolean;
  skipReason?: string;
}

export interface CapabilityExecutionResult {
  success: boolean;
  appliedChanges: Record<string, any>;
  beforeState?: Record<string, any>;
  afterState?: Record<string, any>;
  verified: boolean;
  message: string;
  screenshotPath?: string;
  error?: string;
}

export interface ParameterSemantic {
  name: string;
  type: string;
  description: string;
  allowedValues?: { value: string; meaning: string }[];
  default?: any;
}

export interface CapabilityDefinition {
  capabilityId: string;
  version: string;
  description: string;
  inputSchema?: Record<string, any>;
  parameterSemantics?: ParameterSemantic[];
  preconditions?: string[];
  constraints?: string[];
  supportedPages: string[];
  riskClass: RiskClass;
  testStatus: 'UNTESTED' | 'MOCK_TESTED' | 'PRODUCTION_VALIDATED';
  productionValidated: boolean;
  createdBy: 'SYSTEM' | 'AI_GENERATED';
  updatedAt: string;

  observe(context: CapabilityExecutionContext, input?: any): Promise<CapabilityObservationResult>;
  plan(context: CapabilityExecutionContext, input?: any): Promise<any>;
  execute(context: CapabilityExecutionContext, input?: any): Promise<CapabilityExecutionResult>;
  verify(context: CapabilityExecutionContext, input?: any): Promise<boolean>;
}

