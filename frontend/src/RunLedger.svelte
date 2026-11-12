<script lang="ts">
  // A run's journal (dated, append-only entries) and the findings that cite it, on the run page
  // and in the Lineage panel.
  import { Button, InlineNotification, TextArea, TextInput } from 'carbon-components-svelte';
  import { tool, apiMessage } from './api';
  import { t, number, date, type Message } from './i18n';
  let {
    run,
    project,
    onFinding,
  }: { run: string; project: string; onFinding: (id: string) => void } = $props();
  type Entry = { id: string; time: number; update: number | null; text: string; by: string };
  type Cited = { id: string; title: string; status: string };
  let entries = $state<Entry[] | null>(null),
    findings = $state<Cited[] | null>(null),
    error = $state<Message>(''),
    text = $state(''),
    update = $state(''),
    busy = $state(false);
  let loadedFor = '';
  async function load() {
    const id = run;
    loadedFor = id;
    try {
      const [journal, cited] = await Promise.all([
        tool('journal_list', { run: id }),
        tool('findings_list', { project, run: id }),
      ]);
      if (loadedFor !== id) return;
      entries = journal.entries;
      findings = cited.findings;
    } catch (reason) {
      if (loadedFor === id) error = apiMessage(reason);
    }
  }
  $effect(() => {
    if (run !== loadedFor) {
      entries = findings = null;
      void load();
    }
  });
  let updateValid = $derived(!update.trim() || Number.isFinite(Number(update)));
  async function add() {
    busy = true;
    error = '';
    try {
      // Each entry made here is new, even when its text repeats an earlier one.
      await tool('journal_add', {
        run,
        key: crypto.randomUUID(),
        text: text.trim(),
        ...(update.trim() ? { update: Number(update) } : {}),
      });
      text = update = '';
      await load();
    } catch (reason) {
      error = apiMessage(reason);
    } finally {
      busy = false;
    }
  }
</script>

{#if error}<InlineNotification
    lowContrast
    kind="error"
    title={$t('lineage.ledger.errors.failed')}
    subtitle={$t(error)}
    closeButtonDescription={$t('common.notification.close')}
    on:close={() => (error = '')}
  />{/if}
<section class="run-ledger">
  <h3>{$t('lineage.journal.title')}</h3>
  {#if entries === null}<p class="lineage-muted">{$t('common.status.loading')}</p>
  {:else if !entries.length}<p class="lineage-muted">{$t('lineage.journal.empty')}</p>
  {:else}<ol class="lineage-journal">
      {#each entries as entry (entry.id)}<li>
          <span class="lineage-muted"
            >{$date(entry.time)}{entry.update === null ? '' : ' · @' + $number(entry.update)}{entry.by
              ? ' · ' + entry.by
              : ''}</span
          >
          <p class="lineage-hypothesis">{entry.text}</p>
        </li>{/each}
    </ol>{/if}
  <div class="form-stack lineage-journal-add">
    <TextArea labelText={$t('lineage.journal.add')} rows={2} bind:value={text} />
    <div class="lineage-actions">
      <TextInput
        size="sm"
        labelText={$t('lineage.journal.update')}
        inputmode="numeric"
        invalid={!updateValid}
        bind:value={update}
      />
      <Button size="small" disabled={busy || !text.trim() || !updateValid} on:click={add}
        >{$t('lineage.journal.save')}</Button
      >
    </div>
  </div>
</section>
{#if findings?.length}<section class="run-ledger">
    <h3>{$t('lineage.findings.title')}</h3>
    <ul class="lineage-children">
      {#each findings as finding (finding.id)}<li>
          <button type="button" class="lineage-link" onclick={() => onFinding(finding.id)}
            >{finding.title}</button
          >{#if finding.status === 'ruled_out'}<span class="lineage-muted">
              · {$t('findings.status.ruledOut')}</span
            >{/if}
        </li>{/each}
    </ul>
  </section>{/if}
