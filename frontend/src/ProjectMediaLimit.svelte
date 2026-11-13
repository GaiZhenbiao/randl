<script lang="ts">
  import {
    Button,
    InlineNotification,
    NumberInput,
    RadioButton,
    RadioButtonGroup,
    Toggle,
  } from 'carbon-components-svelte';
  import Choice from './Choice.svelte';
  import { api, apiMessage, tool } from './api';
  import { t, type Message } from './i18n';
  import { filterChoice, resultCount } from './ui';
  import type { Run } from './types';

  // A project's media limit (docs/contributing/storage.md): the server's unless the project
  // sets its own, and the axis its runs' media are spaced on when they are thinned.
  type Limit = {
    inherit: boolean;
    enabled: boolean;
    megabytes: number;
    axis: string;
    effective: { enabled: boolean; megabytes: number };
  };
  let { project, runs }: { project: string; runs: Run[] } = $props();
  const max = 1024 * 1024,
    builtIn = ['_step', '_runtime', '_relative_wall', '_timestamp'];
  let saved = $state<Limit | undefined>(),
    server = $state({ enabled: true, megabytes: 500 }),
    inherit = $state(true),
    enabled = $state(true),
    megabytes = $state<number | null>(null),
    axis = $state('_step'),
    metrics = $state<string[]>([]),
    busy = $state(false),
    done = $state(false),
    error = $state<Message>('');
  function show(limit: Limit) {
    saved = limit;
    inherit = limit.inherit;
    enabled = limit.enabled;
    megabytes = limit.megabytes;
    axis = limit.axis;
  }
  let loaded = '';
  $effect(() => {
    const id = project;
    if (id === loaded) return;
    loaded = id;
    saved = undefined;
    done = false;
    error = '';
    void (async () => {
      try {
        const [limit, settings] = await Promise.all([
          tool('project_media_limit_get', { id }),
          tool('settings_get', {}),
        ]);
        if (id !== project) return;
        server = settings.mediaLimit;
        show(limit);
      } catch (reason) {
        if (id === project) error = apiMessage(reason);
      }
    })();
  });
  // The axis choices: the built-in axes and the metrics the project's runs logged.
  let metricsFor = '';
  $effect(() => {
    const id = project,
      ids = runs.slice(0, 200).map((run) => run.id);
    if (!ids.length || metricsFor === id) return;
    metricsFor = id;
    void api('/api/metrics', { runs: ids }).then(
      (result) => {
        if (id === project) metrics = result.metrics;
      },
      () => {},
    );
  });
  let axisItems = $derived([
    { id: '_step', text: $t('charts.xAxis.step') },
    { id: '_runtime', text: $t('charts.xAxis.runtime') },
    { id: '_relative_wall', text: $t('charts.xAxis.relativeWall') },
    { id: '_timestamp', text: $t('charts.xAxis.wallTime') },
    ...[...new Set([...metrics, ...(builtIn.includes(axis) ? [] : [axis])])]
      .sort()
      .map((id) => ({ id, text: id })),
  ]);
  let valid = $derived(
    megabytes !== null && Number.isInteger(megabytes) && megabytes >= 1 && megabytes <= max,
  );
  let sizeNeeded = $derived(!inherit && enabled);
  let changed = $derived(
    !!saved &&
      (inherit !== saved.inherit ||
        axis !== saved.axis ||
        (!inherit && (enabled !== saved.enabled || (enabled && megabytes !== saved.megabytes)))),
  );
  async function save() {
    busy = true;
    done = false;
    error = '';
    try {
      show(
        await tool('project_media_limit_update', {
          id: project,
          inherit,
          axis,
          ...(inherit ? {} : { enabled, ...(enabled ? { megabytes } : {}) }),
        }),
      );
      done = true;
    } catch (reason) {
      error = apiMessage(reason);
    } finally {
      busy = false;
    }
  }
</script>

<div class="form-stack project-media-limit">
  <RadioButtonGroup
    legendText={$t('projects.mediaLimit.source')}
    orientation="vertical"
    name="project-media-limit-source"
    disabled={!saved}
    selected={inherit ? 'server' : 'project'}
    on:change={(event) => {
      inherit = event.detail === 'server';
      done = false;
    }}
    ><RadioButton
      value="server"
      labelText={$t(
        server.enabled ? 'projects.mediaLimit.serverOn' : 'projects.mediaLimit.serverOff',
        { megabytes: server.megabytes },
      )}
    /><RadioButton value="project" labelText={$t('projects.mediaLimit.own')} /></RadioButtonGroup
  >
  {#if !inherit}<Toggle
      id="project-media-limit-enabled"
      labelText={$t('app.settings.mediaLimit.toggle')}
      labelA={$t('common.state.off')}
      labelB={$t('common.state.on')}
      bind:toggled={enabled}
      on:toggle={() => (done = false)}
    />{#if enabled}<NumberInput
        id="project-media-limit"
        labelText={$t('app.settings.mediaLimit.label')}
        min={1}
        {max}
        step={50}
        allowEmpty
        hideSteppers
        invalid={!valid}
        invalidText={$t('app.settings.mediaLimit.invalid', { max })}
        bind:value={megabytes}
        on:input={() => (done = false)}
      />{/if}{/if}
  <Choice
    id="project-media-limit-axis"
    labelText={$t('projects.mediaLimit.axis.label')}
    helperText={$t('projects.mediaLimit.axis.help')}
    selectionClearedText={$t('common.combobox.selectionCleared')}
    filterResultsText={(count) => resultCount(count, $t)}
    translateWithId={(id) => $t(id === 'open' ? 'common.combobox.open' : 'common.combobox.close')}
    translateWithIdSelection={() => $t('common.combobox.clear')}
    shouldFilterItem={filterChoice}
    disabled={!saved}
    items={axisItems}
    selectedId={axis}
    on:select={(event) => {
      axis = String(event.detail.selectedId || '_step');
      done = false;
    }}
    on:clear={() => {
      axis = '_step';
      done = false;
    }}
  />
  <div>
    <Button size="small" disabled={busy || !changed || (sizeNeeded && !valid)} on:click={save}
      >{$t('app.settings.mediaLimit.save')}</Button
    >
  </div>
  {#if done}<InlineNotification
      kind="success"
      lowContrast
      hideCloseButton
      title={$t('projects.mediaLimit.saved')}
    />{/if}{#if error}<InlineNotification
      kind="error"
      lowContrast
      hideCloseButton
      title={$t(error)}
    />{/if}
</div>
