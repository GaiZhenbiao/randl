import type { Translator, Values } from './i18n';
import type { OptionValue, PluginSettings } from '../../backend/src/plugin-options';
export type PlotSettings = {
  maxRuns?: number | null | 'focused';
  legendPosition?: 'top' | 'bottom' | 'left' | 'right';
  legendTemplate?: string;
  tooltipLimit?: number;
  tooltipFullNames?: boolean;
  tooltipColoredNames?: boolean;
  tooltipOnlyHighlighted?: boolean;
  xAxis?: string;
  xScale?: 'linear' | 'log';
  yScale?: 'linear' | 'log';
  xMin?: number | null;
  xMax?: number | null;
  yMin?: number | null;
  yMax?: number | null;
  excludeOutliers?: boolean;
  outlierLower?: number;
  outlierUpper?: number;
  smoothingMethod?: 'none' | 'ema' | 'twema' | 'gaussian' | 'running';
  smoothingValue?: number;
  showOriginal?: boolean;
  showPoints?: boolean;
  legend?: boolean;
  lineWidth?: number;
  groupBy?: string;
  aggregation?: string;
  spread?: string;
  resolution?: Resolution;
  /** Every run or group in one chart (`single`), a grid of cells, or one at a time. */
  layout?: 'single' | 'grid' | 'coverflow';
  /** Grid cell width in CSS pixels. */
  itemSize?: number;
  /** Grid cells share one Y range instead of fitting their own. */
  sharedY?: boolean;
  /** Media panels: every run at one step, or every step of one run. */
  mediaAcross?: 'runs' | 'steps';
  /** Media panels: files shown per step, shared among runs. */
  mediaFiles?: number;
  /** Plugin option values by plugin ID, checked against each plugin's descriptors. */
  options?: Record<string, Record<string, OptionValue>>;
};
export type Resolution = 'low' | 'medium' | 'high' | 'full';
export type Run = {
  id: string;
  entity: string;
  project: string;
  name: string;
  display_name: string;
  state: string;
  created: number;
  updated: number;
  revision: number;
  history_count: number;
  /** Creation-order index into the default run palette. */
  color_index?: number | null;
  stop_requested?: number;
  metric_count?: number;
  metric_revision?: number;
  host?: string;
  program?: string;
  git_commit?: string;
  git_remote?: string;
  username?: string;
  runtime?: number | null;
  runtime_at?: number;
  snapshot_at?: number | null;
  snapshot_source?: string | null;
  started?: number;
  heartbeat?: number;
  finished?: number | null;
  exit_code?: number | null;
};
export type SectionLayout = { width?: number; height?: number; rows?: number };
export type Section = { id: string; name: string; collapsed?: boolean };
export type Panel = {
  section?: string;
  id: string;
  plugin: string;
  metric: string;
  metrics?: string[];
  title?: string;
  settings?: PlotSettings;
  // Computed metrics: named expressions over metrics of the same history record.
  expressions?: ComputedMetric[];
};
export type ComputedMetric = { name: string; expression: string };
export type RecordTransform =
  | { kind: 'compute'; expressions: ComputedMetric[]; align?: 'none' | 'percent' }
  | { kind: 'align'; normalization: 'none' | 'percent' };
export type View = {
  id: string;
  name: string;
  project: string;
  version: number;
  body: {
    panels: Panel[];
    generation?: 'automatic' | 'manual';
    hiddenMetrics?: string[];
    hidePattern?: string;
    sections?: Section[];
    sectionLayouts?: Record<string, SectionLayout>;
    runQuery?: { sort?: string; group?: string; columns?: string[] };
    runColors?: Record<string, string>;
    pinned?: string[];
    visible: string[];
    /** Runs created after this time are visible in addition to `visible`. */
    visibleThrough?: number;
    solo: string[];
    run?: string;
    plotSettings?: PlotSettings;
    sectionSettings?: Record<string, PlotSettings>;
    filters?: { field: string; operator: string; value: string }[];
    filterMode?: string;
  };
};
export type Plugin = {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  enabled: boolean;
  builtin: boolean;
  entry?: string;
  source?: string;
  revision?: string;
  renderer?: string;
  settings: PluginSettings;
  /** Locale IDs to the plugin's own message catalogs. */
  locales?: Record<string, string>;
  dataKind?: 'scalar' | 'media' | 'snapshot';
  metricTypes?: string[];
  metricSelection?: 'single' | 'multiple' | 'xy' | 'axes';
  recordTransform?: { kind: 'align'; normalization: 'none' | 'percent' };
};
export type ChartData = {
  xAxis?: string;
  resolution?: Resolution;
  /** Aligned bucket width used for downsampling; null when every point is included. */
  bucketWidth?: number | null;
  xRange?: [number, number] | null;
  /** Set when the panel's point limit, not its resolution, chose the bucket width. */
  pointLimit?: { limit: number; total: number };
  snapshot?: boolean;
  revision?: string;
  /** Media responses: the entries shown, and the steps the runs logged (ascending). */
  entries?: MediaEntry[];
  steps?: number[];
  stepsTruncated?: boolean;
  /** The step shown across runs; null across the steps of one run. */
  step?: number | null;
  /** Runs with media at the step, or the entries the run logged. */
  total?: number;
  sampled: boolean;
  groupCount?: number;
  queryMs: number;
  metrics: string[];
  recordTransform?: RecordTransform;
  omittedRecords?: number;
  series: {
    id: string;
    name: string;
    attributes?: Record<string, any>;
    group?: { field: string; value: unknown };
    runIds?: string[];
    /** Set while the series is still streaming in; its values are empty until it arrives. */
    pending?: boolean;
    /** Read-only shared arrays; copy before transforming. */
    values: Record<string, [number, number][]>;
    /** Grouped series: [x, lower, upper, runs aggregated at x] per aggregated point. */
    bands?: Record<string, [number, number, number, number][]>;
  }[];
};
export type MediaEntry = {
  run: string;
  runName: string;
  metric: string;
  /** Null when the run logs this metric only after the step shown. */
  step: number | null;
  /** The SDK media descriptor, or null with `step`. */
  value: any;
  /** Set when `value` lists only the first of `files` logged files. */
  files?: number;
  filesTruncated?: boolean;
};
export type PanelContext = {
  locale: string;
  translate: Translator;
  /** Resolves a key of the plugin's own catalogs (`locales`), falling back to English. */
  localize: (key: string, values?: Values) => string;
  /** Every declared plugin option, resolved through the cascade and defaulted. */
  options: Record<string, OptionValue>;
  /** Set when the host draws this renderer as one cell of a grid. */
  cell?: { index: number; count: number; compact: boolean };
  colors?: Record<string, string>;
  data: ChartData;
  panel: Panel;
  dark: boolean;
};
export type ChartCursor = { axis: string; value: number; runOrder?: string[] };
export type Renderer = {
  update: (ctx: PanelContext) => void | Promise<void>;
  resize: () => void;
  destroy: () => void;
  /** A PNG data URL; the host's grid composes its cells' images asynchronously. */
  exportImage?: () => string | Promise<string>;
  highlightRuns?: (ids: string[], local: boolean) => void;
  showCursor?: (cursor: ChartCursor | null) => void;
};
export type ProjectSummary = {
  id: string;
  name: string;
  description: string;
  archived: number;
  created: number | null;
  runs: number;
  lastActivity: number | null;
  storage: number;
};
export type ProjectDetails = Omit<ProjectSummary, 'runs' | 'storage'> & {
  states: Record<string, number>;
  artifactCollections: number;
  crossProjectUsers: number;
  totalCompute: number;
  storage: { history: number; files: number; artifacts: number };
  largestRuns: { id: string; name: string; display_name: string; deleted: number; history: number; files: number }[];
  largestArtifacts: { id: string; name: string; version: number; type: string; bytes: number }[];
  runningRuns: number;
  runningDeletedRuns: number;
  counts: { runs: number; deletedRuns: number; artifactVersions: number; views: number };
};
