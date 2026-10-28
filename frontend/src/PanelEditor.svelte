<script lang="ts">
  import { fieldLabel, groupFields, pluginName } from './ui';
  import { supportsFocusedRun } from './focused-run';
  import { t, locale, type Message, type MessageKey } from './i18n';
  import { codedMessage } from './api';
  import { ExpressionError, parseExpression, suggestedName } from '../../backend/src/expressions';

  import { tick, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import {
    Modal,
    Button,
    Tabs,
    Tab,
    TabContent,
    Select,
    SelectItem,
    TextInput,
    Slider,
    Checkbox,
    InlineNotification,
    ContentSwitcher,
    Switch,
    RadioButtonGroup,
    RadioButton,
  } from 'carbon-components-svelte';
  import ChartLine from 'carbon-icons-svelte/lib/ChartLine.svelte';
  import GridIcon from 'carbon-icons-svelte/lib/Grid.svelte';
  import CarouselHorizontal from 'carbon-icons-svelte/lib/CarouselHorizontal.svelte';
  import { pluginExtent } from './plugins/registry';
  import SideDrawer from './SideDrawer.svelte';
  import MetricPicker from './MetricPicker.svelte';
  import ComputedMetricList, { type ComputedCheck } from './ComputedMetricList.svelte';
  import EditorChoice from './EditorChoice.svelte';
  import panelLimits from '../../backend/src/panel-limits.json';
  import PanelCard from './Panel.svelte';
  import PluginOptionField from './PluginOptionField.svelte';
  import { pluginLocalizer, type Localize } from './plugins/catalogs';
  import {
    optionEnabled,
    optionsAt,
    resolveOptions,
    type OptionDescriptor,
    type OptionTab,
    type OptionValue,
  } from '../../backend/src/plugin-options';
  import { outlierPercentiles, smoothingAmount, smoothingParameters } from './chart-math';
  import type { Panel, Plugin, PlotSettings, Resolution, Run, Section } from './types';
  import {
    groupOf,
    optionKey,
    resolvePlotSettings,
    settingValue,
    sourceOf,
    withSetting,
    type SettingKey,
    type SettingsLayer,
    type SettingsScope,
  } from './plot-settings';
  let {
    open = $bindable(false),
    panel,
    metrics,
    metricKinds = {},
    metricDefinitions = {},
    metricsLoading = false,
    plugins,
    onSave,
    settingsOnly = false,
    workspaceScope = false,
    workspaceOptions = {},
    onWorkspaceOptions = () => {},
    fields = [],
    heading = '',
    runs = [],
    pinned = [],
    dark = true,
    colors = {},
    inheritedLayers = [],
    sections = [],
    scopePlugins = [],
    onPreview = () => {},
  }: {
    open: boolean;
    settingsOnly?: boolean;
    workspaceScope?: boolean;
    workspaceOptions?: {
      generation?: 'automatic' | 'manual';
      hidePattern?: string;
      hiddenMetrics?: string[];
    };
    onWorkspaceOptions?: (options: {
      generation: 'automatic' | 'manual';
      hidePattern: string;
      hiddenMetrics: string[];
    }) => void;
    fields?: string[];
    heading?: string;
    runs?: Run[];
    pinned?: string[];
    dark?: boolean;
    colors?: Record<string, string>;
    inheritedLayers?: SettingsLayer[];
    sections?: Section[];
    /** Section and workspace settings: the enabled plugins of the panels in that scope. */
    scopePlugins?: Plugin[];
    onPreview?: (settings: PlotSettings) => void;
    panel: Panel;
    metrics: string[];
    metricKinds?: Record<string, string[]>;
    metricDefinitions?: Record<string, { hidden: boolean; stepMetric?: string }>;
    metricsLoading?: boolean;
    plugins: Plugin[];
    onSave: (p: Panel) => void;
  } = $props();
  let modalRef = $state<HTMLDivElement | null>(null);
  let shieldRef = $state<HTMLDivElement | null>(null);
  let keptDraft = false;
  let pointerDismissal = false;
  let closing = $state(false);
  let hadModalOpen = false;
  function shieldInput(node: HTMLDivElement) {
    const cancel = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    node.addEventListener('touchstart', cancel, { passive: false });
    node.addEventListener('wheel', cancel, { passive: false });
    return {
      destroy() {
        node.removeEventListener('touchstart', cancel);
        node.removeEventListener('wheel', cancel);
      },
    };
  }
  function focusEditorCategory() {
    modalRef
      ?.querySelector<HTMLElement>(
        '.editor-categories [role="tab"][aria-selected="true"], .editor-categories select',
      )
      ?.focus();
  }
  $effect(() => {
    if (!modalRef) return;
    const node = modalRef;
    const click = (event: MouseEvent) => {
      if (
        keptDraft &&
        event.detail > 1 &&
        event.target instanceof Element &&
        event.target.closest('.bx--modal-footer .bx--btn--secondary')
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        focusEditorCategory();
      }
    };
    const pointer = () => {
      if (open) pointerDismissal = true;
    };
    node.addEventListener('pointerdown', pointer, true);
    node.addEventListener('click', click, true);
    return () => {
      node.removeEventListener('pointerdown', pointer, true);
      node.removeEventListener('click', click, true);
    };
  });
  $effect(() => {
    const node = modalRef;
    if (!node || settingsOnly) {
      closing = false;
      hadModalOpen = false;
      return;
    }
    if (open) {
      closing = false;
      hadModalOpen = true;
      return;
    }
    if (!hadModalOpen) return;
    hadModalOpen = false;
    closing = true;
    let cancelled = false;
    void tick().then(async () => {
      await Promise.allSettled(
        node.getAnimations({ subtree: true }).map((animation) => animation.finished),
      );
      if (!cancelled) closing = false;
    });
    return () => {
      cancelled = true;
    };
  });
  $effect(() => {
    const blockClosingInput = (event: Event) => {
      if (!closing && event.target !== shieldRef) return;
      if (event instanceof PointerEvent && event.type === 'pointerdown')
        shieldRef?.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const continuation = (event: MouseEvent) => {
      if (closing || event.target === shieldRef) {
        blockClosingInput(event);
        return;
      }
      if (open || !pointerDismissal) return;
      if (event.detail <= 1) {
        pointerDismissal = false;
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (closing) blockClosingInput(event);
      else pointerDismissal = false;
    };
    window.addEventListener('pointerdown', blockClosingInput, true);
    window.addEventListener('mousedown', continuation, true);
    window.addEventListener('click', continuation, true);
    window.addEventListener('dblclick', continuation, true);
    window.addEventListener('keydown', keyboard, true);
    return () => {
      window.removeEventListener('pointerdown', blockClosingInput, true);
      window.removeEventListener('mousedown', continuation, true);
      window.removeEventListener('click', continuation, true);
      window.removeEventListener('dblclick', continuation, true);
      window.removeEventListener('keydown', keyboard, true);
    };
  });
  let panelGeneration = $state<'automatic' | 'manual'>('manual'),
    hidePattern = $state(''),
    hiddenMetrics = $state<string[]>([]);
  let draft = $state<Panel>({ id: '', plugin: 'line', metric: '' }),
    settings = $state<PlotSettings>({}),
    keys = $state<string[]>([]),
    computedRows = $state<{ id: number; name: string; expression: string }[]>([]),
    computedSerial = 0,
    error = $state<Message>(''),
    initialDraft = '',
    discardPrompt = $state(false),
    editorWidth = $state(1200),
    editorHeight = $state(360),
    editorSession = $state(0),
    tab = $state(0),
    wasOpen = false,
    loadedPanel: Panel | undefined;
  // Reload when opening, and when another scope's settings open in the same drawer.
  $effect(() => {
    if (open && (!wasOpen || panel !== loadedPanel)) {
      loadedPanel = panel;
      draft = JSON.parse(JSON.stringify(panel));
      settings = { ...panel.settings };
      panelGeneration = workspaceOptions.generation || 'manual';
      hidePattern = workspaceOptions.hidePattern || '';
      hiddenMetrics = [...(workspaceOptions.hiddenMetrics || [])];
      keys = panel.metrics?.length
        ? [...panel.metrics]
        : panel.expressions?.length || !panel.metric
          ? []
          : [panel.metric];
      const taken: string[] = [];
      computedRows = (panel.expressions || []).map((item) => {
        const auto = suggestedName(item.expression, taken);
        taken.push(item.name);
        return { id: ++computedSerial, ...item, name: item.name === auto ? '' : item.name };
      });
      error = '';
      tab = 0;
      editorSession++;
      discardPrompt = false;
      keptDraft = false;
      pointerDismissal = false;
      initialDraft = JSON.stringify({
        plugin: draft.plugin,
        title: draft.title || '',
        section: draft.section || '',
        keys,
        settings,
        expressions: panel.expressions || [],
      });
    }
    wasOpen = open;
  });
  // The categories re-render for each editing session; restore the initial focus if
  // that removed the element the modal focused.
  let primaryFocus = $derived(
    panel.id ? '.editor-categories [role="tab"][aria-selected="true"]' : '.metric-picker input',
  );
  $effect(() => {
    if (!open || settingsOnly || !editorSession) return;
    void tick().then(() => {
      if (modalRef && !modalRef.contains(document.activeElement))
        modalRef.querySelector<HTMLElement>(primaryFocus)?.focus();
    });
  });
  let capabilities = $derived(
    settingsOnly
      ? [
          'axes',
          'outliers',
          'smoothing',
          'grouping',
          'legend',
          'legendLabels',
          'points',
          'lineWidth',
          'spread',
          'original',
          'tooltip',
        ]
      : plugins.find((p) => p.id === draft.plugin)?.settings.common || [],
  );
  let hasBounds = $derived(capabilities.includes('axes') || capabilities.includes('yAxis'));
  let scope = $derived<SettingsScope>(
    workspaceScope ? 'workspace' : settingsOnly ? 'section' : 'panel',
  );
  // Plugins whose options this editor shows: the panel's own plugin, or the plugins of the
  // panels in a section or the workspace. Options limited to other scopes are left out.
  const inScope = (option: OptionDescriptor) => !option.scopes || option.scopes.includes(scope);
  // Section and workspace settings list every option at the end of its tab.
  const noAnchors = new Set<string>();
  let optionPlugins = $derived(
    (settingsOnly ? scopePlugins : plugins.filter((p) => p.id === draft.plugin)).filter((p) =>
      p.settings.options.some(inScope),
    ),
  );
  let optionTabs = $derived(
    new Set(optionPlugins.flatMap((p) => p.settings.options.filter(inScope).map((o) => o.tab))),
  );
  let hasAxes = $derived(hasBounds || capabilities.includes('outliers') || optionTabs.has('axes'));
  let hasSmoothing = $derived(capabilities.includes('smoothing') || optionTabs.has('smoothing'));
  let hasGrouping = $derived(capabilities.includes('grouping') || optionTabs.has('grouping'));
  let hasDisplay = $derived(
    capabilities.some((c) =>
      ['legend', 'points', 'lineWidth', 'cellLayout', 'itemLayout'].includes(c),
    ) ||
      optionTabs.has('display'),
  );
  // External plugins name their labels in their own catalogs.
  let localizers = $state.raw<Record<string, Localize>>({});
  $effect(() => {
    const external = optionPlugins.filter((p) => !p.builtin),
      language = $locale;
    let stale = false;
    void Promise.all(external.map((p) => pluginLocalizer(p, language))).then((list) => {
      if (!stale) localizers = Object.fromEntries(external.map((p, i) => [p.id, list[i]]));
    });
    return () => {
      stale = true;
    };
  });
  function optionText(plugin: Plugin) {
    return (key: string) =>
      plugin.builtin ? $t(key as MessageKey) : localizers[plugin.id](key);
  }
  $effect(() => {
    if (open && settingsOnly) {
      const next = JSON.stringify(settings);
      untrack(() => onPreview(JSON.parse(next)));
    }
  });
  // A panel's plugin may default host settings, such as the media item size.
  let resolved = $derived(
    resolvePlotSettings(
      [...inheritedLayers, { scope, settings }],
      optionPlugins,
      settingsOnly ? {} : plugins.find((p) => p.id === draft.plugin)?.settings.defaults,
    ),
  );
  let inheritedSources = $derived(resolvePlotSettings(inheritedLayers, optionPlugins).sources);
  let effective = $derived<PlotSettings>({
    ...(metricDefinitions[keys[0]]?.stepMetric
      ? { xAxis: metricDefinitions[keys[0]].stepMetric }
      : {}),
    ...resolved.settings,
  });
  let outlierLower = $derived(effective.outlierLower ?? outlierPercentiles.lower);
  let outlierUpper = $derived(effective.outlierUpper ?? outlierPercentiles.upper);
  // A full explicit Y range leaves nothing to fit.
  let yFixed = $derived(
    hasBounds && typeof effective.yMin === 'number' && typeof effective.yMax === 'number',
  );
  let percentilesInvalid = $derived(
    capabilities.includes('outliers') &&
      !!effective.excludeOutliers &&
      !yFixed &&
      outlierLower >= outlierUpper,
  );
  // Changing one key of a grouped setting copies the rest of its group from the
  // inherited value, so the override is complete.
  function override(values: PlotSettings) {
    let next: PlotSettings = { ...settings };
    for (const key of Object.keys(values) as (keyof PlotSettings)[])
      for (const member of groupOf(key as SettingKey))
        if (settingValue(next, member) === undefined && settingValue(effective, member) !== undefined)
          next = withSetting(next, member, settingValue(effective, member));
    settings = { ...next, ...values };
  }
  function overrideOption(plugin: Plugin, key: string, value: OptionValue | undefined) {
    const name = optionKey(plugin.id, key);
    if (value === undefined) return resetKeys([name]);
    let next = settings;
    for (const member of groupOf(name, optionPlugins))
      if (settingValue(next, member) === undefined)
        next = withSetting(next, member, effectiveOptions(plugin).values[member.split('.')[2]]);
    settings = withSetting(next, name, value);
  }
  function resetKeys(keys: SettingKey[]) {
    let next: PlotSettings = { ...settings };
    for (const key of keys)
      for (const member of groupOf(key, optionPlugins)) next = withSetting(next, member, undefined);
    settings = next;
  }
  function effectiveOptions(plugin: Plugin) {
    return resolveOptions(plugin.settings.options, effective.options?.[plugin.id]);
  }
  let previewSettings = $derived(effective);
  // Pinned runs are plotted in addition to the limit, within the chart request limit.
  let runLimitMax = $derived(
    Math.max(
      1,
      Math.min(
        panelLimits.chartRuns - pinned.length,
        Math.max(100, runs.length, typeof effective.maxRuns === 'number' ? effective.maxRuns : 0),
      ),
    ),
  );
  let manifest = $derived(plugins.find((p) => p.id === draft.plugin));
  const resolutionDefault = panelLimits.resolution.default as Resolution,
    resolutionNames: Record<Resolution, MessageKey> = {
      low: 'panelSettings.data.resolution.low',
      medium: 'panelSettings.data.resolution.medium',
      high: 'panelSettings.data.resolution.high',
      full: 'panelSettings.data.resolution.full',
    };
  let selectionMode = $derived(manifest?.metricSelection || 'multiple');
  // Computed metrics: named expressions over metrics of the same history record.
  let computedEnabled = $derived(capabilities.includes('expressions') && !settingsOnly);
  let computedChecks = $derived.by(() => {
    const checks: ComputedCheck[] = [];
    for (const row of computedRows) {
      const suggestion = suggestedName(
          row.expression,
          checks.map((check) => check.name),
        ),
        name = row.name.trim() || suggestion;
      const check: ComputedCheck = { name, suggestion };
      if (name && (keys.includes(name) || checks.some((previous) => previous.name === name)))
        check.nameError = codedMessage('COMPUTED_METRIC_DUPLICATE', { name });
      try {
        parseExpression(row.expression);
      } catch (failure) {
        check.errorCode = failure instanceof ExpressionError ? failure.code : 'EXPRESSION_EMPTY';
        check.errorParams = failure instanceof ExpressionError ? failure.params : {};
        check.expressionError = codedMessage(check.errorCode, check.errorParams);
      }
      checks.push(check);
    }
    return checks;
  });
  let computedInvalid = $derived(
    computedEnabled && computedChecks.some((check) => check.nameError || check.expressionError),
  );
  // The preview plots the computed metrics that are currently valid.
  let previewExpressions = $derived(
    computedEnabled
      ? computedRows.flatMap((row, index) =>
          computedChecks[index].nameError || computedChecks[index].expressionError
            ? []
            : [{ name: computedChecks[index].name, expression: row.expression }],
        )
      : [],
  );
  function draftExpressions() {
    return computedEnabled && computedRows.length
      ? computedRows.map((row, index) => ({
          name: computedChecks[index].name,
          expression: row.expression,
        }))
      : undefined;
  }
  let seriesCount = $derived(
    keys.filter(Boolean).length + (computedEnabled ? computedRows.length : 0),
  );
  // Layout applies to cellLayout panels; section and workspace settings offer it when a
  // panel in scope can use it. Focused run takes precedence over it.
  let cellPlugins = $derived(
    (settingsOnly ? scopePlugins : manifest ? [manifest] : []).filter((p) =>
      p.settings.common.includes('cellLayout'),
    ),
  );
  let focusedApplies = $derived(
    !settingsOnly && effective.maxRuns === 'focused' && supportsFocusedRun(manifest, seriesCount),
  );
  let showsCells = $derived(
    cellPlugins.length > 0 && (settingsOnly || (effective.layout === 'grid' && !focusedApplies)),
  );
  // Coverflow fills the panel, so the item size applies to grids only.
  let sizedItems = $derived(settingsOnly || effective.layout !== 'coverflow');
  // Media panels lay out their own items at the item size.
  let itemPlugins = $derived(
    (settingsOnly ? scopePlugins : manifest ? [manifest] : []).filter((p) =>
      p.settings.common.includes('itemLayout'),
    ),
  );
  // Item size applies to grids of cells or items, not to Coverflow or a single chart.
  let itemSizeShown = $derived(showsCells || (itemPlugins.length > 0 && sizedItems));
  // Host controls the editor shows, which options may follow; an option whose control is not
  // shown goes at the end of its tab.
  let anchors = $derived<Record<OptionTab, Set<string>>>({
    data: new Set(
      settingsOnly
        ? ['shown', 'resolution']
        : [
            'metrics',
            ...(selectionMode !== 'xy' && capabilities.includes('axes') ? ['xAxis'] : []),
            'title',
            ...(sections.length ? ['section'] : []),
            'shown',
            ...(capabilities.includes('cellLayout') ? ['layout'] : []),
            ...(['media', 'snapshot'].includes(manifest?.dataKind || '') ? [] : ['resolution']),
          ],
    ),
    axes: new Set([
      ...(settingsOnly && selectionMode !== 'xy' && !capabilities.includes('yAxis') ? ['xAxis'] : []),
      ...(hasBounds ? ['bounds'] : []),
      ...(capabilities.includes('outliers') ? ['outliers'] : []),
    ]),
    smoothing: new Set(
      capabilities.includes('smoothing')
        ? ['smoothing', ...(capabilities.includes('original') ? ['original'] : [])]
        : [],
    ),
    grouping: new Set(
      capabilities.includes('grouping')
        ? ['groupBy', 'aggregation', ...(capabilities.includes('spread') ? ['spread'] : [])]
        : [],
    ),
    display: new Set([
      ...(['legend', 'points', 'lineWidth', 'tooltip'] as const).filter((c) =>
        capabilities.includes(c),
      ),
      ...(itemSizeShown ? ['itemSize'] : []),
    ]),
  });
  // Media panels have no combined chart: an inherited Combined shows their grid.
  let layouts = $derived<NonNullable<PlotSettings['layout']>[]>(
    cellPlugins.length
      ? ['single', 'grid', 'coverflow']
      : itemPlugins.length
        ? ['grid', 'coverflow']
        : [],
  );
  const layoutNames: Record<NonNullable<PlotSettings['layout']>, MessageKey> = {
    single: 'panelSettings.data.layout.single',
    grid: 'panelSettings.data.layout.grid',
    coverflow: 'panelSettings.data.layout.coverflow',
  };
  // A shared Y range needs the plugin's `extent` export.
  let extentSupport = $state<Record<string, boolean>>({});
  $effect(() => {
    for (const plugin of cellPlugins)
      if (!(plugin.id in untrack(() => extentSupport)))
        void pluginExtent(plugin).then(
          (extent) => (extentSupport = { ...extentSupport, [plugin.id]: !!extent }),
          () => (extentSupport = { ...extentSupport, [plugin.id]: false }),
        );
  });
  let sharedYSupported = $derived(cellPlugins.some((p) => extentSupport[p.id] !== false));
  let eligibleMetrics = $derived(
    [...new Set([...metrics, ...Object.keys(metricKinds)])].filter((metric) =>
      (Object.hasOwn(metricKinds, metric) ? metricKinds[metric] : ['scalar']).some((kind) =>
        (manifest?.metricTypes || ['scalar']).includes(kind),
      ),
    ),
  );
  const loggedMetrics = $derived(Object.keys(metricKinds));
  const metricEmptyMessage = $derived(
    runs.length ? 'metrics.picker.unavailable' : 'panelSettings.data.noRuns',
  );
  const builtInAxes = ['_step', '_runtime', '_relative_wall', '_timestamp'];
  const missingXAxis = $derived(
    effective.xAxis && !builtInAxes.includes(effective.xAxis) && !metrics.includes(effective.xAxis)
      ? effective.xAxis
      : '',
  );
  let previousPlugin = '';
  $effect(() => {
    const id = draft.plugin;
    if (!open) {
      previousPlugin = '';
      return;
    }
    if (previousPlugin === id) return;
    const changed = !!previousPlugin;
    previousPlugin = id;
    // Opening or refreshing a catalog must never discard a stored metric.
    if (!changed) return;
    const available = eligibleMetrics;
    untrack(() => {
      let next = keys.filter((key) => available.includes(key));
      if (selectionMode === 'single') next = next.slice(0, 1);
      if (selectionMode === 'xy') next = next.slice(0, 2);
      keys = next;
      draft.metric = next[0] || '';
    });
  });
  let smoothingLabel = $derived(
    $t(
      effective.smoothingMethod === 'running'
        ? 'panelSettings.smoothing.window'
        : effective.smoothingMethod === 'gaussian'
          ? 'panelSettings.smoothing.sigma'
          : 'panelSettings.smoothing.weight',
    ),
  );
  let smoothingRange = $derived(
    effective.smoothingMethod && effective.smoothingMethod !== 'none'
      ? smoothingParameters[effective.smoothingMethod]
      : undefined,
  );
  // Values chosen in this editor per method, restored when switching back to that method.
  const chosenSmoothing: Partial<Record<string, number>> = {};
  const aggregationNames: Record<string, MessageKey> = {
    mean: 'panelSettings.grouping.aggregation.mean',
    median: 'panelSettings.grouping.aggregation.median',
    min: 'panelSettings.grouping.aggregation.min',
    max: 'panelSettings.grouping.aggregation.max',
  };
  const methods: [string, MessageKey][] = [
    ['none', 'panelSettings.smoothing.method.none'],
    ['ema', 'panelSettings.smoothing.method.ema'],
    ['twema', 'panelSettings.smoothing.method.twema'],
    ['gaussian', 'panelSettings.smoothing.method.gaussian'],
    ['running', 'panelSettings.smoothing.method.running'],
  ];
  let categories = $derived<MessageKey[]>([
    ...(workspaceScope ? (['panelSettings.tabs.panelList'] as const) : []),
    'panelSettings.tabs.data',
    ...(hasAxes ? (['panelSettings.tabs.axes'] as const) : []),
    ...(hasSmoothing ? (['panelSettings.tabs.smoothing'] as const) : []),
    ...(hasGrouping ? (['panelSettings.tabs.grouping'] as const) : []),
    ...(hasDisplay ? (['panelSettings.tabs.display'] as const) : []),
  ]);
  // Beside the fields the preview fills its column; stacked above them it keeps a fixed height.
  const stacked = new MediaQuery('max-width: 900px');
  function measureEditor(node: HTMLElement) {
    const observer = new ResizeObserver(() => {
      editorWidth = node.clientWidth;
      editorHeight = node.clientHeight;
    });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }
  function draftChanged() {
    return (
      JSON.stringify({
        plugin: draft.plugin,
        title: draft.title || '',
        section: draft.section || '',
        keys,
        settings,
        expressions: draftExpressions() || [],
      }) !== initialDraft
    );
  }
  let hideError = $derived.by(() => {
    try {
      if (hidePattern) new RegExp(hidePattern, 'i');
      return '';
    } catch {
      return $t('panelSettings.panelList.hidePattern.invalid');
    }
  });
  function requestClose() {
    if (settingsOnly) {
      open = false;
      return;
    }
    if (draftChanged()) discardPrompt = !discardPrompt;
    else open = false;
  }
  // Workspace and section settings choose no metrics.
  let saveDisabled = $derived(
    !!hideError ||
      percentilesInvalid ||
      (!settingsOnly &&
        (!(keys[0] || (computedEnabled && computedRows.length)) ||
          computedInvalid ||
          seriesCount > panelLimits.maxMetrics ||
          keys.some((key) => !key) ||
          (['xy', 'axes'].includes(selectionMode) && new Set(keys.filter(Boolean)).size < 2))),
  );
  function save() {
    if (saveDisabled) return;
    if (workspaceScope) {
      try {
        if (hidePattern) new RegExp(hidePattern, 'i');
      } catch {
        return;
      }
    }

    const chosen = keys.filter(Boolean);
    const clean: PlotSettings = {};
    for (const [k, v] of Object.entries(settings))
      if (v !== undefined && v !== '') Object.assign(clean, { [k]: v });
    // A panel keeps only its own plugin's options. Each layer keeps the keys its plugins
    // declare for this scope; options of plugins the editor does not show are kept as stored.
    if (clean.options) {
      const options: NonNullable<PlotSettings['options']> = {};
      for (const [id, values] of Object.entries(clean.options)) {
        if (!settingsOnly && id !== draft.plugin) continue;
        const plugin = settingsOnly
          ? optionPlugins.find((p) => p.id === id)
          : plugins.find((p) => p.id === id);
        const kept = plugin
          ? Object.fromEntries(
              plugin.settings.options
                .filter((option) => inScope(option) && Object.hasOwn(values, option.key))
                .map((option) => [option.key, values[option.key]]),
            )
          : values;
        if (Object.keys(kept).length) options[id] = kept;
      }
      if (Object.keys(options).length) clean.options = options;
      else delete clean.options;
    }
    if (clean.smoothingMethod && clean.smoothingValue !== undefined)
      clean.smoothingValue = smoothingAmount(clean.smoothingMethod, clean.smoothingValue);
    if (
      typeof effective.xMin === 'number' &&
      typeof effective.xMax === 'number' &&
      effective.xMin >= effective.xMax
    ) {
      error = 'panelSettings.axes.xRangeInvalid';
      return;
    }
    if (
      typeof effective.yMin === 'number' &&
      typeof effective.yMax === 'number' &&
      effective.yMin >= effective.yMax
    ) {
      error = 'panelSettings.axes.yRangeInvalid';
      return;
    }
    if (workspaceScope)
      onWorkspaceOptions({ generation: panelGeneration, hidePattern, hiddenMetrics });
    const { expressions: _, ...rest } = draft,
      expressions = draftExpressions(),
      metric = chosen[0] || expressions?.[0].name || draft.metric;
    onSave({
      ...rest,
      metric,
      metrics: chosen.length || expressions ? chosen : [draft.metric],
      settings: clean,
      ...(expressions ? { expressions } : {}),
    });
    open = false;
  }
</script>

{#snippet xAxisChoice()}
  <EditorChoice
    onRequestClose={requestClose}
    labelText={$t('panelSettings.data.xAxis')}
    disabled={metricsLoading}
    items={[
      { id: '_step', text: $t('charts.xAxis.step') },
      { id: '_runtime', text: $t('charts.xAxis.runtime') },
      { id: '_relative_wall', text: $t('charts.xAxis.relativeWall') },
      { id: '_timestamp', text: $t('charts.xAxis.wallTime') },
      ...metrics.map((id) => ({ id, text: id })),
      ...(missingXAxis ? [{ id: missingXAxis, text: missingXAxis }] : []),
    ]}
    selectedId={effective.xAxis || '_step'}
    clearSelectionId="_step"
    on:clear={() => {
      if ((effective.xAxis || '_step') !== '_step') override({ xAxis: '_step' });
    }}
    clearFilterOnOpen
    on:select={(event) => {
      const next = String(event.detail.selectedId || '_step');
      if (next !== (effective.xAxis || '_step')) override({ xAxis: next });
    }}
  />{#if !metricsLoading && missingXAxis}<p class="bx--form__helper-text">
      {$t('metrics.notLogged', { metric: missingXAxis })}
    </p>{/if}
  {#if !runs.length}<p class="bx--form__helper-text">{$t('panelSettings.data.noRuns')}</p>{/if}
  {@render origin(['xAxis'], $t('panelSettings.data.xAxis'))}
{/snippet}

{#snippet origin(keys: SettingKey[], label: string)}
  {@const overridden = keys.some((key) => settingValue(settings, key) !== undefined)}
  {@const source = overridden ? scope : sourceOf(inheritedSources, keys)}
  {#if overridden || !workspaceScope}<div class="setting-origin">
      <span
        >{$t(
          source === 'panel'
            ? 'panelSettings.origin.panel'
            : source === 'section'
              ? overridden
                ? 'panelSettings.origin.section'
                : 'panelSettings.origin.fromSection'
              : source === 'workspace'
                ? overridden
                  ? 'panelSettings.origin.workspace'
                  : 'panelSettings.origin.fromWorkspace'
                : 'panelSettings.origin.default',
        )}</span
      >{#if overridden}<Button
          kind="ghost"
          size="small"
          aria-label={$t(
            workspaceScope ? 'panelSettings.origin.resetDefault' : 'panelSettings.origin.resetInherited',
            {
              setting: label,
            },
          )}
          on:click={() => resetKeys(keys)}>{$t('panelSettings.origin.reset')}</Button
        >{/if}
    </div>{/if}
{/snippet}

{#snippet optionField(plugin: Plugin, option: OptionDescriptor)}
  {@const resolvedOptions = effectiveOptions(plugin)}
  {@const text = optionText(plugin)}
  <PluginOptionField
    {option}
    {dark}
    {text}
    value={resolvedOptions.values[option.key]}
    invalidSaved={resolvedOptions.invalid.includes(option.key)}
    disabled={!optionEnabled(option, resolvedOptions.values, {
      legend: effective.legend ?? true,
      smoothingMethod: effective.smoothingMethod,
      groupBy: effective.groupBy || 'none',
    })}
    onChange={(value) => overrideOption(plugin, option.key, value)}
  />{@render origin([optionKey(plugin.id, option.key)], text(option.label))}
{/snippet}

<!-- Options after a host control in panel settings; with no anchor, the rest of the tab's
     options under each plugin's name. -->
{#snippet pluginOptions(tab: OptionTab, anchor?: string)}
  {#each optionPlugins.filter((p) => p.builtin || localizers[p.id]) as plugin (plugin.id)}
    {@const list = optionsAt(
      plugin.settings.options.filter(inScope),
      tab,
      anchor,
      settingsOnly ? noAnchors : anchors[tab],
    )}
    {#if list.length}{#if anchor === undefined}<h3 class="form-subheading">
          {pluginName(plugin, $t)}
        </h3>{/if}{#each list as option (option.key)}{@render optionField(plugin, option)}{/each}{/if}
  {/each}
{/snippet}

{#snippet runLimit()}
  {@const groupedLimit = !!effective.groupBy && effective.groupBy !== 'none'}
  {@const shownLabel = $t(groupedLimit ? 'panelSettings.data.limit.labelGrouped' : 'panelSettings.data.limit.label')}
  <Select
    labelText={shownLabel}
    selected={effective.maxRuns === 'focused'
      ? 'focused'
      : typeof effective.maxRuns === 'number'
        ? 'limit'
        : 'all'}
    on:change={(event) => {
      const mode = (event.target as HTMLSelectElement).value;
      if (mode === 'all') {
        if (workspaceScope) resetKeys(['maxRuns']);
        else override({ maxRuns: null });
      } else override({ maxRuns: mode === 'focused' ? 'focused' : Math.min(10, runLimitMax) });
    }}
    ><SelectItem value="all" text={$t('panelSettings.data.limit.all')} /><SelectItem
      value="limit"
      text={$t('panelSettings.data.limit.maximum')}
    />{#if settingsOnly || supportsFocusedRun(manifest, seriesCount) || effective.maxRuns === 'focused'}<SelectItem
        value="focused"
        text={$t('panelSettings.data.limit.focused')}
      />{/if}</Select
  >{#if typeof effective.maxRuns === 'number'}<Slider
      labelText={$t(groupedLimit ? 'panelSettings.data.limit.countGrouped' : 'panelSettings.data.limit.count')}
      hideLabel
      min={1}
      max={runLimitMax}
      step={1}
      value={effective.maxRuns}
      on:change={(event) => override({ maxRuns: event.detail })}
    />{/if}{@render origin(['maxRuns'], shownLabel)}{@render pluginOptions('data', 'shown')}
  {#if layouts.length}<div class="layout-choice">
      <span class="bx--label" id="layout-label">{$t('panelSettings.data.layout.label')}</span>
      <ContentSwitcher
        size="sm"
        aria-labelledby="layout-label"
        selectedIndex={Math.max(0, layouts.indexOf(effective.layout || 'single'))}
        on:change={(event) => override({ layout: layouts[event.detail] })}
        >{#each layouts as layout (layout)}<Switch
            text={$t(layoutNames[layout])}
            disabled={focusedApplies}
            ><span class="switch-label"
              >{#if layout === 'single'}<ChartLine size={16} />{:else if layout === 'grid'}<GridIcon
                  size={16}
                />{:else}<CarouselHorizontal size={16} />{/if}{$t(layoutNames[layout])}</span
            ></Switch
          >{/each}</ContentSwitcher
      >{#if focusedApplies}<div class="bx--form__helper-text">
          {$t('panelSettings.data.layout.focusedHelp')}
        </div>{/if}
    </div>{@render origin(['layout'], $t('panelSettings.data.layout.label'))}{@render pluginOptions(
      'data',
      'layout',
    )}{/if}
  {#if itemPlugins.length}<RadioButtonGroup
      legendText={$t('panelSettings.data.mediaAcross.label')}
      orientation="vertical"
      selected={effective.mediaAcross || 'runs'}
      on:change={(event) => override({ mediaAcross: event.detail as 'runs' | 'steps' })}
      ><RadioButton
        labelText={$t('panelSettings.data.mediaAcross.runs')}
        value="runs"
      /><RadioButton
        labelText={$t('panelSettings.data.mediaAcross.steps')}
        value="steps"
      /></RadioButtonGroup
    >{@render origin(['mediaAcross'], $t('panelSettings.data.mediaAcross.label'))}<Slider
      aria-label={$t('panelSettings.data.mediaFiles.label')}
      labelText={$t('panelSettings.data.mediaFiles.label')}
      helperText={$t('panelSettings.data.mediaFiles.help')}
      min={1}
      max={panelLimits.media.files.max}
      step={1}
      value={effective.mediaFiles ?? panelLimits.media.files.default}
      on:change={(event) => override({ mediaFiles: Number(event.detail) })}
    />{@render origin(['mediaFiles'], $t('panelSettings.data.mediaFiles.label'))}{/if}
  {#if anchors.data.has('resolution')}<Select
      labelText={$t('panelSettings.data.resolution.label')}
      selected={effective.resolution ?? resolutionDefault}
      on:change={(event) =>
        override({ resolution: (event.target as HTMLSelectElement).value as Resolution })}
      >{#each Object.entries(resolutionNames) as [value, name]}<SelectItem
          {value}
          text={$t(name)}
        />{/each}</Select
    >{@render origin(['resolution'], $t('panelSettings.data.resolution.label'))}{@render pluginOptions(
      'data',
      'resolution',
    )}{/if}
{/snippet}

{#snippet editorForm()}
  <div class="editor-categories" class:compact-categories={!settingsOnly && editorWidth < 600}>
    {#if !settingsOnly && editorWidth < 600}<Select
        labelText={$t('panelSettings.title.edit')}
        hideLabel
        selected={String(tab)}
        on:change={(event) => (tab = Number((event.target as HTMLSelectElement).value))}
        >{#each categories as category, index}<SelectItem
            value={String(index)}
            text={$t(category)}
          />{/each}</Select
      >{/if}
    {#key editorSession}<Tabs autoWidth bind:selected={tab}
        >{#if workspaceScope}<Tab label={$t('panelSettings.tabs.panelList')} />{/if}<Tab
          label={$t('panelSettings.tabs.data')}
        />{#if hasAxes}<Tab
            label={$t('panelSettings.tabs.axes')}
          />{/if}{#if hasSmoothing}<Tab
            label={$t('panelSettings.tabs.smoothing')}
          />{/if}{#if hasGrouping}<Tab
            label={$t('panelSettings.tabs.grouping')}
          />{/if}{#if hasDisplay}<Tab label={$t('panelSettings.tabs.display')} />{/if}<svelte:fragment slot="content">
          {#if workspaceScope}<TabContent
              ><div class="form-stack">
                <Select
                  labelText={$t('panelSettings.panelList.generation.label')}
                  helperText={$t(
                    panelGeneration === 'automatic'
                      ? 'panelSettings.panelList.generation.automaticHelp'
                      : 'panelSettings.panelList.generation.manualHelp',
                  )}
                  bind:selected={panelGeneration}
                  ><SelectItem value="automatic" text={$t('panelSettings.panelList.generation.automatic')} /><SelectItem
                    value="manual"
                    text={$t('panelSettings.panelList.generation.manual')}
                  /></Select
                >
                <TextInput
                  labelText={$t('panelSettings.panelList.hidePattern.label')}
                  placeholder={$t('panelSettings.panelList.hidePattern.placeholder')}
                  helperText={$t('panelSettings.panelList.hidePattern.help')}
                  bind:value={hidePattern}
                  invalid={!!hideError}
                  invalidText={hideError}
                />
                {#if hiddenMetrics.length}<Button
                    kind="tertiary"
                    size="small"
                    on:click={() => (hiddenMetrics = [])}
                    >{$t('panelSettings.panelList.restore', {
                      count: hiddenMetrics.length,
                    })}</Button
                  >{/if}
              </div></TabContent
            >{/if}
            <TabContent
              ><div class="form-stack">
                {#if !settingsOnly}
                <Select labelText={$t('panelSettings.data.type')} bind:selected={draft.plugin}
                  >{#each plugins.filter((p) => p.enabled) as p}<SelectItem
                      value={p.id}
                      text={pluginName(p, $t)}
                    />{/each}</Select
                >
                {#if selectionMode === 'xy'}
                  <MetricPicker
                    onRequestClose={requestClose}
                    loading={metricsLoading}
                    {loggedMetrics}
                    label={$t('panelSettings.data.xMetric')}
                    emptyMessage={eligibleMetrics.length
                      ? 'panelSettings.data.noOtherMetrics'
                      : metricEmptyMessage}
                    metrics={eligibleMetrics.filter((metric) => metric !== keys[0])}
                    selected={keys[1] ? [keys[1]] : []}
                    limit={1}
                    onChange={(next) =>
                      (keys = next.length ? [keys[0] || '', next[0]] : keys.slice(0, 1))}
                  />
                  <MetricPicker
                    onRequestClose={requestClose}
                    loading={metricsLoading}
                    {loggedMetrics}
                    label={$t('panelSettings.data.yMetric')}
                    emptyMessage={eligibleMetrics.length
                      ? 'panelSettings.data.noOtherMetrics'
                      : metricEmptyMessage}
                    metrics={eligibleMetrics.filter((metric) => metric !== keys[1])}
                    selected={keys[0] ? [keys[0]] : []}
                    limit={1}
                    onChange={(next) => {
                      keys = [next[0] || '', keys[1] || ''];
                      draft.metric = keys[0];
                    }}
                  />{@render pluginOptions('data', 'metrics')}
                {:else}
                  <MetricPicker
                    onRequestClose={requestClose}
                    loading={metricsLoading}
                    {loggedMetrics}
                    label={selectionMode === 'single'
                      ? $t('panelSettings.data.metric')
                      : selectionMode === 'axes'
                        ? $t('panelSettings.data.axisMetrics')
                        : $t('panelSettings.data.yMetrics')}
                    metrics={eligibleMetrics}
                    emptyMessage={metricEmptyMessage}
                    selected={keys}
                    limit={selectionMode === 'single' ? 1 : panelLimits.maxMetrics}
                    capacity={computedEnabled
                      ? panelLimits.maxMetrics - seriesCount
                      : panelLimits.maxMetrics}
                    seriesCount={computedEnabled ? seriesCount : undefined}
                    onChange={(next) => {
                      keys = next;
                      draft.metric = next[0] || '';
                    }}
                  />
                  {#if computedEnabled}<ComputedMetricList
                      bind:rows={computedRows}
                      checks={computedChecks}
                      metrics={eligibleMetrics}
                      plotted={keys}
                      capacity={panelLimits.maxMetrics - seriesCount}
                      loading={metricsLoading}
                      nextId={() => ++computedSerial}
                    />{/if}
                  {@render pluginOptions('data', 'metrics')}
                  {#if capabilities.includes('axes')}{@render xAxisChoice()}{@render pluginOptions(
                      'data',
                      'xAxis',
                    )}{/if}
                {/if}
                <TextInput
                  labelText={$t('panelSettings.data.title')}
                  placeholder={keys[0] || computedChecks[0]?.name || draft.metric}
                  bind:value={draft.title}
                />{@render pluginOptions('data', 'title')}
                {#if sections.length}<Select
                    labelText={$t('panelSettings.data.section')}
                    selected={draft.section || ''}
                    on:change={(event) =>
                      (draft.section = (event.target as HTMLSelectElement).value || undefined)}
                    ><SelectItem
                      value=""
                      text={$t('panelSettings.data.sectionByPrefix')}
                    />{#each sections as section}<SelectItem
                        value={section.id}
                        text={section.name}
                      />{/each}</Select
                  >{@render pluginOptions('data', 'section')}{/if}
                {/if}
                {@render runLimit()}
                {@render pluginOptions('data')}
              </div></TabContent
            >
          {#if hasAxes}<TabContent
              ><div class="form-stack">
                {#if settingsOnly && selectionMode !== 'xy' && !capabilities.includes('yAxis')}{@render xAxisChoice()}{@render pluginOptions(
                    'axes',
                    'xAxis',
                  )}{/if}
                {#if hasBounds}<div class="form-grid">
                    {#each capabilities.includes('yAxis') ? ['y'] : ['x', 'y'] as axis}{@const scaleKey =
                        (axis + 'Scale') as 'xScale' | 'yScale'}
                      <div class="form-stack">
                        <Select
                          labelText={$t('panelSettings.axes.scale', { axis: axis.toUpperCase() })}
                          selected={effective[scaleKey] || 'linear'}
                          on:change={(event) =>
                            override({ [scaleKey]: (event.target as HTMLSelectElement).value })}
                          ><SelectItem value="linear" text={$t('panelSettings.axes.linear')} /><SelectItem
                            value="log"
                            text={$t('panelSettings.axes.logarithmic')}
                          /></Select
                        >
                        {#each ['Min', 'Max'] as bound}{@const boundKey = (axis + bound) as
                            'xMin' | 'xMax' | 'yMin' | 'yMax'}<TextInput
                            labelText={$t(bound === 'Min' ? 'panelSettings.axes.min' : 'panelSettings.axes.max', {
                              axis: axis.toUpperCase(),
                            })}
                            type="number"
                            value={effective[boundKey]?.toString() || ''}
                            placeholder={$t('panelSettings.axes.automatic')}
                            on:input={(event) =>
                              override({
                                [boundKey]:
                                  event.detail === '' || event.detail === null
                                    ? null
                                    : Number(event.detail),
                              })}
                          />{/each}
                        {@render origin(
                          [scaleKey, (axis + 'Min') as 'xMin', (axis + 'Max') as 'xMax'],
                          $t('panelSettings.axes.axisSetting', { axis: axis.toUpperCase() }),
                        )}
                      </div>{/each}
                  </div>{@render pluginOptions('axes', 'bounds')}{/if}
                {#if showsCells && hasBounds}<Checkbox
                    labelText={$t('panelSettings.axes.sharedY.label')}
                    helperText={sharedYSupported ? '' : $t('panelSettings.axes.sharedY.unavailable')}
                    disabled={!sharedYSupported}
                    checked={effective.sharedY || false}
                    on:change={(event) =>
                      override({ sharedY: (event.target as HTMLInputElement).checked })}
                  />{@render origin(['sharedY'], $t('panelSettings.axes.sharedY.label'))}{/if}
                {#if capabilities.includes('outliers')}<Checkbox
                    labelText={$t('panelSettings.axes.excludeOutliers.label')}
                    disabled={yFixed}
                    checked={effective.excludeOutliers || false}
                    on:change={(event) =>
                      override({
                        excludeOutliers: (event.target as HTMLInputElement).checked,
                      })}
                  />{@render origin(['excludeOutliers'], $t('panelSettings.axes.excludeOutliers.setting'))}
                  <Slider
                    aria-label={$t('panelSettings.axes.excludeOutliers.lower')}
                    labelText={$t('panelSettings.axes.excludeOutliers.lower')}
                    min={0}
                    max={100}
                    step={1}
                    disabled={yFixed || !effective.excludeOutliers}
                    invalid={percentilesInvalid}
                    value={outlierLower}
                    on:change={(event) =>
                      override({ outlierLower: Number(event.detail), outlierUpper })}
                  /><Slider
                    aria-label={$t('panelSettings.axes.excludeOutliers.upper')}
                    labelText={$t('panelSettings.axes.excludeOutliers.upper')}
                    min={0}
                    max={100}
                    step={1}
                    disabled={yFixed || !effective.excludeOutliers}
                    invalid={percentilesInvalid}
                    invalidText={$t('panelSettings.axes.excludeOutliers.invalid')}
                    value={outlierUpper}
                    on:change={(event) =>
                      override({ outlierLower, outlierUpper: Number(event.detail) })}
                  />{@render origin(
                    ['outlierLower', 'outlierUpper'],
                    $t('panelSettings.axes.excludeOutliers.percentiles'),
                  )}{@render pluginOptions('axes', 'outliers')}{/if}
                {@render pluginOptions('axes')}
              </div></TabContent
            >
          {/if}
          {#if hasSmoothing}<TabContent
              ><div class="form-stack">
                {#if capabilities.includes('smoothing')}<Select
                  labelText={$t('panelSettings.smoothing.method.label')}
                  selected={effective.smoothingMethod || 'none'}
                  on:change={(event) => {
                    const method = (event.target as HTMLSelectElement)
                      .value as PlotSettings['smoothingMethod'];
                    override({
                      smoothingMethod: method,
                      smoothingValue:
                        !method || method === 'none'
                          ? undefined
                          : (chosenSmoothing[method] ?? smoothingParameters[method].value),
                    });
                  }}
                  >{#each methods as [id, name]}<SelectItem
                      value={id}
                      text={$t(name)}
                    />{/each}</Select
                >{#if smoothingRange}<Slider
                    aria-label={smoothingLabel}
                    labelText={smoothingLabel}
                    value={smoothingAmount(effective.smoothingMethod!, effective.smoothingValue)}
                    min={smoothingRange.min}
                    max={smoothingRange.max}
                    step={smoothingRange.step}
                    on:change={(event) => {
                      const value = Number(event.detail);
                      chosenSmoothing[effective.smoothingMethod!] = value;
                      override({ smoothingValue: value });
                    }}
                  />{/if}{@render origin(
                  ['smoothingMethod'],
                  $t('panelSettings.smoothing.setting'),
                )}{@render pluginOptions('smoothing', 'smoothing')}{#if capabilities.includes('original')}<Checkbox
                    labelText={$t('panelSettings.smoothing.showOriginal')}
                    checked={effective.showOriginal || false}
                    on:change={(event) =>
                      override({ showOriginal: (event.target as HTMLInputElement).checked })}
                  />{@render origin(['showOriginal'], $t('panelSettings.smoothing.showOriginal'))}{@render pluginOptions(
                    'smoothing',
                    'original',
                  )}{/if}{/if}
                {@render pluginOptions('smoothing')}
              </div></TabContent
            >
          {/if}
          {#if hasGrouping}<TabContent
              ><div class="form-stack">
                {#if capabilities.includes('grouping')}<EditorChoice
                  onRequestClose={requestClose}
                  labelText={$t('panelSettings.grouping.groupBy')}
                  items={[
                    { id: 'none', text: $t('panelSettings.grouping.none') },
                    { id: 'all', text: $t('panelSettings.grouping.all') },
                    ...groupFields(fields).map((f) => ({ id: f, text: fieldLabel(f, $t) })),
                  ]}
                  selectedId={effective.groupBy || 'none'}
                  clearSelectionId="none"
                  on:clear={() => {
                    if ((effective.groupBy || 'none') !== 'none') override({ groupBy: 'none' });
                  }}
                  clearFilterOnOpen
                  on:select={(event) => {
                    const next = String(event.detail.selectedId || 'none');
                    if (next !== (effective.groupBy || 'none')) override({ groupBy: next });
                  }}
                />{@render pluginOptions('grouping', 'groupBy')}<Select
                  disabled={!effective.groupBy || effective.groupBy === 'none'}
                  labelText={$t('panelSettings.grouping.aggregation.label')}
                  selected={effective.aggregation || 'mean'}
                  on:change={(event) =>
                    override({ aggregation: (event.target as HTMLSelectElement).value })}
                  >{#each Object.entries(aggregationNames) as [method, name]}<SelectItem
                      value={method}
                      text={$t(name)}
                    />{/each}</Select
                >{@render pluginOptions('grouping', 'aggregation')}{#if capabilities.includes('spread')}<Select
                    disabled={!effective.groupBy || effective.groupBy === 'none'}
                    labelText={$t('panelSettings.grouping.spread.label')}
                    selected={effective.spread || 'none'}
                    on:change={(event) =>
                      override({ spread: (event.target as HTMLSelectElement).value })}
                    ><SelectItem value="none" text={$t('panelSettings.grouping.spread.none')} /><SelectItem
                      value="minmax"
                      text={$t('panelSettings.grouping.spread.minMax')}
                    /><SelectItem value="stddev" text={$t('panelSettings.grouping.spread.stddev')} /><SelectItem
                      value="stderr"
                      text={$t('panelSettings.grouping.spread.stderr')}
                    /></Select
                  >{/if}{@render origin(['groupBy'], $t('panelSettings.grouping.setting'))}{@render pluginOptions(
                  'grouping',
                  'spread',
                )}{/if}
                {@render pluginOptions('grouping')}
              </div></TabContent
            >
          {/if}
          {#if hasDisplay}<TabContent
              ><div class="form-stack">
                {#if capabilities.includes('legend')}<Checkbox
                    labelText={$t('panelSettings.legend.show')}
                    checked={effective.legend ?? true}
                    on:change={(event) =>
                      override({ legend: (event.target as HTMLInputElement).checked })}
                  /><Select
                    disabled={effective.legend === false}
                    labelText={$t('panelSettings.legend.position')}
                    selected={effective.legendPosition || 'top'}
                    on:change={(event) =>
                      override({
                        legendPosition: (event.target as HTMLSelectElement)
                          .value as PlotSettings['legendPosition'],
                      })}
                    ><SelectItem value="top" text={$t('panelSettings.legend.top')} /><SelectItem
                      value="bottom"
                      text={$t('panelSettings.legend.bottom')}
                    /><SelectItem value="left" text={$t('panelSettings.legend.left')} /><SelectItem
                      value="right"
                      text={$t('panelSettings.legend.right')}
                    /></Select
                  >{#if capabilities.includes('legendLabels')}<EditorChoice
                      onRequestClose={requestClose}
                      disabled={effective.legend === false}
                      labelText={$t('panelSettings.legend.labels.label')}
                      items={[
                        { id: '{run}', text: $t('panelSettings.legend.labels.run') },
                        { id: '{id}', text: $t('panelSettings.legend.labels.id') },
                        { id: '{run} · {metric}', text: $t('panelSettings.legend.labels.runMetric') },
                      ]}
                      selectedId={effective.legendTemplate || '{run}'}
                      clearSelectionId={'{run}'}
                      clearFilterOnOpen
                      on:clear={() => {
                        if ((effective.legendTemplate || '{run}') !== '{run}')
                          override({ legendTemplate: '{run}' });
                      }}
                      on:select={(event) => {
                        const next = String(event.detail.selectedId || '{run}');
                        if (next !== (effective.legendTemplate || '{run}'))
                          override({ legendTemplate: next });
                      }}
                    />{/if}{@render origin(
                    ['legend', 'legendPosition', 'legendTemplate'],
                    $t('panelSettings.legend.setting'),
                  )}{@render pluginOptions('display', 'legend')}{/if}{#if capabilities.includes('points')}<Checkbox
                    labelText={$t('panelSettings.display.points')}
                    checked={effective.showPoints || false}
                    on:change={(event) =>
                      override({ showPoints: (event.target as HTMLInputElement).checked })}
                  />{@render origin(
                    ['showPoints'],
                    $t('panelSettings.display.points'),
                  )}{@render pluginOptions('display', 'points')}{/if}{#if capabilities.includes('lineWidth')}<Slider
                    aria-label={$t('panelSettings.display.lineWidth')}
                    labelText={$t('panelSettings.display.lineWidth')}
                    min={0.5}
                    max={8}
                    step={0.5}
                    value={effective.lineWidth || 1.5}
                    on:change={(event) => override({ lineWidth: Number(event.detail) })}
                  />{@render origin(['lineWidth'], $t('panelSettings.display.lineWidth'))}{@render pluginOptions(
                    'display',
                    'lineWidth',
                  )}{/if}
                {#if capabilities.includes('tooltip')}<h3 class="form-subheading">
                    {$t('panelSettings.tooltip.title')}
                  </h3>
                  <Slider
                    aria-label={$t('panelSettings.tooltip.maxEntries')}
                    labelText={$t('panelSettings.tooltip.maxEntries')}
                    min={1}
                    max={100}
                    step={1}
                    value={effective.tooltipLimit || 10}
                    on:change={(event) => override({ tooltipLimit: event.detail })}
                  />
                  {#each [['tooltipFullNames', 'panelSettings.tooltip.fullNames'], ['tooltipColoredNames', 'panelSettings.tooltip.coloredNames'], ['tooltipOnlyHighlighted', 'panelSettings.tooltip.highlightedOnly']] as const as [key, label]}<Checkbox
                      labelText={$t(label)}
                      checked={effective[key] || false}
                      on:change={(event) =>
                        override({ [key]: (event.target as HTMLInputElement).checked })}
                    />{/each}
                  {@render origin(
                    [
                      'tooltipLimit',
                      'tooltipFullNames',
                      'tooltipColoredNames',
                      'tooltipOnlyHighlighted',
                    ],
                    $t('panelSettings.tooltip.title'),
                  )}{@render pluginOptions('display', 'tooltip')}
                {/if}
                {#if anchors.display.has('itemSize')}{@const size =
                    effective.itemSize ??
                    (itemPlugins.length ? panelLimits.itemSize.media : panelLimits.itemSize.chart)}<Slider
                    aria-label={$t('panelSettings.display.itemSize.label')}
                    labelText={$t('panelSettings.display.itemSize.label')}
                    helperText={showsCells && size < panelLimits.itemSize.chartMin
                      ? $t('panelSettings.display.itemSize.chartMinimum', {
                          size: panelLimits.itemSize.chartMin,
                        })
                      : ''}
                    min={panelLimits.itemSize.min}
                    max={panelLimits.itemSize.max}
                    step={panelLimits.itemSize.step}
                    formatValue={(value: number) => $t('common.units.px', { value })}
                    value={size}
                    on:change={(event) => override({ itemSize: Number(event.detail) })}
                  />{@render origin(['itemSize'], $t('panelSettings.display.itemSize.label'))}{@render pluginOptions(
                    'display',
                    'itemSize',
                  )}{/if}
                {@render pluginOptions('display')}
              </div></TabContent
            >
          {/if}
        </svelte:fragment></Tabs
      >{/key}
  </div>
  {#if !workspaceScope && (settingsOnly || !!panel.id) && Object.values(settings).some((value) => value !== undefined)}<Button
      kind="ghost"
      size="small"
      on:click={() => (settings = {})}>{$t('panelSettings.resetAll')}</Button
    >{/if}{#if error}<InlineNotification kind="error" title={$t(error)} hideCloseButton />{/if}
{/snippet}
{#if open && settingsOnly}<SideDrawer
    title={heading || $t('panelSettings.drawerTitle')}
    onClose={() => (open = false)}
    >{@render editorForm()}{#snippet footer()}<Button
        kind="secondary"
        on:click={() => (open = false)}>{$t('common.action.cancel')}</Button
      ><Button on:click={save}>{$t('panelSettings.apply')}</Button>{/snippet}</SideDrawer
  >
{:else}
  <Modal
    class="panel-editor-modal"
    selectorPrimaryFocus={primaryFocus}
    size="lg"
    bind:open
    bind:ref={modalRef}
    iconDescription={$t('common.action.close')}
    on:keydown={(event) => {
      if (event.isComposing || event.keyCode === 229) {
        event.stopImmediatePropagation();
        return;
      }
      if (event.key === 'Enter' && event.repeat) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (
        event.key === 'Enter' &&
        (event.target instanceof HTMLInputElement ||
          (event.target instanceof HTMLTextAreaElement &&
            event.target.closest('.expression-input')))
      ) {
        event.preventDefault();
        if (event.target instanceof HTMLTextAreaElement) save();
        if (event.target.classList.contains('bx--slider-text-input'))
          event.target.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }}
    modalHeading={discardPrompt
      ? $t('panelSettings.discard.title')
      : heading || $t(panel.id ? 'panelSettings.title.edit' : 'panelSettings.title.add')}
    primaryButtonText={$t(
      discardPrompt ? 'panelSettings.discard.confirm' : settingsOnly ? 'panelSettings.saveSettings' : 'panelSettings.savePanel',
    )}
    danger={discardPrompt}
    primaryButtonDisabled={!discardPrompt && saveDisabled}
    secondaryButtonText={$t(discardPrompt ? 'panelSettings.discard.keepEditing' : 'common.action.cancel')}
    on:close={(event) => {
      if (event.detail.trigger !== 'programmatic' && draftChanged()) {
        event.preventDefault();
        discardPrompt = !discardPrompt;
      }
    }}
    on:submit={() => {
      if (discardPrompt) open = false;
      else save();
    }}
    on:click:button--secondary={async () => {
      if (discardPrompt) {
        keptDraft = true;
        discardPrompt = false;
        await tick();
        focusEditorCategory();
      } else open = false;
    }}
  >
    {#if open}<div class="panel-editor-layout" use:measureEditor>
        <div class="panel-editor-preview">
          {#if keys.some(Boolean) || previewExpressions.length}<PanelCard
              height={editorWidth < 850 || stacked.current ? 180 : editorHeight}
              panel={{
                ...draft,
                id: 'preview-' + draft.id,
                metric: keys.find(Boolean) || previewExpressions[0]?.name || '',
                metrics: keys.filter(Boolean),
                settings: previewSettings,
                expressions: previewExpressions.length ? previewExpressions : undefined,
              }}
              {runs}
              {pinned}
              {dark}
              {colors}
              plugin={plugins.find((p) => p.id === draft.plugin)}
              readonly
              onedit={() => {}}
              onremove={() => {}}
              onduplicate={() => {}}
              onmove={() => {}}
            />{:else}<div class="empty-preview">
              {$t('panelSettings.preview.empty')}
            </div>{/if}
        </div>
        <div class="panel-editor-fields">{@render editorForm()}</div>
      </div>{/if}
  </Modal>{/if}

<div
  class="panel-editor-closing-shield"
  aria-hidden="true"
  hidden={!closing}
  bind:this={shieldRef}
  use:shieldInput
></div>
