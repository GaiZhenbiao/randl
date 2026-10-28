<script lang="ts">
  import {
    filterChoice,
    fieldLabel,
    runSearchQuery,
    runURL,
    artifactURL,
    groupFields,
    resultCount,
    runGroupField,
    pluginName,
  } from './ui';
  import { t, number, message, type Message, type MessageKey } from './i18n';

  import { onMount, tick, untrack } from 'svelte';
  import {
    Header,
    SideNav,
    SideNavItems,
    SideNavLink,
    SideNavDivider,
    Tabs,
    Tab,
    TabContent,
    Breadcrumb,
    BreadcrumbItem,
    Button,
    Modal,
    TextInput,
    TextArea,
    Select,
    SelectItem,
    Search,
    ComboBox,
    InlineNotification,
    NotificationActionButton,
    Theme,
    OverflowMenu,
    OverflowMenuItem,
  } from 'carbon-components-svelte';
  import Add from 'carbon-icons-svelte/lib/Add.svelte';
  import Settings from 'carbon-icons-svelte/lib/Settings.svelte';
  import Chat from 'carbon-icons-svelte/lib/Chat.svelte';
  import Folders from 'carbon-icons-svelte/lib/Folders.svelte';
  import Undo from 'carbon-icons-svelte/lib/Undo.svelte';
  import Redo from 'carbon-icons-svelte/lib/Redo.svelte';
  import SideDrawer from './SideDrawer.svelte';
  import ContextPopover from './ContextPopover.svelte';
  import ViewIcon from 'carbon-icons-svelte/lib/View.svelte';
  import ViewFilled from 'carbon-icons-svelte/lib/ViewFilled.svelte';
  import ViewOff from 'carbon-icons-svelte/lib/ViewOff.svelte';
  import SortDescending from 'carbon-icons-svelte/lib/SortDescending.svelte';
  import SortAscending from 'carbon-icons-svelte/lib/SortAscending.svelte';
  import GroupObjects from 'carbon-icons-svelte/lib/GroupObjects.svelte';
  import ArrowLeft from 'carbon-icons-svelte/lib/ArrowLeft.svelte';
  import SidePanelOpen from 'carbon-icons-svelte/lib/SidePanelOpen.svelte';
  import SidePanelClose from 'carbon-icons-svelte/lib/SidePanelClose.svelte';
  import Menu from 'carbon-icons-svelte/lib/Menu.svelte';
  import Close from 'carbon-icons-svelte/lib/Close.svelte';
  import { parseRoute, pageURL } from './routes';
  import Login from './Login.svelte';
  import AgentSettings from './AgentSettings.svelte';
  import LanguagePicker from './LanguagePicker.svelte';
    import FilterBuilder from './FilterBuilder.svelte';
  import Filter from 'carbon-icons-svelte/lib/Filter.svelte';
  import PanelEditor from './PanelEditor.svelte';
  import Workspace from './Workspace.svelte';
  import RunPage from './RunPage.svelte';
  import RunStateTag from './RunStateTag.svelte';
  import PanelTools from './PanelTools.svelte';
  import Download from 'carbon-icons-svelte/lib/Download.svelte';
  import StopFilled from 'carbon-icons-svelte/lib/StopFilled.svelte';
  import ProjectPages from './ProjectPages.svelte';
  import ServerOverview from './ServerOverview.svelte';
  import ConnectSdk from './ConnectSdk.svelte';
  import Code from 'carbon-icons-svelte/lib/Code.svelte';
  import { pendingProjectConfirmation } from './agent-confirmation';
  import Dashboard from 'carbon-icons-svelte/lib/Dashboard.svelte';
  import Activity from 'carbon-icons-svelte/lib/Activity.svelte';
  import Table from 'carbon-icons-svelte/lib/Table.svelte';
  import ChartLine from 'carbon-icons-svelte/lib/ChartLine.svelte';
  import Archive from 'carbon-icons-svelte/lib/Archive.svelte';
  import TrashPanel from './TrashPanel.svelte';
  import RunTable from './RunTable.svelte';
  import RunList from './RunList.svelte';
  import selectionLimits from '../../backend/src/selection-limits.json';
  import { ApiError, MessageError, api, tool, apiMessage, knownMessage, clearCache } from './api';
  import { resolveRunColors } from './run-colors';
  import { accents, palette } from './theme';
  import type {
    Run,
    View,
    Plugin,
    Panel,
    PlotSettings,
    Section,
    SectionLayout,
    ProjectSummary,
  } from './types';
  let runPanelSearch = $state('');
  let canvasWidth = $state(1000),
    focusPanel = $state('');
  function observeCanvas(node: HTMLElement) {
    const observer = new ResizeObserver(() => (canvasWidth = node.clientWidth));
    observer.observe(node);
    return {
      destroy() {
        observer.disconnect();
      },
    };
  }
  let projectNavExpanded = $state(localStorage.getItem('randl.project-nav') === 'expanded'),
    runsPreference = $state(localStorage.getItem('randl.runs-sidebar') || 'auto'),
    menuOpen = $state(false);
  async function breadcrumbNavigate(event: MouseEvent, target: string, kind = 'overview') {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!(await canNavigate())) return;
    if (activeRun && target === project && kind === runOrigin) {
      await backToOrigin();
      return;
    }
    await loadProject(target);
    await navigate(kind);
  }
  let sidebarWidth = $state(Number(localStorage.getItem('randl.sidebar-width')) || 304),
    sidebarDrag = false;
  function sidebarResize(event: PointerEvent) {
    if (sidebarDrag) sidebarWidth = Math.max(240, Math.min(sidebarLimit, event.clientX - navWidth));
  }
  function sidebarResizeEnd() {
    if (sidebarDrag) {
      sidebarDrag = false;
      localStorage.setItem('randl.sidebar-width', String(sidebarWidth));
    }
  }
  let trashOpen = $state(false),
    lastDeleted = $state<string[]>([]),
    runFeedback = $state.raw<Message>(''),
    undoFeedback = $state.raw<Message | null>(null),
    feedbackUndo = $state<(() => Promise<void>) | null>(null),
    runBusy = $state(false);
  // Deleting a panel or section offers Undo, which restores the layout before the delete.
  function rememberLayout(feedback: Message) {
    if (!view) return;
    const viewId = view.id,
      panels = JSON.parse(JSON.stringify(view.body.panels)),
      sections = JSON.parse(JSON.stringify(view.body.sections || [])),
      hiddenMetrics = [...(view.body.hiddenMetrics || [])];
    lastDeleted = [];
    runFeedback = feedback;
    feedbackUndo = async () => {
      if (!view || view.id !== viewId) return;
      view.body.panels = panels;
      view.body.sections = sections;
      view.body.hiddenMetrics = hiddenMetrics;
      save();
    };
  }
  $effect(() => {
    const feedback = runFeedback;
    if (!feedback || lastDeleted.length || feedbackUndo || feedback === undoFeedback) return;
    const timer = setTimeout(() => (runFeedback = ''), 5000);
    return () => clearTimeout(timer);
  });
  async function changeRuns(action: string, ids: string[], tags?: string[]) {
    await tool('runs_update', { action, ids, ...(tags ? { tags } : {}) });
    if (action === 'delete') {
      feedbackUndo = null;
      lastDeleted = ids;
      runFeedback = message('runs.feedback.deleted', { count: ids.length });
      runs = runs.filter((run) => !ids.includes(run.id));
      if (activeRun && ids.includes(activeRun.id)) await navigate('workspace');
    } else if (action === 'restore') {
      lastDeleted = [];
      runFeedback = 'runs.feedback.restored';
    } else if (action === 'stop') {
      lastDeleted = [];
      runFeedback = 'runs.stop.requested';
    } else {
      runFeedback = action === 'add-tags' ? 'runs.feedback.tagsAdded' : 'runs.feedback.tagsRemoved';
    }
  }
  /** Runs that can receive a stop request: live runs, not imported snapshots. */
  const stoppable = (run: Run) =>
    run.state === 'running' && run.snapshot_at == null && !run.stop_requested;
  let stopTargets = $state.raw<Run[]>([]),
    stopDialog = $state(false),
    stopError = $state<Message>(''),
    stopInvoker: HTMLElement | null = null;
  /** Requested stops by run ID; each reports once its run leaves the running state. */
  let pendingStops = $state.raw(new Map<string, string>());
  function requestStop(targets: Run[]) {
    stopTargets = targets.filter(stoppable);
    if (!stopTargets.length) return;
    stopInvoker = document.activeElement as HTMLElement | null;
    stopError = '';
    stopDialog = true;
  }
  async function confirmStop() {
    if (runBusy) return;
    const targets = stopTargets;
    stopError = '';
    runBusy = true;
    try {
      await changeRuns(
        'stop',
        targets.map((run) => run.id),
      );
      pendingStops = new Map([
        ...pendingStops,
        ...targets.map((run) => [run.id, run.display_name] as [string, string]),
      ]);
      stopDialog = false;
    } catch (error) {
      stopError = !(error instanceof ApiError)
        ? 'runs.stop.errors.offline'
        : knownMessage(error) || 'runs.stop.errors.failed';
    } finally {
      runBusy = false;
    }
  }
  $effect(() => {
    if (!pendingStops.size) return;
    const ended = [...pendingStops].filter(([id]) => {
      const run = runs.find((item) => item.id === id);
      return run && run.state !== 'running';
    });
    if (!ended.length) return;
    const next = new Map(pendingStops);
    for (const [id] of ended) next.delete(id);
    pendingStops = next;
    lastDeleted = [];
    runFeedback =
      ended.length === 1
        ? message('runs.feedback.stoppedSingle', { name: ended[0][1] })
        : message('runs.feedback.stoppedMultiple', { count: ended.length });
  });
  let runActionAnchor = $state<HTMLElement | null>(null);
  let runActionForm = $state<HTMLFormElement>();
  let runAction = $state(''),
    actionRun = $state<Run | null>(null),
    runName = $state(''),
    runActionError = $state<Message>('');
  function setRunColor(id: string, color: string | null) {
    if (!sidebarView) return;
    const next = { ...sidebarView.body.runColors };
    if (color) next[id] = color;
    else delete next[id];
    sidebarView.body.runColors = next;
    save(true, sidebarView);
  }
  async function runActionOpen(run: Run, action: string) {
    if (action === 'pin') {
      if (sidebarView) {
        const pinned = new Set(sidebarView.body.pinned || []);
        if (!pinned.has(run.id) && pinned.size >= 20) {
          notice = 'runs.pin.limit';
          return;
        }
        if (notice === 'runs.pin.limit') notice = '';
        pinned.has(run.id) ? pinned.delete(run.id) : pinned.add(run.id);
        sidebarView.body.pinned = [...pinned];
        save(true, sidebarView);
      }
      return;
    }
    if (action === 'delete') {
      await changeRuns('delete', [run.id]).catch((error) => (notice = apiMessage(error)));
      return;
    }
    if (action === 'compare') {
      await compare([...(sidebarView?.body.visible || []), run.id]);
      return;
    }
    if (action === 'stop') {
      requestStop([run]);
      return;
    }
    if (action.startsWith('copy-')) {
      try {
        await navigator.clipboard.writeText(
          action === 'copy-id'
            ? run.name
            : new URL(
                `/${encodeURIComponent(run.entity)}/${encodeURIComponent(run.project)}/runs/${encodeURIComponent(run.name)}`,
                location.origin,
              ).href,
        );
      } catch {
        notice = 'common.clipboard.failed';
      }
      return;
    }
    runActionAnchor = document.querySelector<HTMLElement>(
      '[data-run-id="' + CSS.escape(run.id) + '"] .run-name',
    );
    actionRun = run;
    runName = run.display_name;
    runActionError = '';
    runAction = action;
  }
  async function saveRunAction() {
    if (!actionRun) return;
    runBusy = true;
    try {
      await api('/api/run', { id: actionRun.id, displayName: runName }, 'PATCH');
      await refresh();
      runAction = '';
    } catch (error) {
      runActionError = apiMessage(error);
    } finally {
      runBusy = false;
      if (runAction && runActionError) {
        await tick();
        runActionForm?.querySelector<HTMLElement>('input,button[type="submit"]')?.focus();
      }
    }
  }
  let workspaceRevision = $state(0);
  let authError = $state<Message>(''),
    routeError = $state<Message>('');
  let authReady = $state(false),
    authenticated = $state(false),
    authRequired = $state(false),
    serverURL = $state(location.origin);
  let dirty = $state(false),
    conflicted = $state(false),
    saveGeneration = 0,
    lastURL = location.href;
  let previewSettings = $state<import('./types').PlotSettings | null>(null);
  let settingsScope = $state<string | null>(null);
  let filterAnchor = $state<HTMLElement | null>(null),
    runControl = $state(''),
    runControlAnchor = $state<HTMLElement | null>(null),
    groupBy = $state('');
  function openRunControl(kind: string, event: MouseEvent) {
    runControlAnchor = (event.target as HTMLElement).closest('button');
    runControl = runControl === kind ? '' : kind;
  }
  let filterDialog = $state(false),
    matchingIds = $state<string[] | null>(null);
  let parentView = $state<View | null>(null);
  const scrollPositions = new Map<string, number>();
  const tablePositions = new Map<string, { top: number; run?: string }>();
  let tableRestore = $state<{ top: number; run?: string } | null>(null);
  function retainScroll() {
    scrollPositions.set(lastURL, document.getElementById('main')?.scrollTop || 0);
    const table = document.querySelector<HTMLElement>('[data-runs-scroller]');
    if (table)
      tablePositions.set(lastURL, {
        top: table.scrollTop,
        run: table.contains(document.activeElement)
          ? document.activeElement?.closest<HTMLElement>('tr[data-row]')?.dataset.row
          : undefined,
      });
  }
  async function restoreScroll() {
    tableRestore = tablePositions.get(location.href) || null;
    await tick();
    const main = document.getElementById('main');
    if (main) main.scrollTop = scrollPositions.get(location.href) || 0;
  }
  function draftView(name: string, project: string, run?: string): View {
    return {
      id: crypto.randomUUID(),
      name,
      project,
      version: 0,
      body: {
        panels: [],
        visible: run
          ? [run]
          : runs
              .filter((r) => r.entity + '/' + r.project === project)
              .slice(0, 3)
              .map((r) => r.id),
        solo: [],
        generation: 'automatic',
        ...(run
          ? { run }
          : {
              visibleThrough: runs
                .filter((r) => r.entity + '/' + r.project === project)
                .reduce((latest, r) => Math.max(latest, r.created), 0),
            }),
      },
    };
  }
  const promotedViews = new Map<string, string>();
  let page = $state('workspace'),
    runTab = $state('metrics'),
    activeRun = $state<Run | null>(null),
    artifactId = $state(''),
    artifactTab = $state('files');
  const pages: { id: string; name: MessageKey; icon: typeof Dashboard }[] = [
    { id: 'overview', name: 'nav.overview', icon: Dashboard },
    { id: 'workspace', name: 'nav.workspace', icon: ChartLine },
    { id: 'runs', name: 'nav.runs', icon: Table },
    { id: 'artifacts', name: 'nav.artifacts', icon: Archive },
    { id: 'settings', name: 'nav.settings', icon: Settings },
  ];
  // Pages outside any project: the project list and server-wide statistics.
  const globalPages: { id: string; name: MessageKey; icon: typeof Dashboard }[] = [
    { id: 'overview', name: 'nav.projects', icon: Dashboard },
    { id: 'server', name: 'server.title', icon: Activity },
  ];
  let runs = $state<Run[]>([]),
    projects = $state<ProjectSummary[]>([]),
    views = $state<any[]>([]),
    plugins = $state<Plugin[]>([]),
    view = $state<View | null>(null),
    project = $state(parseRoute(new URL(location.href)).project),
    search = $state(''),
    sort = $state('-created'),
    notice = $state<Message>(''),
    refreshError = $state<Message>(''),
    saving = $state<Message>(''),
    drawer = $state(false),
    width = $state(1200);
  let sidebarView = $derived(activeRun && parentView?.project === project ? parentView : view);
  let sidebarFilterCount = $derived(sidebarView?.body.filters?.length || 0);
  $effect(() => {
    if (
      notice === 'runs.pin.limit' &&
      sidebarView &&
      (sidebarView.body.pinned || []).length < 20
    )
      notice = '';
  });
  let themeChoice = $state(localStorage.getItem('randl.theme') || 'system');
  let systemDark = $state(matchMedia('(prefers-color-scheme: dark)').matches);
  let theme = $derived<'g100' | 'g10'>(
    themeChoice === 'system'
      ? systemDark
        ? 'g100'
        : 'g10'
      : themeChoice === 'g10'
        ? 'g10'
        : 'g100',
  );
  let accent = $state(localStorage.getItem('randl.accent') || '#0f62fe');
  let dark = $derived(theme === 'g100'),
    colors = $derived(palette(accent, dark));
  $effect(() => {
    localStorage.setItem('randl.theme', themeChoice);
    localStorage.setItem('randl.accent', accent);
    document.documentElement.style.setProperty('--randl-on-primary', colors.onPrimary);
  });
  let navWidth = $derived(projectNavExpanded ? 208 : 72);
  let sidebarLimit = $derived(Math.max(240, Math.min(600, width - navWidth - 320)));
  let displayedSidebarWidth = $derived(Math.min(sidebarWidth, sidebarLimit));
  let showRunSidebar = $derived(
    (page === 'workspace' || page === 'run') &&
      (width <= 760 ||
        (runsPreference !== 'closed' &&
          (runsPreference === 'open' ? width - navWidth >= 560 : width >= 1056))),
  );
  let runsCollapsed = $derived(width > 760 && !showRunSidebar);
  // Plain clicks on a navigation link stay in the app and close the phone menu;
  // modified clicks keep the browser's default (for example, a new tab).
  // Opening the phone navigation moves focus to the current page, or the first link.
  $effect(() => {
    if (!menuOpen || width > 760) return;
    void tick().then(() =>
      (
        document.querySelector<HTMLElement>('.phone-navigation [aria-current="page"]') ||
        document.querySelector<HTMLElement>('.phone-navigation .bx--side-nav__link')
      )?.focus(),
    );
  });
  function followNavigation(event: MouseEvent, go: () => unknown) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    menuOpen = false;
    void go();
  }
  function toggleRuns() {
    if (width <= 760) {
      menuOpen = false;
      drawer = !drawer;
    } else {
      runsPreference = showRunSidebar ? 'closed' : 'open';
      if (width < 1056) projectNavExpanded = false;
      localStorage.setItem('randl.runs-sidebar', runsPreference);
    }
  }
  let projectRuns = $derived(
    runs.filter((r) => !project || r.entity + '/' + r.project === project),
  );
  // Workspace views show runs created after their last visibility choice, so the first
  // SDK run of an empty project appears without a reload. Arriving runs are added
  // locally; the next save stores them with the view.
  $effect(() => {
    const through = view?.body.visibleThrough;
    if (!view || view.body.run || through === undefined || view.project !== project) return;
    const visible = new Set(view.body.visible),
      added = projectRuns.filter((run) => run.created > through && !visible.has(run.id)).map((run) => run.id),
      room = selectionLimits.maxSelectedRuns - view.body.visible.length;
    if (!added.length || room <= 0) return;
    view.body.visible = [...view.body.visible, ...added.slice(0, room)];
    if (historyView === view.id) lastBody = JSON.stringify(view.body);
  });
  let runValues = $state<Record<string, Record<string, any>>>({});
  let valueFields = $derived([
    ...new Set(
      [sort.replace(/^-/, ''), groupBy, ...(sidebarView?.body.runQuery?.columns || [])].filter(
        (field) =>
          field.startsWith('config.') ||
          field.startsWith('summary.') ||
          [
            'os',
            'python',
            'executable',
            'cpu_count',
            'gpu_count',
            'gpu',
            'memory',
            'sdk_version',
            'notes',
          ].includes(field),
      ),
    ),
  ]);
  let valuesKey = $derived(JSON.stringify([valueFields, projectRuns.map((r) => r.id).sort()]));
  async function fetchRunValues(ids: string[], columns = valueFields) {
    if (!ids.length || !columns.length) return;
    // The endpoint accepts 10,000 runs per request; larger projects load in batches.
    const loaded: { id: string; values: Record<string, unknown> }[] = [];
    for (let offset = 0; offset < ids.length; offset += 10000)
      loaded.push(
        ...(await api('/api/run-values', { runs: ids.slice(offset, offset + 10000), fields: columns }))
          .runs,
      );
    runValues = {
      ...runValues,
      ...Object.fromEntries(loaded.map((r) => [r.id, { ...runValues[r.id], ...r.values }])),
    };
  }
  $effect(() => {
    const [columns, ids] = JSON.parse(valuesKey);
    void fetchRunValues(ids, columns).catch((error) => (notice = apiMessage(error)));
  });
  function runField(run: Run, field: string): any {
    if (field === 'running') return run.state === 'running';
    return field.startsWith('config.') ||
      field.startsWith('summary.') ||
      [
        'os',
        'python',
        'executable',
        'cpu_count',
        'gpu_count',
        'gpu',
        'memory',
        'sdk_version',
        'notes',
      ].includes(field)
      ? runValues[run.id]?.[field]
      : (run as any)[field];
  }
  // Sort and grouping belong to the view; the search text stays local to this tab.
  function queryChanged() {
    if (sidebarView) {
      sidebarView.body.runQuery = { ...sidebarView.body.runQuery, sort, group: groupBy };
      save(true, sidebarView);
    }
  }
  let matchingIdSet = $derived(matchingIds ? new Set(matchingIds) : null);
  let searchQuery = $derived(runSearchQuery(search));
  let filtered = $derived(
    projectRuns
      .filter(
        (r) =>
          (sidebarView?.body.pinned || []).includes(r.id) ||
          ((!matchingIdSet || matchingIdSet.has(r.id)) &&
            (r.display_name + ' ' + r.name + ' ' + r.id).toLowerCase().includes(searchQuery)),
      )
      .sort((a, b) => {
        const pinned = groupBy
          ? 0
          : Number((sidebarView?.body.pinned || []).includes(b.id)) -
            Number((sidebarView?.body.pinned || []).includes(a.id));
        if (pinned) return pinned;
        const field = sort.replace(/^-/, ''),
          av = runField(a, field),
          bv = runField(b, field);
        if (av == null) return bv == null ? 0 : 1;
        if (bv == null) return -1;
        const delta =
          typeof av === 'number' && typeof bv === 'number'
            ? av - bv
            : String(av).localeCompare(String(bv), undefined, { numeric: true });
        return sort.startsWith('-') ? -delta : delta;
      }),
  );
  let currentRun = $derived(
    activeRun ? runs.find((run) => run.id === activeRun!.id) || activeRun : null,
  );
  // Selections are replaced, never edited in place, so depend on the array rather than on each of
  // its (up to 100,000) entries.
  const idSet = (ids: string[] | undefined) => untrack(() => new Set(ids));
  const visibleIds = $derived(idSet(view?.body.visible));
  const comparisonIds = $derived(
    idSet(view?.body.solo.length ? view.body.solo : view?.body.visible),
  );
  let selected = $derived(
    activeRun
      ? [runs.find((r) => r.id === activeRun!.id) || activeRun]
      : filtered.filter((r) => comparisonIds.has(r.id)),
  );
  /** Compared runs of this project that the sidebar search or filters leave out of the list. */
  const hiddenByFilter = $derived(
    activeRun
      ? 0
      : projectRuns.reduce((count, run) => count + (comparisonIds.has(run.id) ? 1 : 0), 0) -
          selected.length,
  );
  const storedColors = $derived(
    resolveRunColors(projectRuns, {
      ...sidebarView?.body.runColors,
      ...view?.body.runColors,
    }),
  );
  const resolvedColors = $derived(resolveRunColors(projectRuns, storedColors, dark));
  let help = $state(false),
    settings = $state(false),
    panelDialog = $state(false),
    projectDialog = $state(false),
    viewDialog = $state(false),
    agentDialog = $state(false),
    deleteViewDialog = $state(false);
  let settingsTab = $state(0);
  let auxiliaryOpen = $derived(
    settings || agentDialog || trashOpen || (panelDialog && settingsScope !== null),
  );
  function openTrash() {
    drawer = false;
    settings = false;
    agentDialog = false;
    panelDialog = false;
    trashOpen = true;
  }
  let displayView = $derived(
    view && panelDialog && settingsScope !== null && previewSettings
      ? {
          ...view,
          body: {
            ...view.body,
            ...(settingsScope
              ? {
                  sectionSettings: {
                    ...view.body.sectionSettings,
                    [settingsScope]: previewSettings,
                  },
                }
              : { plotSettings: previewSettings }),
          },
        }
      : view,
  );
  let fields = $state<string[]>([]);
  $effect(() => {
    if (authenticated)
      void api('/api/run-fields?project=' + encodeURIComponent(project))
        .then((r) => {
          fields = r.fields;
        })
        .catch((e) => (notice = apiMessage(e)));
  });
  type Catalog = {
    metrics: string[];
    kinds: Record<string, string[]>;
    definitions: Record<string, { hidden: boolean; stepMetric?: string }>;
  };
  let metricDefinitions = $state.raw<Catalog['definitions']>({});
  let metricKinds = $state.raw<Catalog['kinds']>({});
  let metricsLoading = $state(false);
  let metrics = $state.raw<string[]>([]),
    draft = $state<Panel>({ id: '', plugin: 'line', metric: '', metrics: [], title: '' });
  let viewStart = $state('current');
  let viewName = $state(''),
    viewMode = $state<'create' | 'rename' | 'duplicate'>('create'),
    projectOwner = $state('local'),
    projectError = $state<Message>(''),
    projectDescription = $state(''),
    projectOwnerItem = $state<string | undefined>(undefined),
    viewError = $state<Message>(''),
    projectName = $state(''),
    pluginSource = $state(''),
    pluginBusy = $state(false),
    pluginError = $state<Message>('');
  async function openAgent() {
    settings = false;
    panelDialog = false;
    trashOpen = false;
    drawer = false;
    agentDialog = true;
  }
  let savingQueue = Promise.resolve(),
    versions = new Map<string, number>(),
    refreshing = false;
  $effect(() => {
    const filters = sidebarView?.body.filters || [],
      mode = sidebarView?.body.filterMode || 'and';
    if (!filters.length) {
      matchingIds = null;
      return;
    }
    runs.map((run) => run.revision);
    const controller = new AbortController();
    void api('/api/runs/query', { filters, mode }, undefined, controller.signal)
      .then((r) => (matchingIds = r.ids))
      .catch((e) => {
        if (!controller.signal.aborted) notice = apiMessage(e);
      });
    return () => controller.abort();
  });
  function rememberView(next: View) {
    if (!next.version) return;
    if (!next.body.run) localStorage.setItem('randl.project-view:' + next.project, next.id);
  }
  let undoStack = $state<string[]>([]),
    redoStack = $state<string[]>([]),
    historyView = '',
    lastBody = '';
  function resetHistory() {
    historyView = view?.id || '';
    lastBody = JSON.stringify(view?.body || {});
    undoStack = [];
    redoStack = [];
  }
  async function restoreHistory(direction: 'undo' | 'redo') {
    await savingQueue;
    if (!view || conflicted) return;
    const source = direction === 'undo' ? undoStack : redoStack;
    if (!source.length) return;
    const body = source.at(-1)!;
    if (direction === 'undo') {
      undoStack = source.slice(0, -1);
      redoStack = [...redoStack, JSON.stringify(view.body)];
    } else {
      redoStack = source.slice(0, -1);
      undoStack = [...undoStack, JSON.stringify(view.body)];
    }
    view.body = JSON.parse(body);
    sort = view.body.runQuery?.sort || '-created';
    groupBy = runGroupField(view.body.runQuery?.group);
    save(false);
  }
  let failedView = $state.raw<View | null>(null);
  let saveError = $state<Message>(''),
    retrySave = $state(false),
    failedFeedback: Message | undefined,
    retrying = $state(false),
    pendingDiscard = $state.raw<View | null>(null),
    viewDeleted = $state(false),
    refocusFailure = false;
  /** A save whose request may have reached the server although no response arrived. */
  let unconfirmedSave: View | null = null;
  const leaveMessage = 'views.unsaved.leave';
  type SelectionField = 'visible' | 'solo';
  let limitRefusal: { view: string; field: SelectionField; ids: string; message: Message } | null =
    null;
  /**
   * Explains a refused selection. `deleted` notes stored IDs of runs the list no longer shows,
   * which count toward the limit but cannot be hidden from the list.
   */
  function limitMessage(
    field: SelectionField,
    stored: number,
    total: number,
    deleted = false,
  ): Message {
    const limit = selectionLimits.maxSelectedRuns,
      keys: Record<string, MessageKey> = {
        visibleFull: 'runs.limits.visibleFull',
        visibleFullDeleted: 'runs.limits.visibleFullDeleted',
        visibleExceeded: 'runs.limits.visibleExceeded',
        visibleExceededDeleted: 'runs.limits.visibleExceededDeleted',
        soloFull: 'runs.limits.soloFull',
        soloFullDeleted: 'runs.limits.soloFullDeleted',
        soloExceeded: 'runs.limits.soloExceeded',
        soloExceededDeleted: 'runs.limits.soloExceededDeleted',
      };
    return message(
      keys[field + (stored >= limit ? 'Full' : 'Exceeded') + (deleted ? 'Deleted' : '')],
      {
        limit,
        total,
      },
    );
  }
  function saveFailure(error: unknown, snapshot: View): Message {
    if (!(error instanceof ApiError)) return 'views.errors.offline';
    if (error.code === 'VIEW_CONFLICT')
      return 'views.errors.changedElsewhere';
    if (error.code === 'VIEW_DELETED')
      return 'views.errors.deletedSaveNew';
    if (error.code === 'VISIBLE_RUN_LIMIT' || error.code === 'SOLO_RUN_LIMIT') {
      const field = error.code === 'VISIBLE_RUN_LIMIT' ? 'visible' : 'solo';
      return limitMessage(field, 0, snapshot.body[field].length);
    }
    if (error.status === 503) return 'views.errors.busy';
    if (error.status >= 500) return 'views.errors.server';
    return knownMessage(error) || 'views.errors.rejected';
  }
  /** Serializes a value with sorted object keys so stored and local bodies compare by content. */
  function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)))
        : item,
    );
  }
  /**
   * After a save lost its response, finds out whether the server applied it. Returns the stored
   * view when it holds the unconfirmed save, after adopting its identity and version.
   */
  async function confirmLostSave(): Promise<View | null> {
    const lost = unconfirmedSave;
    if (!lost) return null;
    let id = promotedViews.get(lost.id) || lost.id;
    if (!(versions.get(id) || lost.version)) {
      const candidate = ((await api('/api/views')).views as (View & { run?: string })[]).find(
        (item) => item.project === lost.project && item.name === lost.name && !item.run,
      );
      if (!candidate) {
        unconfirmedSave = null;
        return null;
      }
      id = candidate.id;
    }
    const stored = await api<View>('/api/views/' + id).catch((error) => {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    });
    unconfirmedSave = null;
    if (!stored || stored.name !== lost.name || canonical(stored.body) !== canonical(lost.body))
      return null;
    if (id !== lost.id) promotedViews.set(lost.id, id);
    versions.set(id, stored.version);
    return stored;
  }
  function save(trackHistory = true, target = view, feedback?: Message) {
    if (!target) return;
    if (target === view) {
      const nextBody = JSON.stringify(target.body);
      if (historyView !== target.id) {
        historyView = target.id;
        undoStack = [];
        redoStack = [];
      } else if (trackHistory && lastBody && lastBody !== nextBody) {
        undoStack = [...undoStack.slice(-29), lastBody];
        redoStack = [];
      }
      lastBody = nextBody;
    }
    if (undoFeedback && runFeedback === undoFeedback) runFeedback = '';
    undoFeedback = null;
    dirty = true;
    const generation = ++saveGeneration,
      snapshot = JSON.parse(JSON.stringify(target));
    if (conflicted) {
      saving = 'views.saveStatus.notSaved';
      return;
    }
    saving = 'common.status.saving';
    savingQueue = savingQueue.then(async () => {
      if (conflicted) return;
      let sent = false;
      try {
        const created = !(
          versions.get(promotedViews.get(snapshot.id) || snapshot.id) || snapshot.version
        );
        const stored = await confirmLostSave();
        sent = true;
        const id = promotedViews.get(snapshot.id) || snapshot.id,
          version = versions.get(id) || snapshot.version;
        const result: View =
          stored &&
          stored.id === id &&
          canonical(stored.body) === canonical(snapshot.body) &&
          stored.name === snapshot.name
            ? stored
            : version
              ? await api<View>(
                  '/api/views/' + id,
                  { name: snapshot.name, project: snapshot.project, body: snapshot.body, version },
                  'PUT',
                )
              : await tool('view_create', {
                  name: snapshot.name,
                  project: snapshot.project,
                  body: snapshot.body,
                });
        if (created) {
          promotedViews.set(snapshot.id, result.id);
          target.id = result.id;
          if (target === view) historyView = result.id;
          views = (await api('/api/views')).views;
          if (!snapshot.body.run && ['workspace', 'runs'].includes(page)) {
            history.replaceState(history.state, '', pageURL(project, page, result.id));
            lastURL = location.href;
          }
        }
        versions.set(result.id, result.version);
        target.version = result.version;
        if (
          limitRefusal &&
          notice === limitRefusal.message &&
          limitRefusal.view === result.id &&
          JSON.stringify(snapshot.body[limitRefusal.field]) !== limitRefusal.ids
        ) {
          notice = '';
          limitRefusal = null;
        }
        if (generation === saveGeneration) {
          dirty = false;
          conflicted = false;
          saving = 'views.saveStatus.saved';
          saveError = '';
          failedView = null;
          retrySave = false;
          failedFeedback = undefined;
          pendingDiscard = null;
          if (notice === leaveMessage) notice = '';
          if (feedback) {
            runFeedback = feedback;
            undoFeedback = feedback;
          }
          rememberView(target);
        }
      } catch (error) {
        if (sent && !(error instanceof ApiError)) unconfirmedSave = snapshot;
        dirty = true;
        conflicted = error instanceof ApiError && error.status === 409;
        if (conflicted) pendingDiscard = null;
        viewDeleted = error instanceof ApiError && error.code === 'VIEW_DELETED';
        retrySave = !(error instanceof ApiError) || error.status >= 500;
        failedView = target;
        failedFeedback = generation === saveGeneration ? feedback : undefined;
        saving = 'views.saveStatus.notSaved';
        saveError = saveFailure(error, snapshot);
      }
    });
  }
  /** Notes whether focus is in the failure notification before one of its actions runs. */
  function noteFailureFocus() {
    refocusFailure = !!document.getElementById('save-failure')?.contains(document.activeElement);
  }
  /**
   * After a failure action, keeps keyboard focus in the task: on the notification if it remains,
   * otherwise on the run list (or the workspace when the list is unavailable).
   */
  function settleFailureFocus() {
    if (!refocusFailure) return;
    refocusFailure = false;
    // The notice sits in the runs drawer on phones and in the view toolbar otherwise.
    const inDrawer = width <= 760 && drawer;
    void tick().then(() => {
      const failure = document.getElementById('save-failure');
      if (failure?.contains(document.activeElement)) return;
      if (failure)
        return (failure.querySelector<HTMLElement>('.save-failure-actions button') || failure).focus();
      if (document.activeElement && document.activeElement !== document.body) return;
      if (!inDrawer && document.querySelector('.view-controls')) return focusViewControls();
      const runList = document.getElementById('run-list');
      const target =
        runList && !runList.closest('[inert]') && runList.getClientRects().length
          ? runList
          : document.getElementById('main');
      target?.focus({ preventScroll: true });
    });
  }
  function retryFailedSave() {
    if (retrying) return;
    noteFailureFocus();
    retrying = true;
    // The actions hide while the save is in flight; keep focus on the notification.
    if (refocusFailure) void tick().then(() => document.getElementById('save-failure')?.focus());
    save(false, failedView || view, failedFeedback);
    void savingQueue.then(() => {
      retrying = false;
      settleFailureFocus();
    });
  }
  async function canNavigate() {
    await savingQueue;
    if (dirty) {
      await tick();
      const failure = document.getElementById('save-failure');
      if (failure && !failure.closest('[inert]')) failure.focus();
      else if (!notice) notice = leaveMessage;
      return false;
    }
    return true;
  }
  async function readView(id: string, discard = false, retainQuery = false) {
    if (!discard && !(await canNavigate())) return false;
    const next = await api<View>('/api/views/' + id);
    pendingDiscard = null;
    versions.set(id, next.version);
    view = next;
    if (!retainQuery) {
      sort = next.body.runQuery?.sort || '-created';
      groupBy = runGroupField(next.body.runQuery?.group);
    }
    resetHistory();
    dirty = false;
    conflicted = false;
    saving = '';
    rememberView(next);
    return true;
  }
  async function chooseView(id: string) {
    if (await readView(id)) {
      history.pushState(null, '', pageURL(project, page, id));
      lastURL = location.href;
    }
  }
  function clearSaveFailure() {
    failedView = null;
    pendingDiscard = null;
    viewDeleted = false;
    saveError = '';
    retrySave = false;
    failedFeedback = undefined;
    unconfirmedSave = null;
    notice = '';
  }
  /** A failed target that never reached the server has no saved copy to reload. */
  function neverSaved(target: View | null) {
    if (target && pendingDiscard && (promotedViews.get(target.id) || target.id) === pendingDiscard.id)
      return true;
    return !!target && !(versions.get(promotedViews.get(target.id) || target.id) || target.version);
  }
  async function reloadSaved() {
    const target = failedView || view;
    if (!target || retrying) return;
    noteFailureFocus();
    try {
      if (target !== view) {
        const saved = await api<View>('/api/views/' + target.id);
        parentView = saved;
        versions.set(saved.id, saved.version);
        sort = saved.body.runQuery?.sort || '-created';
        groupBy = runGroupField(saved.body.runQuery?.group);
        dirty = false;
        conflicted = false;
        saving = '';
      } else await readView(target.id, true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        conflicted = true;
        viewDeleted = true;
        retrySave = false;
        saveError = 'views.errors.deletedSaveNew';
      } else
        saveError =
          'views.errors.reloadFailed';
      settleFailureFocus();
      return;
    }
    clearSaveFailure();
    settleFailureFocus();
  }
  async function discardDraft() {
    const target = failedView || view;
    if (!target || retrying) return;
    noteFailureFocus();
    await savingQueue;
    try {
      // A create whose response was lost may have stored the draft; discarding removes it.
      // Keep that view until its deletion succeeds, so a later Discard retries it.
      if (pendingDiscard) {
        // Delete only the view this draft created, unchanged since the lost save was confirmed.
        const current = await api<View>('/api/views/' + pendingDiscard.id).catch((error) => {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        });
        if (current && current.version !== pendingDiscard.version) {
          pendingDiscard = null;
          conflicted = true;
          retrySave = false;
          saveError =
            'views.errors.changedElsewhere';
          settleFailureFocus();
          return;
        }
        if (!current) pendingDiscard = null;
      } else pendingDiscard = await confirmLostSave();
      if (pendingDiscard) {
        await api('/api/views/' + pendingDiscard.id, undefined, 'DELETE');
        promotedViews.delete(target.id);
        versions.delete(pendingDiscard.id);
        pendingDiscard = null;
        views = (await api('/api/views')).views;
      }
    } catch {
      saveError = 'views.errors.discardFailed';
      settleFailureFocus();
      return;
    }
    const fresh = draftView(target.name, target.project, target.body.run);
    if (target === view) view = fresh;
    else parentView = fresh;
    search = '';
    sort = '-created';
    groupBy = '';
    resetHistory();
    dirty = false;
    conflicted = false;
    saving = '';
    clearSaveFailure();
    settleFailureFocus();
  }
  let deleteConfirmed = false;
  let viewMenuOpen = $state(false);
  // Keep every View actions item reachable on short screens, and leave half an
  // item visible at the bottom so the menu reads as scrollable.
  function fitViewMenu() {
    const menu = document.querySelector<HTMLElement>('.view-actions-menu');
    if (!menu) return;
    menu.style.maxHeight = '';
    const item = menu.querySelector<HTMLElement>('.bx--overflow-menu-options__option');
    const space = innerHeight - menu.getBoundingClientRect().top - 8;
    if (!item || menu.scrollHeight <= space) return;
    const step = item.getBoundingClientRect().height;
    menu.style.maxHeight =
      Math.max(step * 1.5, Math.floor((space - step / 2) / step) * step + step / 2) + 'px';
  }
  $effect(() => {
    if (!viewMenuOpen) return;
    const openedWidth = innerWidth;
    let frame = requestAnimationFrame(fitViewMenu);
    // A width change can move the trigger and change the menu's items, so close
    // the menu and keep focus on its trigger; a height change only refits it.
    const resize = () => {
      if (innerWidth !== openedWidth) {
        const focused = document
          .querySelector('.view-actions-menu')
          ?.contains(document.activeElement);
        viewMenuOpen = false;
        if (focused) focusViewControls(false);
      } else {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(fitViewMenu);
      }
    };
    addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener('resize', resize);
    };
  });
  function focusViewControls(selector = true) {
    void tick().then(() =>
      (
        (selector && document.querySelector<HTMLElement>('.view-controls select')) ||
        document.getElementById('view-actions')
      )?.focus({ preventScroll: true }),
    );
  }
  // With no saved view left, open the same unsaved draft as an empty project.
  function openDraftView(projectId: string) {
    view = draftView($t('views.defaultName'), projectId);
    resetHistory();
    dirty = false;
    conflicted = false;
    saving = '';
  }
  async function discardDeletedView() {
    const target = failedView || view;
    if (!target || retrying) return;
    noteFailureFocus();
    await savingQueue;
    views = (await api('/api/views')).views;
    const next = views.find(
      (item) => item.project === target.project && !item.run && item.id !== target.id,
    );
    const replacement: View = next
      ? await api<View>('/api/views/' + next.id)
      : draftView($t('views.defaultName'), target.project);
    if (target === view) {
      if (next) await readView(next.id, true);
      else openDraftView(target.project);
      if (page !== 'run') {
        history.replaceState(history.state, '', pageURL(project, page, next?.id));
        lastURL = location.href;
      }
    } else {
      if (next) versions.set(replacement.id, replacement.version);
      parentView = replacement;
      dirty = false;
      conflicted = false;
      saving = '';
      if (next) rememberView(replacement);
    }
    clearSaveFailure();
    settleFailureFocus();
  }
  async function recoverView() {
    const target = failedView || view;
    if (!target || retrying) return;
    noteFailureFocus();
    await savingQueue;
    try {
      const names = (await api('/api/views')).views;
      const base = $t('views.copyName', { name: target.name });
      let name = base,
        index = 2;
      while (names.some((item: View) => item.project === target.project && item.name === name))
        name = base + ' ' + index++;
      const saved: View = await tool('view_create', {
        name,
        project: target.project,
        body: JSON.parse(JSON.stringify(target.body)),
      });
      if (target === view) view = saved;
      else parentView = saved;
      versions.set(saved.id, saved.version);
      dirty = false;
      conflicted = false;
      saving = 'views.saveStatus.saved';
      clearSaveFailure();
      rememberView(saved);
      views = (await api('/api/views')).views;
      if (page !== 'run') {
        history.replaceState(history.state, '', pageURL(project, page, saved.id));
        lastURL = location.href;
      }
      resetHistory();
    } catch (error) {
      saveError = knownMessage(error) || 'views.errors.createFailed';
    }
    settleFailureFocus();
  }
  async function loadProject(id: string) {
    if (!(await canNavigate())) return false;
    panelDialog = false;
    filterDialog = false;
    runControl = '';
    if (id && !projects.some((item) => item.id === id)) {
      routeError = 'projects.errors.notFound';
      page = 'not-found';
      view = null;
      return false;
    }
    routeError = '';
    project = id;
    if (!id) {
      view = null;
      activeRun = null;
      page = 'overview';
      search = '';
      groupBy = '';
      closeDrawer();
      return true;
    }
    parentView = null;
    if (activeRun) {
      activeRun = null;
      page = 'workspace';
    }
    search = '';
    const candidates = views.filter((v) => v.project === project && !v.run),
      saved = localStorage.getItem('randl.project-view:' + id);
    if (candidates.length)
      await readView(candidates.find((v) => v.id === saved)?.id || candidates[0].id);
    else {
      view = draftView($t('views.defaultName'), project);
      resetHistory();
    }
    closeDrawer();
    return true;
  }
  async function changeProject(id: string) {
    if (await loadProject(id)) {
      history.pushState(
        null,
        '',
        pageURL(
          id,
          page,
          ['workspace', 'runs'].includes(page) && view?.version ? view.id : undefined,
        ),
      );
      lastURL = location.href;
    }
  }
  async function refresh(force = false, includeRuns = true) {
    if (refreshing) return;
    refreshing = true;
    try {
      const [r, p, v, g] = await Promise.all([
        includeRuns ? api('/api/runs') : Promise.resolve(null),
        api('/api/projects'),
        api('/api/views'),
        api('/api/plugins'),
      ]);
      if (r) runs = r.runs;
      projects = p.projects;
      if (project && !routeError && !projects.some((item) => item.id === project)) {
        // The open project was deleted elsewhere. Nothing on its pages can save into it now.
        dirty = false;
        view = null;
        activeRun = null;
        page = 'not-found';
        routeError = 'projects.errors.notFound';
      }
      views = v.views;
      plugins = g.plugins.map((next: Plugin) => {
        const current = plugins.find((p) => p.id === next.id);
        return current && JSON.stringify(current) === JSON.stringify(next) ? current : next;
      });
      if (force) clearCache();
      if (view) {
        const latest = views.find((v) => v.id === view!.id);
        if (
          latest &&
          latest.version > view.version &&
          !dirty &&
          !panelDialog &&
          !viewDialog &&
          !deleteViewDialog
        ) {
          await readView(view.id, false, !!activeRun);
          runFeedback = 'views.feedback.reloaded';
        }
      }
      refreshError = '';
    } catch (error) {
      refreshError = apiMessage(error);
    } finally {
      refreshing = false;
    }
  }
  function sectionsForView(): Section[] {
    const list = [...(view?.body.sections || [])];
    for (const p of view?.body.panels || []) {
      const id = sectionForPanel(p);
      if (!list.some((s) => s.id === id)) list.push({ id, name: id });
    }
    return list;
  }
  // Enabled plugins of the panels a section's settings (or, for an empty scope, the workspace
  // settings) apply to, in order of their first panel.
  function pluginsInScope(scope: string) {
    const ids = new Set(
      (view?.body.panels || [])
        .filter((panel) => !scope || sectionForPanel(panel) === scope)
        .map((panel) => panel.plugin),
    );
    return [...ids].flatMap((id) => plugins.filter((plugin) => plugin.id === id && plugin.enabled));
  }
  function sectionForPanel(panel: Panel) {
    return panel.section || (panel.metric.includes('/') ? panel.metric.split('/')[0] : 'Metrics');
  }
  function resizeSection(id: string, layout: SectionLayout) {
    if (view) {
      view.body.sectionLayouts = { ...view.body.sectionLayouts, [id]: layout };
      save();
    }
  }
  function sectionAction(action: string, id: string, value?: string) {
    if (!view) return;
    let createdId: string | undefined;
    let sections = sectionsForView(),
      index = sections.findIndex((s) => s.id === id);
    if (action === 'add') {
      createdId = crypto.randomUUID();
      let name = $t('workspace.section.newName'),
        suffix = 2;
      while (sections.some((section) => section.name === name))
        name = $t('workspace.section.newName') + ' ' + suffix++;
      sections.splice(index < 0 ? sections.length : index + 1, 0, { id: createdId, name });
    } else if (action === 'rename')
      sections = sections.map((s) => (s.id === id ? { ...s, name: value! } : s));
    else if (action === 'collapse')
      sections = sections.map((s) => (s.id === id ? { ...s, collapsed: !s.collapsed } : s));
    else if (action === 'delete') {
      const count = view.body.panels.filter((p) => sectionForPanel(p) === id).length,
        name = sections[index]?.name || id;
      rememberLayout(
        message(count === 0 ? 'workspace.section.deletedEmpty' : 'workspace.section.deleted', {
          name,
          count,
        }),
      );
      sections = sections.filter((s) => s.id !== id);
      if (view.body.generation === 'automatic')
        view.body.hiddenMetrics = [
          ...new Set([
            ...(view.body.hiddenMetrics || []),
            ...view.body.panels.filter((p) => sectionForPanel(p) === id).map((p) => p.metric),
          ]),
        ];
      view.body.panels = view.body.panels.filter((p) => sectionForPanel(p) !== id);
    } else if (action === 'sort') {
      const sorted = view.body.panels
        .filter((p) => sectionForPanel(p) === id)
        .sort((a, b) => (a.title || a.metric).localeCompare(b.title || b.metric));
      let cursor = 0;
      view.body.panels = view.body.panels.map((p) =>
        sectionForPanel(p) === id ? sorted[cursor++] : p,
      );
    }
    view.body.sections = sections;
    save();
    return createdId;
  }
  /** Applies a reordered layout unless the view changed while the user was dragging. */
  function applyLayout(panels: Panel[], sections: Section[], original: string) {
    if (!view) return;
    if (JSON.stringify([view.body.panels, view.body.sections || []]) !== original) {
      notice = 'workspace.errors.reorderConflict';
      return;
    }
    view.body.panels = panels;
    view.body.sections = sections;
    save();
  }
  function reorderPanel(source: string, target: string, section?: string) {
    if (!view || source === target) return;
    const panels = [...view.body.panels],
      panel = panels.find((p) => p.id === source),
      destination = panels.find((p) => p.id === target);
    if (!panel) return;
    panel.section =
      section || (destination ? sectionForPanel(destination) : sectionForPanel(panel));
    const rest = panels.filter((p) => p.id !== source),
      index = rest.findIndex((p) => p.id === target);
    rest.splice(index < 0 ? rest.length : index, 0, panel);
    view.body.panels = rest;
    save();
  }
  $effect(() => {
    if (!authenticated) return;
    const events = new EventSource('/api/events');
    events.addEventListener('ready', () => void refresh());
    events.addEventListener('reset', () => void refresh());
    events.onerror = () => {
      void api('/api/auth/status')
        .then((status) => {
          if (!status.authenticated) authenticated = false;
        })
        .catch(() => {});
    };
    events.onmessage = (event) => {
      const update = JSON.parse(event.data);
      void fetchRunValues(
        update.runs
          .filter((r: Run) => !project || r.entity + '/' + r.project === project)
          .map((r: Run) => r.id),
      ).catch((error) => (notice = apiMessage(error)));
      const changes = new Map<string, Run>(update.runs.map((r: Run) => [r.id, r]));
      runs = runs
        .filter((r) => !update.removed.includes(r.id))
        .map((r) => {
          const next = changes.get(r.id);
          changes.delete(r.id);
          return next || r;
        })
        .concat([...changes.values()]);
      if (update.workspace || changes.size) {
        workspaceRevision++;
        void refresh(false, false);
      }
    };
    return () => events.close();
  });
  let automaticSignature = $derived(
    view?.body.generation === 'automatic'
      ? JSON.stringify([
          view.id,
          view.body.hiddenMetrics,
          (view.body.run ? runs.filter((run) => run.id === view!.body.run) : projectRuns).map(
            (run) => [run.id, run.metric_count, run.metric_revision],
          ),
          plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id),
        ])
      : '',
  );
  $effect(() => {
    if (!automaticSignature) return;
    const [id, , catalogRuns] = JSON.parse(automaticSignature) as [
      string,
      string[],
      [string, number][],
    ];
    const ids = catalogRuns.map(([id]) => id);
    let current = true;
    const timer = setTimeout(async () => {
      try {
        const catalog = await loadCatalog(ids).request;
        if (!current || view?.id !== id || view.body.generation !== 'automatic') return;
        if (view.body.panels.length >= 500) return;
        const kinds: Record<string, string[]> = Object.create(null);
        for (const metric of catalog.metrics) kinds[metric] = catalog.kinds[metric] || [];
        const definitions = catalog.definitions;
        const existing = new Set(view.body.panels.map((panel) => panel.metric)),
          hidden = new Set(view.body.hiddenMetrics || []),
          added: Panel[] = [];
        for (const metric of Object.keys(kinds).sort()) {
          if (existing.has(metric) || hidden.has(metric) || definitions[metric]?.hidden) continue;
          const plugin = kinds[metric].includes('scalar')
            ? plugins.find((p) => p.id === 'line' && p.enabled)
            : plugins.find(
                (p) =>
                  p.enabled &&
                  p.dataKind === 'media' &&
                  p.metricTypes?.some((type) => kinds[metric].includes(type)),
              );
          if (plugin)
            added.push({
              id: crypto.randomUUID(),
              plugin: plugin.id,
              metric,
              metrics: [metric],
              title: metric,
            });
          if (view.body.panels.length + added.length >= 500) break;
        }
        if (added.length) {
          view.body.panels = [...view.body.panels, ...added];
          if (view.version) save();
          else resetHistory();
        }
      } catch (error) {
        if (current) notice = apiMessage(error);
      }
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  });
  function selection(visible: string[], solo: string[], feedback?: Message) {
    if (!view || conflicted) return false;
    for (const [field, ids] of [
      ['visible', visible],
      ['solo', solo],
    ] as const) {
      if (ids.length > selectionLimits.maxSelectedRuns) {
        const listed = new Set(projectRuns.map((run) => run.id));
        notice = limitMessage(
          field,
          view.body[field].length,
          ids.length,
          view.body[field].some((id) => !listed.has(id)),
        );
        limitRefusal = {
          view: promotedViews.get(view.id) || view.id,
          field,
          ids: JSON.stringify(view.body[field]),
          message: notice,
        };
        return false;
      }
    }
    // The choice covers every run known now; runs created later start visible.
    if (!view.body.run)
      view.body.visibleThrough = projectRuns.reduce((latest, run) => Math.max(latest, run.created), 0);
    view.body.visible = visible;
    view.body.solo = solo;
    save(true, view, feedback);
    return true;
  }
  function toggleAll(on: boolean) {
    if (!view) return;
    const set = new Set(view.body.visible);
    for (const r of filtered) on ? set.add(r.id) : set.delete(r.id);
    selection([...set], view.body.solo, on ? 'runs.list.listedShown' : 'runs.list.listedHidden');
  }

  // Metric catalogs per run list. A cached catalog is shown at once and refreshed in the
  // background when any of its runs has recorded data since it was fetched.
  const catalogCache = new Map<
    string,
    { signature: string; request: Promise<Catalog>; value?: Catalog }
  >();
  let catalogRequest = 0,
    shownCatalog: Catalog | undefined;
  async function fetchCatalog(ids: string[]): Promise<Catalog> {
    const parts: Catalog[] = [];
    for (let i = 0; i < ids.length; i += 1000)
      parts.push(await api('/api/metrics', { runs: ids.slice(i, i + 1000) }));
    if (parts.length === 1) return { ...parts[0], definitions: parts[0].definitions || {} };
    const kinds: Catalog['kinds'] = Object.create(null),
      definitions: Catalog['definitions'] = {};
    for (const part of parts) {
      for (const [metric, list] of Object.entries(part.kinds))
        kinds[metric] = [...new Set([...(kinds[metric] || []), ...list])];
      for (const [metric, definition] of Object.entries(part.definitions || {}))
        definitions[metric] = definitions[metric]
          ? { ...definitions[metric], hidden: definitions[metric].hidden && definition.hidden }
          : definition;
    }
    return { metrics: [...new Set(parts.flatMap((part) => part.metrics))].sort(), kinds, definitions };
  }
  function loadCatalog(ids: string[]) {
    ids = [...ids].sort();
    const key = JSON.stringify(ids),
      byId = new Map(runs.map((run) => [run.id, run])),
      signature = ids
        .map((id) => {
          const run = byId.get(id);
          return run ? `${run.revision}:${run.metric_count}:${run.metric_revision}` : '';
        })
        .join(',');
    let entry = catalogCache.get(key);
    if (entry?.signature !== signature) {
      const next: { signature: string; request: Promise<Catalog>; value?: Catalog } = {
        signature,
        request: fetchCatalog(ids),
        value: entry?.value,
      };
      next.request.then(
        (value) => (next.value = value),
        () => {
          if (catalogCache.get(key) === next) catalogCache.delete(key);
        },
      );
      entry = next;
    }
    catalogCache.delete(key);
    catalogCache.set(key, entry);
    for (const old of catalogCache.keys())
      if (catalogCache.size > 8) catalogCache.delete(old);
      else break;
    return entry;
  }
  function showCatalog(catalog: Catalog) {
    if (catalog === shownCatalog) return;
    shownCatalog = catalog;
    metrics = catalog.metrics;
    metricKinds = catalog.kinds;
    metricDefinitions = catalog.definitions;
  }
  // Open immediately; the editor keeps its selected metrics independently of the catalog.
  function prepareCatalog(ids: string[]) {
    const entry = loadCatalog(ids),
      request = ++catalogRequest;
    showCatalog(entry.value || { metrics: [], kinds: {}, definitions: {} });
    metricsLoading = !entry.value;
    entry.request.then(
      (catalog) => {
        if (request !== catalogRequest) return;
        showCatalog(catalog);
        metricsLoading = false;
      },
      (error) => {
        if (request !== catalogRequest) return;
        metricsLoading = false;
        notice = apiMessage(error);
      },
    );
    return entry.value;
  }
  // Use the same candidates as Workspace/Panel, including sidebar filtering and pins.
  // Focus and per-panel run limits do not narrow the editor's available candidates.
  const editorCatalogSignature = $derived(
    panelDialog
      ? JSON.stringify(
          selected.map((run) => [run.id, run.revision, run.metric_count, run.metric_revision]),
        )
      : '',
  );
  $effect(() => {
    if (!editorCatalogSignature) return;
    const candidates = JSON.parse(editorCatalogSignature) as [string, number, number, number][];
    untrack(() => prepareCatalog(candidates.map(([id]) => id)));
  });
  function openPanel(panel?: Panel, section?: string) {
    settings = false;
    agentDialog = false;
    trashOpen = false;
    settingsScope = null;
    if (!view) return;
    const catalog = prepareCatalog(selected.map((run) => run.id));
    let defaultPlugin = 'line';
    if (catalog) {
      const first =
        catalog.metrics.find((metric) => catalog.kinds[metric]?.includes('scalar')) ||
        catalog.metrics[0] ||
        '';
      if (!catalog.kinds[first]?.includes('scalar'))
        defaultPlugin =
          plugins.find(
            (plugin) =>
              plugin.enabled &&
              plugin.metricTypes?.some((type) => catalog.kinds[first]?.includes(type)),
          )?.id || 'line';
    }
    draft = panel
      ? JSON.parse(JSON.stringify(panel))
      : {
          id: '',
          plugin: defaultPlugin,
          metric: '',
          metrics: [],
          title: '',
          ...(section ? { section } : {}),
        };
    panelDialog = true;
  }
  function openDefaults(section?: string) {
    settings = false;
    agentDialog = false;
    trashOpen = false;
    drawer = false;
    if (!view) return;
    settingsScope = section || '';
    const catalog = prepareCatalog(selected.map((run) => run.id));
    draft = {
      id: 'defaults',
      plugin: 'line',
      metric: catalog?.metrics[0] || '',
      settings: section ? view.body.sectionSettings?.[section] || {} : view.body.plotSettings || {},
    };
    panelDialog = true;
  }
  // One view save per change made in the panel itself, so undo reverts it.
  function changePanelSettings(id: string, settings: PlotSettings) {
    if (!view) return;
    view.body.panels = view.body.panels.map((panel) =>
      panel.id === id ? { ...panel, settings: { ...panel.settings, ...settings } } : panel,
    );
    save();
  }
  function removePanel(id: string) {
    if (view) {
      const panel = view.body.panels.find((p) => p.id === id);
      if (panel) {
        rememberLayout(message('panel.feedback.deleted', { name: panel.title || panel.metric }));
      }
      if (panel && view.body.generation === 'automatic')
        view.body.hiddenMetrics = [...new Set([...(view.body.hiddenMetrics || []), panel.metric])];
      view.body.panels = view.body.panels.filter((p) => p.id !== id);
      save();
    }
  }
  function duplicatePanel(panel: Panel) {
    if (!view) return;
    const base = $t('panel.copyName', { name: panel.title || panel.metric });
    let title = base,
      index = 2;
    while (view.body.panels.some((p) => (p.title || p.metric) === title))
      title = base + ' ' + index++;
    const copy = { ...panel, id: crypto.randomUUID(), title };
    view.body.panels = [...view.body.panels, copy];
    save();
    focusPanel = copy.id;
  }
  async function details(run: Run, push = true, tab = page === 'run' ? runTab : 'metrics') {
    try {
      if (!(await canNavigate())) return;
      panelDialog = false;
      retainScroll();
      runOrigin = originOf(push ? history.state?.returnURL || lastURL : history.state?.returnURL);
      const nextProject = run.entity + '/' + run.project;
      if (!activeRun && view?.project === nextProject) parentView = view;
      if (parentView?.project !== nextProject) {
        await loadProject(nextProject);
        parentView = view;
      }
      activeRun = run;
      runTab = tab;
      project = nextProject;
      page = 'run';
      const existing = views.find((v) => v.run === run.id);
      if (existing) await readView(existing.id, false, true);
      else {
        view = draftView(run.display_name, project, run.id);
        resetHistory();
        saving = '';
      }
      const url = runURL(run, runTab);
      if (push)
        history.pushState(
          {
            returnURL: history.state?.returnURL || lastURL,
            runDepth: activeRun && history.state?.returnURL ? (history.state.runDepth || 1) + 1 : 1,
          },
          '',
          url,
        );
      lastURL = location.href;
      await restoreScroll();
      closeDrawer();
    } catch (e) {
      notice = apiMessage(e);
    }
  }
  async function navigate(next: string, push = true) {
    if (!(await canNavigate())) return false;
    panelDialog = false;
    filterDialog = false;
    runControl = '';
    retainScroll();
    const wasRun = !!activeRun,
      leaving = activeRun?.id;
    activeRun = null;
    artifactId = '';
    routeError = '';
    page = !project ? (next === 'server' ? 'server' : 'overview') : next;
    if (wasRun) {
      if (parentView?.project === project) {
        view = parentView;
        parentView = null;
        resetHistory();
      } else await loadProject(project);
    }
    if (push)
      history.pushState(
        null,
        '',
        pageURL(
          project,
          page,
          ['workspace', 'runs'].includes(page) && view?.version ? view.id : undefined,
        ),
      );
    lastURL = location.href;
    await restoreScroll();
    closeDrawer();
    if (leaving) void focusReturnedRun(leaving);
    return true;
  }

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const focusLost = () => !document.activeElement || document.activeElement === document.body;
  // Leaving a run page removes the focused control; return focus to that run in the list.
  async function focusReturnedRun(id: string) {
    await tick();
    await nextFrame();
    if (page !== 'workspace' || !focusLost()) return;
    if (width <= 760) return document.getElementById('open-runs')?.focus();
    const list = document.getElementById('run-list');
    if (!list) return;
    const name = () =>
      list.querySelector<HTMLElement>('[data-run-id="' + CSS.escape(id) + '"] [data-control="name"]');
    const target = filtered.findIndex((run) => run.id === id);
    // The list mounts only nearby rows: scroll toward the run until its row exists.
    for (let attempt = 0; target >= 0 && !name() && attempt < 4; attempt++) {
      const first = list.querySelector<HTMLElement>('[data-run-id]');
      const index = first ? filtered.findIndex((run) => run.id === first.dataset.runId) : 0;
      const offset = first ? first.getBoundingClientRect().top - list.getBoundingClientRect().top : 0;
      list.scrollTop += offset + (target - index) * (first?.offsetHeight || 36) - list.clientHeight / 2;
      await nextFrame();
      await nextFrame();
    }
    if (page !== 'workspace' || !focusLost()) return;
    const control = name(),
      row = control?.closest<HTMLElement>('[data-run-id]')?.getBoundingClientRect(),
      bounds = list.getBoundingClientRect();
    if (!control || !row) return list.focus({ preventScroll: true });
    if (row.top < bounds.top) list.scrollTop -= bounds.top - row.top;
    else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
    control.focus({ preventScroll: true });
  }
  // The page a run was opened from; Back and the breadcrumb return there.
  let runOrigin = $state('workspace');
  const runOrigins: Record<string, MessageKey> = {
    workspace: 'nav.back.workspace',
    runs: 'nav.back.runs',
    overview: 'nav.back.overview',
    artifacts: 'nav.back.artifacts',
  };
  function originOf(url?: string) {
    if (!url) return 'workspace';
    const origin = parseRoute(new URL(url, location.origin));
    return !origin.run && Object.hasOwn(runOrigins, origin.page) ? origin.page : 'workspace';
  }
  async function backToOrigin() {
    if (!(await canNavigate())) return;
    if (history.state?.returnURL) {
      history.go(-(history.state.runDepth || 1));
      return;
    }
    await navigate('workspace', false);
    history.replaceState(
      null,
      '',
      pageURL(project, 'workspace', view?.version ? view.id : undefined),
    );
    lastURL = location.href;
    await restoreScroll();
  }
  async function compare(ids: string[]) {
    if (await navigate('workspace')) if (view) selection([...new Set(ids)], []);
  }
  async function openArtifact(id: string) {
    if (!(await canNavigate())) return;
    retainScroll();
    if (activeRun && parentView) {
      view = parentView;
      parentView = null;
      resetHistory();
    }
    activeRun = null;
    page = 'artifacts';
    artifactId = id;
    history.pushState(
      null,
      '',
      (() => {
        const url = new URL(pageURL(project, 'artifacts'), location.origin);
        if (id) url.searchParams.set('artifact', id);
        return url.pathname + url.search;
      })(),
    );
    lastURL = location.href;
    closeDrawer();
  }
  /** Shows a not-found page for a project, view or run named in the URL. */
  function missing(projectId: string, error: MessageKey) {
    project = projectId;
    view = null;
    activeRun = null;
    page = 'not-found';
    routeError = error;
    lastURL = location.href;
  }
  async function route() {
    if (!(await canNavigate())) {
      history.replaceState(null, '', lastURL);
      return;
    }
    retainScroll();
    const target = parseRoute(new URL(location.href));
    routeError = '';
    if (target.project && !projects.some((item) => item.id === target.project)) {
      missing('', 'projects.errors.notFound');
      return;
    }
    if (
      target.view &&
      !views.some((item) => item.id === target.view && item.project === target.project)
    ) {
      missing(target.project, 'views.errors.notFound');
      return;
    }
    if (target.run) {
      const run = runs.find((r) => r.id === target.run);
      if (
        run &&
        ['metrics', 'overview', 'config', 'summary', 'logs', 'files', 'artifacts'].includes(
          target.runTab!,
        )
      )
        await details(run, false, target.runTab);
      else missing(target.project, 'runs.errors.notFound');
      return;
    }
    const leaving = activeRun?.id;
    if (activeRun && parentView?.project === target.project) {
      view = parentView;
      parentView = null;
      activeRun = null;
      resetHistory();
    }
    if (project !== target.project || !view) await loadProject(target.project);
    activeRun = null;
    page = (target.project ? pages : globalPages).some((p) => p.id === target.page)
      ? target.page
      : 'not-found';
    if (page === 'not-found') routeError = 'app.errors.pageNotFound';
    if (leaving) void focusReturnedRun(leaving);
    artifactId = target.artifact || '';
    artifactTab = new URL(location.href).searchParams.get('tab') || 'files';
    if (!['files', 'metadata', 'usage'].includes(artifactTab)) {
      page = 'not-found';
      routeError = 'app.errors.pageNotFound';
    }
    if (artifactId || target.artifactRef) {
      const list = (await api('/api/artifacts')).artifacts;
      if (target.artifactRef)
        artifactId =
          list.find(
            (a: any) =>
              a.entity + '/' + a.project === project &&
              a.type === target.artifactRef!.type &&
              a.name === target.artifactRef!.name &&
              'v' + a.version === target.artifactRef!.version,
          )?.id || '';
      if (
        !artifactId ||
        !list.some((a: any) => a.id === artifactId && a.entity + '/' + a.project === project)
      ) {
        page = 'not-found';
        routeError = 'artifacts.errors.notFound';
      }
    }
    if (target.view) await readView(target.view);
    lastURL = location.href;
    await restoreScroll();
    closeDrawer();
  }

  async function managePlugin(action: string, id?: string) {
    pluginBusy = true;
    pluginError = '';
    try {
      if (action === 'install') {
        await api('/api/plugins/install', { source: pluginSource });
        runFeedback = 'plugins.feedback.installed';
      } else await api(`/api/plugins/${id}/${action}`, {});
      plugins = (await api('/api/plugins')).plugins;
      pluginSource = '';
      if (action === 'remove')
        await tick().then(() => document.getElementById('plugin-source')?.focus());
    } catch (e) {
      pluginError = (e as Error).message.includes('ENOENT')
        ? 'plugins.errors.sourceNotFound'
        : apiMessage(e);
    } finally {
      pluginBusy = false;
    }
  }
  function openCreateProject() {
    projectOwner = project.split('/')[0] || 'local';
    projectError = '';
    projectName = '';
    projectDescription = '';
    projectOwnerItem = undefined;
    projectDialog = true;
  }
  async function archiveProject(item: ProjectSummary, archived: boolean) {
    try {
      await tool('project_update', { id: item.id, archived });
      await refresh(false, false);
      lastDeleted = [];
      runFeedback = message(archived ? 'projects.archived' : 'projects.restored', { name: item.name });
      feedbackUndo = () => archiveProject(item, !archived);
    } catch (error) {
      notice = apiMessage(error);
    }
  }
  async function projectDeleted(result: { id: string; name: string; cleanupFailed?: number }) {
    localStorage.removeItem('randl.project-view:' + result.id);
    projects = projects.filter((item) => item.id !== result.id);
    runs = runs.filter((run) => run.entity + '/' + run.project !== result.id);
    lastDeleted = [];
    feedbackUndo = null;
    runFeedback = result.cleanupFailed
      ? message('projects.deletedCleanupFailed', { name: result.name, count: result.cleanupFailed })
      : message('projects.deleted', { name: result.name });
    if (project === result.id) {
      // Settings pushes the list; a deleted page behind the Assistant drawer is replaced.
      const replace = agentDialog;
      dirty = false;
      view = null;
      if (await loadProject('')) {
        if (replace) history.replaceState(null, '', pageURL('', 'overview'));
        else history.pushState(null, '', pageURL('', 'overview'));
        lastURL = location.href;
      }
    }
    void refresh(false, false);
  }
  let projectSlug = $derived(
    projectName
      .trim()
      .replace(/[^\p{L}\p{N}_.-]+/gu, '-')
      .replace(/^-+|-+$/g, ''),
  );
  let projectId = $derived(projectOwner.trim() + '/' + projectSlug);
  let projectProblem = $derived<Message>(
    projectOwner.includes('/')
      ? 'projects.create.namespaceSlash'
      : projectName.trim() && !/[\p{L}\p{N}]/u.test(projectSlug)
        ? 'projects.create.needsLetter'
        : projects.some((p) => p.id === projectId)
          ? message('projects.errors.alreadyExists', { id: projectId })
          : '',
  );
  async function applyProject() {
    if (projectProblem || !projectSlug || !projectOwner.trim()) return;
    projectError = '';
    try {
      const id = projectId;
      await tool('project_create', {
        id,
        name: projectName.trim(),
        ...(projectDescription.trim() ? { description: projectDescription } : {}),
      });
      projectDialog = false;
      await refresh();
      if (await loadProject(id)) await navigate('workspace');
      await tick();
      document.querySelector<HTMLElement>('.view-controls select')?.focus();
    } catch (error) {
      projectError = apiMessage(error);
    }
  }
  let viewReturn: HTMLElement | null = null;
  function openViewDialog(mode: 'create' | 'rename' | 'duplicate') {
    const active = document.activeElement as HTMLElement;
    viewReturn = active?.id === 'new-view' ? active : document.getElementById('view-actions');
    viewMode = mode;
    viewStart = 'current';
    viewName =
      mode === 'rename'
        ? view?.name || ''
        : mode === 'duplicate'
          ? $t('views.copyName', { name: view?.name || $t('views.fallbackName') })
          : '';
    viewError = '';
    viewDialog = true;
  }
  const viewChoices = $derived(views.filter((item) => item.project === project && !item.run));
  const viewMissing = $derived(!!view && !viewChoices.some((item) => item.id === view?.id));
  let viewChoiceId = $state('');
  $effect(() => {
    viewChoiceId = view?.id || '';
  });
  function closeViewDialog() {
    viewDialog = false;
    void tick().then(() => {
      if (viewReturn?.isConnected) viewReturn.focus();
      else document.getElementById('view-actions')?.focus();
    });
  }
  async function applyView() {
    viewError = '';
    try {
      await savingQueue;
      if (conflicted) throw new MessageError('views.errors.unresolved');
      if (!viewName.trim()) return;
      if (viewMode !== 'rename') {
        const body =
          view && (viewMode === 'duplicate' || viewStart === 'current')
            ? JSON.parse(JSON.stringify(view.body))
            : {
                panels: [],
                visible: [...(view?.body.visible || [])],
                solo: [...(view?.body.solo || [])],
                runColors: { ...view?.body.runColors },
                generation: 'manual',
              };
        delete body.run;
        const next = await tool('view_create', { name: viewName, project, body });
        await refresh();
        await readView(next.id);
        history.pushState(null, '', pageURL(project, page, next.id));
        lastURL = location.href;
      } else if (view && !view.version) {
        view.name = viewName.trim();
        save();
        await savingQueue;
      } else if (view) {
        await tool('view_rename', { id: view.id, name: viewName });
        await refresh();
      }
      closeViewDialog();
    } catch (e) {
      viewError = apiMessage(e);
    }
  }
  async function initialise() {
    authError = '';
    authReady = false;
    try {
      const status = await api('/api/auth/status');
      authRequired = status.required;
      serverURL = status.publicUrl || location.origin;
      authenticated = status.authenticated;
      if (authenticated) {
        await refresh();
        await route();
      }
    } catch {
      authError = 'app.errors.unreachable';
    } finally {
      authReady = true;
    }
  }
  onMount(() => {
    const expired = () => (authenticated = false),
      media = matchMedia('(prefers-color-scheme: dark)'),
      changed = (event: MediaQueryListEvent) => (systemDark = event.matches);
    media.addEventListener('change', changed);
    window.addEventListener('randl-auth-required', expired);
    const deleted = (event: Event) => void projectDeleted((event as CustomEvent).detail);
    window.addEventListener('randl-project-deleted', deleted);
    void initialise();
    return () => {
      media.removeEventListener('change', changed);
      window.removeEventListener('randl-auth-required', expired);
      window.removeEventListener('randl-project-deleted', deleted);
    };
  });

  let mobileDrawerOpen = $derived(drawer && width <= 760);
  $effect(() => {
    if (mobileDrawerOpen)
      void tick().then(() => document.querySelector<HTMLElement>('.runs-heading h2')?.focus());
  });
  function closeDrawer() {
    const wasOpen = drawer;
    drawer = false;
    menuOpen = false;
    if (!wasOpen) return;
    void tick().then(() => document.querySelector<HTMLButtonElement>('#open-runs')?.focus());
  }
  function drawerKey(event: KeyboardEvent) {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'z' &&
      !panelDialog &&
      !(event.target as HTMLElement).closest('input,textarea,[contenteditable=true]')
    ) {
      event.preventDefault();
      void restoreHistory(event.shiftKey ? 'redo' : 'undo');
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === '.') {
      event.preventDefault();
      toggleRuns();
      return;
    }
    if (event.key === 'Escape' && document.querySelector(':popover-open')) return;
    // Escape closes the phone navigation and returns focus to its menu button.
    if (event.key === 'Escape' && menuOpen && width <= 760) {
      menuOpen = false;
      void tick().then(() =>
        document.querySelector<HTMLElement>('.bx--header__menu-toggle')?.focus(),
      );
      return;
    }
    if (width > 760 || !drawer) return;
    if (event.key === 'Escape') {
      closeDrawer();
    }
    if (event.key === 'Tab') {
      const items = [
        ...document.querySelectorAll<HTMLElement>(
          '.run-sidebar button:not([tabindex="-1"]),.run-sidebar input,.run-sidebar select,.run-sidebar a[href]:not([tabindex="-1"])',
        ),
      ].filter((e) => e.offsetParent !== null && !e.hasAttribute('disabled'));
      const first = items[0],
        last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }
</script>

{#snippet runPanelTools()}
  {#if displayView?.body.panels.length || displayView?.body.sections?.length}<PanelTools
      bind:search={runPanelSearch}
      {canvasWidth}
      onDefaults={() => openDefaults()}
      onAdd={() => openPanel()}
    />{/if}
{/snippet}

{#snippet saveFailureNotice()}
  {#if dirty && (saving === 'views.saveStatus.notSaved' || retrying)}<InlineNotification
      id="save-failure"
      tabindex={-1}
      kind={retrying ? 'info' : 'error'}
      hideCloseButton
      title={$t(retrying ? 'common.status.saving' : 'views.saveStatus.notSaved')}
      subtitle={retrying ? '' : $t(saveError)}
    >
      <svelte:fragment slot="actions"
        >{#if !retrying}<div class="save-failure-actions">
          {#if neverSaved(failedView || view)}<NotificationActionButton on:click={discardDraft}
              >{$t('views.unsaved.discard')}</NotificationActionButton
            >{:else if viewDeleted}<NotificationActionButton on:click={discardDeletedView}
              >{$t('views.unsaved.discard')}</NotificationActionButton
            >{:else}<NotificationActionButton on:click={reloadSaved}
              >{$t('views.unsaved.reload')}</NotificationActionButton
            >{/if}{#if conflicted}<NotificationActionButton on:click={recoverView}
              >{$t('views.unsaved.saveAsNew')}</NotificationActionButton
            >{:else if retrySave}<NotificationActionButton on:click={retryFailedSave}
              >{$t('common.action.retry')}</NotificationActionButton
            >{/if}
          </div>{/if}</svelte:fragment
      >
    </InlineNotification>{/if}
{/snippet}

{#snippet actionNotice()}
  {#if (notice || refreshError) && !conflicted}<InlineNotification
      kind="error"
      title={$t('app.notice.actionFailed')}
      closeButtonDescription={$t('common.notification.close')}
      subtitle={$t(notice || refreshError)}
      on:close={() => {
        notice = '';
        refreshError = '';
        const runList = document.getElementById('run-list');
        const target =
          width <= 760 && drawer
            ? document.querySelector<HTMLElement>('.runs-heading h2')
            : runList && !runList.closest('[inert]')
              ? runList
              : document.getElementById('open-runs') || document.querySelector<HTMLElement>('main');
        void tick().then(() => target?.focus({ preventScroll: true }));
      }}
    />{/if}
{/snippet}

<svelte:window
  bind:innerWidth={width}
  onkeydown={drawerKey}
  onpopstate={() => void route()}
  onbeforeunload={(event) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = '';
    }
  }}
/>
<Theme
  {theme}
  tokens={{
    'interactive-01': colors.primary,
    'interactive-04': colors.primary,
    'link-01': colors.primary,
    focus: colors.primary,
    'hover-primary': colors.hover,
    'active-primary': colors.active,
  }}
/>
{#if !authReady}<div class="loading-page" role="status">
    {$t('app.loading')}
  </div>{:else if authError}<main class="connection-error">
    <h1>{$t(authError)}</h1>
    <p>{$t('app.errors.serverDown')}</p>
    <Button on:click={initialise}>{$t('common.action.retry')}</Button>
  </main>{:else if !authenticated}<Login
    onSuccess={() => {
      authenticated = true;
      void refresh().then(route);
    }}
  />{:else}
  <Header
    inert={width <= 760 && (auxiliaryOpen || drawer)}
    platformName="randl"
    href="/"
    expandedByDefault={false}
    expansionBreakpoint={761}
    bind:isSideNavOpen={menuOpen}
    ariaLabelMenu={$t(menuOpen ? 'app.nav.close' : 'app.nav.open')}
    uiShellAriaLabel="randl"
    ><div class="project-bar">
      <Breadcrumb noTrailingSlash
        >{#if !project && page === 'server'}<BreadcrumbItem isCurrentPage
            >{$t('server.title')}</BreadcrumbItem
          >{:else}<BreadcrumbItem
            href="/?page=overview"
            on:click={(event) => breadcrumbNavigate(event, '')}>{$t('nav.projects')}</BreadcrumbItem
          >{/if}{#if project}<BreadcrumbItem
            href={pageURL(project, 'overview')}
            title={projects.find((item) => item.id === project)?.name || project}
            on:click={(event) => breadcrumbNavigate(event, project)}
            >{projects.find((item) => item.id === project)?.name || project}</BreadcrumbItem
          >{/if}{#if activeRun}{#if runOrigin !== 'overview'}<BreadcrumbItem
              href={runOrigin === 'workspace'
                ? pageURL(
                    project,
                    'workspace',
                    localStorage.getItem('randl.project-view:' + project) || undefined,
                  )
                : pageURL(project, runOrigin)}
              on:click={(event) => breadcrumbNavigate(event, project, runOrigin)}
              >{$t(pages.find((item) => item.id === runOrigin)?.name || 'nav.workspace')}</BreadcrumbItem
            >{/if}<BreadcrumbItem isCurrentPage title={activeRun.display_name}
            >{activeRun.display_name}</BreadcrumbItem
          >{:else if project}<BreadcrumbItem isCurrentPage
            >{$t(
              page === 'not-found'
                ? routeError || 'app.errors.pageNotFound'
                : pages.find((item) => item.id === page)?.name || 'nav.workspace',
            )}</BreadcrumbItem
          >{/if}</Breadcrumb
      >
      <div class="project-switcher">
        {#if project && !routeError}{#if width < 1280}<Button
              kind="ghost"
              size="small"
              icon={Code}
              class="connect-sdk-button"
              hideTooltip
              title={$t('connect.title')}
              iconDescription={$t('connect.title')}
              on:click={() => (help = true)}
            />{:else}<Button
              kind="ghost"
              size="small"
              icon={Code}
              class="connect-sdk-button"
              on:click={() => (help = true)}>{$t('connect.title')}</Button
            >{/if}{/if}<Select
          size="sm"
          labelText={$t('projects.picker.label')}
          hideLabel
          selected={project}
          on:change={(event) => {
            const element = event.target as HTMLSelectElement,
              next = element.value;
            element.value = project;
            void changeProject(next);
          }}
          ><SelectItem
            value=""
            text={$t('projects.picker.all')}
          />{#each projects.filter((p) => !p.archived || p.id === project) as p (p.id)}<SelectItem
              value={p.id}
              text={p.name}
            />{/each}</Select
        >{#if project}<Button
            kind="ghost"
            size="small"
            icon={Add}
            hideTooltip
            title={$t('projects.create.action')}
            iconDescription={$t('projects.create.action')}
            tooltipAlignment="end"
            on:click={openCreateProject}
          />{/if}
      </div>
    </div><div class="header-actions">
      <!-- Narrow header rows also hold the breadcrumb, so their actions are icons. -->
{#if width < 1056}<Button
          kind="ghost"
          size="small"
          icon={Chat}
          class="assistant-button"
          hideTooltip
          title={$t('assistant.title')}
          iconDescription={$pendingProjectConfirmation && !agentDialog
            ? $t('assistant.title') + ' · ' + $t('projects.confirmation.needed')
            : $t('assistant.title')}
          on:click={openAgent}
        />{#if $pendingProjectConfirmation && !agentDialog}<span
            class="confirmation-dot"
            aria-hidden="true"
          ></span>{/if}{:else}<Button kind="ghost" size="small" icon={Chat} on:click={openAgent}
          >{$t('assistant.title')}{#if $pendingProjectConfirmation && !agentDialog}<span
              class="confirmation-badge">{$t('projects.confirmation.needed')}</span
            >{/if}</Button
        >{/if}<Button
        kind="ghost"
        size="small"
        icon={Settings}
        id="app-settings"
        tooltipAlignment="end"
        hideTooltip
        title={$t('app.settings.title')}
        iconDescription={$t('app.settings.title')}
        on:click={() => {
          agentDialog = false;
          panelDialog = false;
          trashOpen = false;
          drawer = false;
          settings = true;
        }}
      />
    </div></Header
  >
  <!-- Phones navigate through Carbon's overlay side navigation, opened from the header's menu button. -->
  {#if width <= 760}<SideNav
      bind:isOpen={menuOpen}
      expansionBreakpoint={761}
      ariaLabel={$t('app.nav.label')}
      class="phone-navigation"
      ><SideNavItems
        ><SideNavLink
          href="/?page=overview"
          icon={Folders}
          text={$t('nav.projects')}
          isSelected={!project && page !== 'server'}
          on:click={(event) =>
            followNavigation(event, async () =>
              project ? changeProject('') : navigate('overview'),
            )}
        /><SideNavLink
          href="/?page=server"
          icon={Activity}
          text={$t('server.title')}
          isSelected={!project && page === 'server'}
          on:click={(event) =>
            followNavigation(event, async () => {
              if (project) await changeProject('');
              await navigate('server');
            })}
        />
        {#if projects.length}<SideNavDivider /><li class="phone-navigation-project">
            <Select
              size="sm"
              labelText={$t('projects.picker.label')}
              selected={project}
              on:change={(event) => {
                const next = (event.target as HTMLSelectElement).value;
                menuOpen = false;
                void changeProject(next);
              }}
              ><SelectItem
                value=""
                text={$t('projects.picker.all')}
              />{#each projects.filter((p) => !p.archived || p.id === project) as p (p.id)}<SelectItem
                  value={p.id}
                  text={p.name}
                />{/each}</Select
            >
          </li>{/if}{#if project}{#each pages as item (item.id)}<SideNavLink
              href={pageURL(project, item.id)}
              icon={item.icon}
              text={item.name === 'nav.settings' ? $t('nav.settingsShort') : $t(item.name)}
              isSelected={page === item.id || (page === 'run' && item.id === 'workspace')}
              on:click={(event) => followNavigation(event, () => navigate(item.id))}
            />{/each}{/if}<SideNavDivider />{#if project && !routeError}<li
            class="bx--side-nav__item"
          >
            <button
              type="button"
              class="bx--side-nav__link"
              onclick={() => {
                menuOpen = false;
                help = true;
              }}
              ><span class="bx--side-nav__icon bx--side-nav__icon--small"><Code /></span><span
                class="bx--side-nav__link-text">{$t('connect.title')}</span
              ></button
            >
          </li>{/if}<li class="bx--side-nav__item">
          <button
            type="button"
            class="bx--side-nav__link"
            onclick={() => {
              menuOpen = false;
              openCreateProject();
            }}
            ><span class="bx--side-nav__icon bx--side-nav__icon--small"><Add /></span><span
              class="bx--side-nav__link-text">{$t('projects.create.action')}</span
            ></button
          >
        </li></SideNavItems
      ></SideNav
    >{/if}
  <div
    class="shell layered-shell"
    inert={width <= 760 && (auxiliaryOpen || menuOpen)}
    class:drawer-open={drawer}
    class:project-only={page !== 'workspace' && page !== 'run'}
    class:nav-expanded={projectNavExpanded}
    class:settings-open={(panelDialog && settingsScope !== null) ||
      settings ||
      agentDialog ||
      trashOpen}
    class:runs-collapsed={!showRunSidebar}
    style:--sidebar-width={displayedSidebarWidth + 'px'}
  >
    <nav class="project-rail" aria-label={$t('nav.projectPages')} inert={width <= 760 && !drawer}>
      <Button
        kind="ghost"
        size="small"
        icon={Menu}
        hideTooltip
        title={projectNavExpanded
          ? $t('nav.collapse')
          : $t('nav.expand')}
        iconDescription={projectNavExpanded
          ? $t('nav.collapse')
          : $t('nav.expand')}
        tooltipPosition="right"
        on:click={() => {
          projectNavExpanded = !projectNavExpanded;
          localStorage.setItem('randl.project-nav', projectNavExpanded ? 'expanded' : 'collapsed');
        }}
      />
      {#each project ? pages : globalPages as item}<Button
          kind="ghost"
          size="small"
          icon={item.icon}
          title={$t(item.name)}
          aria-pressed={page === item.id || (page === 'run' && item.id === 'workspace')}
          on:click={() => navigate(item.id)}
          >{item.name === 'nav.settings' ? $t('nav.settingsShort') : $t(item.name)}</Button
        >{/each}
    </nav>
    {#if page === 'workspace' || page === 'run'}<aside
        class="run-sidebar"
        inert={(width <= 760 && !drawer) || runsCollapsed}
        aria-label={$t('runs.list.region')}
      >
        {#if page === 'workspace' || page === 'run'}
          <div class="runs-heading">
            <h2 tabindex="-1">{$t('runs.list.title')}<span>{$number(filtered.length)}</span></h2>
            <span
              class="heading-control"
              ><Button
                kind="ghost"
                size="small"
                icon={Filter}
                hideTooltip
                title={$t(sidebarFilterCount ? 'runs.filter.buttonWithCount' : 'runs.filter.button', { count: sidebarFilterCount })}
                iconDescription={$t('runs.filter.button')}
                tooltipAlignment="end"
                on:click={(event) => {
                  filterAnchor = (event.target as HTMLElement).closest('button');
                  filterDialog = true;
                }}
              />{#if sidebarFilterCount}<span class="control-badge" aria-hidden="true"
                  >{$number(sidebarFilterCount)}</span
                >{/if}</span
            ><span class="heading-control"
              ><Button
                kind="ghost"
                size="small"
                icon={GroupObjects}
                hideTooltip
                title={groupBy ? $t('runs.group.buttonWithField', { field: fieldLabel(groupBy, $t) }) : $t('runs.group.button')}
                iconDescription={$t('runs.group.button')}
                tooltipAlignment="end"
                on:click={(event) => openRunControl('group', event)}
              />{#if groupBy}<span class="control-dot" aria-hidden="true"></span>{/if}</span
            ><span class="heading-control"
              ><Button
                kind="ghost"
                size="small"
                icon={sort.startsWith('-') ? SortDescending : SortAscending}
                hideTooltip
                title={$t(sort.startsWith('-') ? 'runs.sort.buttonDescending' : 'runs.sort.buttonAscending', {
                  field: fieldLabel(sort.replace(/^-/, ''), $t),
                })}
                iconDescription={$t('runs.sort.button')}
                tooltipAlignment="end"
                on:click={(event) => openRunControl('sort', event)}
              />{#if sort !== '-created'}<span class="control-dot" aria-hidden="true"></span>{/if}</span
            >{#if width <= 760}<Button
                kind="ghost"
                size="small"
                icon={Close}
                hideTooltip
                title={$t('runs.list.close')}
                iconDescription={$t('runs.list.close')}
                tooltipAlignment="end"
                on:click={closeDrawer}
              />{/if}
          </div>
          <div class="run-search">
            <Search
              closeButtonLabelText={$t('common.search.clear')}
              id="run-search"
              size="sm"
              labelText={$t('runs.search.label')}
              placeholder={$t('runs.search.label')}
              bind:value={search}
            />
          </div>
          {#if width <= 760 && drawer}{@render actionNotice()}{@render saveFailureNotice()}{/if}
          <div class="list-label run-table-heading" class:browse={page !== 'workspace'}>
            {#if page === 'workspace'}{@const listedShown = filtered.filter((run) =>
                visibleIds.has(run.id),
              ).length}<button
                class="all-visibility"
                class:none-shown={!listedShown}
                class:solo-overridden={!!view?.body.solo.length}
                aria-label={$t(
                  filtered.length && listedShown === filtered.length
                    ? 'runs.list.hideListed'
                    : 'runs.list.showListed',
                )}
                title={$t(
                  filtered.length && listedShown === filtered.length
                    ? 'runs.list.hideListed'
                    : 'runs.list.showListed',
                )}
                onclick={() => toggleAll(listedShown !== filtered.length)}
                >{#if filtered.length && listedShown === filtered.length}<ViewFilled
                    size={16}
                  />{:else if listedShown}<ViewIcon size={16} />{:else}<ViewOff
                    size={16}
                  />{/if}</button
              >
              {#if view?.body.solo.length}<button
                  class="toggle solo clear-solo"
                  aria-label={$t('runs.list.clearSolo')}
                  title={$t('runs.list.clearSolo')}
                  onclick={() => {
                    if (!view) return;
                    selection(view.body.visible, [], 'runs.list.soloCleared');
                    void tick().then(() => document.getElementById('run-list')?.focus());
                  }}><Close size={16} /></button
                >{:else}<span class="solo-spacer"></span>{/if}{/if}
            <span class="color-spacer"></span><span class="name-heading">{$t('runs.list.nameColumn')}</span>
          </div>
          {#if !filtered.length}<div class="runs-empty">
              <p>{$t(projectRuns.length ? 'runs.empty.noMatches' : 'runs.empty.none')}</p>
              {#if projectRuns.length}<Button
                  kind="ghost"
                  size="small"
                  on:click={() => {
                    search = '';
                    if (sidebarView) {
                      sidebarView.body.filters = [];
                      queryChanged();
                    }
                  }}>{$t('runs.filter.clear')}</Button
                >{/if}
            </div>{/if}
          <a
            class="skip-panels"
            href="#main"
            onclick={(event) => {
              event.preventDefault();
              document.getElementById('main')?.focus();
            }}>{$t('workspace.skipToPanels')}</a
          >
          <RunList
            {groupBy}
            fieldValue={runField}
            comparison={page === 'workspace'}
            activeId={activeRun?.id || ''}
            pinned={sidebarView?.body.pinned || []}
            {dark}
            colors={storedColors}
            onaction={runActionOpen}
            oncolor={setRunColor}
            runs={filtered}
            visible={view?.body.visible || []}
            solo={view?.body.solo || []}
            onchange={selection}
            ondetails={details}
          />
          {#if page === 'workspace' || filtered.length !== projectRuns.length}<div class="side-footer">
            {#if page === 'workspace'}<span
                >{#if hiddenByFilter > 0}{$t(
                    view?.body.solo.length
                      ? 'runs.list.summary.soloedHidden'
                      : 'runs.list.summary.visibleHidden',
                    { count: selected.length, hidden: hiddenByFilter },
                  )}{:else}{$t(view?.body.solo.length ? 'runs.list.summary.soloed' : 'runs.list.summary.visible', {
                    count: selected.length,
                  })}{/if}</span
              >{/if}{#if filtered.length !== projectRuns.length}<span
                >{$t('runs.list.summary.shownOfTotal', {
                  shown: filtered.length,
                  total: projectRuns.length,
                })}</span
              >{/if}
          </div>{/if}
        {/if}
        {#if width > 760}<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (Focusable splitter with arrow-key resizing.) -->
          <div
            class="sidebar-resize"
            role="separator"
            aria-label={$t('runs.list.resize')}
            aria-orientation="vertical"
            aria-valuemin={240}
            aria-valuemax={sidebarLimit}
            aria-valuenow={displayedSidebarWidth}
            tabindex="0"
            onpointerdown={(event) => {
              sidebarDrag = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              event.preventDefault();
            }}
            onpointermove={sidebarResize}
            onpointerup={sidebarResizeEnd}
            onpointercancel={sidebarResizeEnd}
            onkeydown={(event) => {
              if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
                event.preventDefault();
                sidebarWidth = Math.max(
                  240,
                  Math.min(
                    sidebarLimit,
                    displayedSidebarWidth + (event.key === 'ArrowRight' ? 16 : -16),
                  ),
                );
                localStorage.setItem('randl.sidebar-width', String(sidebarWidth));
              }
            }}
          ></div>{/if}
      </aside>{/if}
    {#snippet runsToggle()}
      <!-- On phones the runs drawer opens from a labeled button; wider screens keep the icon. -->
      {#if width <= 760}<Button
          id="open-runs"
          kind="ghost"
          size="small"
          icon={drawer ? SidePanelClose : SidePanelOpen}
          class="runs-drawer-toggle"
          aria-label={drawer ? $t('runs.list.hide') : $t('runs.list.show')}
          aria-expanded={drawer}
          on:click={toggleRuns}>{$t('runs.list.toggle')}</Button
        >{:else}<Button
          kind="ghost"
          size="small"
          icon={showRunSidebar ? SidePanelClose : SidePanelOpen}
          aria-pressed={undefined}
          hideTooltip
          title={showRunSidebar ? $t('runs.list.hide') : $t('runs.list.show')}
          iconDescription={showRunSidebar ? $t('runs.list.hide') : $t('runs.list.show')}
          tooltipAlignment="start"
          on:click={toggleRuns}
        />{/if}
    {/snippet}
    {#snippet viewControls()}
      <div class="view-controls" data-view-id={view?.id}>
        {#if viewChoices.length + (viewMissing ? 1 : 0) > 1}<Select
            hideLabel
            labelText={$t('views.picker.label')}
            size="sm"
            bind:selected={viewChoiceId}
            on:change={async (event) => {
              const next = (event.target as HTMLSelectElement).value;
              try {
                await chooseView(next);
              } finally {
                viewChoiceId = view?.id || '';
              }
            }}
            >{#if view && viewMissing}<SelectItem
                value={view.id}
                text={view.name}
              />{/if}{#each viewChoices as v (v.id)}<SelectItem
                value={v.id}
                text={v.name}
              />{/each}</Select
          >{:else}<span class="view-name" title={view?.name}
            ><span class="bx--visually-hidden"
              >{$t(view?.version ? 'views.picker.saved' : 'views.picker.unsaved', {
                name: view?.name || '',
              })}</span
            ><span aria-hidden="true">{view?.name}</span></span
          >{/if}{#if canvasWidth >= 620}<Button
            kind="ghost"
            size="small"
            id="new-view"
            on:click={() => openViewDialog('create')}>{$t('views.actions.new')}</Button
          >{/if}<OverflowMenu
          size="sm"
          flipped
          id="view-actions"
          bind:open={viewMenuOpen}
          menuOptionsClass="view-actions-menu"
          title={$t('views.actions.menu')}
          aria-label={$t('views.actions.menu')}
          iconDescription={$t('views.actions.menu')}
          >{#if canvasWidth < 620}<OverflowMenuItem
              text={$t('views.actions.new')}
              on:click={() => openViewDialog('create')}
            /><OverflowMenuItem
              text={$t('views.actions.undo')}
              disabled={!undoStack.length || conflicted}
              on:click={() => restoreHistory('undo')}
            /><OverflowMenuItem
              text={$t('views.actions.redo')}
              disabled={!redoStack.length || conflicted}
              on:click={() => restoreHistory('redo')}
            />{/if}{#if !(viewMissing && view?.version)}<OverflowMenuItem
              text={$t('views.actions.rename')}
              on:click={() => openViewDialog('rename')}
            />{/if}<OverflowMenuItem
            text={$t('views.actions.duplicate')}
            on:click={() => openViewDialog('duplicate')}
          /><OverflowMenuItem
            text={$t('views.actions.delete')}
            disabled={!view?.version}
            danger
            on:click={() => {
              deleteConfirmed = false;
              deleteViewDialog = true;
            }}
          /></OverflowMenu
        >
        {#if canvasWidth >= 620}
          <Button
            id="undo-view"
            kind="ghost"
            size="small"
            icon={Undo}
            aria-pressed={undefined}
            hideTooltip
            title={$t('views.actions.undo')}
            iconDescription={$t('views.actions.undo')}
            disabled={!undoStack.length || conflicted}
            on:click={() => restoreHistory('undo')}
          /><Button
            kind="ghost"
            size="small"
            icon={Redo}
            aria-pressed={undefined}
            hideTooltip
            title={$t('views.actions.redo')}
            iconDescription={$t('views.actions.redo')}
            disabled={!redoStack.length || conflicted}
            on:click={() => restoreHistory('redo')}
          />
        {/if}
        <span class="save-status" class:has-notice={dirty && saving === 'views.saveStatus.notSaved'}
          >{#each ['common.status.saving', 'views.saveStatus.saved', 'views.saveStatus.notSaved'] as const as status}<span
              aria-hidden="true"
              class:current={status === saving}>{$t(status)}</span
            >{/each}</span
        ><span class="bx--visually-hidden" aria-live="polite"
          >{dirty && saving === 'views.saveStatus.notSaved' ? '' : $t(saving)}</span
        >
      </div>
    {/snippet}
    {#snippet workspaceLeading()}
      <div class="view-group">
        <div class="workspace-title workspace-current">
          {@render runsToggle()}
          <h1>{$t('workspace.heading')}</h1>
        </div>
        {@render viewControls()}
      </div>
    {/snippet}
    {#snippet viewStatus()}
      {#if !(width <= 760 && drawer)}{@render actionNotice()}{@render saveFailureNotice()}{/if}
    {/snippet}
    <main
      class:runs-page={page === 'runs'}
      tabindex="-1"
      use:observeCanvas
      id="main"
      inert={drawer && width <= 760}
    >
      {#if page !== 'workspace'}
        <div class="workspace-heading">
          <div class="workspace-title" class:workspace-current={page === 'workspace'}>
            {#if page === 'workspace' || page === 'run'}{@render runsToggle()}{/if}
            {#if activeRun}<Button
                kind="ghost"
                size="small"
                icon={ArrowLeft}
                hideTooltip
                title={$t(runOrigins[runOrigin])}
                iconDescription={$t(runOrigins[runOrigin])}
                tooltipAlignment="start"
                on:click={backToOrigin}
              />{/if}
            <h1>
              {currentRun?.display_name ||
                (page === 'workspace'
                  ? $t('nav.workspace')
                  : page === 'overview'
                    ? project
                      ? projects.find((p) => p.id === project)?.name || project.split('/')[1]
                      : $t('nav.projects')
                    : page === 'server'
                      ? $t('server.title')
                      : page === 'not-found'
                        ? $t(routeError || 'app.errors.pageNotFound')
                      : $t(pages.find((p) => p.id === page)?.name))}
            </h1>
            {#if page === 'run' && currentRun}<RunStateTag run={currentRun} />{/if}
          </div>
          {#if page === 'run' && currentRun?.state === 'running' && currentRun.snapshot_at == null}{@const stopLabel = $t(
              currentRun.stop_requested ? 'runs.stop.requested' : 'runs.actions.stop',
            )}{#if canvasWidth >= 620}<Button
                class="run-stop"
                kind="danger-ghost"
                size="small"
                icon={StopFilled}
                disabled={!!currentRun.stop_requested}
                on:click={() => currentRun && requestStop([currentRun])}>{stopLabel}</Button
              >{:else}<Button
                class="run-stop"
                kind="danger-ghost"
                size="small"
                icon={StopFilled}
                disabled={!!currentRun.stop_requested}
                hideTooltip
                title={stopLabel}
                iconDescription={stopLabel}
                tooltipAlignment="end"
                on:click={() => currentRun && requestStop([currentRun])}
              />{/if}{/if}
          {#if page === 'run' && currentRun}{@const exportURL =
              '/api/run-export?run=' + encodeURIComponent(currentRun.id) + '&format=csv'}{@const exportLabel = $t(
              currentRun.snapshot_at == null ? 'runs.actions.exportHistory' : 'runs.snapshot.export',
            )}{#if canvasWidth >= 620}<Button
                class="run-export"
                kind="ghost"
                size="small"
                icon={Download}
                href={exportURL}>{exportLabel}</Button
              >{:else}<Button
                class="run-export"
                kind="ghost"
                size="small"
                icon={Download}
                hideTooltip
                title={exportLabel}
                iconDescription={exportLabel}
                tooltipAlignment="end"
                href={exportURL}
              />{/if}{/if}
          {#if page === 'runs'}{@render viewControls()}{/if}
        </div>
        {@render viewStatus()}{/if}

      {#if routeError}<section class="empty missing-object">
          <Button
            kind="tertiary"
            href="/?page=overview"
            on:click={(event) => breadcrumbNavigate(event, '')}>{$t('nav.back.projects')}</Button
          >
        </section>{:else if page === 'workspace'}<Workspace
          {canvasWidth}
          leading={workspaceLeading}
          below={viewStatus}
          colors={resolvedColors}
          hasRuns={projectRuns.length > 0}
          view={displayView}
          {focusPanel}
          noMatchingRuns={projectRuns.length > 0 && !filtered.length}
          runs={selected}
          {plugins}
          {dark}
          onAdd={(section) => openPanel(undefined, section)}
          onEdit={openPanel}
          onPanelSettings={changePanelSettings}
          onRemove={removePanel}
          onDuplicate={duplicatePanel}
          onResize={resizeSection}
          onSection={sectionAction}
          onLayout={applyLayout}
          onReorder={reorderPanel}
          onDefaults={openDefaults}
          onConnect={() => (help = true)}
        />{:else if page === 'run' && activeRun}<RunPage
          activeTab={runTab}
          onTab={(tab) => {
            retainScroll();
            runTab = tab;
            history.pushState(
              { ...history.state, runDepth: (history.state?.runDepth || 0) + 1 },
              '',
              runURL(activeRun!, tab),
            );
            lastURL = location.href;
            void restoreScroll();
          }}
          run={runs.find((r) => r.id === activeRun!.id) || activeRun}
          onArtifact={openArtifact}
          metricsActions={runPanelTools}
          ><Workspace
            {canvasWidth}
            tools={false}
            bind:search={runPanelSearch}
            colors={resolvedColors}
            hasRuns={projectRuns.length > 0}
            view={displayView}
            {focusPanel}
            noMatchingRuns={projectRuns.length > 0 && !filtered.length}
            runs={selected}
            {plugins}
            {dark}
            onAdd={(section) => openPanel(undefined, section)}
            onEdit={openPanel}
            onPanelSettings={changePanelSettings}
            onRemove={removePanel}
            onDuplicate={duplicatePanel}
            onResize={resizeSection}
            onSection={sectionAction}
            onLayout={applyLayout}
            onReorder={reorderPanel}
            onDefaults={openDefaults}
            onConnect={() => (help = true)}
          /></RunPage
        >{:else if page === 'runs'}<RunTable
          restorePosition={tableRestore}
          onrestored={() => (tableRestore = null)}
          totalCount={projectRuns.length}
          filterCount={view?.body.filters?.length || 0}
          onclear={() => {
            search = '';
            if (sidebarView) {
              sidebarView.body.filters = [];
              queryChanged();
            }
          }}
          onManage={(action, ids, tags) =>
            action === 'stop'
              ? Promise.resolve(requestStop(runs.filter((run) => ids.includes(run.id))))
              : changeRuns(action, ids, tags)}
          {groupBy}
          {sort}
          onSortColumn={(field) => {
            sort = sort === field ? '-' + field : field;
            queryChanged();
          }}
          runs={filtered}
          bind:search
          {dark}
          colors={storedColors}
          {fields}
          columns={view?.body.runQuery?.columns || ['state', 'history_count', 'created']}
          fieldValue={runField}
          oncolumns={(columns) => {
            if (view) {
              view.body.runQuery = { ...view.body.runQuery, columns };
              save();
            }
          }}
          onrun={details}
          oncolor={setRunColor}
          onfilter={(event) => {
            filterAnchor = (event.target as HTMLElement).closest('button');
            filterDialog = true;
          }}
          ongroup={(event) => openRunControl('group', event)}
          onsort={(event) => openRunControl('sort', event)}
        />{:else if page === 'server' && !project}<div class="project-page-content"><ServerOverview {dark} /></div>{:else}<ProjectPages
          revision={workspaceRevision}
          {page}
          {project}
          runs={page === 'runs' ? filtered : projectRuns}
          {dark}
          onRun={(run, tab) => details(run, true, tab)}
          {artifactId}
          activeArtifactTab={artifactTab}
          onArtifactTab={(tab) => {
            artifactTab = tab;
            history.pushState(null, '', artifactURL(project, artifactId, tab));
            lastURL = location.href;
          }}
          {projects}
          onTrash={openTrash}
          onCreate={openCreateProject}
          onConnect={() => (help = true)}
          onArchive={archiveProject}
          onChanged={() => void refresh(false, false)}
          onDeleted={projectDeleted}
          onProject={async (id, next = 'overview') => {
            if (await loadProject(id)) await navigate(next);
          }}
          onArtifact={openArtifact}
        />{/if}
    </main>
  </div>
  {#if drawer && width <= 760}<button
      class="drawer-shade"
      aria-label={$t('runs.list.close')}
      onclick={closeDrawer}
    ></button>{/if}
  {#if runControl && runControlAnchor}<ContextPopover
      anchor={runControlAnchor}
      title={runControl === 'group' ? $t('runs.group.title') : $t('runs.sort.title')}
      onClose={() => (runControl = '')}
      >{#if runControl === 'group'}<ComboBox
          selectionClearedText={$t('common.combobox.selectionCleared')}
          filterResultsText={(count) =>
            resultCount(count, $t)}
          on:keydown={(event) => {
            if (
              event.key === 'Escape' &&
              (event.target as HTMLElement).getAttribute('aria-expanded') === 'true'
            )
              event.preventDefault();
          }}
          shouldFilterItem={filterChoice}
          portalMenu
          wrapOptions
          translateWithId={(id) => $t(id === 'open' ? 'common.combobox.open' : 'common.combobox.close')}
          translateWithIdSelection={() => $t('common.combobox.clear')}
          labelText={$t('runs.group.field')}
          items={[
            { id: '', text: $t('runs.group.none') },
            ...[
              ...groupFields(fields),
              // Keep a stored group visible even before any run reports that field.
              ...(groupBy && !groupFields(fields).includes(groupBy) ? [groupBy] : []),
            ].map((f) => ({ id: f, text: fieldLabel(f, $t) })),
          ]}
          selectedId={groupBy}
          on:clear={() => {
            groupBy = '';
            queryChanged();
          }}
          clearFilterOnOpen
          on:select={(event) => {
            groupBy = String(event.detail.selectedId || '');
            queryChanged();
          }}
        />{:else}<ComboBox
          selectionClearedText={$t('common.combobox.selectionCleared')}
          filterResultsText={(count) =>
            resultCount(count, $t)}
          on:keydown={(event) => {
            if (
              event.key === 'Escape' &&
              (event.target as HTMLElement).getAttribute('aria-expanded') === 'true'
            )
              event.preventDefault();
          }}
          shouldFilterItem={filterChoice}
          portalMenu
          wrapOptions
          translateWithId={(id) => $t(id === 'open' ? 'common.combobox.open' : 'common.combobox.close')}
          translateWithIdSelection={() => $t('common.combobox.clear')}
          labelText={$t('runs.sort.field')}
          items={fields.map((id) => ({ id, text: fieldLabel(id, $t) }))}
          selectedId={sort.replace(/^-/, '')}
          on:clear={() => {
            sort = '-created';
            queryChanged();
          }}
          clearFilterOnOpen
          on:select={(event) => {
            sort = (sort.startsWith('-') ? '-' : '') + String(event.detail.selectedId || 'created');
            queryChanged();
          }}
        /><Select
          labelText={$t('runs.sort.order')}
          selected={sort.startsWith('-') ? 'desc' : 'asc'}
          on:change={(event) => {
            sort =
              ((event.target as HTMLSelectElement).value === 'desc' ? '-' : '') +
              sort.replace(/^-/, '');
            queryChanged();
          }}
          ><SelectItem value="desc" text={$t('runs.sort.descending')} /><SelectItem
            value="asc"
            text={$t('runs.sort.ascending')}
          /></Select
        >{/if}</ContextPopover
    >{/if}
  {#if runAction && runActionAnchor}<ContextPopover
      anchor={runActionAnchor}
      title={$t('runs.rename.title')}
      onClose={() => (runAction = '')}
      ><form
        bind:this={runActionForm}
        class="run-action-form"
        onsubmit={(event) => {
          event.preventDefault();
          void saveRunAction();
        }}
      >
        <TextInput labelText={$t('runs.fields.displayName')} bind:value={runName} />{#if runActionError}<InlineNotification
            kind="error"
            title={$t(runActionError)}
            closeButtonDescription={$t('common.notification.close')}
            on:close={() => {
              runActionError = '';
              void tick().then(() =>
                runActionForm
                  ?.querySelector<HTMLElement>('input,button[type="submit"]')
                  ?.focus({ preventScroll: true }),
              );
            }}
          />{/if}
        <div class="popover-footer">
          <Button kind="ghost" size="small" on:click={() => (runAction = '')}>{$t('common.action.cancel')}</Button
          ><Button
            kind="primary"
            size="small"
            disabled={runBusy}
            type="submit">{$t('runs.rename.save')}</Button
          >
        </div>
      </form></ContextPopover
    >{/if}
  {#if trashOpen}<TrashPanel
      {project}
      revision={workspaceRevision}
      onClose={() => (trashOpen = false)}
    />{/if}
  {#if runFeedback}<div class="operation-toast" role="status">
      <span>{$t(runFeedback)}</span>{#if runFeedback === undoFeedback}<Button
          kind="ghost"
          size="small"
          on:click={() => {
            restoreHistory('undo');
            runFeedback = '';
          }}>{$t('common.action.undo')}</Button
        >{/if}{#if feedbackUndo}<Button
          kind="ghost"
          size="small"
          on:click={() => {
            const undo = feedbackUndo!;
            feedbackUndo = null;
            runFeedback = '';
            undo().catch((error) => (notice = apiMessage(error)));
          }}>{$t('common.action.undo')}</Button
        >{/if}{#if lastDeleted.length}<Button
          kind="ghost"
          size="small"
          on:click={() =>
            changeRuns('restore', lastDeleted).catch((error) => (notice = apiMessage(error)))}
          >{$t('common.action.undo')}</Button
        >{/if}<Button
        kind="ghost"
        size="small"
        icon={Close}
        hideTooltip
        title={$t('app.notice.dismiss')}
        iconDescription={$t('app.notice.dismiss')}
        on:click={() => {
          runFeedback = '';
          feedbackUndo = null;
        }}
      />
    </div>{/if}
  {#if project}<ConnectSdk bind:open={help} {project} {authRequired} {serverURL} />{/if}
  <PanelEditor
    workspaceOptions={{
      generation: view?.body.generation,
      hidePattern: view?.body.hidePattern,
      hiddenMetrics: view?.body.hiddenMetrics,
    }}
    onWorkspaceOptions={(options) => {
      if (view) Object.assign(view.body, options);
    }}
    {metricKinds}
    {metricDefinitions}
    {metricsLoading}
    runs={selected}
    pinned={view?.body.pinned || []}
    {dark}
    colors={resolvedColors}
    sections={sectionsForView()}
    inheritedLayers={settingsScope === ''
      ? []
      : settingsScope !== null
        ? [{ scope: 'workspace', settings: view?.body.plotSettings }]
        : [
            { scope: 'workspace', settings: view?.body.plotSettings },
            {
              scope: 'section',
              settings: view?.body.sectionSettings?.[draft.section || sectionForPanel(draft)],
            },
          ]}
    onPreview={(value) => (previewSettings = value)}
    {fields}
    bind:open={panelDialog}
    panel={draft}
    settingsOnly={settingsScope !== null}
    workspaceScope={settingsScope === ''}
    scopePlugins={settingsScope === null ? [] : pluginsInScope(settingsScope)}
    heading={settingsScope === null
      ? ''
      : settingsScope
        ? $t('workspace.section.settings', {
            name: sectionsForView().find((s) => s.id === settingsScope)?.name || settingsScope,
          })
        : $t('workspace.settings')}
    {metrics}
    {plugins}
    onSave={(panel) => {
      if (!view) return;
      if (settingsScope !== null) {
        if (settingsScope)
          view.body.sectionSettings = {
            ...view.body.sectionSettings,
            [settingsScope]: panel.settings || {},
          };
        else view.body.plotSettings = panel.settings || {};
        save();
        return;
      }
      const value = {
        ...panel,
        id: panel.id || crypto.randomUUID(),
        title: panel.title || panel.metric,
      };
      view.body.panels = panel.id
        ? view.body.panels.map((p) => (p.id === panel.id ? value : p))
        : [...view.body.panels, value];
      save();
      focusPanel = value.id;
    }}
  />
  {#snippet pluginSettingsContent()}
    <div class="plugin-install">
      <TextInput
        id="plugin-source"
        labelText={$t('plugins.install.source')}
        placeholder={$t('plugins.install.placeholder')}
        bind:value={pluginSource}
      /><Button
        size="field"
        disabled={pluginBusy || !pluginSource}
        on:click={() => managePlugin('install')}>{$t('plugins.install.action')}</Button
      >
    </div>
    {#if pluginError}<InlineNotification
        kind="error"
        title={$t('plugins.errors.actionFailed')}
        subtitle={$t(pluginError)}
        hideCloseButton
      />{/if}
    <p class="help-note">{$t('plugins.trustNotice')}</p>
    <div class="plugin-list">
      {#each plugins as p}<div class="plugin-row">
          <div>
            <strong>{pluginName(p, $t)}</strong><span
              >{p.version}{p.builtin ? ' · ' + $t('plugins.builtIn') : ''} · {$t(
                p.enabled ? 'plugins.status.enabled' : 'plugins.status.disabled',
              )}</span
            >
          </div>
          <div class="plugin-actions">
            <Button
              kind="ghost"
              size="small"
              disabled={pluginBusy}
              on:click={() => managePlugin(p.enabled ? 'disable' : 'enable', p.id)}
              >{p.enabled ? $t('plugins.actions.disable') : $t('plugins.actions.enable')}</Button
            >{#if !p.builtin}<Button
                kind="ghost"
                size="small"
                disabled={pluginBusy}
                on:click={() => managePlugin('update', p.id)}>{$t('plugins.actions.update')}</Button
              ><Button
                kind="ghost"
                size="small"
                disabled={pluginBusy}
                on:click={() => managePlugin('remove', p.id)}>{$t('plugins.actions.uninstall')}</Button
              >
            {/if}
          </div>
        </div>{/each}
    </div>
  {/snippet}
  {#if settings}<SideDrawer title={$t('app.settings.title')} onClose={() => (settings = false)}>
      <Tabs bind:selected={settingsTab}>
        <Tab label={$t('app.settings.tabs.general')} /><Tab label={$t('assistant.title')} /><Tab
          label={$t('app.settings.tabs.plugins')}
        />
        <svelte:fragment slot="content">
          <TabContent
            ><div class="form-stack">
              <LanguagePicker />
              <Select
                labelText={$t('app.settings.theme.label')}
                selected={themeChoice}
                on:change={(event) => (themeChoice = (event.target as HTMLSelectElement).value)}
                ><SelectItem value="system" text={$t('app.settings.theme.system')} /><SelectItem
                  value="g10"
                  text={$t('app.settings.theme.light')}
                /><SelectItem value="g100" text={$t('app.settings.theme.dark')} /></Select
              >
              <fieldset class="palette">
                <legend>{$t('app.settings.accent.label')}</legend>{#each accents as [name, hex]}<label
                    ><input type="radio" name="accent" value={hex} bind:group={accent} /><span
                      style:background={hex}
                    ></span>{$t(name)}</label
                  >{/each}
              </fieldset>
            </div></TabContent
          >
          <TabContent
            >{#if settingsTab === 1}<AgentSettings
                onRequestClose={() => (settings = false)}
              />{/if}</TabContent
          >
          <TabContent
            >{#if settingsTab === 2}{@render pluginSettingsContent()}{/if}</TabContent
          >
        </svelte:fragment>
      </Tabs>
      {#snippet footer()}{#if authRequired}<Button
            kind="ghost"
            size="small"
            on:click={async () => {
              await api('/api/auth/logout', {});
              settings = false;
              authenticated = false;
            }}>{$t('auth.signOut')}</Button
          >{/if}{/snippet}
    </SideDrawer>{/if}
  <Modal
    iconDescription={$t('common.action.close')}
    bind:open={projectDialog}
    selectorPrimaryFocus="#project-name"
    modalHeading={$t('projects.create.action')}
    primaryButtonText={$t('projects.create.action')}
    primaryButtonDisabled={!projectSlug || !projectOwner.trim() || !!projectProblem}
    secondaryButtonText={$t('common.action.cancel')}
    on:submit={applyProject}
    on:click:button--secondary={() => (projectDialog = false)}
    size="sm"
    ><div class="form-stack">
      <ComboBox
        selectionClearedText={$t('common.combobox.selectionCleared')}
        filterResultsText={(count) =>
          resultCount(count, $t)}
        on:keydown={(event) => {
          if (
            event.key === 'Escape' &&
            (event.target as HTMLElement).getAttribute('aria-expanded') === 'true'
          )
            event.preventDefault();
        }}
        shouldFilterItem={filterChoice}
        portalMenu
        wrapOptions
        translateWithId={(id) => $t(id === 'open' ? 'common.combobox.open' : 'common.combobox.close')}
        translateWithIdSelection={() => $t('common.combobox.clear')}
        labelText={$t('projects.create.namespace')}
        items={[...new Set(['local', ...projects.map((p) => p.id.split('/')[0])])].map((id) => ({
          id,
          text: id,
        }))}
        allowCustomValue
        bind:value={projectOwner}
        bind:selectedId={projectOwnerItem}
        on:input={(event) => {
          // Typing a custom namespace replaces an earlier menu choice.
          if ((event.target as HTMLInputElement).value !== projectOwnerItem) projectOwnerItem = undefined;
        }}
        on:select={(event) => (projectOwner = String(event.detail.selectedId || projectOwner))}
      />
      <TextInput
        id="project-name"
        labelText={$t('projects.create.name')}
        bind:value={projectName}
        maxlength={200}
        invalid={!!projectProblem}
        invalidText={$t(projectProblem)}
        helperText={projectSlug ? $t('projects.create.idPreview', { id: projectId }) : ''}
      /><TextArea
        labelText={$t('projects.create.description')}
        bind:value={projectDescription}
        rows={3}
        maxCount={5000}
      />{#if projectError}<InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title={$t(projectError)}
        />{/if}
    </div></Modal
  >
  <Modal
    iconDescription={$t('common.action.close')}
    bind:open={stopDialog}
    danger
    modalHeading={stopTargets.length === 1
      ? $t('runs.stop.titleSingle', { name: stopTargets[0].display_name })
      : $t('runs.stop.titleMultiple', { count: stopTargets.length })}
    primaryButtonText={$t('runs.stop.confirm', { count: stopTargets.length })}
    secondaryButtonText={$t('common.action.cancel')}
    on:click:button--secondary={() => (stopDialog = false)}
    on:close={() => void tick().then(() => stopInvoker?.isConnected && stopInvoker.focus())}
    on:submit={confirmStop}
    ><p>
      {stopTargets.length === 1
        ? $t('runs.stop.bodySingle', {
            name: stopTargets[0]?.display_name || '',
          })
        : $t('runs.stop.bodyMultiple', {
            count: stopTargets.length,
          })}
    </p>{#if stopError}<InlineNotification
        kind="error"
        lowContrast
        hideCloseButton
        title={$t(stopError)}
      />{/if}</Modal
  >
  <Modal
    iconDescription={$t('common.action.close')}
    bind:open={deleteViewDialog}
    on:close={() => focusViewControls(deleteConfirmed)}
    danger
    modalHeading={$t('views.delete.title')}
    primaryButtonText={$t('views.actions.delete')}
    secondaryButtonText={$t('common.action.cancel')}
    on:click:button--secondary={() => (deleteViewDialog = false)}
    on:submit={async () => {
      if (!view) return;
      await savingQueue;
      await api('/api/views/' + view.id, undefined, 'DELETE');
      deleteConfirmed = true;
      views = (await api('/api/views')).views;
      const next = views.find((v) => v.project === project && !v.run);
      if (next) await readView(next.id);
      else openDraftView(project);
      history.replaceState(
        null,
        '',
        pageURL(project, 'workspace', view?.version ? view.id : undefined),
      );
      lastURL = location.href;
      deleteViewDialog = false;
    }}
    ><p>
      {$t('views.delete.body', {
        name: view?.name || '',
      })}
    </p></Modal
  >
  <Modal
    iconDescription={$t('common.action.close')}
    bind:open={viewDialog}
    on:close={closeViewDialog}
    modalHeading={viewMode === 'create'
      ? $t('views.actions.new')
      : viewMode === 'duplicate'
        ? $t('views.dialog.duplicateTitle')
        : $t('views.dialog.renameTitle')}
    primaryButtonText={viewMode === 'create'
      ? $t('views.dialog.create')
      : viewMode === 'duplicate'
        ? $t('views.dialog.duplicateTitle')
        : $t('views.dialog.renameTitle')}
    secondaryButtonText={$t('common.action.cancel')}
    on:submit={applyView}
    on:click:button--secondary={closeViewDialog}
    size="sm"
    primaryButtonDisabled={!viewName.trim()}
    ><div class="form-stack">
      <TextInput
        labelText={$t('views.dialog.name')}
        bind:value={viewName}
      />{#if viewMode === 'create'}<Select labelText={$t('views.dialog.startWith')} bind:selected={viewStart}
          ><SelectItem value="current" text={$t('views.dialog.startCurrent')} /><SelectItem
            value="empty"
            text={$t('views.dialog.startEmpty')}
          /></Select
        >{/if}
    </div>
    {#if viewError}<InlineNotification kind="error" title={$t(viewError)} />{/if}</Modal
  >
  {#if agentDialog}<SideDrawer title={$t('assistant.title')} onClose={() => (agentDialog = false)}
      >{#await import('./AgentChat.svelte')}<p role="status">
          {$t('common.status.loading')}
        </p>{:then module}<module.default
          onRequestClose={() => (agentDialog = false)}
          {project}
          viewId={view?.version ? view.id : ''}
          onSettings={() => {
            agentDialog = false;
            settingsTab = 1;
            settings = true;
          }}
          onChange={refresh}
        />{:catch error}<InlineNotification
          kind="error"
          title={$t('app.notice.requestFailed')}
          subtitle={$t(error.message)}
        />{/await}</SideDrawer
    >{/if}

  <FilterBuilder
    loadValues={async (field) => {
      const values: string[] = [];
      for (let offset = 0; offset < projectRuns.length; offset += 10000) {
        const result = await api('/api/run-values', {
          runs: projectRuns.slice(offset, offset + 10000).map((run) => run.id),
          fields: [field],
        });
        for (const row of result.runs) {
          const value = row.values[field];
          if (value != null)
            for (const item of Array.isArray(value) ? value : [value])
              if (typeof item !== 'object') values.push(String(item));
        }
      }
      return [...new Set(values)]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .slice(0, 500);
    }}
    anchor={filterAnchor}
    {fields}
    bind:open={filterDialog}
    filters={sidebarView?.body.filters || []}
    mode={sidebarView?.body.filterMode || 'and'}
    onApply={(rules, mode) => {
      if (sidebarView) {
        sidebarView.body.filters = rules;
        sidebarView.body.filterMode = mode;
        save(true, sidebarView);
      }
    }}
  />
{/if}
