<script lang="ts">
  import { type Snippet,onMount } from 'svelte';
  import {
    Tabs,
    Tab,
    TabContent,
    Search,
    Button,
    DataTable,
    TextInput,
    TextArea,
    Checkbox,
    Tag,
    InlineNotification,
    Select,
    SelectItem,
  } from 'carbon-components-svelte';
  import Copy from 'carbon-icons-svelte/lib/Copy.svelte';
  import Download from 'carbon-icons-svelte/lib/Download.svelte';
  import { api, apiMessage } from './api';
  import { t, locale, number, date, duration, type Message, type MessageKey } from './i18n';
  import { statusLabel, artifactURL, interceptLink } from './ui';
  import {loggedCommand} from './run-format';
  import JsonValue from './JsonValue.svelte';
  import type { Run } from './types';
  let {
    run,
    children,
    onArtifact,
    activeTab = 'metrics',
    onTab,
    metricsActions,
  }: {
    run: Run;
    children: Snippet;
    metricsActions?: Snippet;
    onArtifact: (id: string) => void;
    activeTab?: string;
    onTab: (tab: string) => void;
  } = $props();
  const tabLabels: Record<string, MessageKey> = {
    metrics: 'runPage.tabs.metrics',
    overview: 'runPage.tabs.overview',
    config: 'runPage.tabs.config',
    summary: 'runPage.tabs.summary',
    logs: 'runPage.tabs.logs',
    files: 'runPage.tabs.files',
    artifacts: 'runPage.tabs.artifacts',
  };
  const tabs = Object.keys(tabLabels);
  let tab = $derived(Math.max(0, tabs.indexOf(activeTab)));
  let record = $state<any>(null);
  let now = $state(Date.now() / 1000),
    runtimeObserved = $state(Date.now() / 1000),
    alerts = $state<any[]>([]),
    copied = $state(''),
    copyError = $state<Message>('');
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  onMount(() => {
    const timer = setInterval(() => {
      if (run.state === 'running' && run.snapshot_at == null) now = Date.now() / 1000;
    }, 1000);
    return () => {
      clearInterval(timer);
      clearTimeout(copyTimer);
    };
  });
  let environment = $derived(JSON.parse(record?.metadata || '{}'));
  let command = $derived(loggedCommand(environment));
  async function copy(value: string, kind: string) {
    copyError = '';
    try {
      await navigator.clipboard.writeText(value);
      copied = kind;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = ''), 2000);
    } catch {
      copyError = 'common.clipboard.failed';
    }
  }
  let files = $state<any[]>([]),
    logs = $state<any[]>([]),
    relations = $state<any>({ inputs: [], outputs: [] });
  let search = $state<Record<string, string>>({ config: '', summary: '' }),
    logSearch = $state(''),
    systemFields = $state(false),
    error = $state<Message>(''),
    editing = $state(false),
    name = $state(''),
    notes = $state(''),
    tags = $state(''),
    previousRunId = '';
  let shownLogs = $derived(
    logs.filter((line) =>
      line.content.toLocaleLowerCase($locale).includes(logSearch.toLocaleLowerCase($locale)),
    ),
  );
  $effect(() => {
    if (run.id !== previousRunId) {
      previousRunId = run.id;
      record = null;
      editing = false;copied='';copyError='';clearTimeout(copyTimer);
    }
  });
  $effect(() => {
    run.id;
    run.revision;
    tab;
    const timer = setTimeout(() => void refresh(), 100);
    return () => clearTimeout(timer);
  });
  async function refresh() {
    const id = run.id;
    try {
      if (tab <= 3) {
        const info = await api('/api/run?id=' + encodeURIComponent(id));
        if (run.id !== id) return;
        record = info.run;alerts=info.alerts||[];runtimeObserved=Date.now()/1000;
        if (!editing) {
          name = record.display_name;
          notes = record.notes;
          tags = JSON.parse(record.tags).join(', ');
        }
      } else if (tab === 4) {
        const result = await api('/api/run-logs?run=' + encodeURIComponent(id));
        if (run.id === id) logs = result.lines;
      } else if (tab === 5) {
        const result = await api('/api/run-files?run=' + encodeURIComponent(id));
        if (run.id === id) files = result.files;
      } else {
        const result = await api('/api/run-artifacts?run=' + encodeURIComponent(id));
        if (run.id === id) relations = result;
      }
      error = '';
    } catch (e) {
      error = apiMessage(e);
    }
  }
  function rows(key: string) {
    return Object.entries(JSON.parse(record?.[key] || '{}'))
      .filter(
        ([name]) =>
          (systemFields || !name.startsWith('_')) &&
          name.toLocaleLowerCase($locale).includes(search[key].toLocaleLowerCase($locale)),
      )
      .map(([name, original]) => {
        const value =
          key === 'config' &&
          original &&
          typeof original === 'object' &&
          Object.hasOwn(original, 'value') &&
          Object.keys(original).every((key) => ['value', 'desc'].includes(key))
            ? (original as any).value
            : original;
        return { id: name, name, value };
      });
  }
  async function update() {
    try {
      await api(
        '/api/run',
        {
          id: run.id,
          displayName: name.trim(),
          notes,
          tags: [
            ...new Set(
              tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
            ),
          ],
        },
        'PATCH',
      );
      editing = false;
      await refresh();
    } catch (e) {
      error = apiMessage(e);
    }
  }
</script>

{#if run.snapshot_at != null}<p class="snapshot-note">{$t('runs.snapshot.notice')}</p>{/if}
{#if error}<p role="alert" class="error-copy">{$t(error)}</p>{/if}
<div class="run-tabs">
  <div class="run-tab-picker">
    <Select
      labelText={$t('runPage.tabs.label')}
      hideLabel
      selected={activeTab}
      on:change={(event) => onTab((event.target as HTMLSelectElement).value)}
      >{#each tabs as tab}<SelectItem value={tab} text={$t(tabLabels[tab])} />{/each}</Select
    >
  </div>
  <Tabs
    selected={tab}
    on:change={(event) => {
      const next = tabs[event.detail];
      if (next !== activeTab) onTab(next);
    }}
    autoWidth
  >
    <Tab label={$t('runPage.tabs.metrics')} /><Tab label={$t('runPage.tabs.overview')} /><Tab label={$t('runPage.tabs.config')} /><Tab
      label={$t('runPage.tabs.summary')}
    /><Tab label={$t('runPage.tabs.logs')} /><Tab label={$t('runPage.tabs.files')} /><Tab label={$t('runPage.tabs.artifacts')} />
    <svelte:fragment slot="content">
      <!-- The active tab's search and actions share the tab row, after the tabs in focus order. -->
      <div class="run-tab-actions">
        {#if activeTab === 'metrics'}{@render metricsActions?.()}{:else if activeTab === 'config' || activeTab === 'summary'}{@const key =
            activeTab}<Search
            closeButtonLabelText={$t('common.search.clear')}
            labelText={$t(key === 'config' ? 'runPage.fields.searchConfig' : 'runPage.fields.searchSummary')}
            placeholder={$t(key === 'config' ? 'runPage.fields.searchConfig' : 'runPage.fields.searchSummary')}
            size="sm"
            bind:value={search[key]}
          /><Checkbox
            labelText={$t('runPage.fields.showSystem')}
            checked={systemFields}
            on:change={(event) => (systemFields = (event.target as HTMLInputElement).checked)}
          />{:else if activeTab === 'logs'}<Search
            closeButtonLabelText={$t('common.search.clear')}
            labelText={$t('runPage.logs.search')}
            placeholder={$t('runPage.logs.search')}
            bind:value={logSearch}
            size="sm"
          />{#if logs.length}<Button
              kind="tertiary"
              size="small"
              icon={Download}
              href={'/api/run-export?run=' + encodeURIComponent(run.id) + '&file=output.log'}
              >{$t('runPage.logs.download')}</Button
            >{/if}{/if}
      </div>
      <TabContent flush unmountOnHide>{@render children()}</TabContent>
      <TabContent
        ><div class="run-overview content-inset">
          <dl>
            <dt>{$t('runPage.overview.project')}</dt>
            <dd>{run.entity}/{run.project}</dd>
            <dt>{$t('runs.fields.name')}</dt>
            <dd>{run.name}</dd>
            <dt>{$t('runs.fields.state')}</dt>
            <dd>{statusLabel(run.state, $t)}</dd>
            {#if run.snapshot_at != null}<dt>{$t('runs.snapshot.captured')}</dt><dd>{$date(run.snapshot_at)}</dd>
            {#if run.snapshot_source}<dt>{$t('runs.snapshot.source')}</dt><dd>{run.snapshot_source}</dd>{/if}{/if}
            <dt>{$t('runs.fields.started')}</dt>
            <dd>{$date(run.started||run.created)}</dd>
            {#if record?.runtime!==null&&record?.runtime!==undefined}<dt>{$t('runPage.overview.runtime')}</dt><dd>{$duration(record.runtime+(record.state==='running'&&record.snapshot_at==null?Math.max(0,now-runtimeObserved):0))}</dd>{/if}
            {#if record?.exit_code!==null&&record?.exit_code!==undefined&&['failed','crashed','killed'].includes(record.state)}<dt>{$t('runs.fields.exitCode')}</dt><dd>{record.exit_code}</dd>{/if}
            <dt>{$t('runPage.overview.path')}</dt><dd class="copy-value"><code>{run.id}</code><Button kind="ghost" size="small" icon={Copy} hideTooltip title={$t('runPage.overview.copyPath')} iconDescription={$t('runPage.overview.copyPath')} on:click={()=>copy(run.id,'path')}/></dd>
            <dt>{$t('runs.fields.updated')}</dt>
            <dd>{$date(run.updated)}</dd>
            <dt>{$t('runs.fields.historyCount')}</dt>
            <dd>{$number(run.history_count)}</dd>
            {#if record?.group_name}<dt>{$t('runs.fields.groupName')}</dt>
              <dd>{record.group_name}</dd>{/if}
            {#if record?.job_type}<dt>{$t('runs.fields.jobType')}</dt>
              <dd>{record.job_type}</dd>{/if}
            {#each [['runs.fields.host', record?.host], ['runs.fields.os', environment.os], ['runs.fields.python', environment.python], ['runs.fields.gitRemote', record?.git_remote], ['runs.fields.gitCommit', record?.git_commit], ['runs.fields.executable', environment.executable], ['runs.fields.cpuCount', environment.cpu_count], ['runs.fields.gpu', environment.gpu], ['runs.fields.gpuCount', environment.gpu_count], ['runs.fields.sdkVersion', environment.sdkVersion]] as [MessageKey, unknown][] as [label, value]}{#if value !== undefined && value !== null && value !== ''}<dt
                >
                  {$t(label)}
                </dt>
                <dd><JsonValue {value} /></dd>{/if}{/each}
            {#if typeof environment.memory?.total === 'number'}<dt>
                {$t('runPage.overview.memory')}
              </dt>
              <dd>
                {$t('common.units.gib', {
                  value: $number(environment.memory.total / 1024 ** 3, {
                    maximumFractionDigits: 2,
                  }),
                })}
              </dd>{/if}
            {#if command}<dt>{$t('runPage.overview.command')}</dt>
              <dd class="copy-value">
                <code>{command}</code
                >{#if !String(environment.os || '').startsWith('Windows')}<Button
                    kind="ghost"
                    size="small"
                    icon={Copy}
                    hideTooltip
                    title={$t('runPage.overview.copyCommand')}
                    iconDescription={$t('runPage.overview.copyCommand')}
                    on:click={() => copy(command, 'command')}
                  />{/if}
              </dd>{/if}
          </dl>
          <span role="status" class:bx--visually-hidden={!copied}>{copied?$t(copied==='path'?'runPage.overview.pathCopied':'runPage.overview.commandCopied'):''}</span>
          {#if copyError}<InlineNotification kind="error" title={$t(copyError)} on:close={()=>copyError=''}/>{/if}
          {#if alerts.length}<section class="run-alert-history"><h3>{$t('runPage.alerts.title')}</h3><ul>{#each alerts as alert}<li><div><Tag type={alert.severity==='ERROR'?'red':alert.severity==='WARN'?'warm-gray':'blue'}>{$t(alert.severity==='ERROR'?'runPage.alerts.error':alert.severity==='WARN'?'runPage.alerts.warning':'runPage.alerts.info')}</Tag><time>{$date(alert.created)}</time></div><strong>{alert.title}</strong><p>{alert.text}</p></li>{/each}</ul>{#if alerts.length===100}<p class="help-note">{$t('runPage.alerts.truncated')}</p>{/if}</section>{/if}
          {#if !record}<p role="status">{$t('runPage.loading')}</p>{:else if editing}<form
              class="form-stack"
              onsubmit={(event) => {
                event.preventDefault();
                void update();
              }}
            >
              <TextInput labelText={$t('runs.fields.displayName')} bind:value={name} /><TextInput
                labelText={$t('runs.fields.tags')}
                bind:value={tags}
                helperText={$t('runPage.edit.tagsHelp')}
              /><TextArea labelText={$t('runs.fields.notes')} bind:value={notes} />
              <div class="inline-form-actions">
                <Button size="small" type="submit" disabled={!name.trim()}
                  >{$t('runPage.edit.save')}</Button
                ><Button kind="ghost" size="small" on:click={() => (editing = false)}
                  >{$t('common.action.cancel')}</Button
                >
              </div>
            </form>{:else}<h3>{$t('runs.fields.notes')}</h3>
            <p>{record.notes || $t('runPage.details.noNotes')}</p>
            <h3>{$t('runs.fields.tags')}</h3>
            <p>{JSON.parse(record.tags || '[]').join(', ') || $t('runPage.details.noTags')}</p>
            <Button
              kind="tertiary"
              size="small"
              on:click={() => {
                name = record.display_name;
                notes = record.notes;
                tags = JSON.parse(record.tags).join(', ');
                editing = true;
              }}>{$t('runPage.edit.open')}</Button
            >{/if}
        </div></TabContent
      >
      {#each ['config', 'summary'] as key}<TabContent
          ><div class="content-inset metadata-section">
            {#if !record}<p role="status">
                {$t('runPage.loading')}
              </p>{:else if !rows(key).length}<p class="empty-table">
                {$t(
                  search[key]
                    ? 'runPage.fields.noMatches'
                    : Object.keys(JSON.parse(record[key] || '{}')).length
                      ? 'runPage.fields.onlySystem'
                      : key === 'config'
                        ? 'runPage.fields.noConfig'
                        : 'runPage.fields.noSummary',
                )}
              </p>{:else}
              <DataTable
                tableHeaderTranslateWithId={(id) =>
                  $t(id === 'columnSortAscending' ? 'common.table.sortAscending' : 'common.table.sortDescending')}
                rows={rows(key)}
                headers={[
                  { key: 'name', value: $t('runPage.fields.name') },
                  { key: 'value', value: $t('runPage.fields.value') },
                ]}
                sortable
                size="compact"
                ><svelte:fragment slot="cell" let:cell
                  >{#if cell.key === 'value'}<JsonValue
                      value={cell.value}
                      runId={run.id}
                    />{:else}<span class="metadata-key" title={String(cell.value)}
                      >{cell.value}</span
                    >{/if}</svelte:fragment
                ></DataTable
              >
            {/if}
          </div></TabContent
        >{/each}
      <TabContent
        ><div class="content-inset">
          {#if shownLogs.length}<pre class="logs">{shownLogs
                .map((line) => line.content)
                .join('\n')}</pre>{:else}<p class="empty-table">
              {$t(logs.length ? 'runPage.logs.noMatches' : 'runPage.logs.empty')}
            </p>{/if}
          {#if logs.length === 1000}<p class="help-note">
              {$t('runPage.logs.truncated')}
            </p>{/if}
        </div></TabContent
      >
      <TabContent
        ><div class="content-inset">
          {#if files.length}<DataTable
              tableHeaderTranslateWithId={(id) =>
                $t(id === 'columnSortAscending' ? 'common.table.sortAscending' : 'common.table.sortDescending')}
              rows={files.map((file) => ({
                ...file,
                id: file.name,
                size: $t('common.units.bytes', { count: file.size }),
                updated: $date(Date.parse(file.updated) / 1000),
              }))}
              headers={[
                { key: 'name', value: $t('runPage.files.columns.name') },
                { key: 'size', value: $t('runPage.files.columns.size') },
                { key: 'updated', value: $t('runPage.files.columns.updated') },
              ]}
              sortable
              size="compact"
              ><svelte:fragment slot="cell" let:cell
                >{#if cell.key === 'name'}<a
                    href={'/api/run-files?run=' +
                      encodeURIComponent(run.id) +
                      '&path=' +
                      encodeURIComponent(String(cell.value))}
                    download>{cell.value}</a
                  >{:else}{cell.value}{/if}</svelte:fragment
              ></DataTable
            >{:else}<p class="empty-table">{$t('runPage.files.empty')}</p>{/if}
        </div></TabContent
      >
      <TabContent
        ><div class="content-inset">
          {#each ['outputs', 'inputs'] as kind}<h3 class="table-heading">
              {$t(kind === 'outputs' ? 'runPage.artifacts.outputs' : 'runPage.artifacts.inputs')}
            </h3>
            {#each relations[kind] as artifact}<Button
                kind="ghost"
                size="small"
                href={artifactURL(run.entity + '/' + run.project, artifact.id)}
                on:click={(event) => interceptLink(event, () => onArtifact(artifact.id))}
                >{artifact.name}:v{artifact.version}</Button
              >{:else}<p class="empty-table">
                {$t(kind === 'outputs' ? 'runPage.artifacts.noOutputs' : 'runPage.artifacts.noInputs')}
              </p>{/each}
          {/each}
        </div></TabContent
      >
    </svelte:fragment>
  </Tabs>
</div>

<style>
.snapshot-note{margin:0;padding:.5rem 1rem;font-size:.875rem;line-height:1.4;color:var(--cds-text-secondary)}
</style>
