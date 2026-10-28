<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    Button,
    DataTable,
    Tag,
    TextArea,
    InlineNotification,
    InlineLoading,
    TooltipDefinition,
  } from 'carbon-components-svelte';
  import Edit from 'carbon-icons-svelte/lib/Edit.svelte';
  import OverviewChart from './OverviewChart.svelte';
  import { shareBar, stateColors, chartColors } from './overview-charts';
  import { t, number, date, duration, type Message } from './i18n';
  import { tool, apiMessage } from './api';
  import { runURL, artifactURL, interceptLink, statusLabel, formatBytes } from './ui';
  import { imeKeys } from './ime';
  import type { Run, ProjectDetails, ProjectSummary } from './types';
  let {
    project,
    summary,
    runs,
    revision,
    dark,
    onRun,
    onArtifact,
    onTrash,
    onConnect,
    onArchive,
  }: {
    project: string;
    summary: ProjectSummary | undefined;
    runs: Run[];
    revision: number;
    dark: boolean;
    onRun: (run: Run, tab?: string) => void;
    onArtifact: (id: string) => void;
    onTrash: () => void;
    onConnect: () => void;
    onArchive: (project: ProjectSummary, archived: boolean) => void;
  } = $props();
  let details = $state<ProjectDetails | null>(null),
    loadError = $state<Message>('');
  async function load(id: string) {
    try {
      const value = await tool('project_get', { id });
      if (id === project) {
        details = value;
        loadError = '';
      }
    } catch (error) {
      if (id === project) loadError = apiMessage(error);
    }
  }
  let previous = '',
    throttle: ReturnType<typeof setTimeout> | undefined;
  // Run states and log volume change with every live update of this project's runs.
  // Completion changes a run's state without a new revision, so include both.
  let runSignature = $derived(runs.map((run) => run.state + run.revision).join());
  $effect(() => {
    const id = project;
    revision;
    runSignature;
    summary?.name;
    summary?.description;
    summary?.archived;
    if (id !== previous) {
      previous = id;
      details = null;
      void load(id);
      return;
    }
    // Runs that log continuously change this every few hundred milliseconds; reload
    // the totals at most once a second.
    throttle ??= setTimeout(() => {
      throttle = undefined;
      void load(project);
    }, 1000);
  });
  onMount(() => () => clearTimeout(throttle));
  let editing = $state(false),
    draft = $state(''),
    saving = $state(false),
    saveError = $state<Message>(''),
    field = $state<HTMLTextAreaElement | null>(null),
    editButton = $state<HTMLElement | null>(null);
  async function startEditing() {
    draft = details?.description || '';
    saveError = '';
    editing = true;
    await tick();
    field?.focus();
  }
  async function stopEditing() {
    editing = false;
    await tick();
    editButton?.querySelector('button')?.focus();
  }
  async function saveDescription() {
    if (saving) return;
    saving = true;
    saveError = '';
    try {
      details = await tool('project_update', { id: project, description: draft });
      await stopEditing();
    } catch (error) {
      saveError = apiMessage(error);
    } finally {
      saving = false;
    }
  }
  // Running runs come from the live run list; runtimes advance every second. Imported
  // snapshots count as running (they were at the source) and keep their recorded runtime.
  let now = $state(Date.now() / 1000);
  let running = $derived(
    runs
      .filter((run) => run.state === 'running')
      .sort((a, b) => b.created - a.created),
  );
  onMount(() => {
    const timer = setInterval(() => {
      if (running.length && !document.hidden) now = Date.now() / 1000;
    }, 1000);
    return () => clearInterval(timer);
  });
  const liveRuntime = (run: Run) =>
    run.snapshot_at != null
      ? (run.runtime ?? 0)
      : (run.runtime ?? 0) + Math.max(0, now - (run.runtime_at ?? now));
  const ago = (seconds: number | undefined) =>
    seconds ? $t('projects.ago', { time: $duration(Math.max(0, now - seconds)) }) : '—';
  let recent = $derived([...runs].sort((a, b) => b.created - a.created).slice(0, 10));
  const order = ['running', 'finished', 'failed', 'crashed', 'killed'];
  let live = $derived(details ? details.counts.runs - details.counts.deletedRuns : 0);
  let colors = $derived(stateColors(dark));
  let palette = $derived(chartColors(dark).categorical);
  let stateParts = $derived(
    details
      ? [
          ...order.map((state) => ({
            name: statusLabel(state, $t),
            value: details!.states[state] || 0,
            color: colors[state],
          })),
        ]
      : [],
  );
  let storageParts = $derived(
    details
      ? [
          { name: $t('projects.storage.history'), value: details.storage.history, color: palette[2] },
          { name: $t('projects.storage.files'), value: details.storage.files, color: palette[3] },
          { name: $t('projects.storage.artifacts'), value: details.storage.artifacts, color: palette[4] },
        ]
      : [],
  );
  let storageTotal = $derived(storageParts.reduce((sum, part) => sum + part.value, 0));
  let bytes = (value: number) => formatBytes(value, $number);
  const runFor = (id: string) => runs.find((run) => run.id === id);
</script>

<div class="project-overview">
  {#if summary?.archived}<div class="archived-status">
      <Tag type="gray">{$t('projects.overview.archivedTag')}</Tag>
      <Button kind="ghost" size="small" on:click={() => summary && onArchive(summary, false)}
        >{$t('projects.restore.action')}</Button
      >
    </div>{/if}
  <section class="project-description" aria-label={$t('projects.description.label')}>
    {#if editing}<form
        onsubmit={(event) => {
          event.preventDefault();
          void saveDescription();
        }}
        use:imeKeys={{
          escape: () => void stopEditing(),
          submit: (event) => (event.ctrlKey || event.metaKey) && (void saveDescription(), true),
        }}
      >
        <TextArea
          labelText={$t('projects.description.label')}
          hideLabel
          rows={4}
          maxCount={5000}
          bind:ref={field}
          bind:value={draft}
          disabled={saving}
        />
        {#if saveError}<InlineNotification kind="error" lowContrast hideCloseButton title={$t(saveError)} />{/if}
        <div class="form-actions">
          <Button kind="ghost" size="small" disabled={saving} on:click={() => void stopEditing()}
            >{$t('common.action.cancel')}</Button
          ><Button size="small" type="submit" disabled={saving || draft === (details?.description || '')}
            >{$t('projects.description.save')}</Button
          >
        </div>
      </form>{:else if details?.description}<div class="description-text">
        <p>{details.description}</p>
        <span bind:this={editButton}
          ><Button
            kind="ghost"
            size="small"
            icon={Edit}
            hideTooltip
            title={$t('projects.description.edit')}
            iconDescription={$t('projects.description.edit')}
            on:click={startEditing}
          /></span
        >
      </div>{:else if details}<span bind:this={editButton} class="add-description"
        ><Button kind="ghost" size="small" icon={Edit} on:click={startEditing}
          >{$t('projects.description.add')}</Button
        ></span
      >{/if}
    {#if details}<p class="project-meta">
        <code>{details.id}</code>{#if details.created}<span
            >{$t('projects.overview.created')} {$date(details.created)}</span
          >{/if}<span
          >{$t('projects.lastActivity')}
          {details.lastActivity ? $date(details.lastActivity) : $t('projects.noActivity')}</span
        >
      </p>{/if}
  </section>
  {#if loadError}<InlineNotification kind="error" lowContrast hideCloseButton title={$t(loadError)} />{/if}
  {#if !details}{#if !loadError}<InlineLoading description={$t('common.status.loading')} />{/if}{:else}
    {#if running.length}<section class="running-runs" aria-labelledby="running-heading">
        <h2 id="running-heading" class="overview-heading">
          <span class="live-dot" aria-hidden="true"></span>{$t('projects.overview.running.title')}<span
            >{$number(running.length)}</span
          >
        </h2>
        <table>
          <thead>
            <tr>
              <th scope="col">{$t('runs.columns.run')}</th>
              <th scope="col">{$t('runs.columns.runtime')}</th>
              <th scope="col">{$t('projects.steps')}</th>
              <th scope="col">{$t('projects.lastUpdate')}</th>
              <th scope="col"><span class="bx--visually-hidden">{$t('projects.runLinks')}</span></th>
            </tr>
          </thead>
          <tbody>
            {#each running.slice(0, 20) as run (run.id)}<tr>
                <td
                  ><div class="run-cell"><a
                    class="table-link"
                    href={runURL(run)}
                    title={run.display_name}
                    onclick={(event) => interceptLink(event, () => onRun(run))}
                    ><span class="table-link-text">{run.display_name}</span></a
                  >{#if run.stop_requested}<Tag size="sm" type="gray">{$t('runs.stop.requested')}</Tag>{/if}</div></td
                >
                <td>{$duration(liveRuntime(run))}</td>
                <td>{$number(run.history_count)}</td>
                <td>{ago(run.heartbeat)}</td>
                <td class="run-links"
                  ><a href={runURL(run, 'logs')} onclick={(event) => interceptLink(event, () => onRun(run, 'logs'))}
                    >{$t('projects.overview.running.logs')}</a
                  ></td
                >
              </tr>{/each}
          </tbody>
        </table>
        {#if running.length > 20}<p class="overview-note">
            {$t('projects.moreRunning', { count: $number(running.length - 20) })}
          </p>{/if}
      </section>{/if}
    <dl class="overview-tiles">
      <div><dt>{$t('projects.overview.stats.runs')}</dt><dd>{$number(live)}</dd></div>
      <div class="tile-running">
        <dt>{$t('projects.overview.stats.running')}</dt>
        <dd>
          {$number(details.states.running || 0)}
        </dd>
      </div>
      <div><dt>{$t('projects.overview.stats.finished')}</dt><dd>{$number(details.states.finished || 0)}</dd></div>
      <div class:tile-failed={details.states.failed || details.states.crashed}>
        <dt>{$t('projects.failedCrashed')}</dt>
        <dd>{$number((details.states.failed || 0) + (details.states.crashed || 0))}</dd>
      </div>
      <div>
        <dt>
          <TooltipDefinition tooltipText={$t('projects.computeHelp')} direction="bottom" align="start"
            >{$t('projects.compute')}</TooltipDefinition
          >
        </dt>
        <dd>{$duration(details.totalCompute)}</dd>
      </div>
      <div><dt>{$t('projects.storage.title')}</dt><dd>{bytes(storageTotal)}</dd></div>
      <div>
        <dt>{$t('projects.artifactVersions')}</dt>
        <dd>
          {$number(details.counts.artifactVersions)}{#if details.counts.artifactVersions}<span
              >{$t('projects.inCollections', { count: $number(details.artifactCollections) })}</span
            >{/if}
        </dd>
      </div>
    </dl>
    {#if !live && !details.counts.deletedRuns}<section class="overview-empty">
        <h2>{$t('projects.overview.empty.title')}</h2>
        <p>{$t('projects.emptyText')}</p>
        <Button size="small" kind="tertiary" on:click={onConnect}>{$t('connect.title')}</Button>
      </section>{:else}
      <div class="overview-storage">
        <div>
          <h3>{$t('projects.runStates')}<span>{$number(live)}</span></h3>
          <OverviewChart option={shareBar(stateParts, dark, (value) => $number(value))} height={16} label={$t('projects.runStates')} />
          <ul class="overview-legend">
            {#each stateParts.filter((part) => part.value) as part}<li>
                <i style:background={part.color}></i>{part.name}<b>{$number(part.value)}</b>
              </li>{/each}
            {#if details.counts.deletedRuns}<li>
                <button type="button" class="link-button" onclick={onTrash}
                  >{$t('projects.deletedRunsCount', { count: $number(details.counts.deletedRuns) })}</button
                >
              </li>{/if}
          </ul>
        </div>
        <div>
          <h3>{$t('projects.storage.title')}<span>{bytes(storageTotal)}</span></h3>
          <OverviewChart option={shareBar(storageParts, dark, bytes)} height={16} label={$t('projects.storage.title')} />
          <ul class="overview-legend">
            {#each storageParts as part}<li>
                <i style:background={part.color}></i>{part.name}<b>{bytes(part.value)}</b>
              </li>{/each}
          </ul>
        </div>
      </div>
      <div class="overview-columns">
        {#if details.largestRuns.length}<section aria-labelledby="largest-runs">
            <h3 id="largest-runs">{$t('projects.largestRuns')}</h3>
            <ol class="size-list">
              {#each details.largestRuns as item}{@const size = item.history + item.files}{@const run = runFor(item.id)}<li>
                  <span class="size-name"
                    >{#if run}<a
                        class="table-link"
                        href={runURL(run)}
                        title={item.display_name}
                        onclick={(event) => interceptLink(event, () => onRun(run))}
                        ><span class="table-link-text">{item.display_name}</span></a
                      >{:else}<span class="table-link-text" title={item.display_name}>{item.display_name}</span
                      >{/if}{#if item.deleted}<Tag size="sm" type="gray">{$t('projects.deletedRun')}</Tag>{/if}</span
                  ><span class="size-bar"
                    ><i style:width={(100 * size) / (details.largestRuns[0].history + details.largestRuns[0].files) + '%'}
                    ></i></span
                  ><b>{bytes(size)}</b>
                </li>{/each}
            </ol>
          </section>{/if}
        {#if details.largestArtifacts.length}<section aria-labelledby="largest-artifacts">
            <h3 id="largest-artifacts">{$t('projects.largestArtifacts')}</h3>
            <ol class="size-list">
              {#each details.largestArtifacts as item}<li>
                  <span class="size-name"
                    ><a
                      class="table-link"
                      href={artifactURL(project, item.id)}
                      onclick={(event) => interceptLink(event, () => onArtifact(item.id))}
                      ><span class="table-link-text">{item.name}:v{item.version}</span></a
                    ></span
                  ><span class="size-bar"
                    ><i style:width={(100 * item.bytes) / details.largestArtifacts[0].bytes + '%'}></i></span
                  ><b>{bytes(item.bytes)}</b>
                </li>{/each}
            </ol>
          </section>{/if}
      </div>
      {#if recent.length}<h2 class="overview-heading">{$t('projects.overview.recent')}</h2>
        <div class="overview-runs">
          <DataTable
            rows={recent.map((run) => ({
              id: run.id,
              display_name: run.display_name,
              state: run.state,
              label: statusLabel(run.state, $t),
              runtime:
                run.state === 'running' ? liveRuntime(run) : (run.runtime ?? null),
              created: run.created,
            }))}
            headers={[
              { key: 'display_name', value: $t('runs.columns.run') },
              { key: 'state', value: $t('runs.fields.state') },
              { key: 'runtime', value: $t('runs.columns.runtime') },
              { key: 'created', value: $t('runs.fields.created') },
            ]}
            size="compact"
            ><svelte:fragment slot="cell" let:row let:cell
              >{#if cell.key === 'display_name'}<a
                  class="table-link"
                  href={runURL(runFor(String(row.id))!)}
                  title={String(cell.value)}
                  onclick={(event) => interceptLink(event, () => onRun(runFor(String(row.id))!))}
                  ><span class="table-link-text">{cell.value}</span></a
                >{:else if cell.key === 'state'}<span class="state-label"
                  ><span class="run-state" data-state={cell.value}></span>{row.label}</span
                >{:else if cell.key === 'runtime'}{cell.value == null ? '—' : $duration(Number(cell.value))}{:else if cell.key === 'created'}{$date(
                  Number(cell.value),
                )}{:else}{cell.value}{/if}</svelte:fragment
            ></DataTable
          >
        </div>{/if}
    {/if}
  {/if}
</div>

<style>
  .project-overview {
    max-width: 80rem;
  }
  .archived-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
  .project-description {
    margin-bottom: 1.5rem;
  }
  .description-text {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .description-text p {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-width: 48rem;
    padding-top: 0.375rem;
  }
  .description-text :global(.bx--btn) {
    opacity: 0;
  }
  .description-text:hover :global(.bx--btn),
  .description-text:focus-within :global(.bx--btn) {
    opacity: 1;
  }
  @media (hover: none) {
    .description-text :global(.bx--btn) {
      opacity: 1;
    }
  }
  .add-description > :global(.bx--btn--ghost) {
    margin-inline-start: -1rem;
  }
  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .project-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1.5rem;
    margin-top: 0.5rem;
    font-size: 0.75rem;
    color: var(--cds-text-secondary);
  }
  .project-meta code {
    font-family: 'IBM Plex Mono', monospace;
  }
  .running-runs {
    margin-bottom: 1.5rem;
    background: var(--cds-ui-01);
    border: 1px solid var(--cds-ui-03);
  }
  .running-runs .overview-heading {
    padding: 0.75rem 1rem 0.25rem;
    margin: 0;
  }
  .live-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--cds-support-02);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--cds-support-02) 25%, transparent);
  }
  .running-runs table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
    table-layout: fixed;
  }
  .running-runs th {
    text-align: left;
    font-weight: 400;
    font-size: 0.75rem;
    color: var(--cds-text-secondary);
    padding: 0.5rem 1rem 0.25rem;
  }
  .running-runs th:first-child {
    width: 40%;
  }
  .running-runs td {
    padding: 0.375rem 1rem;
    border-top: 1px solid var(--cds-ui-03);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .run-cell {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .run-cell::before {
    content: '';
    flex: 0 0 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--cds-support-02);
  }
  .run-cell .table-link {
    display: flex;
    min-width: 0;
  }
  .run-links a {
    color: var(--cds-link-01);
  }
  .tile-running dd {
    color: var(--cds-support-02);
  }
  .tile-failed dd {
    color: var(--cds-support-01);
  }
  .overview-columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
    gap: 1.5rem 2rem;
    margin-bottom: 1.5rem;
  }
  .overview-columns h3 {
    font-size: 0.875rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
  }
  .size-list {
    list-style: none;
    padding: 0;
    margin: 0;
    font-size: 0.875rem;
  }
  .size-list li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 5rem 5rem;
    align-items: center;
    gap: 0.75rem;
    padding: 0.25rem 0;
    border-bottom: 1px solid var(--cds-ui-03);
  }
  .size-list b {
    font-weight: 400;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .size-name {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .size-name .table-link {
    display: flex;
    min-width: 0;
  }
  .size-bar {
    height: 6px;
    background: var(--cds-ui-03);
  }
  .size-bar i {
    display: block;
    height: 100%;
    background: var(--cds-interactive-04);
  }
  .state-label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }
  .link-button {
    border: 0;
    padding: 0;
    background: none;
    color: var(--cds-link-01);
    font: inherit;
    cursor: pointer;
    text-decoration: underline;
  }
  .link-button:focus-visible {
    outline: 2px solid var(--cds-focus);
  }
  .overview-empty {
    margin-bottom: 2rem;
  }
  .overview-empty h2 {
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
  }
  .overview-empty p {
    margin-bottom: 1rem;
    color: var(--cds-text-secondary);
  }
  @media (max-width: 760px) {
    .running-runs th:nth-child(3),
    .running-runs td:nth-child(3),
    .running-runs th:nth-child(5),
    .running-runs td:nth-child(5) {
      display: none;
    }
    .running-runs th,
    .running-runs td {
      padding-inline: 0.75rem;
    }
    .size-list li {
      grid-template-columns: minmax(0, 1fr) 4.5rem;
    }
    .size-bar {
      display: none;
    }
  }
</style>
