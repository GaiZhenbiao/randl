<script lang="ts">
  // A project's lineage settings: the metric on each card, how it is shown, and the config keys
  // that link runs without a logged `lineage` block (README "Lineage").
  import {
    Accordion,
    AccordionItem,
    InlineNotification,
    Modal,
    NumberInput,
    RadioButton,
    RadioButtonGroup,
    TextArea,
  } from 'carbon-components-svelte';
  import { untrack } from 'svelte';
  import Choice from './Choice.svelte';
  import { api, apiMessage, tool } from './api';
  import { t, type Message } from './i18n';
  import { filterChoice, resultCount } from './ui';
  import type { Run } from './types';
  import type { LineageSettings } from './lineage-graph';
  let {
    project,
    runs,
    settings,
    onClose,
    onSaved,
  }: {
    project: string;
    runs: Run[];
    settings: LineageSettings;
    onClose: () => void;
    onSaved: () => void;
  } = $props();
  const lines = (keys: string[]) => keys.join('\n'),
    keysOf = (text: string) =>
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
  // A draft of the stored settings, made when the dialog opens.
  const stored = untrack(() => settings);
  let open = $state(true),
    metric = $state(stored.metric),
    scale = $state<number | null>(stored.scale),
    goal = $state(stored.goal),
    window = $state<number | null>(stored.window),
    parentKeys = $state(lines(stored.parentKeys)),
    identityKeys = $state(lines(stored.identityKeys)),
    ignoreKeys = $state(lines(stored.ignoreKeys)),
    metrics = $state<string[]>([]),
    saving = $state(false),
    error = $state<Message>('');
  // Metric choices from the project's newest runs, as the media limit's axis does.
  $effect(() => {
    const ids = [...runs]
      .sort((a, b) => b.created - a.created)
      .slice(0, 200)
      .map((run) => run.id);
    if (ids.length)
      void api('/api/metrics', { runs: ids }).then(
        (result) => (metrics = result.metrics),
        () => {},
      );
  });
  let metricItems = $derived(
    [...new Set([...metrics, ...(metric ? [metric] : [])])].sort().map((id) => ({ id, text: id })),
  );
  let validScale = $derived(scale === null || scale > 0);
  let validWindow = $derived(window !== null && Number.isInteger(window) && window >= 1 && window <= 100);
  async function save() {
    saving = true;
    error = '';
    try {
      await tool('project_lineage_settings_update', {
        id: project,
        metric,
        scale,
        goal,
        window,
        parentKeys: keysOf(parentKeys),
        identityKeys: keysOf(identityKeys),
        ignoreKeys: keysOf(ignoreKeys),
      });
      onSaved();
    } catch (reason) {
      error = apiMessage(reason);
    } finally {
      saving = false;
    }
  }
</script>

<Modal
  bind:open
  size="sm"
  hasScrollingContent
  iconDescription={$t('common.action.close')}
  modalHeading={$t('lineage.settings.title')}
  primaryButtonText={$t(saving ? 'common.status.saving' : 'lineage.settings.save')}
  primaryButtonDisabled={saving || !validScale || !validWindow}
  secondaryButtonText={$t('common.action.cancel')}
  on:click:button--secondary={() => (open = false)}
  on:close={onClose}
  on:submit={save}
>
  <div class="form-stack">
    {#if error}<InlineNotification
        lowContrast
        hideCloseButton
        kind="error"
        title={$t('lineage.settings.errors.saveFailed')}
        subtitle={$t(error)}
      />{/if}
    <Choice
      id="lineage-metric"
      labelText={$t('lineage.settings.metric.label')}
      placeholder={$t('lineage.settings.metric.placeholder')}
      selectionClearedText={$t('common.combobox.selectionCleared')}
      filterResultsText={(count) => resultCount(count, $t)}
      translateWithId={(id) => $t(id === 'open' ? 'common.combobox.open' : 'common.combobox.close')}
      translateWithIdSelection={() => $t('common.combobox.clear')}
      shouldFilterItem={filterChoice}
      items={metricItems}
      selectedId={metric || undefined}
      on:select={(event) => (metric = String(event.detail.selectedId))}
      on:clear={() => (metric = '')}
    />
    <NumberInput
      id="lineage-scale"
      labelText={$t('lineage.settings.scale.label')}
      helperText={$t('lineage.settings.scale.help')}
      allowEmpty
      hideSteppers
      invalid={!validScale}
      invalidText={$t('lineage.settings.scale.invalid')}
      bind:value={scale}
    />
    <NumberInput
      id="lineage-window"
      labelText={$t('lineage.settings.window.label')}
      helperText={$t('lineage.settings.window.help')}
      min={1}
      max={100}
      invalid={!validWindow}
      bind:value={window}
    />
    <RadioButtonGroup
      legendText={$t('lineage.settings.goal.label')}
      name="lineage-goal"
      bind:selected={goal}
      ><RadioButton value="max" labelText={$t('lineage.settings.goal.max')} /><RadioButton
        value="min"
        labelText={$t('lineage.settings.goal.min')}
      /></RadioButtonGroup
    >
    <Accordion>
      <AccordionItem title={$t('lineage.settings.matching')}>
        <div class="form-stack">
          <TextArea
            labelText={$t('lineage.settings.parentKeys.label')}
            helperText={$t('lineage.settings.parentKeys.help')}
            rows={2}
            bind:value={parentKeys}
          />
          <TextArea
            labelText={$t('lineage.settings.identityKeys.label')}
            helperText={$t('lineage.settings.identityKeys.help')}
            rows={2}
            bind:value={identityKeys}
          />
          <TextArea
            labelText={$t('lineage.settings.ignoreKeys.label')}
            helperText={$t('lineage.settings.ignoreKeys.help')}
            rows={4}
            bind:value={ignoreKeys}
          />
        </div>
      </AccordionItem>
    </Accordion>
  </div>
</Modal>
