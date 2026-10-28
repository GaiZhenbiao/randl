<script lang="ts">
  import { Tag } from 'carbon-components-svelte';
  import { t } from './i18n';
  import { statusLabel } from './ui';
  import type { Run } from './types';
  let { run }: { run: Run } = $props();
</script>

<Tag
  size="sm"
  class="run-state-tag"
  type={run.state === 'running'
    ? 'blue'
    : run.state === 'finished'
      ? 'green'
      : ['failed', 'crashed'].includes(run.state)
        ? 'red'
        : 'gray'}
  >{run.stop_requested && run.state === 'running'
    ? $t('runs.stop.requested')
    : statusLabel(run.state, $t)}</Tag
>
